/**
 * HyperCharm Provider Extension
 *
 * Registers HyperCharm (hyper.charm.land) as a custom provider using the
 * openai-completions API. Base URL: https://hyper.charm.land/v1
 *
 * Model metadata comes from Charm's typed official-catalog endpoint,
 * /v1/provider, matching @charmland/pi-hyper-provider. It provides canonical
 * names, pricing, context and output limits, reasoning levels, and attachment
 * support. patch.json remains available for verified endpoint regressions, but
 * currently contains no overrides.
 *
 * Model resolution strategy: Stale-While-Revalidate
 *   1. Serve stale immediately: disk cache → embedded models.json (zero-latency)
 *   2. Revalidate in background: live API /v1/provider → merge with embedded → cache → hot-swap
 *      Quiet startup sync (sync-policy.ts): only with credentials, only when the
 *      disk cache is older than the TTL (1h, PI_PROVIDER_SYNC_TTL_MS), missing,
 *      or fetched under another credential identity (OAuth: the stored refresh
 *      token, since access tokens rotate), and only one pi process at a time
 *      (lock file next to the cache). A completed /login forces a revalidation.
 *   3. patch.json + custom-models.json applied on top of whichever source won
 *
 * Merge order: [live|cache|embedded] → apply patch.json → merge custom-models.json
 *
 * Footer Status Widget:
 *   A below-editor line shows HyperCharm session + account state:
 *
 *     ⚡ 1.24 hc · 7 req          Xu's Team ◆ 249 hc · 996/1k/h · 10k/10k/d · ⟳ 29d
 *     └─ session activity ──┘  └─────────────── account / quota ─────────────────┘
 *
 *   The left side reports what this session has spent/sent (from Hyper's
 *   usage.cost extension on each chat completion — pi requests
 *   stream_options.include_usage, so the final SSE chunk carries cost and we
 *   read it off a teed response stream, no polling). The right side reports
 *   the team (public /v1/teams — works for API-key auth), the canonical
 *   Hypercredit balance (/v1/credits), per-hour/day rate limits captured from
 *   response headers, and OAuth device-session days remaining (/v1/devices).
 *   The right side compresses across progressive tiers as the terminal
 *   narrows. The balance flips to a ⚠ warning at/below lowBalanceHc.
 *
 *   Lifecycle (mirrors pi-neuralwatt-provider): selecting a HyperCharm model
 *   shows the line — the account side renders as soon as the credits/team
 *   prefetch lands, and the session side (spend/requests) joins it on the
 *   first completed turn. hideOnOtherProvider (default true) clears
 *   everything the moment the active model belongs to another provider.
 *   Credits/team are prefetched on session start or model select when a
 *   HyperCharm model is active, so the first turn ends with data already
 *   cached. The session-start prefetch runs only with a UI (never in print
 *   mode or child agents) and is shared across pi processes: the result is
 *   written to cache/hypercharm-account.json and processes that start within
 *   ACCOUNT_SYNC_TTL_MS (2 min) of it render that snapshot instead of
 *   polling (same lock/fingerprint policy as the model sync). The balance is polled again on pi's agent_settled event (fires
 *   only once no automatic retry,
 *   compaction, or queued continuation can follow) — and nowhere else, so
 *   sessions without HyperCharm turns make zero status-related API calls.
 *   Between polls the balance moves optimistically: each turn's
 *   usage.cost.hypercredits is deducted from the last /v1/credits value at
 *   turn_end so the account line tracks spend live; the agent_settled poll
 *   reconciles any drift.
 *
 *   Unit note (observed): 20 hypercredits = $1. usage.cost.hypercredits is in
 *   the same display unit /v1/credits reports; usage.cost.usd ÷ 20 matches.
 *   usage.remaining.hypercredits is USD-denominated despite the name — we
 *   therefore display only the polled /v1/credits balance.
 *
 * Display Configuration:
 *   Create ~/.pi/agent/extensions/hypercharm.json:
 *   {
 *     "session": "widget",            // "widget" | "statusbar" | "off"
 *     "account": "widget",            // "widget" | "statusbar" | "off"
 *     "hideOnOtherProvider": true,    // hide when a non-HyperCharm model is active
 *     "lowBalanceHc": 25,             // warn threshold, null/false disables
 *     "glyphs": "auto"                // "auto" | "unicode" | "ascii"
 *   }
 *
 *   - "widget" (default): rendered in the below-editor status line
 *   - "statusbar": rendered in the built-in pi status bar
 *   - "off": hidden entirely (account=off also skips/quota fetches)
 *
 *   Manage interactively with /hypercharm-status, or non-interactively:
 *     /hypercharm-status session widget|statusbar|off
 *     /hypercharm-status account widget|statusbar|off
 *     /hypercharm-status hide true|false
 *     /hypercharm-status lowBalance <hc>|off
 *     /hypercharm-status glyphs auto|unicode|ascii
 *
 *   - glyphs "auto" swaps the emoji footer glyphs for ASCII on legacy
 *     terminals (mintty/Cygwin), whose cell-width tables disagree with the
 *     width math and can overflow the widget line. "unicode"/"ascii"
 *     force a set. The widget right-aligns the account side flush with the
 *     terminal's last column (as pi's built-in footer does) and clamps an
 *     explicit "unicode" to ASCII on legacy terminals; the statusbar is
 *     not edge-padded and honors the exact choice.
 *     /hypercharm-status refresh          (re-fetch balance/team now)
 *     /hypercharm-status reset
 *
 * Usage:
 *   # Option 1: OAuth — run pi, send /login, and pick "HyperCharm"
 *   # (device flow; provider id "hypercharm", distinct from the official
 *   # @charmland/pi-hyper-provider registration "hyper")
 *
 *   # Option 2: Store in auth.json
 *   # Add to ~/.pi/agent/auth.json:
 *   #   "hypercharm": { "type": "api_key", "key": "your-api-key" }
 *
 *   # Option 3: Set as environment variable
 *   export HYPERCHARM_API_KEY=your-api-key
 *
 *   # Run pi with the extension
 *   pi -e /path/to/pi-hypercharm-provider
 *
 * Then use /model to select from available models.
 *
 * @see https://hyper.charm.land
 */

