import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import embeddedModels from "../models.json" with { type: "json" };
import { keyFingerprint, syncMetaPath } from "../sync-policy";

// Exercise the real per-request fetch wrapper, leaving SDK message parsing out
// of these deterministic lifecycle tests (covered by provider.integration).
vi.mock("@earendil-works/pi-ai/compat", () => ({
  clampThinkingLevel: (_model: unknown, level: unknown) => level,
  streamOpenAICompletions: (model: any, _ctx: unknown, options: any) => ({
    response: options.fetch(`${model.baseUrl}/chat/completions`, { signal: options.signal }),
  }),
}));

vi.mock("../oauth", () => ({
  USER_AGENT: "test",
  loginHypercharm: async () => ({ type: "oauth", access: "new-account-key", refresh: "new-refresh", expires: Date.now() + 3600000 }),
  refreshHypercharmToken: async (credentials: unknown) => credentials,
}));

const KEY = "offline-cancellation-key";
let home: string;
let shutdown: (() => Promise<void>) | undefined;
afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function immediate(work: unknown) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    expect(await Promise.race([
      Promise.resolve(work).then(() => "settled"),
      new Promise((resolve) => { timer = setTimeout(() => resolve("blocked"), 100); }),
    ])).toBe("settled");
  } finally { clearTimeout(timer); }
}

async function setup(provider = "other") {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hypercharm-cancel-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", home);
  vi.stubEnv("HYPERCHARM_API_KEY", "");
  vi.stubEnv("PI_PROVIDER_SYNC_TTL_MS", "");
  const cache = path.join(home, "cache", "hypercharm-models.json");
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(embeddedModels));
  fs.writeFileSync(syncMetaPath(cache), JSON.stringify({ version: 1, keyFingerprint: keyFingerprint(KEY) }));
  vi.resetModules();
  const mod = await import("../index");
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  let config: any;
  mod.default({
    on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerProvider(_id: string, value: any) { config = value; },
    registerCommand() {}, registerEntryRenderer() {}, appendEntry() {},
  } as any);
  const widgets: string[] = [];
  const setStatus = vi.fn();
  const ctx = {
    hasUI: true,
    signal: undefined as AbortSignal | undefined,
    model: { provider },
    modelRegistry: { getApiKeyForProvider: async () => KEY },
    ui: {
      notify: vi.fn(), setStatus,
      theme: { fg: (_c: string, text: string) => text },
      setWidget(_key: string, value: any) {
        if (typeof value === "function") widgets.push(value(undefined, this.theme).render(160).join("\n"));
      },
    },
  };
  async function emit(name: string, event: any = {}) {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  }
  shutdown = () => emit("session_shutdown");
  await emit("session_start");
  await tick();
  async function request(body?: ReadableStream<Uint8Array>, signal?: AbortSignal) {
    const payload = 'data: {"usage":{"cost":{"hypercredits":5}}}\n\n';
    const stream = config.streamSimple({ baseUrl: "https://offline.invalid/v1" }, {}, {
      apiKey: KEY, signal,
      fetch: async () => new Response(body ?? payload),
    });
    return await stream.response as Response;
  }
  async function activity() {
    const response = await request();
    await response.text();
    await emit("turn_end", { message: { role: "assistant", stopReason: "aborted" } });
  }
  return { ctx, emit, activity, request, widgets, setStatus, login: () => config.oauth.login({}) };
}

function stalledFetch(ignoreAbort = false) {
  const signals: AbortSignal[] = [];
  const finish: Array<() => void> = [];
  const fetch = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init!.signal!;
    signals.push(signal);
    finish.push(() => resolve(Response.json({ balance: 999, items: [{ name: "Stale Team" }] })));
    if (!ignoreAbort) {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }
  }));
  vi.stubGlobal("fetch", fetch);
  return { fetch, signals, finish };
}

