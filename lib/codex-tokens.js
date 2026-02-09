/**
 * OpenAI token refresh and multi-store persistence.
 * Depends on: lib/constants.js, lib/paths.js, lib/jwt.js, lib/token-match.js, lib/container.js, lib/fs.js
 */

import { existsSync, readFileSync } from "node:fs";
import { TOKEN_URL, CLIENT_ID, MULTI_ACCOUNT_PATHS, OPENAI_OAUTH_REFRESH_BUFFER_MS } from "./constants.js";
import { getOpencodeAuthPath, getCodexCliAuthPath, getPiAuthPath } from "./paths.js";
import { extractAccountId } from "./jwt.js";
import { isOauthTokenMatch, normalizeEntryTokens, updateEntryTokens, OPENAI_TOKEN_FIELDS } from "./token-match.js";
import { readMultiAccountContainer, writeMultiAccountContainer, mapContainerAccounts } from "./container.js";
import { writeFileAtomic } from "./fs.js";

// Keep the original function names as internal helpers for backward compat
function isOpenAiOauthTokenMatch(params) {
	return isOauthTokenMatch(params);
}

function normalizeOpenAiOauthEntryTokens(entry) {
	return normalizeEntryTokens(entry, OPENAI_TOKEN_FIELDS);
}

function updateOpenAiOauthEntry(entry, account) {
	const fields = {
		access: account.access,
		refresh: account.refresh,
		expires: account.expires ?? null,
		accountId: account.accountId,
	};
	// Only include idToken when truthy (matches original behavior)
	if (account.idToken) {
		fields.idToken = account.idToken;
	}
	return updateEntryTokens(entry, fields, OPENAI_TOKEN_FIELDS);
}

/**
 * Update OpenCode auth.json with new OpenAI OAuth tokens
 * @param {{ access: string, refresh: string, expires?: number, accountId: string }} account
 * @returns {{ updated: boolean, path: string, error?: string, skipped?: boolean }}
 */
export function updateOpencodeAuth(account) {
	const authPath = getOpencodeAuthPath();
	if (!existsSync(authPath)) {
		return { updated: false, path: authPath, skipped: true };
	}

	let existingAuth = {};
	try {
		const raw = readFileSync(authPath, "utf-8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { updated: false, path: authPath, error: "Invalid OpenCode auth.json format" };
		}
		existingAuth = parsed;
	} catch (err) {
		const message = err?.message ?? String(err);
		return { updated: false, path: authPath, error: `Failed to read OpenCode auth.json: ${message}` };
	}

	const openaiEntry = existingAuth.openai;
	const openaiAuth = openaiEntry && typeof openaiEntry === "object" ? openaiEntry : {};
	const expires = account.expires ?? Date.now() - 1000;
	const updatedAuth = {
		...existingAuth,
		openai: {
			...openaiAuth,
			type: "oauth",
			access: account.access,
			refresh: account.refresh,
			expires: expires,
			accountId: account.accountId,
		},
	};

	try {
		writeFileAtomic(authPath, JSON.stringify(updatedAuth, null, 2) + "\n", { mode: 0o600 });
	} catch (err) {
		const message = err?.message ?? String(err);
		return { updated: false, path: authPath, error: `Failed to write OpenCode auth.json: ${message}` };
	}

	return { updated: true, path: authPath };
}

/**
 * Update pi auth.json with new OpenAI Codex OAuth tokens
 * @param {{ access: string, refresh: string, expires?: number, accountId: string }} account
 * @returns {{ updated: boolean, path: string, error?: string, skipped?: boolean }}
 */
export function updatePiAuth(account) {
	const authPath = getPiAuthPath();
	if (!existsSync(authPath)) {
		return { updated: false, path: authPath, skipped: true };
	}

	let existingAuth = {};
	try {
		const raw = readFileSync(authPath, "utf-8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { updated: false, path: authPath, error: "Invalid pi auth.json format" };
		}
		existingAuth = parsed;
	} catch (err) {
		const message = err?.message ?? String(err);
		return { updated: false, path: authPath, error: `Failed to read pi auth.json: ${message}` };
	}

	const codexEntry = existingAuth["openai-codex"];
	const codexAuth = codexEntry && typeof codexEntry === "object" ? codexEntry : {};
	const expires = account.expires ?? Date.now() - 1000;
	const updatedAuth = {
		...existingAuth,
		"openai-codex": {
			...codexAuth,
			type: "oauth",
			access: account.access,
			refresh: account.refresh,
			expires: expires,
			accountId: account.accountId,
		},
	};

	try {
		writeFileAtomic(authPath, JSON.stringify(updatedAuth, null, 2) + "\n", { mode: 0o600 });
	} catch (err) {
		const message = err?.message ?? String(err);
		return { updated: false, path: authPath, error: `Failed to write pi auth.json: ${message}` };
	}

	return { updated: true, path: authPath };
}

/**
 * Persist refreshed OpenAI OAuth tokens to all known stores that match.
 * @param {{ label: string, access: string, refresh: string, expires?: number, accountId: string, idToken?: string, source?: string }} account
 * @param {{ previousAccessToken?: string | null, previousRefreshToken?: string | null }} previousTokens
 * @returns {{ updatedPaths: string[], errors: string[] }}
 */
