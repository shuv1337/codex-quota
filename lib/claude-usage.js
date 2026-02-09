/**
 * Claude usage API fetch (session + OAuth).
 * Depends on: lib/constants.js, lib/paths.js, lib/claude-accounts.js, lib/claude-tokens.js
 */

import { existsSync, readFileSync, copyFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes, pbkdf2Sync, createDecipheriv } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLAUDE_CREDENTIALS_PATH,
	CLAUDE_MULTI_ACCOUNT_PATHS,
	CLAUDE_API_BASE,
	CLAUDE_ORIGIN,
	CLAUDE_ORGS_URL,
	CLAUDE_ACCOUNT_URL,
	CLAUDE_TIMEOUT_MS,
	CLAUDE_USER_AGENT,
	CLAUDE_OAUTH_USAGE_URL,
	CLAUDE_OAUTH_VERSION,
	CLAUDE_OAUTH_BETA,
} from "./constants.js";
import { getOpencodeAuthPath } from "./paths.js";
import {
	findClaudeSessionKey,
	loadClaudeAccountsFromFile,
	loadClaudeSessionFromCredentials,
	loadClaudeOAuthToken,
} from "./claude-accounts.js";
import { ensureFreshClaudeOAuthToken } from "./claude-tokens.js";

export function normalizeClaudeOrgId(orgId) {
	if (!orgId || typeof orgId !== "string") return orgId;
	if (/^[0-9a-f-]{36}$/i.test(orgId)) {
		return orgId.replace(/-/g, "");
	}
	return orgId;
}

export function isClaudeAuthError(error) {
	if (!error) return false;
	return /account_session_invalid|invalid authorization|http 401|http 403/i.test(String(error));
}

export function loadClaudeOAuthFromClaudeCode() {
	const credentialsPath = process.env.CLAUDE_CREDENTIALS_PATH || CLAUDE_CREDENTIALS_PATH;
	if (!existsSync(credentialsPath)) return [];

	try {
		const raw = readFileSync(credentialsPath, "utf-8");
		const parsed = JSON.parse(raw);
		const oauth = parsed?.claudeAiOauth ?? parsed?.claude_ai_oauth;

		if (!oauth?.accessToken) return [];

		// Check if token has user:profile scope (required for usage API)
		const scopes = oauth.scopes ?? [];
		if (!scopes.includes("user:profile")) {
			return [];
		}

		return [{
			label: "claude-code",
			accessToken: oauth.accessToken,
			refreshToken: oauth.refreshToken,
			expiresAt: oauth.expiresAt,
			subscriptionType: oauth.subscriptionType,
			rateLimitTier: oauth.rateLimitTier,
			scopes,
			source: credentialsPath,
		}];
	} catch {
		return [];
	}
}

/**
 * Load Claude OAuth account from OpenCode auth.json
 * @returns {Array<{ label: string, accessToken: string, refreshToken?: string, expiresAt?: number, source: string }>}
 */
export function loadClaudeOAuthFromOpenCode() {
	const authPath = getOpencodeAuthPath();
	if (!existsSync(authPath)) return [];

	try {
		const raw = readFileSync(authPath, "utf-8");
		const parsed = JSON.parse(raw);
		const anthropic = parsed?.anthropic;

		if (!anthropic?.access) return [];

		return [{
			label: "opencode",
			accessToken: anthropic.access,
			refreshToken: anthropic.refresh,
			expiresAt: anthropic.expires,
			source: authPath,
		}];
	} catch {
		return [];
	}
}

/**
 * Load Claude OAuth accounts from environment variable
 * Format: JSON array with { label, accessToken, refreshToken?, ... }
 * @returns {Array<{ label: string, accessToken: string, ... }>}
 */
export function loadClaudeOAuthFromEnv() {
	const envAccounts = process.env.CLAUDE_OAUTH_ACCOUNTS;
	if (!envAccounts) return [];

	try {
		const parsed = JSON.parse(envAccounts);
		const accounts = Array.isArray(parsed) ? parsed : parsed?.accounts ?? [];
		return accounts
			.filter(a => a?.label && a?.accessToken)
			.map(a => ({ ...a, source: "env:CLAUDE_OAUTH_ACCOUNTS" }));
	} catch {
		return [];
	}
}

