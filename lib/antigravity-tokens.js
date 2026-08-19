/**
 * Google AI Pro / Antigravity OAuth refresh.
 * Depends on: lib/constants.js
 *
 * Google does not rotate this refresh token. Refresh stays in memory for the
 * quota request so we do not race shuvcode's stored credential.
 */

import {
	ANTIGRAVITY_OAUTH_REFRESH_BUFFER_MS,
	ANTIGRAVITY_TIMEOUT_MS,
	ANTIGRAVITY_TOKEN_URL,
	ANTIGRAVITY_USER_AGENT,
} from "./constants.js";

function antigravityOAuthClient() {
	const clientId = process.env.ANTIGRAVITY_CLIENT_ID;
	const clientSecret = process.env.ANTIGRAVITY_CLIENT_SECRET;
	if (!clientId || !clientSecret) {
		return { error: "Set ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET in ~/.shuvquota.env" };
	}
	return { clientId, clientSecret };
}

/**
 * @param {string | null | undefined} accessToken
 * @param {number | null | undefined} expiresAt
 * @param {number} [bufferMs]
 * @returns {boolean}
 */
export function isAntigravityTokenExpiring(
	accessToken,
	expiresAt,
	bufferMs = ANTIGRAVITY_OAUTH_REFRESH_BUFFER_MS,
) {
	if (typeof expiresAt === "number" && expiresAt > 0) {
		return expiresAt <= Date.now() + bufferMs;
	}
	return !accessToken;
}

/**
 * Refresh a Google AI Pro access token. The refresh token is kept when Google
 * omits a new one.
 * @param {string} refreshToken
 * @param {{ fetchFn?: typeof fetch, timeoutMs?: number, url?: string }} [options]
 * @returns {Promise<{ access: string, refresh: string, expires: number } | { error: string }>}
 */
export async function refreshAntigravityToken(refreshToken, options = {}) {
	if (!refreshToken) return { error: "No refresh token available" };
	const client = antigravityOAuthClient();
	if (client.error) return { error: client.error };

	const fetchFn = options.fetchFn ?? fetch;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? ANTIGRAVITY_TIMEOUT_MS);

	try {
		const response = await fetchFn(options.url ?? ANTIGRAVITY_TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"User-Agent": ANTIGRAVITY_USER_AGENT,
				Accept: "application/json",
			},
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: client.clientId,
				client_secret: client.clientSecret,
			}),
			signal: controller.signal,
		});
		const text = await response.text();
		if (!response.ok) {
			return {
				error: `Token refresh failed: HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
			};
		}
		let body;
		try {
			body = JSON.parse(text);
		} catch {
			return { error: "Token refresh failed: invalid JSON response" };
		}
		if (!body?.access_token) {
			return { error: "Token refresh failed: missing access_token in response" };
		}
		return {
			access: body.access_token,
			refresh: body.refresh_token || refreshToken,
			expires: Date.now() + Number(body.expires_in ?? 3600) * 1000,
		};
	} catch (error) {
		const message = error?.name === "AbortError"
			? "Token refresh timed out"
			: error?.message ?? String(error);
		return { error: message };
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Refresh the account in memory when the access token is near expiry.
 * @param {object} account
 * @param {{ fetchFn?: typeof fetch, timeoutMs?: number, now?: number }} [options]
 * @returns {Promise<{ ok: boolean, refreshed: boolean, error?: string }>}
 */
export async function ensureFreshAntigravityToken(account, options = {}) {
	if (!isAntigravityTokenExpiring(account?.access, account?.expires)) {
		return { ok: true, refreshed: false };
	}
	if (!account?.refresh) {
		return { ok: Boolean(account?.access), refreshed: false, error: "No refresh token available" };
	}
	const tokens = await refreshAntigravityToken(account.refresh, options);
	if (tokens.error) {
		return { ok: Boolean(account.access), refreshed: false, error: tokens.error };
	}
	account.access = tokens.access;
	account.refresh = tokens.refresh;
	account.expires = tokens.expires;
	return { ok: true, refreshed: true };
}
