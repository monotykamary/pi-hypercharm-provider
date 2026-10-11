/**
 * Quiet startup sync, end to end through the extension's real session_start
 * handler: the live /models catalog is fetched only with a key, only when the
 * disk cache is stale (or the key changed), only by one process at a time, and
 * never on the session_start critical path.
 *
 * Porting: only the "Provider specifics" block below differs between
 * pi-*-provider repos. HyperCharm additionally covers the stable OAuth
 * identity, the /login forced revalidation, and the shared startup account
 * snapshot (see the "HyperCharm" describe block at the end).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keyFingerprint, syncLockPath, syncMetaPath } from "../sync-policy";
import embeddedModels from "../models.json" with { type: "json" };

// ─── Provider specifics ───────────────────────────────────────────────────────
const PROVIDER_ID = "hypercharm";
const LIVE_ONLY_ID = "live-only-test-model";
/** A minimal successful /v1/provider response containing LIVE_ONLY_ID. */
const liveModelsResponse = () => Response.json({
  models: [{
    id: LIVE_ONLY_ID,
    name: "Live only",
    context_window: 65536,
    default_max_tokens: 4096,
    cost_per_1m_in: 1,
    cost_per_1m_out: 2,
  }],
});
const isCatalogUrl = (url: string) => url.endsWith("/v1/provider");
// ──────────────────────────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const KEY = "sk-quiet-sync-test";

let home: string;
let cachePath: string;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("../oauth");
  vi.resetModules();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

function setupHome(): void {
  home = fs.mkdtempSync(path.join(os.tmpdir(), `pi-${PROVIDER_ID}-sync-`));
  cachePath = path.join(home, "cache", `${PROVIDER_ID}-models.json`);
  vi.stubEnv("PI_CODING_AGENT_DIR", home);
  vi.stubEnv("PI_PROVIDER_SYNC_TTL_MS", "");
  vi.stubEnv("HYPERCHARM_API_KEY", "");
}

function writeCache(ageMs: number, models: unknown[] = embeddedModels, fingerprintKey: string | null = KEY): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(models));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(cachePath, t, t);
  if (fingerprintKey !== null) {
    fs.writeFileSync(syncMetaPath(cachePath), JSON.stringify({ version: 1, keyFingerprint: keyFingerprint(fingerprintKey) }));
  }
}

const urlOf = (input: unknown) => String(input instanceof Request ? input.url : input);

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> = async () => liveModelsResponse()) {
  const fetch = vi.fn((input: unknown, init?: RequestInit) => impl(urlOf(input), init));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** Only the catalog requests (account endpoints are covered separately). */
const catalogCalls = (fetch: ReturnType<typeof stubFetch>) => fetch.mock.calls.filter(([input]) => isCatalogUrl(urlOf(input)));

interface CtxOptions { hasUI?: boolean; provider?: string }

/** Load the extension fresh (module-level cache paths read PI_CODING_AGENT_DIR). */
async function loadExtension() {
  vi.resetModules();
  const mod = await import("../index");
  const handlers = new Map<string, (...args: any[]) => any>();
  const registrations: Array<{ models: Array<{ id: string }>; oauth?: any }> = [];
  mod.default({
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    registerProvider: (_id: string, config: any) => registrations.push(config),
    registerCommand: () => {},
    registerEntryRenderer: () => {},
    appendEntry: () => {},
  } as any);
  const getApiKeyForProvider = vi.fn(async (): Promise<string | undefined> => KEY);
  const widgets: string[] = [];
  const makeCtx = ({ hasUI = false, provider }: CtxOptions = {}) => ({
    hasUI,
    model: provider ? { provider } : undefined,
    modelRegistry: { getApiKeyForProvider },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: (_key: string, value: any) => {
        if (typeof value !== "function") return;
        const theme = { fg: (_c: string, text: string) => text };
        widgets.push(value(undefined, theme).render(160).join("\n"));
      },
      theme: { fg: (_c: string, text: string) => text },
    },
  });
  const startSession = (ctx: CtxOptions = {}) =>
    handlers.get("session_start")!({ type: "session_start", reason: "startup" }, makeCtx(ctx));
  return { handlers, registrations, getApiKeyForProvider, startSession, widgets };
}

