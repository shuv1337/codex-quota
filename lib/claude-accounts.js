/**
 * Claude account loading, session/OAuth resolution.
 * Depends on: lib/constants.js, lib/container.js, lib/paths.js
 */

import { existsSync, readFileSync } from "node:fs";
import { CLAUDE_CREDENTIALS_PATH, CLAUDE_MULTI_ACCOUNT_PATHS } from "./constants.js";
import { readMultiAccountContainer, writeMultiAccountContainer } from "./container.js";
import { getOpencodeAuthPath } from "./paths.js";

export function isClaudeSessionKey(value) {
	return typeof value === "string" && value.startsWith("sk-ant-");
}

export function findClaudeSessionKey(value) {
	if (isClaudeSessionKey(value)) return value;
	if (typeof value === "string") {
		const match = value.match(/sk-ant-[a-z0-9_-]+/i);
		if (match) return match[0];
	}
	if (!value || typeof value !== "object") return null;

	const direct = value.sessionKey
		?? value.session_key
		?? value.token
		?? value.sessionToken
		?? value.accessToken
		?? value.access_token
		?? value.oauthAccessToken;
	if (isClaudeSessionKey(direct)) return direct;

	for (const child of Object.values(value)) {
		const found = findClaudeSessionKey(child);
		if (found) return found;
	}
	return null;
}

export function normalizeClaudeAccount(raw, source) {
	if (!raw || typeof raw !== "object") return null;
	const label = raw.label ?? null;
	const sessionKey = raw.sessionKey ?? raw.session_key ?? null;
	const oauthToken = raw.oauthToken ?? raw.oauth_token ?? raw.accessToken ?? raw.access_token ?? null;
	const cfClearance = raw.cfClearance ?? raw.cf_clearance ?? null;
	const orgId = raw.orgId ?? raw.org_id ?? null;
	const cookies = raw.cookies && typeof raw.cookies === "object" ? raw.cookies : null;
	const oauthRefreshToken = raw.oauthRefreshToken ?? raw.oauth_refresh_token ?? null;
	const oauthExpiresAt = raw.oauthExpiresAt ?? raw.oauth_expires_at ?? null;
	const oauthScopes = raw.oauthScopes ?? raw.oauth_scopes ?? null;
	return {
		label,
		sessionKey,
		oauthToken,
		cfClearance,
		orgId,
		cookies,
		oauthRefreshToken,
		oauthExpiresAt,
		oauthScopes,
		source,
	};
}

export function isValidClaudeAccount(account) {
	if (!account?.label) return false;
	const sessionKey = account.sessionKey ?? findClaudeSessionKey(account.cookies);
	const oauthToken = account.oauthToken ?? null;
	return Boolean(sessionKey || oauthToken);
}

export function loadClaudeAccountsFromEnv() {
	const envAccounts = process.env.CLAUDE_ACCOUNTS;
	if (!envAccounts) return [];

	try {
		const parsed = JSON.parse(envAccounts);
		const accounts = Array.isArray(parsed) ? parsed : parsed?.accounts ?? [];
		return accounts
			.map(a => normalizeClaudeAccount(a, "env"))
			.filter(a => a && isValidClaudeAccount(a));
	} catch {
		console.error("Warning: CLAUDE_ACCOUNTS env var is not valid JSON");
		return [];
	}
}

export function loadClaudeAccountsFromFile(filePath) {
	const container = readMultiAccountContainer(filePath);
	if (!container.exists) return [];
	return container.accounts
		.map(a => normalizeClaudeAccount(a, filePath))
		.filter(a => a && isValidClaudeAccount(a));
}

export function loadClaudeAccounts() {
	const all = [];
	all.push(...loadClaudeAccountsFromEnv());
	for (const path of CLAUDE_MULTI_ACCOUNT_PATHS) {
		all.push(...loadClaudeAccountsFromFile(path));
	}
	return all;
}

/**
 * Resolve the multi-account file that stores activeLabel for Claude.
 * @returns {string}
 */