/**
 * Deduplicate Claude OAuth accounts by refresh token
 * This handles the case where the same Claude account is sourced from multiple files
 * (e.g., claude-code and opencode both storing the same credentials)
 * 
 * We use refreshToken because:
 * - Access tokens change on refresh, but refresh tokens stay constant
 * - Two entries with same refresh token are the same underlying account
 * @param {Array<{accessToken: string, refreshToken?: string, ...}>} accounts - Array of accounts
 * @returns {Array<{accessToken: string, ...}>} Deduplicated accounts
 */
export function deduplicateClaudeOAuthAccounts(accounts) {
	const seenTokens = new Set();
	return accounts.filter(account => {
		if (!account.accessToken) return true; // Keep accounts without token (shouldn't happen)
		// Use refresh token if available (stays constant), otherwise fall back to access token
		const tokenKey = account.refreshToken 
			? account.refreshToken.substring(0, 50)
			: account.accessToken.substring(0, 50);
		if (seenTokens.has(tokenKey)) return false;
		seenTokens.add(tokenKey);
		return true;
	});
}

/**
 * Deduplicate Claude usage results by comparing usage fingerprints
 * This catches cases where the same account has different OAuth tokens
 * (e.g., claude-code and opencode both logged into the same Claude account)
 * 
 * We consider two results identical if they have the same utilization values.
 * Reset times are NOT included since they can differ by milliseconds between calls.
 * 
 * @param {Array<{usage: object, ...}>} results - Array of fetched usage results
 * @returns {Array<{usage: object, ...}>} Deduplicated results
 */
export function deduplicateClaudeResultsByUsage(results) {
	const seen = new Set();
	return results.filter(result => {
		if (!result.success || !result.usage) return true; // Keep errors/failures
		
		// Create a fingerprint from utilization values only (not reset times)
		const usage = result.usage;
		const fiveHour = usage.five_hour?.utilization ?? "null";
		const sevenDay = usage.seven_day?.utilization ?? "null";
		const sevenDayOpus = usage.seven_day_opus?.utilization ?? "null";
		const sevenDaySonnet = usage.seven_day_sonnet?.utilization ?? "null";
		
		// Fingerprint: all utilization values concatenated
		// Same account will have identical utilization regardless of which OAuth token is used
		const fingerprint = `${fiveHour}|${sevenDay}|${sevenDayOpus}|${sevenDaySonnet}`;
		
		if (seen.has(fingerprint)) return false;
		seen.add(fingerprint);
		return true;
	});
}

/**
 * Load all Claude OAuth accounts from all sources
 * Sources (in priority order):
 *   1. CLAUDE_OAUTH_ACCOUNTS env var
 *   2. ~/.claude-accounts.json (accounts with oauthToken field)
 *   3. ~/.claude/.credentials.json (Claude Code)       [skipped when local=true]
 *   4. ~/.local/share/opencode/auth.json (OpenCode)    [skipped when local=true]
 * Deduplicates by accessToken to prevent showing same account twice
 * @param {{ local?: boolean }} [options] - When local=true, skip harness auth files
 * @returns {Array<{ label: string, accessToken: string, refreshToken?: string, expiresAt?: number, subscriptionType?: string, rateLimitTier?: string, source: string }>}
 */
export function loadAllClaudeOAuthAccounts(options = {}) {
	const all = [];
	const seenLabels = new Set();

	// 1. Environment variable
	for (const account of loadClaudeOAuthFromEnv()) {
		if (!seenLabels.has(account.label)) {
			seenLabels.add(account.label);
			all.push(account);
		}
	}

	// 2. Multi-account file (accounts with oauthToken)
	for (const path of CLAUDE_MULTI_ACCOUNT_PATHS) {
		const accounts = loadClaudeAccountsFromFile(path);
		for (const account of accounts) {
			if (account.oauthToken && !seenLabels.has(account.label)) {
				seenLabels.add(account.label);
				all.push({
					label: account.label,
					accessToken: account.oauthToken,
					// Pass through new OAuth metadata fields (optional, may be null for legacy accounts)
					refreshToken: account.oauthRefreshToken || null,
					expiresAt: account.oauthExpiresAt || null,
					scopes: account.oauthScopes || null,
					source: account.source,
				});
			}
		}
	}

	// 3. Claude Code credentials (skip in local mode)
	if (!options.local) {
		for (const account of loadClaudeOAuthFromClaudeCode()) {
			if (!seenLabels.has(account.label)) {
				seenLabels.add(account.label);
				all.push(account);
			}
		}
	}

	// 4. OpenCode credentials (skip in local mode)
	if (!options.local) {
		for (const account of loadClaudeOAuthFromOpenCode()) {
			if (!seenLabels.has(account.label)) {
				seenLabels.add(account.label);
				all.push(account);
			}
		}
	}

	// 5. Deduplicate by accessToken (same account from multiple sources with different labels)
	return deduplicateClaudeOAuthAccounts(all);
}