/** Let the fire-and-forget revalidation chain run to completion. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const hasLiveModel = (config: { models: Array<{ id: string }> } | undefined) => !!config?.models.some((m) => m.id === LIVE_ONLY_ID);

describe("quiet startup sync", () => {
  it("skips the live fetch while the disk cache is fresher than the TTL", async () => {
    setupHome();
    writeCache(10 * 60 * 1000);
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await settle();
    expect(ext.getApiKeyForProvider).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("revalidates a stale cache once, hot-swaps the catalog and rewrites the cache", async () => {
    setupHome();
    writeCache(2 * HOUR);
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).toHaveBeenCalledOnce();
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    // Cache stays a plain JSON array so older extension versions still read it.
    expect(Array.isArray(cached)).toBe(true);
    expect(cached.some((m: { id: string }) => m.id === LIVE_ONLY_ID)).toBe(true);
    expect(Date.now() - fs.statSync(cachePath).mtimeMs).toBeLessThan(60_000);
    expect(fs.existsSync(syncLockPath(cachePath))).toBe(false);
    const meta = fs.readFileSync(syncMetaPath(cachePath), "utf8");
    expect(meta).not.toContain(KEY);
    expect(JSON.parse(meta).keyFingerprint).toBe(keyFingerprint(KEY));

    // A second session in the same process (/new) is now inside the TTL.
    await ext.startSession();
    await settle();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("never touches the network without an API key", async () => {
    setupHome();
    const fetch = stubFetch();
    const ext = await loadExtension();
    ext.getApiKeyForProvider.mockResolvedValue(undefined);
    await ext.startSession({ hasUI: true, provider: PROVIDER_ID });
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(syncLockPath(cachePath))).toBe(false);
  });

  it("skips when another process holds the revalidation lock", async () => {
    setupHome();
    writeCache(2 * HOUR);
    fs.writeFileSync(syncLockPath(cachePath), JSON.stringify({ pid: 999999, token: "other-process" }));
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(syncLockPath(cachePath), "utf8")).token).toBe("other-process");
  });

  it("reclaims a stale lock left by a crashed process", async () => {
    setupHome();
    writeCache(2 * HOUR);
    const lockPath = syncLockPath(cachePath);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: "crashed" }));
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lockPath, old, old);
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).toHaveBeenCalledOnce();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("forces a revalidation when the API key changed, even inside the TTL", async () => {
    setupHome();
    writeCache(60 * 1000, embeddedModels, "previous-key");
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("revalidates once when the cache predates the sync sidecar (older extension version)", async () => {
    setupHome();
    writeCache(60 * 1000, embeddedModels, null);
    const fetch = stubFetch();
    const ext = await loadExtension();
    expect(ext.registrations[0].models.length).toBeGreaterThan(0); // old cache is still served
    await ext.startSession();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not throw or fetch when the cache dir is unwritable", async () => {
    setupHome();
    fs.writeFileSync(path.join(home, "cache"), "a file where the cache dir should be");
    const fetch = stubFetch();
    const ext = await loadExtension();
    await expect(ext.startSession({ hasUI: true, provider: PROVIDER_ID })).resolves.toBeUndefined();
    await settle();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not await the network in session_start", async () => {
    setupHome();
    writeCache(2 * HOUR);
    let release!: () => void;
    const fetch = stubFetch(() => new Promise<Response>((resolve) => { release = () => resolve(liveModelsResponse()); }));
    const ext = await loadExtension();
    const outcome = await Promise.race([
      Promise.resolve(ext.startSession()).then(() => "returned"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 1000)),
    ]);
    expect(outcome).toBe("returned");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    release();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
  });

  it("swallows API key resolution failures (no unhandled rejection)", async () => {
    setupHome();
    const fetch = stubFetch();
    const ext = await loadExtension();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      ext.getApiKeyForProvider.mockRejectedValue(new Error("keychain locked"));
      await ext.startSession();
      await settle();
      expect(unhandled).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("backs off after a failed fetch instead of retrying in every new process", async () => {
    setupHome();
    writeCache(2 * HOUR);
    const fetch = stubFetch(async () => new Response("unauthorized", { status: 401 }));
    let ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await settle();
    ext = await loadExtension(); // next pi process
    await ext.startSession();
    await settle();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("adopts a cache refreshed by another process without fetching", async () => {
    setupHome();
    writeCache(30 * 60 * 1000);
    const fetch = stubFetch();
    const ext = await loadExtension();
    // Another pi process revalidated after this one started.
    const refreshed = [...embeddedModels, { ...embeddedModels[0], id: LIVE_ONLY_ID }];
    fs.writeFileSync(cachePath, JSON.stringify(refreshed));
    await ext.startSession();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("PI_PROVIDER_SYNC_TTL_MS=0 revalidates on every session start", async () => {
    setupHome();
    vi.stubEnv("PI_PROVIDER_SYNC_TTL_MS", "0");
    writeCache(0);
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  });
});

// ─── HyperCharm: OAuth identity, /login, shared account snapshot ─────────────

function writeOAuthAuth(refresh: string, access: string): void {
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({
    [PROVIDER_ID]: { type: "oauth", refresh, access, expires: Date.now() + HOUR },
  }));
}

const json = (body: unknown) => Response.json(body);
/** Catalog + account endpoints; counts every request per path suffix. */
function accountApi() {
  const counts: Record<string, number> = {};
  const fetch = stubFetch(async (url) => {
    const key = url.slice(url.lastIndexOf("/"));
    counts[key] = (counts[key] ?? 0) + 1;
    if (url.endsWith("/credits")) return json({ balance: 249 });
    if (url.endsWith("/teams")) return json({ items: [{ name: "Xu's Team" }] });
    if (url.endsWith("/devices")) return json({ items: [] });
    if (isCatalogUrl(url)) return liveModelsResponse();
    throw new Error("unexpected request: " + url);
  });
  return { fetch, counts };
}