import { clampThinkingLevel, streamOpenAICompletions } from "@earendil-works/pi-ai/compat";
import type { AssistantMessageEventStream, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { USER_AGENT, loginHypercharm, refreshHypercharmToken } from "./oauth";
import {
	ACCOUNT_CACHE_FILE_NAME,
	API_KEY_PLACEHOLDER,
	API_NAME,
	CACHE_FILE_NAME,
	CONFIG_FILE_NAME,
	PRISM_ENTRY_TYPE,
	PROVIDER_DISPLAY_NAME,
	PROVIDER_ID,
	STATUS_COMMAND,
	STATUS_KEY_ACCOUNT,
	STATUS_KEY_SESSION,
	WIDGET_KEY,
} from "./identity";
import { createNotifier } from "./notify";
import { prismRouteFromHeaders, prismRouteLabel, readPrismRoute, type PrismRoute } from "./prism";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import modelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchData from "./patch.json" with { type: "json" };
import deprecatedData from "./deprecated-models.json" with { type: "json" };
import {
	applyOptimisticSpend,
	buildAccountTiers,
	buildSessionLine,
	coerceStatusConfig,
	DEFAULT_STATUS_CONFIG,
	EMPTY_ACCOUNT,
	EMPTY_SESSION_STATS,
	StatusLineWidget,
	accountHasData,
	resolveGlyphSet,
	resolveWidgetGlyphSet,
	type AccountState,
	type SessionStats,
	type GlyphSet,
	type StatusConfig,
} from "./status";
import fs from "fs";
import { hostname } from "os";
import path from "path";
import {
	acquireModelSync,
	cacheChangedSinceLoad,
	keyFingerprint,
	markCacheLoaded,
	syncMetaPath,
	writeFileAtomic,
} from "./sync-policy";

// ─── Types ────────────────────────────────────────────────────────────────────

// Warning sink for fetch/parse failures: deduplicated, routed to the session UI
// once one is active, stderr before that. Warnings must never throw.
const notifier = createNotifier();

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function warnAccountFetch(label: string, reason: string): void {
	notifier.warn(`Unable to refresh HyperCharm ${label}: ${reason}.`);
}

interface JsonModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: {
		supportsDeveloperRole?: boolean;
		supportsStore?: boolean;
		maxTokensField?: "max_completion_tokens" | "max_tokens";
		thinkingFormat?: "openai" | "zai" | "qwen" | "qwen-chat-template" | "deepseek";
		supportsReasoningEffort?: boolean;
		requiresReasoningContentOnAssistantMessages?: boolean;
	};
}

interface PatchEntry {
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
	contextWindow?: number;
	maxTokens?: number;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: Record<string, unknown>;
}

type PatchData = Record<string, PatchEntry>;

// ─── Patch Application ────────────────────────────────────────────────────────

function applyPatch(model: JsonModel, patch: PatchEntry): JsonModel {
	const result = { ...model };

	if (patch.name !== undefined) result.name = patch.name;
	if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
	if (patch.input !== undefined) result.input = patch.input;
	if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
	if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;
	if (patch.thinkingLevelMap !== undefined) result.thinkingLevelMap = { ...patch.thinkingLevelMap };

	if (patch.cost) {
		result.cost = {
			input: patch.cost.input ?? result.cost.input,
			output: patch.cost.output ?? result.cost.output,
			cacheRead: patch.cost.cacheRead ?? result.cost.cacheRead,
			cacheWrite: patch.cost.cacheWrite ?? result.cost.cacheWrite,
		};
	}
	if (patch.compat) {
		result.compat = { ...(result.compat || {}), ...patch.compat };
	}

	if (!result.reasoning && result.compat?.thinkingFormat) {
		delete result.compat.thinkingFormat;
	}
	if (!result.reasoning && result.thinkingLevelMap) {
		delete result.thinkingLevelMap;
	}
	if (result.compat && Object.keys(result.compat).length === 0) {
		delete result.compat;
	}

	return result;
}

/** Full pipeline: base models → patch → custom → result */
function buildModels(base: JsonModel[], custom: JsonModel[], patch: PatchData): JsonModel[] {
	const modelMap = new Map<string, JsonModel>();

	// Seed with the base list plus grace-period deprecated models so patch.json
	// entries apply to deprecated models exactly as while the model was live
	// (withDeprecated keeps live data on id conflicts).
	for (const model of withDeprecated(base)) {
		modelMap.set(model.id, model);
	}

	for (const [id, patchEntry] of Object.entries(patch)) {
		const existing = modelMap.get(id);
		if (existing) {
			modelMap.set(id, applyPatch(existing, patchEntry));
		}
	}

	for (const model of custom) {
		const existing = modelMap.get(model.id);
		const patchEntry = patch[model.id];
		if (existing && patchEntry) {
			modelMap.set(model.id, applyPatch(model, patchEntry));
		} else if (existing) {
			modelMap.set(model.id, model);
		} else if (patchEntry) {
			modelMap.set(model.id, applyPatch(model, patchEntry));
		} else {
			modelMap.set(model.id, model);
		}
	}

	return Array.from(modelMap.values());
}

// ─── Stale-While-Revalidate Model Sync ────────────────────────────────────────

const BASE_URL = "https://hyper.charm.land/v1";
const MODELS_URL = `${BASE_URL}/provider`;
const CACHE_DIR = path.join(getAgentDir(), "cache");
const CACHE_PATH = path.join(CACHE_DIR, CACHE_FILE_NAME);
const LIVE_FETCH_TIMEOUT_MS = 8000;

const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

const ON_OFF_THINKING_LEVEL_MAP: Record<string, string | null> = {
	off: "off",
	minimal: null,
	low: null,
	medium: null,
	high: null,
	xhigh: null,
	max: "max",
};

function buildThinkingLevelMap(levels: string[]): Record<string, string | null> | undefined {
	if (levels.length === 0) return undefined;
	const available = new Set(levels);
	const result: Record<string, string | null> = {
		off: available.has("off") ? "off" : available.has("none") ? "none" : null,
	};
	for (const level of PI_THINKING_LEVELS) {
		result[level] = available.has(level) ? level : null;
	}
	return result;
}

/** Transform a model from Charm's official typed Hyper /v1/provider catalog. */
function transformApiModel(apiModel: any): JsonModel | null {
	if (typeof apiModel.id !== "string" || apiModel.id.length === 0) return null;

	const reasoningLevels = Array.isArray(apiModel.reasoning_levels)
		? apiModel.reasoning_levels.filter((level: any) => typeof level === "string")
		: [];
	const supportsReasoningEffort = reasoningLevels.length > 0;
	const thinkingLevelMap = supportsReasoningEffort
		? buildThinkingLevelMap(reasoningLevels)
		: apiModel.can_reason === true
			? ON_OFF_THINKING_LEVEL_MAP
			: undefined;

	return {
		id: apiModel.id,
		name: apiModel.name || apiModel.id,
		reasoning: apiModel.can_reason === true,
		thinkingLevelMap,
		input: apiModel.supports_attachments === true ? ["text", "image"] : ["text"],
		cost: {
			input: apiModel.cost_per_1m_in || 0,
			output: apiModel.cost_per_1m_out || 0,
			cacheRead: apiModel.cost_per_1m_out_cached || 0,
			cacheWrite: apiModel.cost_per_1m_in_cached || 0,
		},
		contextWindow: apiModel.context_window || 0,
		maxTokens: apiModel.default_max_tokens || apiModel.context_window || 0,
		compat: {
			supportsStore: false,
			supportsReasoningEffort,
			thinkingFormat: "deepseek",
			maxTokensField: "max_tokens",
		},
	};
}

async function fetchLiveModels(apiKey: string, signal?: AbortSignal): Promise<JsonModel[] | null> {
	try {
		const response = await fetch(MODELS_URL, {
			headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": USER_AGENT },
			signal: signal ? AbortSignal.any([AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS), signal]) : AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
		});
		if (!response.ok) {
			notifier.warn(`HyperCharm model catalog refresh failed: HTTP ${response.status} — serving cached/embedded models.`);
			return null;
		}
		const data = await response.json();
		const apiModels = Array.isArray(data) ? data : (data.models || data.data || []);
		if (!Array.isArray(apiModels) || apiModels.length === 0) {
			notifier.warn("HyperCharm model catalog refresh returned no usable models — serving cached/embedded models.");
			return null;
		}
		return apiModels.map(transformApiModel).filter((m): m is JsonModel => m !== null);
	} catch (err) {
		// An aborted signal means the session was replaced, not that Hyper failed.
		if (!signal?.aborted) {
			notifier.warn(`HyperCharm model catalog refresh failed: ${describeError(err)} — serving cached/embedded models.`);
		}
		return null;
	}
}