/**
 * Fetch Claude usage via OAuth API (new official endpoint)
 * Endpoint: GET https://api.anthropic.com/api/oauth/usage
 * Required headers:
 *   - Authorization: Bearer <access_token>
 *   - anthropic-version: 2023-06-01
 *   - anthropic-beta: oauth-2025-04-20
 * @param {string} accessToken - OAuth access token with user:profile scope
 * @returns {Promise<{ success: boolean, data?: object, error?: string }>}
 */
export async function fetchClaudeOAuthUsage(accessToken) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);

	try {
		const res = await fetch(CLAUDE_OAUTH_USAGE_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"anthropic-version": CLAUDE_OAUTH_VERSION,
				"anthropic-beta": CLAUDE_OAUTH_BETA,
			},
			signal: controller.signal,
		});

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			return {
				success: false,
				error: `HTTP ${res.status}: ${body.slice(0, 200) || res.statusText}`,
			};
		}

		const data = await res.json();
		return { success: true, data };
	} catch (err) {
		const message = err.name === "AbortError" ? "Request timed out" : err.message;
		return { success: false, error: message };
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Fetch usage for a Claude OAuth account
 * @param {{ label: string, accessToken: string, ... }} account - OAuth account
 * @returns {Promise<{ success: boolean, label: string, source: string, usage?: object, ... }>}
 */
export async function fetchClaudeOAuthUsageForAccount(account) {
	const refreshed = await ensureFreshClaudeOAuthToken(account);
	if (!refreshed) {
		const message = account.refreshToken
			? "OAuth token expired and refresh failed - run 'claude /login'"
			: "OAuth token expired - refresh token missing, run 'claude /login'";
		return {
			success: false,
			label: account.label,
			source: account.source,
			error: message,
			subscriptionType: account.subscriptionType,
			rateLimitTier: account.rateLimitTier,
		};
	}

	const result = await fetchClaudeOAuthUsage(account.accessToken);

	if (!result.success) {
		return {
			success: false,
			label: account.label,
			source: account.source,
			error: result.error,
			subscriptionType: account.subscriptionType,
			rateLimitTier: account.rateLimitTier,
		};
	}

	return {
		success: true,
		label: account.label,
		source: account.source,
		usage: result.data,
		subscriptionType: account.subscriptionType,
		rateLimitTier: account.rateLimitTier,
	};
}

export function getChromeSafeStoragePassword() {
	const candidates = ["chromium", "chrome", "google-chrome", "google-chrome-canary"];
	for (const app of candidates) {
		try {
			const result = spawnSync("secret-tool", ["lookup", "application", app], {
				encoding: "utf-8",
			});
			if (result.status === 0) {
				const value = (result.stdout || "").trim();
				if (value) return value;
			}
		} catch {
			// ignore
		}
	}
	return "peanuts";
}

export function decryptChromeCookie(encryptedValue, password) {
	if (!encryptedValue || encryptedValue.length < 4) return null;
	const prefix = encryptedValue.slice(0, 3).toString("utf-8");
	if (prefix !== "v10" && prefix !== "v11") {
		try {
			return encryptedValue.toString("utf-8");
		} catch {
			return null;
		}
	}

	try {
		const ciphertext = encryptedValue.slice(3);
		const key = pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
		const iv = Buffer.alloc(16, " ");
		const decipher = createDecipheriv("aes-128-cbc", key, iv);
		let decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
		const pad = decrypted[decrypted.length - 1];
		if (pad > 0 && pad <= 16) {
			decrypted = decrypted.slice(0, -pad);
		}
		return decrypted.toString("utf-8");
	} catch {
		return null;
	}
}

export function stripNonPrintable(value) {
	if (!value) return value;
	return value.replace(/^[^\x20-\x7E]+/, "").replace(/[^\x20-\x7E]+$/, "");
}

export function extractClaudeCookieValue(value, name = null) {
	const cleaned = stripNonPrintable(value);
	if (!cleaned) return null;
	const asciiOnly = cleaned.replace(/[^\x20-\x7E]/g, "");
	if (!asciiOnly) return null;
	if (name === "sessionKey") {
		const match = asciiOnly.match(/sk-ant-[a-z0-9_-]+/i);
		return match ? match[0] : null;
	}
	if (name === "cf_clearance") {
		const match = asciiOnly.match(/[A-Za-z0-9._-]{20,}/);
		return match ? match[0] : null;
	}
	if (name === "lastActiveOrg") {
		const match = asciiOnly.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
		return match ? match[0] : null;
	}
	return asciiOnly;
}

export function readClaudeCookiesFromDb(cookiePath) {
	const tempPath = join(tmpdir(), `cq-claude-cookies-${randomBytes(6).toString("hex")}.db`);
	try {
		copyFileSync(cookiePath, tempPath);
		const query = [
			"select name, value, hex(encrypted_value)",
			"from cookies",
			"where host_key like '%claude.ai%'",
			";",
		].join(" ");
		const result = spawnSync("sqlite3", ["-readonly", "-separator", "\t", tempPath, query], {
			encoding: "utf-8",
		});
		if (result.status !== 0) {
			return { error: result.stderr?.trim() || "Failed to read cookie DB" };
		}
		const lines = (result.stdout || "").trim().split("\n").filter(Boolean);
		if (!lines.length) {
			return { error: "No Claude cookies found in DB" };
		}

		const password = getChromeSafeStoragePassword();
		const cookies = {};

		for (const line of lines) {
			const [name, plainValue, hexValue] = line.split("\t");
			if (!name) continue;
			if (plainValue) {
				const value = extractClaudeCookieValue(plainValue, name);
				if (value) cookies[name] = value;
				continue;
			}
			if (hexValue) {
				const buffer = Buffer.from(hexValue, "hex");
				const decrypted = decryptChromeCookie(buffer, password);
				const value = extractClaudeCookieValue(decrypted, name);
				if (value) cookies[name] = value;
			}
		}

		return {
			sessionKey: cookies.sessionKey ?? null,
			cfClearance: cookies.cf_clearance ?? null,
			cookies,
		};
	} catch (err) {
		return { error: err?.message ?? String(err) };
	} finally {
		try {
			unlinkSync(tempPath);
		} catch {
			// ignore
		}
	}
}

export function loadClaudeCookieCandidates() {
	const overridePath = process.env.CLAUDE_COOKIE_DB_PATH;
	const candidates = overridePath
		? [overridePath]
		: [
			join(homedir(), ".config", "chromium", "Default", "Cookies"),
			join(homedir(), ".config", "google-chrome", "Default", "Cookies"),
			join(homedir(), ".config", "google-chrome-canary", "Default", "Cookies"),
			join(homedir(), ".config", "google-chrome-for-testing", "Default", "Cookies"),
		];

	const sessions = [];

	for (const cookiePath of candidates) {
		if (!existsSync(cookiePath)) continue;
		const result = readClaudeCookiesFromDb(cookiePath);
		if (result.sessionKey) {
			sessions.push({
				sessionKey: result.sessionKey,
				cfClearance: result.cfClearance ?? null,
				cookies: result.cookies ?? null,
				source: cookiePath,
			});
		}
	}

	return sessions;
}

export function loadClaudeSessionCandidates() {
	const sessions = [];
	const cookieSessions = loadClaudeCookieCandidates();
	const oauth = loadClaudeOAuthToken();
	for (const session of cookieSessions) {
		sessions.push({
			...session,
			oauthToken: oauth.token ?? null,
		});
	}

	const credentialsSession = loadClaudeSessionFromCredentials();
	if (credentialsSession.sessionKey) {
		sessions.push({
			...credentialsSession,
			oauthToken: oauth.token ?? credentialsSession.sessionKey,
		});
	}

	return sessions;
}

export function buildClaudeHeaders(sessionKey, cfClearance, bearerToken, mode, cookies) {
	const headers = {
		accept: "application/json, text/plain, */*",
		"accept-language": "en-US,en;q=0.9",
		"cache-control": "no-cache",
		pragma: "no-cache",
		origin: CLAUDE_ORIGIN,
		referer: `${CLAUDE_ORIGIN}/`,
		"user-agent": CLAUDE_USER_AGENT,
		"sec-fetch-dest": "empty",
		"sec-fetch-mode": "cors",
		"sec-fetch-site": "same-origin",
		"x-requested-with": "XMLHttpRequest",
	};
	if (mode.includes("cookie")) {
		if (!sessionKey && !(cookies && typeof cookies === "object")) {
			return headers;
		}
		let parts = [];
		if (cookies && typeof cookies === "object") {
			parts = Object.entries(cookies)
				.filter(([, value]) => typeof value === "string" && value.length)
				.map(([name, value]) => `${name}=${value}`);
		} else {
			parts = [`sessionKey=${sessionKey}`];
			if (cfClearance) {
				parts.push(`cf_clearance=${cfClearance}`);
			}
		}
		headers.Cookie = parts.join("; ");
	}
	if (mode.includes("bearer")) {
		if (bearerToken) {
			headers.Authorization = `Bearer ${bearerToken}`;
		}
	}
	return headers;
}

export async function fetchClaudeJson(url, sessionKey, cfClearance, oauthToken, cookies) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);

	try {
		const attempts = [];
		const hasCookie = Boolean(sessionKey || (cookies && typeof cookies === "object"));
		const hasSessionBearer = Boolean(sessionKey);
		const hasOauthBearer = Boolean(oauthToken);

		if (hasCookie) attempts.push({ mode: "cookie", bearer: null });
		if (hasSessionBearer) attempts.push({ mode: "bearer", bearer: sessionKey });
		if (hasOauthBearer) attempts.push({ mode: "bearer", bearer: oauthToken });
		if (hasCookie && hasSessionBearer) attempts.push({ mode: "cookie+bearer", bearer: sessionKey });
		if (hasCookie && hasOauthBearer) attempts.push({ mode: "cookie+bearer", bearer: oauthToken });
		let lastError = null;

		for (const attempt of attempts) {
			const res = await fetch(url, {
				method: "GET",
				headers: buildClaudeHeaders(
					sessionKey,
					cfClearance,
					attempt.bearer,
					attempt.mode,
					cookies
				),
				signal: controller.signal,
			});
			if (res.ok) {
				const text = await res.text();
				if (!text) {
					return { data: null };
				}
				try {
					return { data: JSON.parse(text) };
				} catch {
					return { error: "Invalid JSON response" };
				}
			}

			let detail = "";
			try {
				const text = await res.text();
				if (text) {
					detail = text.trim().slice(0, 200);
				}
			} catch {
				// ignore body parse errors
			}
			const error = {
				status: res.status,
				error: detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`,
			};
			lastError = error;
			if (res.status !== 401 && res.status !== 403) {
				return error;
			}
		}

		return lastError ?? { error: "HTTP 403" };
	} catch (err) {
		const message = err?.name === "AbortError" ? "Request timed out" : err?.message ?? String(err);
		return { error: message };
	} finally {
		clearTimeout(timeout);
	}
}

export function extractClaudeOrgId(payload) {
	if (!payload) return null;
	if (typeof payload === "string") return payload;

	const isUuidLike = (value) => {
		if (typeof value !== "string") return false;
		if (/^[0-9a-f]{32}$/i.test(value)) return true;
		if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
			return true;
		}
		return false;
	};

	const searchUuid = (root) => {
		const stack = [root];
		const seen = new Set();
		while (stack.length) {
			const current = stack.pop();
			if (!current || typeof current !== "object") continue;
			if (seen.has(current)) continue;
			seen.add(current);
			if (Array.isArray(current)) {
				for (const item of current) {
					if (isUuidLike(item)) return item;
					if (item && typeof item === "object") stack.push(item);
				}
			} else {
				for (const value of Object.values(current)) {
					if (isUuidLike(value)) return value;
					if (value && typeof value === "object") stack.push(value);
				}
			}
		}
		return null;
	};

	const uuidCandidate = searchUuid(payload);
	if (uuidCandidate) return uuidCandidate;

	const direct = payload.id ?? payload.uuid ?? payload.organizationId ?? payload.orgId ?? payload.org_id;
	if (direct) return direct;
	if (payload.current_organization_uuid) return payload.current_organization_uuid;

	const orgs = Array.isArray(payload)
		? payload
		: payload.organizations ?? payload.orgs ?? payload.items ?? payload.data;

	if (!Array.isArray(orgs) || orgs.length === 0) return null;
	const first = orgs[0];
	if (typeof first === "string") return first;
	return first?.id ?? first?.uuid ?? first?.organizationId ?? first?.orgId ?? first?.org_id ?? null;
}

export async function fetchClaudeUsageForCredentials(credentials) {
	const sessionKey = credentials.sessionKey ?? findClaudeSessionKey(credentials.cookies);
	const oauthToken = credentials.oauthToken ?? null;
	const cfClearance = credentials.cfClearance ?? credentials.cookies?.cf_clearance ?? credentials.cookies?.cfClearance ?? null;
	const cookies = credentials.cookies ?? null;

	if (!sessionKey && !oauthToken && !cookies) {
		return {
			success: false,
			label: credentials.label ?? null,
			source: credentials.source ?? null,
			error: "Missing Claude session key or OAuth token",
		};
	}

	let lastAuthError = null;
	const tryUsageForOrg = async (orgId) => {
		const normalizedOrgId = normalizeClaudeOrgId(orgId);
		const usageUrl = `${CLAUDE_API_BASE}/organizations/${normalizedOrgId}/usage`;
		const overageUrl = `${CLAUDE_API_BASE}/organizations/${normalizedOrgId}/overage_spend_limit`;

		const [usageResponse, overageResponse, accountResponse] = await Promise.all([
			fetchClaudeJson(
				usageUrl,
				sessionKey,
				cfClearance,
				oauthToken,
				cookies
			),
			fetchClaudeJson(
				overageUrl,
				sessionKey,
				cfClearance,
				oauthToken,
				cookies
			),
			fetchClaudeJson(
				CLAUDE_ACCOUNT_URL,
				sessionKey,
				cfClearance,
				oauthToken,
				cookies
			),
		]);

		const errors = {};
		if (usageResponse.error) errors.usage = usageResponse.error;
		if (overageResponse.error) errors.overage = overageResponse.error;
		if (accountResponse.error) errors.account = accountResponse.error;

		return { usageResponse, overageResponse, accountResponse, errors, orgId };
	};

	const cookieOrg = credentials.cookies?.lastActiveOrg;
	const configuredOrg = credentials.orgId ?? null;

	if (configuredOrg || cookieOrg) {
		const orgAttempt = await tryUsageForOrg(configuredOrg ?? cookieOrg);
		const authErrors = Object.values(orgAttempt.errors).some(isClaudeAuthError);
		if (!authErrors) {
			return {
				success: true,
				label: credentials.label ?? null,
				source: credentials.source ?? null,
				orgId: orgAttempt.orgId,
				usage: orgAttempt.usageResponse.data ?? null,
				overage: orgAttempt.overageResponse.data ?? null,
				account: orgAttempt.accountResponse.data ?? null,
				errors: Object.keys(orgAttempt.errors).length ? orgAttempt.errors : null,
			};
		}
		lastAuthError = orgAttempt.errors.usage || orgAttempt.errors.overage || lastAuthError;
	}

	const orgsResponse = await fetchClaudeJson(
		CLAUDE_ORGS_URL,
		sessionKey,
		cfClearance,
		oauthToken,
		cookies
	);
	if (orgsResponse.error) {
		const errorText = String(orgsResponse.error);
		const isAuthError = /account_session_invalid|invalid authorization|http 401|http 403/i.test(errorText);
		if (isAuthError) {
			lastAuthError = orgsResponse.error;
			return {
				success: false,
				label: credentials.label ?? null,
				source: credentials.source ?? null,
				error: `Organizations request failed: ${lastAuthError}`,
			};
		}
		return {
			success: false,
			label: credentials.label ?? null,
			source: credentials.source ?? null,
			error: `Organizations request failed: ${orgsResponse.error}`,
		};
	}

	const orgId = extractClaudeOrgId(orgsResponse.data);
	if (!orgId) {
		return {
			success: false,
			label: credentials.label ?? null,
			source: credentials.source ?? null,
			error: "No Claude organization ID found",
		};
	}

	const orgAttempt = await tryUsageForOrg(orgId);
	const authErrors = Object.values(orgAttempt.errors).some(isClaudeAuthError);
	if (!authErrors) {
		return {
			success: true,
			label: credentials.label ?? null,
			source: credentials.source ?? null,
			orgId,
			usage: orgAttempt.usageResponse.data ?? null,
			overage: orgAttempt.overageResponse.data ?? null,
			account: orgAttempt.accountResponse.data ?? null,
			errors: Object.keys(orgAttempt.errors).length ? orgAttempt.errors : null,
		};
	}

	return {
		success: false,
		label: credentials.label ?? null,
		source: credentials.source ?? null,
		error: `Organizations request failed: ${lastAuthError || "Invalid authorization"}`,
	};
}

export async function fetchClaudeUsage() {
	const candidates = loadClaudeSessionCandidates();
	if (!candidates.length) {
		const credentials = loadClaudeSessionFromCredentials();
		return {
			success: false,
			source: credentials.source,
			error: credentials.error ?? "Missing Claude session key",
		};
	}

	let lastAuthError = null;

	for (const credentials of candidates) {
		const tryUsageForOrg = async (orgId) => {
			const normalizedOrgId = normalizeClaudeOrgId(orgId);
			const usageUrl = `${CLAUDE_API_BASE}/organizations/${normalizedOrgId}/usage`;
			const overageUrl = `${CLAUDE_API_BASE}/organizations/${normalizedOrgId}/overage_spend_limit`;

			const [usageResponse, overageResponse, accountResponse] = await Promise.all([
				fetchClaudeJson(
					usageUrl,
					credentials.sessionKey,
					credentials.cfClearance,
					credentials.oauthToken,
					credentials.cookies
				),
				fetchClaudeJson(
					overageUrl,
					credentials.sessionKey,
					credentials.cfClearance,
					credentials.oauthToken,
					credentials.cookies
				),
				fetchClaudeJson(
					CLAUDE_ACCOUNT_URL,
					credentials.sessionKey,
					credentials.cfClearance,
					credentials.oauthToken,
					credentials.cookies
				),
			]);

			const errors = {};
			if (usageResponse.error) errors.usage = usageResponse.error;
			if (overageResponse.error) errors.overage = overageResponse.error;
			if (accountResponse.error) errors.account = accountResponse.error;

			return { usageResponse, overageResponse, accountResponse, errors, orgId };
		};

		const cookieOrg = credentials.cookies?.lastActiveOrg;
		if (cookieOrg) {
			const cookieAttempt = await tryUsageForOrg(cookieOrg);
			const authErrors = Object.values(cookieAttempt.errors).some(isClaudeAuthError);
			if (!authErrors) {
				return {
					success: true,
					source: credentials.source,
					orgId: cookieAttempt.orgId,
					usage: cookieAttempt.usageResponse.data ?? null,
					overage: cookieAttempt.overageResponse.data ?? null,
					account: cookieAttempt.accountResponse.data ?? null,
					errors: Object.keys(cookieAttempt.errors).length ? cookieAttempt.errors : null,
				};
			}
			lastAuthError = cookieAttempt.errors.usage || cookieAttempt.errors.overage || lastAuthError;
		}

		const orgsResponse = await fetchClaudeJson(
			CLAUDE_ORGS_URL,
			credentials.sessionKey,
			credentials.cfClearance,
			credentials.oauthToken,
		credentials.cookies
	);
		if (orgsResponse.error) {
			const errorText = String(orgsResponse.error);
			const isAuthError = /account_session_invalid|invalid authorization|http 401|http 403/i.test(errorText);
			if (isAuthError) {
				lastAuthError = orgsResponse.error;
				continue;
			}
			return {
				success: false,
				source: credentials.source,
				error: `Organizations request failed: ${orgsResponse.error}`,
			};
		}

		const orgId = extractClaudeOrgId(orgsResponse.data);
		if (!orgId) {
			return {
				success: false,
				source: credentials.source,
				error: "No Claude organization ID found",
			};
		}

		const orgAttempt = await tryUsageForOrg(orgId);
		const authErrors = Object.values(orgAttempt.errors).some(isClaudeAuthError);
		if (!authErrors) {
			return {
				success: true,
				source: credentials.source,
				orgId,
				usage: orgAttempt.usageResponse.data ?? null,
				overage: orgAttempt.overageResponse.data ?? null,
				account: orgAttempt.accountResponse.data ?? null,
				errors: Object.keys(orgAttempt.errors).length ? orgAttempt.errors : null,
			};
		}
		lastAuthError = orgAttempt.errors.usage || orgAttempt.errors.overage || lastAuthError;
	}

	return {
		success: false,
		source: candidates[0]?.source ?? null,
		error: `Organizations request failed: ${lastAuthError || "Invalid authorization"}`,
	};
}