describe("HyperCharm quiet sync variants", () => {
  it("keys the fingerprint on the stored OAuth refresh token, not the rotating access token", async () => {
    setupHome();
    writeOAuthAuth("refresh-1", "access-rotated-2");
    writeCache(10 * 60 * 1000, embeddedModels, "oauth:refresh-1");
    const fetch = stubFetch();
    let ext = await loadExtension();
    ext.getApiKeyForProvider.mockResolvedValue("access-rotated-2");
    await ext.startSession();
    await settle();
    expect(fetch).not.toHaveBeenCalled(); // same account, new access token: still fresh

    // A re-login stores a new refresh token: that is an identity change.
    writeOAuthAuth("refresh-2", "access-3");
    ext = await loadExtension();
    ext.getApiKeyForProvider.mockResolvedValue("access-3");
    await ext.startSession();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).toHaveBeenCalledOnce();
    // The fetch itself uses the real access token.
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer access-3");
    expect(JSON.parse(fs.readFileSync(syncMetaPath(cachePath), "utf8")).keyFingerprint).toBe(keyFingerprint("oauth:refresh-2"));
  });

  it("forces a revalidation after /login completes", async () => {
    setupHome();
    writeCache(10 * 60 * 1000);
    vi.doMock("../oauth", () => ({
      USER_AGENT: "pi-hypercharm-provider/test",
      loginHypercharm: async () => ({ type: "oauth", refresh: "fresh-refresh", access: "fresh-access", expires: Date.now() + HOUR }),
      refreshHypercharmToken: async (c: unknown) => c,
    }));
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await settle();
    expect(fetch).not.toHaveBeenCalled();

    const credentials = await ext.registrations[0].oauth.login({});
    expect(credentials.access).toBe("fresh-access");
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).toHaveBeenCalledOnce();
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer fresh-access");
  });

  it("skips the startup account poll without a UI (print mode, child agents)", async () => {
    setupHome();
    writeCache(10 * 60 * 1000);
    const { counts } = accountApi();
    const ext = await loadExtension();
    await ext.startSession({ hasUI: false, provider: PROVIDER_ID });
    await settle();
    expect(counts).toEqual({});
  });

  it("polls the account once across processes and renders the shared snapshot from disk", async () => {
    setupHome();
    writeCache(10 * 60 * 1000);
    const { counts } = accountApi();
    const first = await loadExtension();
    await first.startSession({ hasUI: true, provider: PROVIDER_ID });
    await vi.waitFor(() => expect(first.widgets.some((w) => w.includes("249 hc"))).toBe(true));
    expect(counts).toEqual({ "/credits": 1, "/teams": 1, "/devices": 1 });
    const accountCache = path.join(home, "cache", `${PROVIDER_ID}-account.json`);
    const snapshot = JSON.parse(fs.readFileSync(accountCache, "utf8"));
    expect(snapshot).toMatchObject({ balance: 249, teamName: "Xu's Team" });
    expect(fs.readFileSync(syncMetaPath(accountCache), "utf8")).not.toContain(KEY);
    expect(fs.existsSync(syncLockPath(accountCache))).toBe(false);

    // Next pi process within the account TTL: renders from disk, no polling.
    const second = await loadExtension();
    await second.startSession({ hasUI: true, provider: PROVIDER_ID });
    await settle();
    expect(second.widgets.some((w) => w.includes("Xu's Team") && w.includes("249 hc"))).toBe(true);
    expect(counts).toEqual({ "/credits": 1, "/teams": 1, "/devices": 1 });
  });

  it("does not adopt an account snapshot written for another credential", async () => {
    setupHome();
    writeCache(10 * 60 * 1000, embeddedModels, "other-key");
    const accountCache = path.join(home, "cache", `${PROVIDER_ID}-account.json`);
    fs.writeFileSync(accountCache, JSON.stringify({ version: 1, balance: 999, teamName: "Someone Else", authExpiresAt: null }));
    fs.writeFileSync(syncMetaPath(accountCache), JSON.stringify({ version: 1, keyFingerprint: keyFingerprint("other-key") }));
    const { counts } = accountApi();
    const ext = await loadExtension();
    await ext.startSession({ hasUI: true, provider: PROVIDER_ID });
    await vi.waitFor(() => expect(ext.widgets.some((w) => w.includes("249 hc"))).toBe(true));
    expect(ext.widgets.some((w) => w.includes("Someone Else"))).toBe(false);
    expect(counts["/credits"]).toBe(1);
  });
});