describe("cancellation-safe HyperCharm bookkeeping", () => {
  it.each(["event", "signal"])("skips account requests on aborted %s, even with previous usage", async (source) => {
    const ext = await setup();
    await ext.activity();
    const { fetch } = stalledFetch();
    if (source === "signal") ext.ctx.signal = AbortSignal.abort();
    await immediate(ext.emit("agent_settled", { aborted: source === "event" }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not await a missing balance at turn_end or duplicate metadata at settlement", async () => {
    const ext = await setup();
    const { fetch, signals } = stalledFetch();
    const response = await ext.request();
    await response.text();
    await immediate(ext.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } }));
    expect(fetch).toHaveBeenCalledTimes(1);
    await immediate(ext.emit("agent_settled"));
    await immediate(ext.emit("agent_settled"));
    expect(fetch).toHaveBeenCalledTimes(3);
    await shutdown!();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("joins pending startup credits and metadata without blocking settlement", async () => {
    const { fetch } = stalledFetch();
    const ext = await setup("hypercharm");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    await ext.activity();
    await immediate(ext.emit("agent_settled"));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each(["shutdown", "restart"])("rejects stale responses after %s and keeps new requests single-flight", async (action) => {
    const ext = await setup();
    await ext.activity();
    ext.ctx.model.provider = "hypercharm";
    const old = stalledFetch(true);
    await ext.emit("agent_settled");
    expect(old.fetch).toHaveBeenCalledTimes(3);
    if (action === "shutdown") await shutdown!();
    else {
      ext.ctx.model.provider = "other";
      await ext.emit("session_start");
      await tick();
      ext.ctx.model.provider = "hypercharm";
    }
    const calls = ext.setStatus.mock.calls.length;
    expect(old.signals.every((signal) => signal.aborted)).toBe(true);
    const next = stalledFetch();
    if (action === "restart") {
      await ext.activity();
      await ext.emit("agent_settled");
      expect(next.fetch).toHaveBeenCalledTimes(3);
    }
    old.finish.forEach((resolve) => resolve());
    await tick();
    if (action === "shutdown") expect(ext.setStatus).toHaveBeenCalledTimes(calls);
    else {
      await ext.emit("agent_settled");
      await ext.emit("turn_end", { message: { role: "assistant", stopReason: "aborted" } });
      expect(next.fetch).toHaveBeenCalledTimes(3);
    }
    expect(ext.widgets.some((text) => /999 hc|Stale Team/.test(text))).toBe(false);
  });

  it("does not join or accept old account refreshes after login changes credentials", async () => {
    const ext = await setup();
    await ext.activity();
    ext.ctx.model.provider = "hypercharm";
    const old = stalledFetch(true);
    await ext.emit("agent_settled");
    await ext.login();
    expect(old.signals.every((signal) => signal.aborted)).toBe(true);
    const next = stalledFetch();
    await ext.emit("agent_settled");
    expect(next.fetch).toHaveBeenCalledTimes(3);
    expect(next.fetch.mock.calls.every(([, init]) => new Headers(init?.headers).get("Authorization") === "Bearer new-account-key")).toBe(true);
    old.finish.forEach((resolve) => resolve());
    await tick();
    await ext.emit("turn_end", { message: { role: "assistant", stopReason: "aborted" } });
    expect(ext.widgets.some((text) => /999 hc|Stale Team/.test(text))).toBe(false);
    // The login's deferred catalog sync is unrelated to these account calls.
    const accountCalls = () => next.fetch.mock.calls.filter(([url]) => !String(url).endsWith("/provider"));
    await ext.emit("agent_settled");
    expect(accountCalls()).toHaveLength(3);
  });

  it.each([false, true])("stops a stuck telemetry tee, preserving fulfilled reads across abort (race=%s)", async (race) => {
    const ext = await setup();
    ext.ctx.model.provider = "hypercharm";
    const { fetch } = stalledFetch();
    const abort = new AbortController();
    ext.ctx.signal = abort.signal;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const bytes = new TextEncoder().encode('data: {"usage":{"cost":{"hypercredits":5}}}\ndata: {"usage":{"cost":{"hypercredits":100}}');
    const source = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    // For the race case, deliver directly into the telemetry branch so read()
    // is fulfilled synchronously, then abort before its continuation runs.
    if (race) vi.spyOn(source, "tee").mockReturnValue([new ReadableStream<Uint8Array>(), source]);
    const sdk = await ext.request(source, abort.signal);
    controller.enqueue(bytes);
    if (!race) await tick();
    abort.abort();
    try {
      await immediate(ext.emit("turn_end", { message: { role: "assistant", stopReason: "aborted" } }));
      expect(ext.widgets.some((text) => /5(?:\.0+)? hc/.test(text))).toBe(true);
      expect(ext.widgets.some((text) => /105 hc/.test(text))).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    } finally { await sdk.body!.cancel(); }
  });
});