function loadCachedModels(): JsonModel[] | null {
	try {
		const data = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
		return Array.isArray(data) ? data : null;
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
			notifier.warn(`Ignoring unreadable HyperCharm model cache at ${CACHE_PATH}: ${describeError(err)}.`);
		}
		return null;
	}
}

function cacheModels(models: JsonModel[]): void {
	try {
		fs.mkdirSync(CACHE_DIR, { recursive: true });
		// Atomic (tmp + rename): other pi processes may be reading the cache right now.
		writeFileAtomic(CACHE_PATH, JSON.stringify(models, null, 2) + "\n");
	} catch (err) {
		// Non-fatal: the freshly fetched catalog still serves this session.
		notifier.warn(`Could not write the HyperCharm model cache to ${CACHE_PATH}: ${describeError(err)}.`);
	}
}

function mergeWithEmbedded(liveModels: JsonModel[], embeddedModels: JsonModel[]): JsonModel[] {
	const embeddedMap = new Map(embeddedModels.map(m => [m.id, m]));
	const seen = new Set<string>();
	const result: JsonModel[] = [];
	for (const liveModel of liveModels) {
		const embedded = embeddedMap.get(liveModel.id);
		seen.add(liveModel.id);
		if (embedded) {
			// The official /v1/provider catalog is authoritative for pricing, including
			// legitimately zero-priced preview models. Curation (reasoning/input/compat/name)
			// still wins via ...embedded.
			result.push({
				...liveModel,
				...embedded,
				cost: liveModel.cost,
				contextWindow: liveModel.contextWindow || embedded.contextWindow,
			});
		} else {
			result.push(liveModel);
		}
	}
	// Append any embedded models that the live API didn't return
	for (const em of embeddedModels) {
		if (!seen.has(em.id)) {
			result.push(em);
		}
	}
	return result;
}

// Grace period for delisted models. When the provider API stops listing a
// model, update-models.js moves its last-known definition into
// deprecated-models.json (stamped with deprecatedAt) instead of dropping it.
// For 14 days the model keeps working here so in-flight sessions and saved
// model settings do not break; afterwards it is evicted permanently.
const DEPRECATED_MODEL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// Grace-period deprecated models with deprecation metadata stripped.
function activeDeprecatedModels(): JsonModel[] {
	const now = Date.now();
	const result: JsonModel[] = [];
	for (const entry of Object.values(deprecatedData as Record<string, JsonModel & { deprecatedAt?: string }>)) {
		if (!entry?.id) continue;
		const removedAt = Date.parse(entry.deprecatedAt ?? "");
		if (Number.isNaN(removedAt) || now - removedAt > DEPRECATED_MODEL_TTL_MS) continue;
		const model = { ...entry } as JsonModel & { deprecatedAt?: string };
		delete model.deprecatedAt;
		result.push(model);
	}
	return result;
}

// Append grace-period deprecated models the list does not already have (live data wins).
function withDeprecated(models: JsonModel[]): JsonModel[] {
	const seen = new Set(models.map((m) => m.id));
	const extras = activeDeprecatedModels().filter((m) => !seen.has(m.id));
	return extras.length > 0 ? [...models, ...extras] : models;
}

function loadStaleModels(embeddedModels: JsonModel[]): JsonModel[] {
	markCacheLoaded(CACHE_PATH); // stat before read: lets session_start spot newer caches
	const cached = loadCachedModels();
	if (!cached || cached.length === 0) return embeddedModels;

	// Merge embedded models that are missing from cache (newly added models)
	const cachedMap = new Map(cached.map(m => [m.id, m]));
	for (const em of embeddedModels) {
		if (!cachedMap.has(em.id)) {
			cached.push(em);
		}
	}
	return cached;
}

/**
 * Background revalidation, gated by the quiet startup sync policy
 * (sync-policy.ts): no credentials → no fetch; fresh cache (TTL) → no fetch;
 * another process already fetching → no fetch. When skipped, a cache that
 * another process refreshed since we loaded it is adopted from disk instead.
 * `force` bypasses the TTL (e.g. after /login); it is still single-flight.
 *
 * `identity` is the stable credential identity used only for presence and the
 * fingerprint (see credentialIdentity); `apiKey` is the bearer token we fetch with.
 */
async function revalidateModels(
	apiKey: string | undefined,
	identity: string | undefined,
	embeddedModels: JsonModel[],
	signal?: AbortSignal,
	force = false,
): Promise<JsonModel[] | null> {
	const lease = acquireModelSync({ cachePath: CACHE_PATH, apiKey: apiKey ? identity : undefined, force });
	if (!lease) return cacheChangedSinceLoad(CACHE_PATH) ? loadStaleModels(embeddedModels) : null;
	let merged: JsonModel[] | null = null;
	try {
		const liveModels = apiKey ? await fetchLiveModels(apiKey, signal) : null;
		if (!liveModels || liveModels.length === 0) return null;
		merged = mergeWithEmbedded(liveModels, embeddedModels);
		cacheModels(merged);
		return merged;
	} finally {
		lease.release(merged ? "fetched" : signal?.aborted ? "aborted" : "failed");
	}
}

// ─── API Key Resolution (via ModelRegistry) ────────────────────────────────────

let cachedApiKey: string | undefined;
// Stable identity behind cachedApiKey for the quiet-sync fingerprints.
let cachedSyncIdentity: string | undefined;
let revalidateAbort: AbortController | null = null;
// The in-flight catalog revalidation (session start or /login); it never rejects.
let modelSync: Promise<void> = Promise.resolve();

const AUTH_PATH = path.join(getAgentDir(), "auth.json");

const oauthIdentity = (refresh: string): string => `oauth:${refresh}`;

/**
 * Stable credential identity for the quiet-sync fingerprint. OAuth access
 * tokens rotate on every token refresh, so fingerprinting the resolved key
 * would look like an account change each time. For an OAuth entry in
 * auth.json use its refresh token instead (it changes on /login); API keys —
 * auth.json, --api-key, HYPERCHARM_API_KEY — are static, so use the key itself.
 * Only ever hashed (sync-policy keyFingerprint), never stored.
 */
function credentialIdentity(apiKey: string | undefined): string | undefined {
	if (!apiKey) return undefined;
	try {
		const stored = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"))?.[PROVIDER_ID];
		if (stored?.type === "oauth" && typeof stored.refresh === "string" && stored.refresh) {
			return oauthIdentity(stored.refresh);
		}
	} catch {
		// No/unreadable auth.json: the key resolved from elsewhere (env, --api-key).
	}
	return apiKey;
}

async function resolveApiKey(modelRegistry: ModelRegistry): Promise<void> {
	cachedApiKey = await modelRegistry.getApiKeyForProvider(PROVIDER_ID) ?? undefined;
	cachedSyncIdentity = credentialIdentity(cachedApiKey);
}

// Set by the extension entry point: runs after a /login completes.
let onLoginComplete: ((credentials: OAuthCredentials) => void) | null = null;

// ─── Status Display Configuration ──────────────────────────────────────────────

const CONFIG_PATH = path.join(getAgentDir(), "extensions", "hypercharm.json");

let statusConfig: StatusConfig = { ...DEFAULT_STATUS_CONFIG };