export function persistOpenAiOAuthTokens(account, previousTokens = {}) {
	const updatedPaths = [];
	const errors = [];
	const previousAccess = previousTokens.previousAccessToken ?? null;
	const previousRefresh = previousTokens.previousRefreshToken ?? null;

	if (account.source?.startsWith("env")) {
		return { updatedPaths, errors };
	}

	const codexAuthPath = getCodexCliAuthPath();
	if (existsSync(codexAuthPath)) {
		try {
			const raw = readFileSync(codexAuthPath, "utf-8");
			const parsed = JSON.parse(raw);
			const tokens = parsed?.tokens;
			if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
				errors.push(`Invalid Codex auth.json format at ${codexAuthPath}`);
			} else {
				const storedAccess = tokens.access_token ?? null;
				const storedRefresh = tokens.refresh_token ?? null;
				if (isOpenAiOauthTokenMatch({
					storedAccess,
					storedRefresh,
					previousAccess,
					previousRefresh,
					label: account.label,
					storedLabel: parsed?.codex_quota_label ?? null,
				})) {
					const updatedTokens = {
						...tokens,
						access_token: account.access,
						refresh_token: account.refresh,
						account_id: account.accountId,
					};
					if (account.expires) {
						updatedTokens.expires_at = Math.floor(account.expires / 1000);
					}
					if (account.idToken) {
						updatedTokens.id_token = account.idToken;
					}
					const updatedPayload = { ...parsed, tokens: updatedTokens };
					writeFileAtomic(codexAuthPath, JSON.stringify(updatedPayload, null, 2) + "\n", { mode: 0o600 });
					updatedPaths.push(codexAuthPath);
				}
			}
		} catch (err) {
			const message = err?.message ?? String(err);
			errors.push(`Failed to update ${codexAuthPath}: ${message}`);
		}
	}

	const opencodePath = getOpencodeAuthPath();
	if (existsSync(opencodePath)) {
		try {
			const raw = readFileSync(opencodePath, "utf-8");
			const parsed = JSON.parse(raw);
			const openai = parsed?.openai ?? null;
			const storedAccess = openai?.access ?? null;
			const storedRefresh = openai?.refresh ?? null;
			if (isOpenAiOauthTokenMatch({
				storedAccess,
				storedRefresh,
				previousAccess,
				previousRefresh,
				label: account.label,
				storedLabel: "opencode",
			})) {
				const result = updateOpencodeAuth(account);
				if (result.updated) updatedPaths.push(result.path);
				if (result.error) errors.push(result.error);
			}
		} catch {
			// ignore parse errors, handled by updateOpencodeAuth
		}
	}

	const piPath = getPiAuthPath();
	if (existsSync(piPath)) {
		try {
			const raw = readFileSync(piPath, "utf-8");
			const parsed = JSON.parse(raw);
			const codex = parsed?.["openai-codex"] ?? null;
			const storedAccess = codex?.access ?? null;
			const storedRefresh = codex?.refresh ?? null;
			if (isOpenAiOauthTokenMatch({
				storedAccess,
				storedRefresh,
				previousAccess,
				previousRefresh,
				label: account.label,
				storedLabel: "pi",
			})) {
				const result = updatePiAuth(account);
				if (result.updated) updatedPaths.push(result.path);
				if (result.error) errors.push(result.error);
			}
		} catch {
			// ignore parse errors, handled by updatePiAuth
		}
	}

	for (const path of MULTI_ACCOUNT_PATHS) {
		if (!existsSync(path)) continue;
		try {
			const container = readMultiAccountContainer(path);
			if (container.rootType === "invalid") {
				errors.push(`Failed to parse ${path}`);
				continue;
			}
			const mapped = mapContainerAccounts(container, (entry) => {
				if (!entry || typeof entry !== "object") return entry;
				const stored = normalizeOpenAiOauthEntryTokens(entry);
				const matches = isOpenAiOauthTokenMatch({
					storedAccess: stored.access,
					storedRefresh: stored.refresh,
					previousAccess,
					previousRefresh,
					label: account.label,
					storedLabel: entry?.label ?? null,
				});
				if (!matches) return entry;
				return updateOpenAiOauthEntry({ ...entry }, account);
			});

			if (mapped.updated) {
				writeMultiAccountContainer(path, container, mapped.accounts, {}, { mode: 0o600 });
				updatedPaths.push(path);
			}
		} catch (err) {
			const message = err?.message ?? String(err);
			errors.push(`Failed to update ${path}: ${message}`);
		}
	}

	return { updatedPaths, errors };
}

export async function refreshToken(refreshTokenValue) {
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshTokenValue,
			client_id: CLIENT_ID,
		}),
	});
	if (!res.ok) return null;
	const json = await res.json();
	if (!json?.access_token || !json?.refresh_token || typeof json?.expires_in !== "number") {
		return null;
	}
	return {
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
	};
}

export function isOpenAiOauthTokenExpiring(expires) {
	if (!expires) return true;
	return expires <= Date.now() + OPENAI_OAUTH_REFRESH_BUFFER_MS;
}

export async function ensureFreshToken(account, allAccounts) {
	if (!isOpenAiOauthTokenExpiring(account.expires)) return true;
	const previousAccessToken = account.access;
	const previousRefreshToken = account.refresh;
	const refreshed = await refreshToken(account.refresh);
	if (!refreshed) return false;

	// Update accountId from new token (in case it changed)
	const newAccountId = extractAccountId(refreshed.access);
	if (newAccountId) account.accountId = newAccountId;

	account.access = refreshed.access;
	account.refresh = refreshed.refresh;
	account.expires = refreshed.expires;
	account.updatedAt = Date.now();
	persistOpenAiOAuthTokens(account, {
		previousAccessToken,
		previousRefreshToken,
	});
	return true;
}