export function resolveClaudeActiveStorePath() {
	const firstPath = CLAUDE_MULTI_ACCOUNT_PATHS[0];
	if (firstPath && existsSync(firstPath)) return firstPath;
	return firstPath;
}

/**
 * Read the active-label store container for Claude.
 * @returns {{ path: string, container: ReturnType<typeof readMultiAccountContainer> }}
 */
export function readClaudeActiveStoreContainer() {
	const path = resolveClaudeActiveStorePath();
	const container = readMultiAccountContainer(path);
	return { path, container };
}

/**
 * Get the activeLabel stored for Claude (if any).
 * @returns {{ activeLabel: string | null, path: string, schemaVersion: number }}
 */
export function getClaudeActiveLabelInfo() {
	const { path, container } = readClaudeActiveStoreContainer();
	return {
		activeLabel: container.activeLabel ?? null,
		path,
		schemaVersion: container.schemaVersion ?? 0,
	};
}

export function saveClaudeAccounts(accounts) {
	const targetPath = resolveClaudeActiveStorePath();
	const container = readMultiAccountContainer(targetPath);
	const filtered = accounts.filter(account => !(account?.source && account.source.startsWith("env")));
	const sanitized = filtered.map(account => {
		if (!account || typeof account !== "object") return account;
		const { source, ...rest } = account;
		return rest;
	});
	const result = writeMultiAccountContainer(targetPath, container, sanitized, {}, { mode: 0o600 });
	return result.path;
}

export function loadClaudeSessionFromCredentials() {
	const credentialsPath = process.env.CLAUDE_CREDENTIALS_PATH || CLAUDE_CREDENTIALS_PATH;
	if (!existsSync(credentialsPath)) {
		return {
			sessionKey: null,
			source: credentialsPath,
			error: `Claude credentials not found at ${credentialsPath}`,
		};
	}

	try {
		const raw = readFileSync(credentialsPath, "utf-8");
		const parsed = JSON.parse(raw);
		const sessionKey = findClaudeSessionKey(parsed);
		if (!sessionKey) {
			return {
				sessionKey: null,
				source: credentialsPath,
				error: "No Claude sessionKey found in credentials file",
			};
		}
		return { sessionKey, source: credentialsPath };
	} catch (err) {
		return {
			sessionKey: null,
			source: credentialsPath,
			error: `Failed to read Claude credentials: ${err?.message ?? String(err)}`,
		};
	}
}

export function loadClaudeOAuthToken() {
	const credentialsPath = process.env.CLAUDE_CREDENTIALS_PATH || CLAUDE_CREDENTIALS_PATH;
	if (!existsSync(credentialsPath)) {
		return { token: null, source: credentialsPath, error: `Claude credentials not found at ${credentialsPath}` };
	}

	try {
		const raw = readFileSync(credentialsPath, "utf-8");
		const parsed = JSON.parse(raw);
		const token =
			parsed?.claudeAiOauth?.accessToken
			?? parsed?.claude_ai_oauth?.accessToken
			?? parsed?.accessToken
			?? parsed?.access_token
			?? null;
		if (!token) {
			return { token: null, source: credentialsPath, error: "No Claude OAuth accessToken found" };
		}
		return { token, source: credentialsPath };
	} catch (err) {
		return {
			token: null,
			source: credentialsPath,
			error: `Failed to read Claude credentials: ${err?.message ?? String(err)}`,
		};
	}
}

/**
 * Find a Claude account by label from supported sources
 * @param {string} label
 * @returns {object | null}
 */
export function findClaudeAccountByLabel(label) {
	const accounts = loadClaudeAccounts();
	return accounts.find(account => account.label === label) ?? null;
}

/**
 * Get all Claude labels from supported sources
 * @returns {string[]}
 */
export function getClaudeLabels() {
	const accounts = loadClaudeAccounts();
	return [...new Set(accounts.map(account => account.label))];
}