function loadStatusConfig(): StatusConfig {
	try {
		const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
		statusConfig = coerceStatusConfig(raw);
	} catch (err) {
		// A missing file is normal; anything else is worth surfacing once.
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
			notifier.warn(`Ignoring unreadable HyperCharm status config at ${CONFIG_PATH}: ${describeError(err)} — using defaults.`);
		}
	}
	return statusConfig;
}

function writeStatusConfig(): void {
	try {
		let raw: Record<string, unknown> = {};
		try {
			const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
			if (existing && typeof existing === "object" && !Array.isArray(existing)) raw = existing;
		} catch {
			// No existing file — start fresh
		}
		raw.session = statusConfig.session;
		raw.account = statusConfig.account;
		raw.hideOnOtherProvider = statusConfig.hideOnOtherProvider;
		raw.lowBalanceHc = statusConfig.lowBalanceHc;
		raw.glyphs = statusConfig.glyphs;
		fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
		fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + "\n");
	} catch (err) {
		// Non-fatal: the in-memory config still applies to this session.
		notifier.warn(`Could not save the HyperCharm status config to ${CONFIG_PATH}: ${describeError(err)}.`);
	}
}

loadStatusConfig();

// ─── Response Metadata Capture ────────────────────────────────────────────────
// The custom streamSimple below wraps fetch per request (never globalThis —
// concurrent main/helper requests would clobber a global patch). For every
// /chat/completions response we capture x-ratelimit-* headers and tee the
// body: one copy goes to pi's OpenAI streaming layer, the other is scanned
// for the final usage chunk that Hyper extends with hypercredit cost data.

const sessionStats: SessionStats = { ...EMPTY_SESSION_STATS };
const account: AccountState = { ...EMPTY_ACCOUNT };

// Per-turn pending state — teed streams settle asynchronously, so capture
// lands in pending* and is committed at turn_end.
let pendingRequests = 0;
let pendingSpendHc = 0;
let pendingSawUsage = false;
let pendingSawOutOfCredits = false;
let outOfCreditsNotified = false;
let widgetGlyphClampNotified = false;

const teeReaders = new Set<Promise<void>>();

function trackTeeReader(promise: Promise<void>): void {
	teeReaders.add(promise);
	const release = () => { teeReaders.delete(promise); };
	promise.then(release, release);
}

function settleTeeReaders(): Promise<void> {
	if (teeReaders.size === 0) return Promise.resolve();
	const pending = Array.from(teeReaders);
	return Promise.allSettled(pending).then(() => undefined);
}

function captureRateLimitHeaders(headers: Headers): void {
	const limitHour = Number(headers.get("x-ratelimit-limit-hour"));
	const limitDay = Number(headers.get("x-ratelimit-limit-day"));
	const remainingHour = Number(headers.get("x-ratelimit-remaining-hour"));
	const remainingDay = Number(headers.get("x-ratelimit-remaining-day"));
	if (![limitHour, limitDay, remainingHour, remainingDay].every((v) => Number.isFinite(v))) return;
	account.rate = { limitHour, limitDay, remainingHour, remainingDay, capturedAt: Date.now() };
}

/** Extract spend data from a parsed completion chunk/body's usage object. */
function captureUsage(obj: any): void {
	const usage = obj?.usage;
	if (typeof usage !== "object" || usage === null) return;
	const hc = usage.cost?.hypercredits;
	if (typeof hc === "number" && Number.isFinite(hc)) {
		pendingSpendHc += hc;
	}
	pendingSawUsage = true;
}

/** Scan a teed response for the final usage chunk (SSE) or JSON body usage. */
async function readUsageFromTee(body: ReadableStream<Uint8Array>): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const processLine = (line: string): void => {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data: ")) return;
		const payload = trimmed.slice(6);
		if (payload === "[DONE]") return;
		try {
			captureUsage(JSON.parse(payload));
		} catch {
			// Not JSON or no usage — benign
		}
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		}
	} catch {
		// Tee stream may error if the main stream is aborted — that's fine
	}

	const trailing = (buffer + decoder.decode(new Uint8Array(0), { stream: false })).trim();
	if (trailing) {
		if (trailing.startsWith("data: ")) {
			processLine(trailing);
		} else if (trailing.startsWith("{")) {
			try {
				captureUsage(JSON.parse(trailing));
			} catch {
				// Partial non-SSE body — ignore
			}
		}
	}

	try {
		reader.releaseLock();
	} catch {
		// Ignore
	}
}

// ─── Custom Streaming Provider ────────────────────────────────────────────────

function streamHypercharm(
	model: any,
	context: any,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const apiKey = (options as any)?.apiKey || cachedApiKey || "";
	if (!apiKey) {
		throw new Error(
			`No API key for HyperCharm. Add it to ~/.pi/agent/auth.json, ` +
			`set HYPERCHARM_API_KEY env var, or use --api-key.`,
		);
	}

	const hyperModel = { ...model, api: "openai-completions", baseUrl: model.baseUrl || BASE_URL };

	// pi hands the user's thinking selection as options.reasoning (a raw
	// ThinkingLevel); streamOpenAICompletions only reads reasoningEffort.
	// Replicate pi-ai's clamp+convert so levels reach the request body.
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(hyperModel, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
	const { reasoning: _reasoning, ...streamOptions } = (options ?? {}) as any;

	// Per-request fetch wrapper: owns its interceptor, safe under concurrency.
	const upstreamFetch = (streamOptions as any).fetch ?? globalThis.fetch;
	const metaFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const response = await upstreamFetch(input as any, init);
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (!url.includes("/chat/completions")) return response;

		pendingRequests += 1;
		captureRateLimitHeaders(response.headers);
		if (response.status === 402) pendingSawOutOfCredits = true;
		if (!response.ok || !response.body) return response;

		const [bodyForSdk, bodyForMeta] = response.body.tee();
		trackTeeReader(readUsageFromTee(bodyForMeta));
		return new Response(bodyForSdk, {
			headers: response.headers,
			status: response.status,
			statusText: response.statusText,
		});
	};

	return streamOpenAICompletions(hyperModel, context, {
		...streamOptions,
		fetch: metaFetch,
		reasoningEffort,
		apiKey,
	} as any);
}

// ─── Account Metadata Fetching ────────────────────────────────────────────────

const CREDITS_MIN_INTERVAL_MS = 15_000;
const ACCOUNT_FETCH_TIMEOUT_MS = 8_000;

let statusAbort: AbortController | null = null;
// Bumped on every session_start; async continuations compare against this to
// drop work belonging to a replaced session (its ctx is stale and throws).
let statusEpoch = 0;
let lastCreditsFetchAt = 0;
let creditsInFlight: Promise<void> | null = null;
let metaFetched = false;
// Bumped on every successful /v1/credits read (lets the startup sync tell a
// fresh balance from one adopted off disk).
let creditsOkCount = 0;
// Absolute OAuth device-session expiry behind account.authDaysLeft (persisted
// in the account snapshot so other processes recompute days-left correctly).
let authExpiresAtMs: number | null = null;

async function fetchJsonGet(url: string, apiKey: string, signal: AbortSignal | undefined, label: string): Promise<any | null> {
	try {
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": USER_AGENT },
			signal: signal
				? AbortSignal.any([AbortSignal.timeout(ACCOUNT_FETCH_TIMEOUT_MS), signal])
				: AbortSignal.timeout(ACCOUNT_FETCH_TIMEOUT_MS),
		});
		if (!response.ok) {
			warnAccountFetch(label, `HTTP ${response.status}`);
			return null;
		}
		return await response.json();
	} catch (err) {
		// An abort means the session was replaced or shut down, not a failure.
		if (!signal?.aborted) warnAccountFetch(label, describeError(err));
		return null;
	}
}

