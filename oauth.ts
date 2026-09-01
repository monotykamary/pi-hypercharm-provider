/**
 * HyperCharm OAuth device flow (provider id "hypercharm").
 *
 * Mirrors the device flow from @charmland/pi-hyper-provider against
 * hyper.charm.land, but registers under our own provider id ("hypercharm",
 * oauth display name "HyperCharm") so it never collides with the official
 * provider's "hyper" registration when both extensions are installed.
 *
 * Note: both providers register the device under the same name
 * (`Pi (<hostname>)`), so /v1/devices entries are indistinguishable per host
 * when the official provider is also signed in — the status widget's OAuth
 * days-left readout may match either session.
 */

import { hostname } from "os";
import type { OAuthCredentials, OAuthDeviceCodeInfo, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import pkg from "./package.json" with { type: "json" };

const BASE_URL = "https://hyper.charm.land";
const OAUTH_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const MIN_POLL_INTERVAL_MS = 1_000;
const SLOW_DOWN_INCREMENT_MS = 5_000;
const TOKEN_EXPIRY_BUFFER_MS = 30_000;
const CANCEL_MESSAGE = "Login cancelled";
const TIMEOUT_MESSAGE = "HyperCharm device flow timed out";

export const USER_AGENT = `pi-hypercharm-provider/${(pkg as { version?: string }).version ?? "0.0.0"}`;

function deviceName(): string {
	const host = hostname();
	return host ? `Pi (${host})` : "Pi";
}

function hyperHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return { "Content-Type": "application/json", "User-Agent": USER_AGENT, ...extra };
}

async function oauthFetch(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
	const timeout = AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS);
	return fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
}

async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw new Error(CANCEL_MESSAGE);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error(CANCEL_MESSAGE));
			},
			{ once: true },
		);
	});
}

interface DeviceAuthResponse {
	device_code: string;
	expires_in: number;
	user_code: string;
	verification_url: string;
	interval?: number;
}

type DevicePollResponse =
	| { refresh_token: string; team_id?: string; team_name?: string; user_id?: string }
	| { error: string; error_description?: string };

interface TokenExchangeResponse {
	access_token: string;
	refresh_token: string;
	expires_in?: number;
	expires_at?: number;
}

async function initiateDeviceAuth(signal?: AbortSignal): Promise<DeviceAuthResponse> {
	const res = await oauthFetch(`${BASE_URL}/device/auth`, {
		method: "POST",
		headers: hyperHeaders(),
		body: JSON.stringify({ device_name: deviceName() }),
		signal,
	});
	if (!res.ok) throw new Error(`Hyper device auth failed: HTTP ${res.status}`);
	const payload = await res.json();
	if (
		typeof payload?.device_code !== "string" ||
		typeof payload?.user_code !== "string" ||
		typeof payload?.verification_url !== "string" ||
		typeof payload?.expires_in !== "number"
	) {
		throw new Error("Hyper device auth response is invalid");
	}
	return payload;
}

async function pollDeviceAuth(
	auth: DeviceAuthResponse,
	signal?: AbortSignal,
): Promise<{ refresh_token: string; team_name?: string }> {
	const deadline = Date.now() + auth.expires_in * 1000;
	let intervalMs = Math.max(MIN_POLL_INTERVAL_MS, (auth.interval ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000);

	// Server-specified cadence starts after the first wait (device codes are
	// never ready immediately; polling sooner only earns slow_down responses).
	await abortableSleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);

	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error(CANCEL_MESSAGE);
		const res = await fetch(`${BASE_URL}/device/auth/${encodeURIComponent(auth.device_code)}`, {
			headers: hyperHeaders(),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
		});
		if (!res.ok) throw new Error(`Hyper device poll failed: HTTP ${res.status}`);
		const payload = await res.json();

		if (typeof payload?.refresh_token === "string") {
			return { refresh_token: payload.refresh_token, team_name: payload.team_name };
		}
		if (payload?.error === "authorization_pending") {
			// fall through to the interval sleep
		} else if (payload?.error === "slow_down") {
			intervalMs = Math.max(MIN_POLL_INTERVAL_MS, intervalMs + SLOW_DOWN_INCREMENT_MS);
		} else {
			throw new Error(`Hyper device authorization failed: ${payload?.error_description ?? payload?.error ?? "unknown error"}`);
		}

		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) break;
		await abortableSleep(Math.min(intervalMs, remainingMs), signal);
	}
	throw new Error(TIMEOUT_MESSAGE);
}

async function exchangeRefreshToken(refreshToken: string, signal?: AbortSignal): Promise<TokenExchangeResponse> {
	const res = await fetch(`${BASE_URL}/token/exchange`, {
		method: "POST",
		headers: hyperHeaders(),
		body: JSON.stringify({ refresh_token: refreshToken }),
		signal,
	});
	if (!res.ok) {
		const err = new Error(`Hyper token exchange failed: HTTP ${res.status}`);
		if (res.status === 401) {
			throw new Error("Your Hyper session is no longer valid. Run /login and re-authenticate with HyperCharm.", { cause: err });
		}
		throw err;
	}
	const payload = (await res.json()) as TokenExchangeResponse;
	if (typeof payload?.access_token !== "string") throw new Error("Hyper token exchange response is invalid");
	return payload;
}

function tokenExpiresAtMs(token: TokenExchangeResponse): number {
	const now = Date.now();
	const expiresAt = typeof token.expires_in === "number" ? now + token.expires_in * 1000 : Number(token.expires_at) * 1000;
	if (!Number.isFinite(expiresAt) || expiresAt <= now) {
		throw new Error("Hyper token exchange response contains an expired token expiry");
	}
	return expiresAt - Math.min(TOKEN_EXPIRY_BUFFER_MS, Math.floor((expiresAt - now) / 2));
}

function toCredentials(token: TokenExchangeResponse, fallbackRefresh: string, teamName?: string): OAuthCredentials {
	return {
		type: "oauth",
		refresh: token.refresh_token || fallbackRefresh,
		access: token.access_token,
		expires: tokenExpiresAtMs(token),
		...(teamName ? { teamName } : {}),
	};
}

/** Device-flow login for the "hypercharm" provider (/login flow). */
export async function loginHypercharm(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const deviceAuth = await initiateDeviceAuth(callbacks.signal);
	callbacks.onDeviceCode({
		userCode: deviceAuth.user_code,
		verificationUri: deviceAuth.verification_url,
		intervalSeconds: deviceAuth.interval,
		expiresInSeconds: deviceAuth.expires_in,
	});
	const devicePoll = await pollDeviceAuth(deviceAuth, callbacks.signal);
	const token = await exchangeRefreshToken(devicePoll.refresh_token, callbacks.signal);
	return toCredentials(token, devicePoll.refresh_token, devicePoll.team_name);
}

/** Refresh an expired HyperCharm OAuth credential via the token exchange endpoint. */
export async function refreshHypercharmToken(credential: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials> {
	const teamName = typeof credential.teamName === "string" && credential.teamName.trim() ? credential.teamName : undefined;
	return toCredentials(await exchangeRefreshToken(credential.refresh, signal), credential.refresh, teamName);
}
