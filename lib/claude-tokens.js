/**
 * Claude token refresh and multi-store persistence.
 * Depends on: lib/constants.js, lib/paths.js, lib/token-match.js, lib/container.js, lib/fs.js
 */

import { existsSync, readFileSync } from "node:fs";
import {
	CLAUDE_CREDENTIALS_PATH,
	CLAUDE_MULTI_ACCOUNT_PATHS,
	CLAUDE_OAUTH_TOKEN_URL,
	CLAUDE_OAUTH_CLIENT_ID,
	CLAUDE_OAUTH_REFRESH_BUFFER_MS,
	OAUTH_TIMEOUT_MS,
} from "./constants.js";
import { getOpencodeAuthPath, getPiAuthPath } from "./paths.js";
import { isOauthTokenMatch, normalizeEntryTokens, CLAUDE_TOKEN_FIELDS } from "./token-match.js";
import { readMultiAccountContainer, writeMultiAccountContainer, mapContainerAccounts } from "./container.js";
import { writeFileAtomic } from "./fs.js";

// Internal helpers using the shared token-match generics
function isClaudeOauthTokenMatch(params) {
	return isOauthTokenMatch(params);
}

function normalizeClaudeOauthEntryTokens(entry) {
	return normalizeEntryTokens(entry, CLAUDE_TOKEN_FIELDS);
}

function updateClaudeOauthEntry(entry, account) {
	const accessKey = "oauthToken" in entry
		? "oauthToken"
		: "oauth_token" in entry
			? "oauth_token"
			: "accessToken" in entry
				? "accessToken"
				: "access_token" in entry
					? "access_token"
					: "oauthToken";
	const refreshKey = "oauthRefreshToken" in entry
		? "oauthRefreshToken"
		: "oauth_refresh_token" in entry
			? "oauth_refresh_token"
			: "refreshToken" in entry
				? "refreshToken"
				: "refresh_token" in entry
					? "refresh_token"
					: "oauthRefreshToken";
	const expiresKey = "oauthExpiresAt" in entry
		? "oauthExpiresAt"
		: "oauth_expires_at" in entry
			? "oauth_expires_at"
			: "expiresAt" in entry
				? "expiresAt"
				: "expires_at" in entry
					? "expires_at"
					: "oauthExpiresAt";
	const scopesKey = "oauthScopes" in entry
		? "oauthScopes"
		: "oauth_scopes" in entry
			? "oauth_scopes"
			: "scopes" in entry
				? "scopes"
				: "oauthScopes";

	entry[accessKey] = account.accessToken;
	entry[refreshKey] = account.refreshToken ?? null;
	entry[expiresKey] = account.expiresAt ?? null;
	if (account.scopes) {
		entry[scopesKey] = account.scopes;
	}

	return entry;
}

/**
 * Update Claude Code credentials with new OAuth tokens
 * @param {{ oauthToken: string, oauthRefreshToken?: string | null, oauthExpiresAt?: number | null, oauthScopes?: string[] | null }} account
 * @returns {{ updated: boolean, path: string, error?: string }}
 */
export function updateClaudeCredentials(account) {
	const credentialsPath = process.env.CLAUDE_CREDENTIALS_PATH || CLAUDE_CREDENTIALS_PATH;
	let existing = {};
	if (existsSync(credentialsPath)) {
		try {
			const raw = readFileSync(credentialsPath, "utf-8");
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return { updated: false, path: credentialsPath, error: "Invalid Claude credentials format" };
			}
			existing = parsed;
		} catch (err) {
			const message = err?.message ?? String(err);
			return { updated: false, path: credentialsPath, error: `Failed to read Claude credentials: ${message}` };
		}
	}

	const updatedOauth = {
		accessToken: account.oauthToken,
		refreshToken: account.oauthRefreshToken ?? null,
		expiresAt: account.oauthExpiresAt ?? null,
		scopes: account.oauthScopes ?? null,
	};

	const updatedCredentials = {
		...existing,
		claudeAiOauth: updatedOauth,
	};
	if ("claude_ai_oauth" in updatedCredentials) {
		delete updatedCredentials.claude_ai_oauth;
	}

	try {
		writeFileAtomic(credentialsPath, JSON.stringify(updatedCredentials, null, 2) + "\n", { mode: 0o600 });
	} catch (err) {
		const message = err?.message ?? String(err);
		return { updated: false, path: credentialsPath, error: `Failed to write Claude credentials: ${message}` };
	}

	return { updated: true, path: credentialsPath };
}

/**
 * Update OpenCode auth.json with new Claude OAuth tokens
 * @param {{ oauthToken: string, oauthRefreshToken?: string | null, oauthExpiresAt?: number | null, oauthScopes?: string[] | null }} account
 * @returns {{ updated: boolean, path: string, error?: string, skipped?: boolean }}
 */