/** Canonical Hypercredit balance from /v1/credits. Throttled unless forced. */
function refreshCredits(apiKey: string | undefined, signal: AbortSignal | undefined, force: boolean): Promise<void> {
	if (!apiKey) return Promise.resolve();
	if (!force && Date.now() - lastCreditsFetchAt < CREDITS_MIN_INTERVAL_MS) return Promise.resolve();
	lastCreditsFetchAt = Date.now();
	if (creditsInFlight) return creditsInFlight;
	creditsInFlight = (async () => {
		try {
			const data = await fetchJsonGet(`${BASE_URL}/credits`, apiKey, signal, "Hypercredit balance");
			if (data === null) return;
			// /credits can report hypercredits ("balance") or USD ("balance_usd",
			// USD-billed accounts). Handle both at the observed 20 hc = $1 rate so a
			// server-side unit switch can never silently freeze the balance readout.
			const rawBalance = typeof data?.balance === "number" ? data.balance : typeof data?.balance_usd === "number" ? data.balance_usd * 20 : undefined;
			if (typeof rawBalance === "number" && Number.isFinite(rawBalance)) {
				account.balance = rawBalance;
				creditsOkCount += 1;
			}
		} finally {
			creditsInFlight = null;
		}
	})();
	return creditsInFlight;
}

/** Team name (/v1/teams) + OAuth device-session expiry (/v1/devices). */
async function refreshAccountMeta(apiKey: string | undefined, signal?: AbortSignal): Promise<void> {
	if (!apiKey || metaFetched) return;
	const [teams, devices] = await Promise.all([
		fetchJsonGet(`${BASE_URL}/teams`, apiKey, signal, "team metadata"),
		fetchJsonGet(`${BASE_URL}/devices`, apiKey, signal, "device sessions"),
	]);
	if (signal?.aborted) return;

	const teamName = teams?.items?.[0]?.name;
	if (typeof teamName === "string" && teamName.trim()) {
		account.teamName = teamName.trim();
	}

	// Devices: the OAuth device flow registers this machine as
	// `Pi (<hostname>)`. Match by name; skip silently for API-key auth
	// (the endpoint returns OAuth sessions and may be empty).
	if (Array.isArray(devices?.items)) {
		const own = devices.items.find((d: any) => typeof d?.name === "string" && d.name === `Pi (${hostname()})`);
		const expMs = own ? Date.parse(own.expires_at ?? "") : NaN;
		if (!Number.isNaN(expMs)) {
			authExpiresAtMs = expMs;
			account.authDaysLeft = daysUntil(expMs);
		}
	}

	if (account.teamName !== null || account.authDaysLeft !== null) metaFetched = true;
}

function daysUntil(ms: number): number {
	return Math.max(0, Math.ceil((ms - Date.now()) / 86_400_000));
}

// ─── Quiet Startup Account Sync ──────────────────────────────────────────────
// Every pi process with a UI used to poll /v1/credits + /v1/teams + /v1/devices
// on session_start. The startup prefetch now goes through the same
// cross-process policy as the model sync (sync-policy.ts), with its own cache:
// one process polls and writes cache/hypercharm-account.json, every other
// process starting within ACCOUNT_SYNC_TTL_MS renders that snapshot from disk.
// Turn-triggered polls (model_select, agent_settled, 402, /hypercharm-status
// refresh) are unchanged and stay throttled per process.

const ACCOUNT_CACHE_PATH = path.join(CACHE_DIR, ACCOUNT_CACHE_FILE_NAME);
/**
 * Freshness window for the shared startup account snapshot. 2 minutes: long
 * enough to collapse /new, /reload and fan-out bursts into one poll, short
 * enough that a session started later shows a current balance. The balance
 * also moves optimistically per turn and agent_settled reconciles it.
 */
const ACCOUNT_SYNC_TTL_MS = 2 * 60 * 1000;

interface AccountSnapshot {
	version: 1;
	balance: number | null;
	teamName: string | null;
	authExpiresAt: number | null;
}

/** Render a snapshot another process wrote, if it belongs to the same credential identity. */
function adoptAccountSnapshot(identity: string): void {
	try {
		const meta = JSON.parse(fs.readFileSync(syncMetaPath(ACCOUNT_CACHE_PATH), "utf8"));
		if (meta?.keyFingerprint !== keyFingerprint(identity)) return;
		const snap = JSON.parse(fs.readFileSync(ACCOUNT_CACHE_PATH, "utf8")) as Partial<AccountSnapshot> | null;
		if (!snap || typeof snap !== "object") return;
		if (typeof snap.balance === "number" && Number.isFinite(snap.balance)) account.balance = snap.balance;
		if (typeof snap.teamName === "string" && snap.teamName.trim()) account.teamName = snap.teamName.trim();
		if (typeof snap.authExpiresAt === "number" && Number.isFinite(snap.authExpiresAt)) {
			authExpiresAtMs = snap.authExpiresAt;
			account.authDaysLeft = daysUntil(snap.authExpiresAt);
		}
		if (account.teamName !== null || account.authDaysLeft !== null) metaFetched = true;
	} catch {
		// Missing/corrupt snapshot: nothing to adopt.
	}
}

function writeAccountSnapshot(): void {
	const snap: AccountSnapshot = {
		version: 1,
		balance: account.balance,
		teamName: account.teamName,
		authExpiresAt: authExpiresAtMs,
	};
	try {
		fs.mkdirSync(CACHE_DIR, { recursive: true });
		writeFileAtomic(ACCOUNT_CACHE_PATH, JSON.stringify(snap) + "\n");
	} catch {
		// Non-fatal: other processes just poll themselves.
	}
}

/**
 * Session-start account prefetch: adopt the shared snapshot (synchronously,
 * before the first await, so the caller can render it at once), then poll only
 * if this process wins the lease. Callers gate on ctx.hasUI.
 */
async function startupAccountSync(apiKey: string | undefined, identity: string | undefined, signal: AbortSignal): Promise<void> {
	if (!apiKey || !identity) return;
	adoptAccountSnapshot(identity);
	const lease = acquireModelSync({
		cachePath: ACCOUNT_CACHE_PATH,
		apiKey: identity,
		ttlMs: ACCOUNT_SYNC_TTL_MS,
		isValidCache: (d) => d != null,
	});
	if (!lease) return;
	let ok = false;
	try {
		const before = creditsOkCount;
		metaFetched = false;
		await Promise.all([refreshCredits(apiKey, signal, true), refreshAccountMeta(apiKey, signal)]);
		ok = !signal.aborted && creditsOkCount > before;
		if (ok) writeAccountSnapshot();
	} finally {
		lease.release(ok ? "fetched" : signal.aborted ? "aborted" : "failed");
	}
}

// ─── Status Rendering ─────────────────────────────────────────────────────────

function currentProviderId(ctx: ExtensionContext): string | undefined {
	// ctx.model is a getter that can throw on stale contexts
	try {
		return (ctx.model as any)?.provider as string | undefined;
	} catch {
		return undefined;
	}
}

function isStaleCtxError(err: unknown): boolean {
	return err instanceof Error && err.message.includes("This extension ctx is stale");
}

// Render entry point: swallows the stale-ctx throw so a refresh racing a
// session replacement (newSession/fork/switchSession/reload) can't crash pi.
function updateStatus(ctx: ExtensionContext): void {
	try {
		renderStatus(ctx);
	} catch (err) {
		if (!isStaleCtxError(err)) throw err;
	}
}

// Re-render once an async refresh lands, unless the session was replaced
// meanwhile (epoch bump) — its ctx is stale and the render is obsolete anyway.
function updateStatusAfter(promise: Promise<void>, ctx: ExtensionContext): void {
	const epoch = statusEpoch;
	void promise.then(() => {
		if (epoch === statusEpoch) updateStatus(ctx);
	});
}

function renderStatus(ctx: ExtensionContext): void {
	const provider = currentProviderId(ctx);
	const hiddenByOtherProvider =
		statusConfig.hideOnOtherProvider && provider !== undefined && provider !== PROVIDER_ID;

	const clearAll = () => {
		ctx.ui.setStatus(STATUS_KEY_SESSION, undefined);
		ctx.ui.setStatus(STATUS_KEY_ACCOUNT, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	};

	if (hiddenByOtherProvider) {
		clearAll();
		return;
	}

	const hasActivity = sessionStats.requests > 0 || sessionStats.spendHc > 0;
	// Legacy terminals measure these glyphs with their own cell tables; the
	// widget clamps to ASCII there, the statusbar keeps the explicit choice.
	const glyphs = resolveGlyphSet(statusConfig.glyphs);
	const widgetGlyphs = resolveWidgetGlyphSet(statusConfig.glyphs);
	const widgetClamped = widgetGlyphs !== glyphs;
	if (widgetClamped && !widgetGlyphClampNotified && ctx.hasUI) {
		widgetGlyphClampNotified = true;
		ctx.ui.notify("HyperCharm: widget glyphs stay ASCII on this terminal — unicode glyphs overflow legacy mintty/Cygwin cell widths. Statusbar is unaffected.", "info");
	}
	// Show while HyperCharm is the selected provider — the account side renders
	// as soon as the session_start/model_select credits fetch lands, with no
	// need to wait for a turn — and once this session recorded HyperCharm
	// activity, which is what keeps the line alive after a switch when
	// hideOnOtherProvider is false. The default true clears it on the switch.
	const visible = hasActivity || provider === PROVIDER_ID;
	const accountVisible = statusConfig.account !== "off" && accountHasData(account) && visible;
	const lowBalance =
		statusConfig.lowBalanceHc !== null && account.balance !== null && account.balance <= statusConfig.lowBalanceHc;
	const sessionLine = statusConfig.session !== "off" ? buildSessionLine(sessionStats, glyphs) : undefined;
	const accTiers = accountVisible ? buildAccountTiers(account, lowBalance, glyphs) : [];
	const sessionLineW = widgetClamped && statusConfig.session !== "off" ? buildSessionLine(sessionStats, widgetGlyphs) : sessionLine;
	const accTiersW = widgetClamped && accountVisible ? buildAccountTiers(account, lowBalance, widgetGlyphs) : accTiers;

	// Status bar (built-in footer slots)
	const sBar = statusConfig.session === "statusbar" ? sessionLine : undefined;
	const aBar = statusConfig.account === "statusbar" && accountVisible ? accTiers[0] : undefined;
	if (sBar && aBar) {
		// Combined to avoid eating two footer slots
		ctx.ui.setStatus(STATUS_KEY_SESSION, ctx.ui.theme.fg(lowBalance ? "warning" : "dim", `${sBar} ${glyphs.sep} ${aBar}`));
		ctx.ui.setStatus(STATUS_KEY_ACCOUNT, undefined);
	} else {
		ctx.ui.setStatus(STATUS_KEY_SESSION, sBar ? ctx.ui.theme.fg("dim", sBar) : undefined);
		ctx.ui.setStatus(STATUS_KEY_ACCOUNT, aBar ? ctx.ui.theme.fg(lowBalance ? "warning" : "dim", aBar) : undefined);
	}

	// Below-editor widget (two-zone, width-aware)
	const leftW = statusConfig.session === "widget" ? sessionLineW : undefined;
	const rightW = statusConfig.account === "widget" && accountVisible ? accTiersW : undefined;
	if (leftW !== undefined || (rightW !== undefined && rightW.length > 0)) {
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui: any, theme: any) => new StatusLineWidget(theme, leftW ?? "", rightW ?? [], lowBalance, widgetGlyphs),
			{ placement: "belowEditor" },
		);
} else {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
}
}

function resetStatusState(): void {
	sessionStats.requests = 0;
	sessionStats.spendHc = 0;
	Object.assign(account, EMPTY_ACCOUNT);
	pendingRequests = 0;
	pendingSpendHc = 0;
	pendingSawUsage = false;
	pendingSawOutOfCredits = false;
	outOfCreditsNotified = false;
	lastCreditsFetchAt = 0;
	metaFetched = false;
	authExpiresAtMs = null;
}

/** Commit per-turn pending capture into session state (after tees settle). */
function commitPending(ctx: ExtensionContext): void {
	if (!pendingSawUsage && pendingRequests === 0) return;
	sessionStats.requests += pendingRequests;
	sessionStats.spendHc += pendingSpendHc;

	// Optimistic balance: deduct this turn's observed spend so the account
	// line ticks down per turn with zero extra API calls. Every credits poll
	// overwrites account.balance (never adjusts), so this cannot
	// double-count; the agent_settled poll reconciles any drift.
	applyOptimisticSpend(account, pendingSpendHc);

	pendingRequests = 0;
	pendingSpendHc = 0;
	pendingSawUsage = false;

	if (pendingSawOutOfCredits) {
		pendingSawOutOfCredits = false;
		// Re-fetch now so the balance reflects exhaustion immediately
		updateStatusAfter(refreshCredits(cachedApiKey, statusAbort?.signal ?? undefined, true), ctx);
		if (!outOfCreditsNotified && ctx.hasUI) {
			outOfCreditsNotified = true;
			ctx.ui.notify("HyperCharm is out of Hypercredits — recharge at hyper.charm.land", "error");
		}
	}
}

// ─── Status Command ────────────────────────────────────────────────────────────

function statusSummary(): string {
	const lb = statusConfig.lowBalanceHc === null ? "off" : `${statusConfig.lowBalanceHc}`;
	return `session=${statusConfig.session}, account=${statusConfig.account}, hideOnOtherProvider=${statusConfig.hideOnOtherProvider}, lowBalanceHc=${lb}, glyphs=${statusConfig.glyphs}`;
}

const STATUS_USAGE =
	"Usage: /hypercharm-status [session|account widget|statusbar|off · hide true|false · lowBalance <hc>|off · glyphs auto|unicode|ascii · refresh · reset]";