export function updateOpencodeClaudeAuth(account) {
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

	const anthropicEntry = existingAuth.anthropic;
	const anthropicAuth = anthropicEntry && typeof anthropicEntry === "object" ? anthropicEntry : {};
	const updatedAuth = {
		...existingAuth,
		anthropic: {
			...anthropicAuth,
			type: "oauth",
			access: account.oauthToken,
			refresh: account.oauthRefreshToken ?? null,
			expires: account.oauthExpiresAt ?? null,
			scopes: account.oauthScopes ?? null,
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
 * Update pi auth.json with new Claude OAuth tokens
 * @param {{ oauthToken: string, oauthRefreshToken?: string | null, oauthExpiresAt?: number | null, oauthScopes?: string[] | null }} account
 * @returns {{ updated: boolean, path: string, error?: string, skipped?: boolean }}
 */
export function updatePiClaudeAuth(account) {
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

	const anthropicEntry = existingAuth.anthropic;
	const anthropicAuth = anthropicEntry && typeof anthropicEntry === "object" ? anthropicEntry : {};
	const updatedAuth = {
		...existingAuth,
		anthropic: {
			...anthropicAuth,
			type: "oauth",
			access: account.oauthToken,
			refresh: account.oauthRefreshToken ?? null,
			expires: account.oauthExpiresAt ?? null,
			scopes: account.oauthScopes ?? null,
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
 * Persist refreshed Claude OAuth tokens to all known stores that match.
 * @param {{ label: string, accessToken: string, refreshToken?: string | null, expiresAt?: number | null, scopes?: string[] | null, source?: string }} account
 * @param {{ previousAccessToken?: string | null, previousRefreshToken?: string | null }} previousTokens
 * @returns {{ updatedPaths: string[], errors: string[] }}
 */
export function persistClaudeOAuthTokens(account, previousTokens = {}) {
	const updatedPaths = [];
	const errors = [];
	const previousAccess = previousTokens.previousAccessToken ?? null;
	const previousRefresh = previousTokens.previousRefreshToken ?? null;

	const updatePayload = {
		oauthToken: account.accessToken,
		oauthRefreshToken: account.refreshToken ?? null,
		oauthExpiresAt: account.expiresAt ?? null,
		oauthScopes: account.scopes ?? null,
	};

	if (!account.source?.startsWith("env")) {
		const credentialsPath = process.env.CLAUDE_CREDENTIALS_PATH || CLAUDE_CREDENTIALS_PATH;
		if (existsSync(credentialsPath)) {
			try {
				const raw = readFileSync(credentialsPath, "utf-8");
				const parsed = JSON.parse(raw);
				const oauth = parsed?.claudeAiOauth ?? parsed?.claude_ai_oauth ?? null;
				const stored = normalizeClaudeOauthEntryTokens(oauth ?? {});
				if (isClaudeOauthTokenMatch({
					storedAccess: stored.access,
					storedRefresh: stored.refresh,
					previousAccess,
					previousRefresh,
					label: account.label,
					storedLabel: "claude-code",
				})) {
					const scopes = account.scopes ?? stored.scopes ?? null;
					const result = updateClaudeCredentials({
						...updatePayload,
						oauthScopes: scopes,
					});
					if (result.updated) updatedPaths.push(result.path);
					if (result.error) errors.push(result.error);
				}
			} catch {
				// ignore parse errors, handled by updateClaudeCredentials
			}
		}

		const opencodePath = getOpencodeAuthPath();
		if (existsSync(opencodePath)) {
			try {
				const raw = readFileSync(opencodePath, "utf-8");
				const parsed = JSON.parse(raw);
				const anthropic = parsed?.anthropic ?? null;
				const storedAccess = anthropic?.access ?? null;
				const storedRefresh = anthropic?.refresh ?? null;
				if (isClaudeOauthTokenMatch({
					storedAccess,
					storedRefresh,
					previousAccess,
					previousRefresh,
					label: account.label,
					storedLabel: "opencode",
				})) {
					const result = updateOpencodeClaudeAuth(updatePayload);
					if (result.updated) updatedPaths.push(result.path);
					if (result.error) errors.push(result.error);
				}
			} catch {
				// ignore
			}
		}

		const piPath = getPiAuthPath();
		if (existsSync(piPath)) {
			try {
				const raw = readFileSync(piPath, "utf-8");
				const parsed = JSON.parse(raw);
				const anthropic = parsed?.anthropic ?? null;
				const storedAccess = anthropic?.access ?? null;
				const storedRefresh = anthropic?.refresh ?? null;
				if (isClaudeOauthTokenMatch({
					storedAccess,
					storedRefresh,
					previousAccess,
					previousRefresh,
					label: account.label,
					storedLabel: "pi",
				})) {
					const result = updatePiClaudeAuth(updatePayload);
					if (result.updated) updatedPaths.push(result.path);
					if (result.error) errors.push(result.error);
				}
			} catch {
				// ignore
			}
		}

		for (const path of CLAUDE_MULTI_ACCOUNT_PATHS) {
			if (!existsSync(path)) continue;
			try {
				const container = readMultiAccountContainer(path);
				if (container.rootType === "invalid") {
					errors.push(`Failed to parse ${path}`);
					continue;
				}
				const mapped = mapContainerAccounts(container, (entry) => {
					if (!entry || typeof entry !== "object") return entry;
					const stored = normalizeClaudeOauthEntryTokens(entry);
					const matches = isClaudeOauthTokenMatch({
						storedAccess: stored.access,
						storedRefresh: stored.refresh,
						previousAccess,
						previousRefresh,
						label: account.label,
						storedLabel: entry?.label ?? null,
					});
					if (!matches) return entry;
					const scopes = account.scopes ?? stored.scopes ?? null;
					return updateClaudeOauthEntry({ ...entry }, { ...account, scopes });
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
	}

	return { updatedPaths, errors };
}

/**
 * Refresh a Claude OAuth token using the refresh token
 * @param {string} refreshTokenValue - The refresh token
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresIn: number }>}
 */
export async function refreshClaudeToken(refreshTokenValue) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), OAUTH_TIMEOUT_MS);

	try {
		const body = {
			grant_type: "refresh_token",
			refresh_token: refreshTokenValue,
			client_id: CLAUDE_OAUTH_CLIENT_ID,
		};

		const response = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Token refresh failed: ${response.status} ${text}`);
		}

		const data = await response.json();

		return {
			accessToken: data.access_token,
			refreshToken: data.refresh_token || refreshTokenValue,
			expiresIn: data.expires_in || 3600,
		};
	} finally {
		clearTimeout(timeout);
	}
}

export function isClaudeOauthTokenExpiring(expiresAt) {
	if (!expiresAt) return false;
	return expiresAt <= Date.now() + CLAUDE_OAUTH_REFRESH_BUFFER_MS;
}

function resolveClaudeOauthAccountFields(account) {
	const usesOauthShape = Boolean(
		account
		&& typeof account === "object"
		&& (
			"oauthToken" in account
			|| "oauthRefreshToken" in account
			|| "oauthExpiresAt" in account
			|| "oauthScopes" in account
		)
	);
	const accessToken = usesOauthShape ? account.oauthToken : account.accessToken;
	const refreshToken = usesOauthShape ? account.oauthRefreshToken : account.refreshToken;
	const expiresAt = usesOauthShape ? account.oauthExpiresAt : account.expiresAt;
	const scopes = usesOauthShape ? account.oauthScopes : account.scopes;
	return { usesOauthShape, accessToken, refreshToken, expiresAt, scopes };
}

/**
 * Ensure a Claude OAuth access token is fresh, refreshing and persisting if needed.
 * @param {{ label: string, accessToken?: string, refreshToken?: string | null, expiresAt?: number | null, scopes?: string[] | null, oauthToken?: string, oauthRefreshToken?: string | null, oauthExpiresAt?: number | null, oauthScopes?: string[] | null, source?: string }} account
 * @returns {Promise<boolean>}
 */
export async function ensureFreshClaudeOAuthToken(account) {
	const fields = resolveClaudeOauthAccountFields(account);
	if (!isClaudeOauthTokenExpiring(fields.expiresAt)) return true;
	if (!fields.refreshToken) return false;

	const previousAccessToken = fields.accessToken;
	const previousRefreshToken = fields.refreshToken;

	try {
		const refreshed = await refreshClaudeToken(fields.refreshToken);
		if (!refreshed?.accessToken) return false;
		const updatedAccessToken = refreshed.accessToken;
		const updatedRefreshToken = refreshed.refreshToken ?? fields.refreshToken;
		const updatedExpiresAt = Date.now() + refreshed.expiresIn * 1000;
		if (fields.usesOauthShape) {
			account.oauthToken = updatedAccessToken;
			account.oauthRefreshToken = updatedRefreshToken;
			account.oauthExpiresAt = updatedExpiresAt;
			if (fields.scopes && !account.oauthScopes) {
				account.oauthScopes = fields.scopes;
			}
		} else {
			account.accessToken = updatedAccessToken;
			account.refreshToken = updatedRefreshToken;
			account.expiresAt = updatedExpiresAt;
			if (fields.scopes && !account.scopes) {
				account.scopes = fields.scopes;
			}
		}
		persistClaudeOAuthTokens({
			label: account.label,
			accessToken: updatedAccessToken,
			refreshToken: updatedRefreshToken,
			expiresAt: updatedExpiresAt,
			scopes: fields.scopes ?? null,
			source: account.source,
		}, {
			previousAccessToken,
			previousRefreshToken,
		});
		return true;
	} catch {
		return false;
	}
}

// Re-export internal helpers that other modules need
export { normalizeClaudeOauthEntryTokens, updateClaudeOauthEntry };