async function handleStatusCommand(args: string, ctx: ExtensionContext): Promise<void> {
	const tokens = args.trim().split(/\s+/).filter(Boolean);

	if (tokens.length === 0) {
		if (!ctx.hasUI) {
			ctx.ui.notify(statusSummary(), "info");
			return;
		}
		await configureStatusInteractive(ctx);
		return;
	}

	const [rawKey, rawValue] = tokens;
	const key = rawKey.toLowerCase();
	const value = rawValue?.toLowerCase();

	if (key === "refresh") {
		metaFetched = false;
		await Promise.all([
			refreshCredits(cachedApiKey, statusAbort?.signal ?? undefined, true),
			refreshAccountMeta(cachedApiKey, statusAbort?.signal ?? undefined),
		]);
		updateStatus(ctx);
		const bal = account.balance !== null ? `${account.balance} hc` : "unknown";
		ctx.ui.notify(`HyperCharm balance: ${bal}. ${statusSummary()}`, "info");
		return;
	}

	if (key === "reset" && tokens.length === 1) {
		statusConfig = { ...DEFAULT_STATUS_CONFIG };
		writeStatusConfig();
		updateStatus(ctx);
		ctx.ui.notify(`HyperCharm status reset. ${statusSummary()}`, "info");
		return;
	}

	if ((key === "session" || key === "account") && tokens.length === 2) {
		if (value !== "widget" && value !== "statusbar" && value !== "off") {
			ctx.ui.notify(STATUS_USAGE, "error");
			return;
		}
		statusConfig[key] = value;
		writeStatusConfig();
		if (value !== "off" && key === "account") {
			// Turning account on: make sure we have data to show
			updateStatusAfter(refreshCredits(cachedApiKey, statusAbort?.signal ?? undefined, true), ctx);
			void refreshAccountMeta(cachedApiKey, statusAbort?.signal ?? undefined);
		}
		updateStatus(ctx);
		ctx.ui.notify(`HyperCharm ${key} line: ${value}. ${statusSummary()}`, "info");
		return;
	}

	if ((key === "hide" || key === "hideonotherprovider") && tokens.length === 2) {
		if (value !== "true" && value !== "false") {
			ctx.ui.notify(STATUS_USAGE, "error");
			return;
		}
		statusConfig.hideOnOtherProvider = value === "true";
		writeStatusConfig();
		updateStatus(ctx);
		ctx.ui.notify(`HyperCharm status. ${statusSummary()}`, "info");
		return;
	}

	if (key === "lowbalance" && tokens.length === 2) {
		if (value === "off") {
			statusConfig.lowBalanceHc = null;
		} else {
			const n = Number(value);
			if (!Number.isFinite(n) || n <= 0) {
				ctx.ui.notify(STATUS_USAGE, "error");
				return;
			}
			statusConfig.lowBalanceHc = n;
		}
		writeStatusConfig();
		updateStatus(ctx);
		ctx.ui.notify(`HyperCharm status. ${statusSummary()}`, "info");
		return;
	}

	if (key === "glyphs" && tokens.length === 2) {
		if (value !== "auto" && value !== "unicode" && value !== "ascii") {
			ctx.ui.notify(STATUS_USAGE, "error");
			return;
		}
		statusConfig.glyphs = value;
		writeStatusConfig();
		updateStatus(ctx);
		ctx.ui.notify(`HyperCharm status. ${statusSummary()}`, "info");
		return;
	}

	ctx.ui.notify(STATUS_USAGE, "error");
}

async function configureStatusInteractive(ctx: ExtensionContext): Promise<void> {
	const modes = ["widget", "statusbar", "off"] as const;
	const nextMode = (m: string) => modes[(modes.indexOf(m as any) + 1) % modes.length];
	const glyphModes = ["auto", "unicode", "ascii"] as const;
	const nextGlyphMode = () => glyphModes[(glyphModes.indexOf(statusConfig.glyphs as any) + 1) % glyphModes.length];

	for (;;) {
		const lb = statusConfig.lowBalanceHc === null ? "off" : `${statusConfig.lowBalanceHc} hc`;
		const sessionOpt = `Session line (spend/requests): ${statusConfig.session}`;
		const accountOpt = `Account line (team/balance/rate limits): ${statusConfig.account}`;
		const hideOpt = `Hide on other providers: ${statusConfig.hideOnOtherProvider ? "on" : "off"}`;
		const lbOpt = `Low-balance warning: ${lb}`;
		const glyphOpt = `Glyphs (legacy terminals): ${statusConfig.glyphs}`;
		const refreshOpt = "Refresh balance now";
		const doneOpt = "Done";

		const choice = await ctx.ui.select("HyperCharm footer status", [
			sessionOpt,
			accountOpt,
			hideOpt,
			lbOpt,
			glyphOpt,
			refreshOpt,
			doneOpt,
		]);

		if (choice === undefined || choice === doneOpt) {
			updateStatus(ctx);
			return;
		}
		if (choice === sessionOpt) {
			statusConfig.session = nextMode(statusConfig.session);
			writeStatusConfig();
			continue;
		}
		if (choice === accountOpt) {
			statusConfig.account = nextMode(statusConfig.account);
			writeStatusConfig();
			if (statusConfig.account !== "off") {
				updateStatusAfter(refreshCredits(cachedApiKey, statusAbort?.signal ?? undefined, true), ctx);
				void refreshAccountMeta(cachedApiKey, statusAbort?.signal ?? undefined);
			}
			continue;
		}
		if (choice === hideOpt) {
			statusConfig.hideOnOtherProvider = !statusConfig.hideOnOtherProvider;
			writeStatusConfig();
			updateStatus(ctx);
			continue;
		}
		if (choice === lbOpt) {
			const presets = ["off", "10", "25", "50", "100", "200", "500"];
			const current = statusConfig.lowBalanceHc === null ? "off" : String(statusConfig.lowBalanceHc);
			const ordered = presets.includes(current) ? presets : [current, ...presets];
			const pick = await ctx.ui.select("Warn at/below balance (hc)", ordered);
			if (pick !== undefined) {
				statusConfig.lowBalanceHc = pick === "off" ? null : Number(pick);
				writeStatusConfig();
				updateStatus(ctx);
			}
			continue;
		}
		if (choice === glyphOpt) {
			statusConfig.glyphs = nextGlyphMode();
			writeStatusConfig();
			updateStatus(ctx);
			continue;
		}
		if (choice === refreshOpt) {
			metaFetched = false;
			await Promise.all([
				refreshCredits(cachedApiKey, statusAbort?.signal ?? undefined, true),
				refreshAccountMeta(cachedApiKey, statusAbort?.signal ?? undefined),
			]);
			updateStatus(ctx);
			continue;
		}
	}
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

// The currently-registered model list — starts stale, hot-swapped when the
// live catalog lands. Provider identity funnels through makeProviderConfig so
// the stream handler and models never desync.
let currentModels: JsonModel[] = [];

function makeProviderConfig(models: JsonModel[] = currentModels) {
	return {
		baseUrl: BASE_URL,
		apiKey: API_KEY_PLACEHOLDER,
		// Custom API name so our streamSimple registers as its own handler and
		// never shadows pi's built-in openai-completions pipeline for other
		// providers. streamHypercharm delegates to pi-ai's OpenAI-compat streamer.
		api: API_NAME,
		models,
		streamSimple: streamHypercharm,
		oauth: {
			name: PROVIDER_DISPLAY_NAME,
			login: async (callbacks) => {
				const credentials = await loginHypercharm(callbacks);
				onLoginComplete?.(credentials);
				return credentials;
			},
			refreshToken: (credentials, signal) => refreshHypercharmToken(credentials, signal),
			getApiKey: (credentials) => String(credentials.access ?? ""),
		},
	};
}

export default function (pi: ExtensionAPI) {
	const embeddedModels = modelsData as JsonModel[];
	const customModels = customModelsData as JsonModel[];
	const patches = patchData as PatchData;

	// Prism routing state: collected per assistant request, committed at turn_end.
	let collectingPrismRoute = false;
	let prismRoute: PrismRoute | undefined;

	const staleBase = loadStaleModels(embeddedModels);
	const staleModels = buildModels(staleBase, customModels, patches);
	currentModels = staleModels;

	pi.registerProvider(PROVIDER_ID, makeProviderConfig(staleModels));

	// Revalidate the catalog (quiet startup sync policy) and hot-swap on success.
	const syncModels = (epoch: number, signal: AbortSignal | undefined, force: boolean): Promise<void> =>
		revalidateModels(cachedApiKey, cachedSyncIdentity, embeddedModels, signal, force).then((freshBase) => {
			if (freshBase && epoch === statusEpoch && !signal?.aborted) {
				currentModels = buildModels(freshBase, customModels, patches);
				pi.registerProvider(PROVIDER_ID, makeProviderConfig());
			}
		});

	// A completed /login means new credentials: adopt them and force a
	// revalidation (still single-flight). Deferred so pi persists the
	// credential first; never blocks or fails the login itself.
	onLoginComplete = (credentials) => {
		const access = String(credentials.access ?? "");
		if (!access) return;
		cachedApiKey = access;
		cachedSyncIdentity = typeof credentials.refresh === "string" && credentials.refresh ? oauthIdentity(credentials.refresh) : access;
		// New account: team/device metadata and the throttle start over.
		metaFetched = false;
		lastCreditsFetchAt = 0;
		const epoch = statusEpoch;
		setTimeout(() => {
			// The new credentials supersede an in-flight revalidation, which must
			// release its sync lock first, or this forced refresh would skip as "locked".
			revalidateAbort?.abort();
			revalidateAbort = new AbortController();
			const signal = revalidateAbort.signal;
			modelSync = modelSync.then(() => (signal.aborted ? undefined : syncModels(epoch, signal, true))).catch(() => {});
		}, 0);
	};

	pi.registerCommand(STATUS_COMMAND, {
		description: "Configure the HyperCharm footer status (session spend, balance, rate limits)",
		handler: async (args, ctx) => {
			await handleStatusCommand(args, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		notifier.activate(ctx);
		const epoch = ++statusEpoch;
		revalidateAbort?.abort();
		revalidateAbort = new AbortController();
		const signal = revalidateAbort.signal;
		statusAbort?.abort();
		statusAbort = new AbortController();
		const statusSignal = statusAbort.signal;

		loadStatusConfig();
		resetStatusState();
		updateStatus(ctx); // clears any carryover; the account side lands with the credits fetch
		// Re-register so our identity (custom api + streamSimple) always wins
		// over anything that touched provider registration during load.
		pi.registerProvider(PROVIDER_ID, makeProviderConfig());

		// Fire-and-forget: never await network here — startup must not block on
		// the provider API. Nothing is awaited and every rejection is swallowed.
		// A key-resolution failure is surfaced (it used to vanish), then we keep
		// serving the embedded/cached catalog.
		modelSync = resolveApiKey(ctx.modelRegistry)
			.catch((err) => {
				notifier.warn(`Unable to resolve HyperCharm credentials: ${describeError(err)} — serving cached/embedded models.`);
			})
			.then(() => {
				// A session replacement while the key resolved invalidated the
				// captured ctx (fast-resume, /new, /fork); nothing below may touch it.
				if (epoch !== statusEpoch) return;
				// Prefetch credits/team metadata only when a HyperCharm model is
				// active and there is a UI to show it (print mode and child agents
				// never render the footer), deduped across pi processes.
				if (ctx.hasUI && currentProviderId(ctx) === PROVIDER_ID) {
					const accountSync = startupAccountSync(cachedApiKey, cachedSyncIdentity, statusSignal);
					updateStatus(ctx); // renders an adopted snapshot right away
					updateStatusAfter(accountSync.catch(() => {}), ctx);
				}
				return syncModels(epoch, signal, false);
			})
			.catch(() => { /* keep serving the stale catalog */ });
	});

	pi.on("model_select", (event, ctx) => {
		updateStatus(ctx);
		const model: any = (event as any).model;
		if (model?.provider === PROVIDER_ID && cachedApiKey) {
			// Both refreshes repaint when they land: selection alone must fill in
			// the account side (balance now, team/auth atoms a moment later)
			// instead of leaving a bare gem until the next turn.
			updateStatusAfter(refreshCredits(cachedApiKey, statusAbort?.signal ?? undefined, false), ctx);
			updateStatusAfter(refreshAccountMeta(cachedApiKey, statusAbort?.signal ?? undefined), ctx);
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		// Ensure every concurrent response tee has landed before committing.
		await settleTeeReaders();
		commitPending(ctx);
		// If the session_start/model_select credits fetch raced or failed, retry
		// once we have real activity so the very first turn shows the balance.
		if (sessionStats.requests > 0 && account.balance === null) {
			await refreshCredits(cachedApiKey, statusAbort?.signal ?? undefined, false);
		}
		updateStatus(ctx);
	});

	// agent_settled (not agent_end): fires only when no automatic retry,
	// compaction, or queued continuation can follow — the one moment polling
	// /v1/credits is both fresh and not redundant. Gated on session activity
	// so sessions without HyperCharm turns make zero API calls here.
	pi.on("agent_settled", async (_event, ctx) => {
		if (sessionStats.requests > 0 || sessionStats.spendHc > 0) {
			await refreshCredits(cachedApiKey, statusAbort?.signal ?? undefined, false);
			if (!metaFetched) await refreshAccountMeta(cachedApiKey, statusAbort?.signal ?? undefined);
			updateStatus(ctx);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		revalidateAbort?.abort();
		statusAbort?.abort();
		ctx.ui.setStatus(STATUS_KEY_SESSION, undefined);
		ctx.ui.setStatus(STATUS_KEY_ACCOUNT, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	// Prism routing: Hyper's edge reports which upstream model actually served the
	// assistant request via response headers. Collection is scoped to that request
	// so auxiliary calls between turns cannot leak a route into the transcript,
	// and the route lands at turn_end as a durable session entry — never a
	// notification — so it survives reopening the session.
	pi.registerEntryRenderer(PRISM_ENTRY_TYPE, (entry, _options, theme) => {
		const route = readPrismRoute(entry.data);
		const label = route ? prismRouteLabel(route) : undefined;
		if (label === undefined) return undefined;
		return new Text(`${theme.fg("muted", "Prism")} ${theme.fg("dim", "→")} ${theme.fg("muted", label)}`, 0, 0);
	});

	pi.on("turn_start", () => {
		collectingPrismRoute = true;
		prismRoute = undefined;
	});

	pi.on("after_provider_response", (event) => {
		if (!collectingPrismRoute) return;
		prismRoute = prismRouteFromHeaders(event.headers);
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") collectingPrismRoute = false;
	});

	pi.on("turn_end", (event) => {
		const route = prismRoute;
		prismRoute = undefined;
		collectingPrismRoute = false;
		if (route === undefined) return;
		if (event.message.role !== "assistant") return;
		if (event.message.provider !== PROVIDER_ID) return;
		if (event.message.stopReason === "error" || event.message.stopReason === "aborted") return;
		pi.appendEntry(PRISM_ENTRY_TYPE, route);
	});

}
