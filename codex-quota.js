#!/usr/bin/env node

/**
 * Standalone Codex quota checker for multiple OAuth accounts
 * Zero dependencies - uses Node.js built-ins only
 * 
 * Usage:
 *   node codex-quota.js                    # Check all accounts
 *   node codex-quota.js codex quota        # Check Codex usage
 *   node codex-quota.js claude quota       # Check Claude usage
 * 
 * Account sources (checked in order):
 *   1. CODEX_ACCOUNTS env var (JSON array)
 *   2. ~/.codex-accounts.json (multi-account format)
 *   3. ~/.opencode/openai-codex-auth-accounts.json (multi-account format)
 *   4. ~/.codex/auth.json (Codex CLI single-account format)
 * 
 * Multi-account format: { "accounts": [{ label, accountId, access, refresh, expires }] }
 * Codex CLI format: { "tokens": { access_token, refresh_token, expires_at } }
 */

import {
	existsSync,
	readFileSync,
	writeFileSync,
	copyFileSync,
	mkdirSync,
	chmodSync,
	renameSync,
	unlinkSync,
	realpathSync,
	lstatSync,
	readlinkSync,
} from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, createHash, pbkdf2Sync, createDecipheriv } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { createInterface } from "node:readline";

// OAuth config (matches OpenAI Codex CLI)
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const OAUTH_TIMEOUT_MS = 120000; // 2 minutes
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const JWT_CLAIM = "https://api.openai.com/auth";
const JWT_PROFILE = "https://api.openai.com/profile";
const CLAUDE_CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
const CLAUDE_MULTI_ACCOUNT_PATHS = [
	join(homedir(), ".claude-accounts.json"),
];
const CLAUDE_API_BASE = "https://claude.ai/api";
const CLAUDE_ORIGIN = "https://claude.ai";
const CLAUDE_ORGS_URL = `${CLAUDE_API_BASE}/organizations`;
const CLAUDE_ACCOUNT_URL = `${CLAUDE_API_BASE}/account`;
const CLAUDE_TIMEOUT_MS = 15000;
const CLAUDE_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Claude OAuth API configuration (new official endpoint)
const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_VERSION = "2023-06-01";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_OAUTH_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Claude OAuth browser flow configuration
const CLAUDE_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const CLAUDE_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_OAUTH_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_OAUTH_SCOPES = "org:create_api_key user:profile user:inference";

// CLI command names
const PRIMARY_CMD = "codex-quota";
const PACKAGE_JSON_PATH = join(dirname(import.meta.url.replace("file://", "")), "package.json");

const MULTI_ACCOUNT_PATHS = [
	join(homedir(), ".codex-accounts.json"),
	join(homedir(), ".opencode", "openai-codex-auth-accounts.json"),
];

const CODEX_CLI_AUTH_PATH = join(homedir(), ".codex", "auth.json");
const PI_AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const DEFAULT_XDG_DATA_HOME = join(homedir(), ".local", "share");

// ─────────────────────────────────────────────────────────────────────────────
// Color output
// ─────────────────────────────────────────────────────────────────────────────

// ANSI color codes
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

// Global flag set by main() based on CLI args
let noColorFlag = false;

/**
 * Set the noColorFlag value (for testing purposes)
 * @param {boolean} value - Whether to disable colors
 */
function setNoColorFlag(value) {
	noColorFlag = value;
}

/**
 * Check if terminal supports colors
 * Respects NO_COLOR env var (https://no-color.org/) and --no-color flag
 * @returns {boolean} true if colors should be used
 */
function supportsColor() {
	// Respect --no-color CLI flag
	if (noColorFlag) return false;
	// Respect NO_COLOR env var (any non-empty value disables color)
	if (process.env.NO_COLOR) return false;
	// Check if stdout is a TTY (not piped/redirected)
	if (!process.stdout.isTTY) return false;
	return true;
}

/**
 * Apply color to text if terminal supports it
 * @param {string} text - Text to colorize
 * @param {string} color - ANSI color code (GREEN, RED, YELLOW)
 * @returns {string} Colorized text or plain text if colors disabled
 */
function colorize(text, color) {
	if (!supportsColor()) return text;
	return `${color}${text}${RESET}`;
}

/**
 * Output data as formatted JSON to stdout
 * Standardizes JSON output across all handlers with 2-space indent
 * @param {any} data - Data to serialize and output
 */
function outputJson(data) {
	console.log(JSON.stringify(data, null, 2));
}

/**
 * Get the CLI version from package.json
 * @returns {string}
 */
function getPackageVersion() {
	try {
		const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8"));
		return pkg.version || "unknown";
	} catch {
		return "unknown";
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// JWT decode
// ─────────────────────────────────────────────────────────────────────────────

function decodeJWT(token) {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = Buffer.from(parts[1], "base64").toString("utf-8");
		return JSON.parse(payload);
	} catch {
		return null;
	}
}

function extractAccountId(accessToken) {
	const payload = decodeJWT(accessToken);
	return payload?.[JWT_CLAIM]?.chatgpt_account_id ?? null;
}

function extractProfile(accessToken) {
	const payload = decodeJWT(accessToken);
	const auth = payload?.[JWT_CLAIM] ?? {};
	const profile = payload?.[JWT_PROFILE] ?? {};
	return {
		email: profile.email ?? null,
		planType: auth.chatgpt_plan_type ?? null,
		userId: auth.chatgpt_user_id ?? null,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Account storage
// ─────────────────────────────────────────────────────────────────────────────

let activeAccountsPath = null;

/**
 * Resolve OpenCode auth.json path using XDG_DATA_HOME
 * @returns {string}
 */
function getOpencodeAuthPath() {
	const dataHome = process.env.XDG_DATA_HOME || DEFAULT_XDG_DATA_HOME;
	return join(dataHome, "opencode", "auth.json");
}

/**
 * Resolve Codex CLI auth.json path with optional override.
 * @returns {string}
 */
function getCodexCliAuthPath() {
	const override = process.env.CODEX_AUTH_PATH;
	return override ? override : CODEX_CLI_AUTH_PATH;
}

/**
 * Resolve pi auth.json path.
 * @returns {string}
 */
function getPiAuthPath() {
	return PI_AUTH_PATH;
}

// ─────────────────────────────────────────────────────────────────────────────
// File helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the correct write target for a path, preserving symlink files.
 * @param {string} filePath - Intended path to write
 * @returns {{ path: string, isSymlink: boolean }}
 */
function resolveWritePath(filePath) {
	try {
		const stats = lstatSync(filePath);
		if (!stats.isSymbolicLink()) {
			return { path: filePath, isSymlink: false };
		}
		try {
			return { path: realpathSync(filePath), isSymlink: true };
		} catch {
			let linkTarget = readlinkSync(filePath);
			if (!isAbsolute(linkTarget)) {
				linkTarget = resolve(dirname(filePath), linkTarget);
			}
			return { path: linkTarget, isSymlink: true };
		}
	} catch {
		return { path: filePath, isSymlink: false };
	}
}

/**
 * Write a file atomically while preserving existing symlink files.
 * @param {string} filePath - Intended path to write
 * @param {string} contents - File contents
 * @param {{ mode?: number }} [options]
 * @returns {string} Actual path written
 */
function writeFileAtomic(filePath, contents, options = {}) {
	const { path: targetPath } = resolveWritePath(filePath);
	const dir = dirname(targetPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const tempPath = `${targetPath}.tmp`;
	writeFileSync(tempPath, contents, "utf-8");
	if (options.mode !== undefined) {
		chmodSync(tempPath, options.mode);
	}
	renameSync(tempPath, targetPath);
	return targetPath;
}

/**
 * Load accounts from CODEX_ACCOUNTS environment variable
 * @returns {Array<{label: string, accountId: string, access: string, refresh: string, expires?: number, source: string}>}
 */
function loadAccountsFromEnv() {
	const envAccounts = process.env.CODEX_ACCOUNTS;
	if (!envAccounts) return [];
	
	try {
		const parsed = JSON.parse(envAccounts);
		const accounts = Array.isArray(parsed) ? parsed : parsed?.accounts ?? [];
		return accounts
			.filter(isValidAccount)
			.map(a => ({ ...a, source: "env" }));
	} catch {
		console.error("Warning: CODEX_ACCOUNTS env var is not valid JSON");
		return [];
	}
}

/**
 * Load accounts from a multi-account JSON file
 * @param {string} filePath - Path to the JSON file
 * @returns {Array<{label: string, accountId: string, access: string, refresh: string, expires?: number, source: string}>}
 */
function loadAccountsFromFile(filePath) {
	if (!existsSync(filePath)) return [];
	
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		const accounts = Array.isArray(parsed) ? parsed : parsed?.accounts ?? [];
		return accounts
			.filter(isValidAccount)
			.map(a => ({ ...a, source: filePath }));
	} catch {
		// Invalid JSON or read error - silently return empty array
		return [];
	}
}

/**
 * Load account from Codex CLI auth.json (single account format)
 * Returns array with single account for consistency with other loaders
 * @returns {Array<{label: string, accountId: string, access: string, refresh: string, expires?: number, source: string}>}
 */
function loadAccountFromCodexCli() {
	const codexAuthPath = getCodexCliAuthPath();
	if (!existsSync(codexAuthPath)) return [];
	
	try {
		const raw = readFileSync(codexAuthPath, "utf-8");
		const parsed = JSON.parse(raw);
		const tokens = parsed?.tokens;
		
		if (!tokens?.access_token || !tokens?.refresh_token) {
			return [];
		}
		
		const accountId = extractAccountId(tokens.access_token);
		if (!accountId) {
			return [];
		}
		
		return [{
			label: "codex-cli",
			accountId,
			access: tokens.access_token,
			refresh: tokens.refresh_token,
			expires: tokens.expires_at ? tokens.expires_at * 1000 : Date.now() - 1000,
			source: codexAuthPath,
		}];
	} catch {
		// Invalid JSON or read error - silently return empty array
		return [];
	}
}

/**
 * Deduplicate accounts by email (from JWT token), keeping the first occurrence
 * This handles the case where the same account is sourced from multiple files
 * (e.g., codex-accounts.json and opencode both storing the same credentials)
 * 
 * Note: We use email instead of accountId because a team account has one accountId
 * but multiple users (each with their own email). We want to show each user once.
 * @param {Array<{access: string, ...}>} accounts - Array of accounts with JWT access tokens
 * @returns {Array<{access: string, ...}>} Deduplicated accounts
 */
function deduplicateAccountsByEmail(accounts) {
	const seen = new Set();
	return accounts.filter(account => {
		if (!account.access) return true; // Keep accounts without token (shouldn't happen)
		const profile = extractProfile(account.access);
		const email = profile?.email;
		if (!email) return true; // Keep accounts without email (fallback)
		if (seen.has(email)) return false;
		seen.add(email);
		return true;
	});
}

/**
 * Load ALL accounts from ALL sources (env, file paths, codex-cli)
 * Each account includes a `source` property indicating its origin
 * Deduplicates by email to prevent showing same user twice
 * @returns {Array<{label: string, accountId: string, access: string, refresh: string, expires?: number, source: string}>}
 */
function loadAllAccounts() {
	const all = [];
	
	// 1. Load from environment variable
	all.push(...loadAccountsFromEnv());
	
	// 2. Load from multi-account file paths
	for (const path of MULTI_ACCOUNT_PATHS) {
		all.push(...loadAccountsFromFile(path));
	}
	
	// 3. Only load codex-cli synthetic account if no other accounts exist
	// (prevents duplicate entries when user has multi-account file)
	if (all.length === 0) {
		all.push(...loadAccountFromCodexCli());
	}
	
	// 4. Deduplicate by email (same user from multiple sources)
	return deduplicateAccountsByEmail(all);
}

/**
 * Find an account by label from all sources
 * @param {string} label - Account label to find
 * @returns {{label: string, accountId: string, access: string, refresh: string, expires?: number, source: string} | null}
 */
function findAccountByLabel(label) {
	const accounts = loadAllAccounts();
	return accounts.find(a => a.label === label) ?? null;
}

/**
 * Get all labels from all account sources
 * @returns {string[]} Array of all unique labels
 */
function getAllLabels() {
	const accounts = loadAllAccounts();
	return [...new Set(accounts.map(a => a.label))];
}

/**
 * Find a Claude account by label from supported sources
 * @param {string} label - Claude account label to find
 * @returns {{label: string, sessionKey?: string, oauthToken?: string, oauthRefreshToken?: string, oauthExpiresAt?: number, oauthScopes?: string[], source: string} | null}
 */
function findClaudeAccountByLabel(label) {
	const accounts = loadClaudeAccounts();
	return accounts.find(account => account.label === label) ?? null;
}

/**
 * Get all Claude labels from supported sources
 * @returns {string[]} Array of Claude labels
 */
function getClaudeLabels() {
	const accounts = loadClaudeAccounts();
	return [...new Set(accounts.map(account => account.label))];
}

function loadAccounts() {
	// 1. Check env var
	const envAccounts = process.env.CODEX_ACCOUNTS;
	if (envAccounts) {
		try {
			const parsed = JSON.parse(envAccounts);
			const accounts = Array.isArray(parsed) ? parsed : parsed?.accounts ?? [];
			if (accounts.length) {
				activeAccountsPath = null;
				return accounts.filter(isValidAccount).map(a => ({ ...a, source: "env" }));
			}
		} catch {
			console.error("Warning: CODEX_ACCOUNTS env var is not valid JSON");
		}
	}
	
	// 2. Check multi-account file paths
	for (const path of MULTI_ACCOUNT_PATHS) {
		if (!existsSync(path)) continue;
		try {
			const raw = readFileSync(path, "utf-8");
			const parsed = JSON.parse(raw);
			const accounts = Array.isArray(parsed) ? parsed : parsed?.accounts ?? [];
			const valid = accounts.filter(isValidAccount);
			if (valid.length) {
				activeAccountsPath = path;
				return valid.map(a => ({ ...a, source: path }));
			}
		} catch {
			continue;
		}
	}
	
	// 3. Check Codex CLI auth.json (single account format)
	const codexAuthPath = getCodexCliAuthPath();
	if (existsSync(codexAuthPath)) {
		try {
			const raw = readFileSync(codexAuthPath, "utf-8");
			const parsed = JSON.parse(raw);
			const tokens = parsed?.tokens;
			if (tokens?.access_token && tokens?.refresh_token) {
				const accountId = extractAccountId(tokens.access_token);
				if (accountId) {
					activeAccountsPath = codexAuthPath;
					return [{
						label: "codex-cli",
						accountId,
						access: tokens.access_token,
						refresh: tokens.refresh_token,
						expires: tokens.expires_at ? tokens.expires_at * 1000 : Date.now() - 1000,
						source: codexAuthPath,
					}];
				}
			}
		} catch {
			// ignore
		}
	}
	
	return [];
}

function isValidAccount(a) {
	return a?.label && a?.accountId && a?.access && a?.refresh;
}

function saveAccounts(accounts) {
	if (!activeAccountsPath) return;
	const codexAuthPath = getCodexCliAuthPath();
	
	// Don't modify Codex CLI auth.json format
	if (activeAccountsPath === codexAuthPath) {
		try {
			const raw = readFileSync(codexAuthPath, "utf-8");
			const parsed = JSON.parse(raw);
			const account = accounts[0];
			if (account && parsed.tokens) {
				parsed.tokens.access_token = account.access;
				parsed.tokens.refresh_token = account.refresh;
				parsed.tokens.expires_at = Math.floor(account.expires / 1000);
				writeFileAtomic(codexAuthPath, JSON.stringify(parsed, null, 2) + "\n");
			}
		} catch {
			// ignore
		}
		return;
	}
	
	const dir = dirname(activeAccountsPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileAtomic(activeAccountsPath, JSON.stringify({ accounts }, null, 2) + "\n");
}

/**
 * Update OpenCode auth.json with new OpenAI OAuth tokens
 * Preserves other providers and extra fields.
 * @param {{ access: string, refresh: string, expires?: number, accountId: string }} account
 * @returns {{ updated: boolean, path: string, error?: string, skipped?: boolean }}
 */
function updateOpencodeAuth(account) {
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
 * Preserves other providers and extra fields.
 * @param {{ access: string, refresh: string, expires?: number, accountId: string }} account
 * @returns {{ updated: boolean, path: string, error?: string, skipped?: boolean }}
 */
function updatePiAuth(account) {
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
 * Update Claude Code credentials with new OAuth tokens
 * @param {{ oauthToken: string, oauthRefreshToken?: string | null, oauthExpiresAt?: number | null, oauthScopes?: string[] | null }} account
 * @returns {{ updated: boolean, path: string, error?: string }}
 */
function updateClaudeCredentials(account) {
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
function updateOpencodeClaudeAuth(account) {
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
function updatePiClaudeAuth(account) {
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

function isClaudeOauthTokenMatch({
	storedAccess,
	storedRefresh,
	previousAccess,
	previousRefresh,
	label,
	storedLabel,
}) {
	if (previousRefresh && storedRefresh && storedRefresh === previousRefresh) return true;
	if (previousAccess && storedAccess && storedAccess === previousAccess) return true;
	if (!storedAccess && !storedRefresh && label && storedLabel && label === storedLabel) return true;
	return false;
}

function normalizeClaudeOauthEntryTokens(entry) {
	return {
		access: entry?.oauthToken
			?? entry?.oauth_token
			?? entry?.accessToken
			?? entry?.access_token
			?? null,
		refresh: entry?.oauthRefreshToken
			?? entry?.oauth_refresh_token
			?? entry?.refreshToken
			?? entry?.refresh_token
			?? null,
		scopes: entry?.oauthScopes
			?? entry?.oauth_scopes
			?? entry?.scopes
			?? null,
		expires: entry?.oauthExpiresAt
			?? entry?.oauth_expires_at
			?? entry?.expiresAt
			?? entry?.expires_at
			?? null,
	};
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
 * Persist refreshed Claude OAuth tokens to all known stores that match.
 * @param {{ label: string, accessToken: string, refreshToken?: string | null, expiresAt?: number | null, scopes?: string[] | null, source?: string }} account
 * @param {{ previousAccessToken?: string | null, previousRefreshToken?: string | null }} previousTokens
 * @returns {{ updatedPaths: string[], errors: string[] }}
 */
function persistClaudeOAuthTokens(account, previousTokens = {}) {
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
				const raw = readFileSync(path, "utf-8");
				const parsed = JSON.parse(raw);
				const isArray = Array.isArray(parsed);
				const accounts = isArray ? parsed : parsed?.accounts ?? [];
				let updated = false;
				const updatedAccounts = accounts.map(entry => {
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
					updated = true;
					const scopes = account.scopes ?? stored.scopes ?? null;
					return updateClaudeOauthEntry({ ...entry }, { ...account, scopes });
				});

				if (updated) {
					const nextPayload = isArray ? updatedAccounts : { ...parsed, accounts: updatedAccounts };
					writeFileAtomic(path, JSON.stringify(nextPayload, null, 2) + "\n", { mode: 0o600 });
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

// ─────────────────────────────────────────────────────────────────────────────
// Token refresh
// ─────────────────────────────────────────────────────────────────────────────

async function refreshToken(refreshToken) {
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
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

async function ensureFreshToken(account, allAccounts) {
	if (account.expires && account.expires > Date.now() + 60000) {
		return true;
	}
	const refreshed = await refreshToken(account.refresh);
	if (!refreshed) return false;
	
	// Update accountId from new token (in case it changed)
	const newAccountId = extractAccountId(refreshed.access);
	if (newAccountId) account.accountId = newAccountId;
	
	account.access = refreshed.access;
	account.refresh = refreshed.refresh;
	account.expires = refreshed.expires;
	account.updatedAt = Date.now();
	saveAccounts(allAccounts);
	return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage fetch
// ─────────────────────────────────────────────────────────────────────────────

async function fetchUsage(account) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15000);
	
	try {
		const res = await fetch(USAGE_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${account.access}`,
				accept: "application/json",
				"chatgpt-account-id": account.accountId,
				originator: "codex_cli_rs",
			},
			signal: controller.signal,
		});
		if (!res.ok) {
			return { error: `HTTP ${res.status}` };
		}
		return await res.json();
	} catch (e) {
		return { error: e.message };
	} finally {
		clearTimeout(timeout);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude usage fetch
// ─────────────────────────────────────────────────────────────────────────────

function isClaudeSessionKey(value) {
	return typeof value === "string" && value.startsWith("sk-ant-");
}

function findClaudeSessionKey(value) {
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

function normalizeClaudeAccount(raw, source) {
	if (!raw || typeof raw !== "object") return null;
	const label = raw.label ?? null;
	const sessionKey = raw.sessionKey ?? raw.session_key ?? null;
	const oauthToken = raw.oauthToken ?? raw.oauth_token ?? raw.accessToken ?? raw.access_token ?? null;
	const cfClearance = raw.cfClearance ?? raw.cf_clearance ?? null;
	const orgId = raw.orgId ?? raw.org_id ?? null;
	const cookies = raw.cookies && typeof raw.cookies === "object" ? raw.cookies : null;
	// OAuth flow metadata (optional, for accounts created via OAuth browser flow)
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

function isValidClaudeAccount(account) {
	if (!account?.label) return false;
	const sessionKey = account.sessionKey ?? findClaudeSessionKey(account.cookies);
	const oauthToken = account.oauthToken ?? null;
	return Boolean(sessionKey || oauthToken);
}

function loadClaudeAccountsFromEnv() {
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

function loadClaudeAccountsFromFile(filePath) {
	if (!existsSync(filePath)) return [];

	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		const accounts = Array.isArray(parsed) ? parsed : parsed?.accounts ?? [];
		return accounts
			.map(a => normalizeClaudeAccount(a, filePath))
			.filter(a => a && isValidClaudeAccount(a));
	} catch {
		return [];
	}
}

function loadClaudeAccounts() {
	const all = [];
	all.push(...loadClaudeAccountsFromEnv());
	for (const path of CLAUDE_MULTI_ACCOUNT_PATHS) {
		all.push(...loadClaudeAccountsFromFile(path));
	}
	return all;
}

function saveClaudeAccounts(accounts) {
	const targetPath = CLAUDE_MULTI_ACCOUNT_PATHS[0];
	const dir = dirname(targetPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileAtomic(targetPath, JSON.stringify({ accounts }, null, 2) + "\n", { mode: 0o600 });
	return targetPath;
}

function loadClaudeSessionFromCredentials() {
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

function loadClaudeOAuthToken() {
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

// ─────────────────────────────────────────────────────────────────────────────
// Claude OAuth Multi-Account Support
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load Claude OAuth account from Claude Code credentials file
 * @returns {Array<{ label: string, accessToken: string, refreshToken?: string, expiresAt?: number, subscriptionType?: string, rateLimitTier?: string, scopes?: string[], source: string }>}
 */
function loadClaudeOAuthFromClaudeCode() {
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
function loadClaudeOAuthFromOpenCode() {
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
function loadClaudeOAuthFromEnv() {
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
function deduplicateClaudeOAuthAccounts(accounts) {
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
function deduplicateClaudeResultsByUsage(results) {
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
 *   3. ~/.claude/.credentials.json (Claude Code)
 *   4. ~/.local/share/opencode/auth.json (OpenCode)
 * Deduplicates by accessToken to prevent showing same account twice
 * @returns {Array<{ label: string, accessToken: string, refreshToken?: string, expiresAt?: number, subscriptionType?: string, rateLimitTier?: string, source: string }>}
 */
function loadAllClaudeOAuthAccounts() {
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

	// 3. Claude Code credentials
	for (const account of loadClaudeOAuthFromClaudeCode()) {
		if (!seenLabels.has(account.label)) {
			seenLabels.add(account.label);
			all.push(account);
		}
	}

	// 4. OpenCode credentials
	for (const account of loadClaudeOAuthFromOpenCode()) {
		if (!seenLabels.has(account.label)) {
			seenLabels.add(account.label);
			all.push(account);
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
async function fetchClaudeOAuthUsage(accessToken) {
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
async function fetchClaudeOAuthUsageForAccount(account) {
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

function getChromeSafeStoragePassword() {
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

function decryptChromeCookie(encryptedValue, password) {
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

function stripNonPrintable(value) {
	if (!value) return value;
	return value.replace(/^[^\x20-\x7E]+/, "").replace(/[^\x20-\x7E]+$/, "");
}

function extractClaudeCookieValue(value, name = null) {
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

function readClaudeCookiesFromDb(cookiePath) {
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

function loadClaudeCookieCandidates() {
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

function loadClaudeSessionCandidates() {
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

function buildClaudeHeaders(sessionKey, cfClearance, bearerToken, mode, cookies) {
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

async function fetchClaudeJson(url, sessionKey, cfClearance, oauthToken, cookies) {
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

function extractClaudeOrgId(payload) {
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

async function fetchClaudeUsageForCredentials(credentials) {
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

async function fetchClaudeUsage() {
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

// ─────────────────────────────────────────────────────────────────────────────
// Display formatting
// ─────────────────────────────────────────────────────────────────────────────

function parseWindow(window) {
	if (!window) return null;
	const used = window.used_percent ?? window.usedPercent ?? window.percent_used;
	const remaining = window.remaining_percent ?? window.remainingPercent;
	const resets = window.resets_at ?? window.resetsAt ?? window.reset_at;
	const resetAfterSeconds = window.reset_after_seconds ?? window.resetAfterSeconds;
	return { used, remaining, resets, resetAfterSeconds };
}

function formatPercent(used, remaining) {
	// Prefer showing remaining (matches Codex CLI /status display)
	if (remaining !== undefined) return `${Math.round(remaining)}% left`;
	if (used !== undefined) return `${Math.round(100 - used)}% left`;
	return null;
}

function normalizeClaudeOrgId(orgId) {
	if (!orgId || typeof orgId !== "string") return orgId;
	if (/^[0-9a-f-]{36}$/i.test(orgId)) {
		return orgId.replace(/-/g, "");
	}
	return orgId;
}

function isClaudeAuthError(error) {
	if (!error) return false;
	return /account_session_invalid|invalid authorization|http 401|http 403/i.test(String(error));
}

function formatResetTime(seconds, style = "parentheses") {
	if (!seconds) return "";
	
	const resetDate = new Date(Date.now() + seconds * 1000);
	const hours = Math.floor(seconds / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	
	// Format time as HH:MM
	const timeStr = resetDate.toLocaleTimeString("en-US", { 
		hour: "2-digit", 
		minute: "2-digit",
		hour12: false 
	});
	
	// For display matching Codex CLI style
	if (style === "inline") {
		if (hours >= 24) {
			// Show date for weekly+ resets: "resets 20:26 on 19 Jan"
			const day = resetDate.getDate();
			const month = resetDate.toLocaleDateString("en-US", { month: "short" });
			return `(resets ${timeStr} on ${day} ${month})`;
		}
		// Same day: "resets 23:14"
		return `(resets ${timeStr})`;
	}
	
	// Legacy parentheses style for JSON/other uses
	if (hours > 24) {
		const days = Math.floor(hours / 24);
		return `(resets in ${days}d ${hours % 24}h)`;
	}
	if (hours > 0) {
		return `(resets in ${hours}h ${mins}m)`;
	}
	return `(resets in ${mins}m)`;
}

function formatUsage(payload) {
	const usage = payload?.usage ?? payload;
	
	// Handle new API format: rate_limit.primary_window / secondary_window
	const rateLimit = usage?.rate_limit;
	const primaryWindow = rateLimit?.primary_window ?? usage?.primary ?? usage?.session ?? usage?.fiveHour;
	const secondaryWindow = rateLimit?.secondary_window ?? usage?.secondary ?? usage?.weekly ?? usage?.week;
	const tertiaryWindow = usage?.tertiary ?? usage?.monthly ?? usage?.month;
	
	const session = parseWindow(primaryWindow);
	const weekly = parseWindow(secondaryWindow);
	const monthly = parseWindow(tertiaryWindow);
	
	const lines = [];
	
	if (session) {
		const pct = formatPercent(session.used, session.remaining);
		const reset = session.resetAfterSeconds ? formatResetTime(session.resetAfterSeconds) : 
		              session.resets ? `(resets ${session.resets})` : "";
		lines.push(`  Session: ${pct || "?"} ${reset}`);
	}
	if (weekly) {
		const pct = formatPercent(weekly.used, weekly.remaining);
		const reset = weekly.resetAfterSeconds ? formatResetTime(weekly.resetAfterSeconds) :
		              weekly.resets ? `(resets ${weekly.resets})` : "";
		lines.push(`  Weekly:  ${pct || "?"} ${reset}`);
	}
	if (monthly) {
		const pct = formatPercent(monthly.used, monthly.remaining);
		const reset = monthly.resetAfterSeconds ? formatResetTime(monthly.resetAfterSeconds) :
		              monthly.resets ? `(resets ${monthly.resets})` : "";
		lines.push(`  Monthly: ${pct || "?"} ${reset}`);
	}
	
	// Handle credits
	const credits = usage?.credits;
	if (credits) {
		const balance = credits.balance ?? credits.remaining;
		if (balance !== undefined) {
			lines.push(`  Credits: ${parseFloat(balance).toFixed(2)} remaining`);
		}
	}
	
	// Plan type
	const planType = usage?.plan_type;
	if (planType) {
		lines.push(`  Plan: ${planType}`);
	}
	
	return lines.length ? lines : ["  (no usage data)"];
}

function printBar(remaining, width = 20) {
	// Bar shows remaining quota: full = 100% left, empty = 0% left (matches Codex CLI)
	const filled = Math.round((remaining / 100) * width);
	const empty = width - filled;
	const bar = "█".repeat(filled) + "░".repeat(empty);
	return `[${bar}]`;
}

// Box drawing characters
const BOX = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	horizontal: "─",
	vertical: "│",
};

/**
 * Draw a box around content lines
 * @param {string[]} lines - Lines to display inside the box
 * @param {number} minWidth - Minimum box width (default 70)
 * @returns {string[]} Lines with box characters
 */
function drawBox(lines, minWidth = 70) {
	// Calculate content width (max line length)
	const contentWidth = Math.max(minWidth, ...lines.map(l => l.length)) + 2;
	
	const output = [];
	
	// Top border
	output.push(BOX.topLeft + BOX.horizontal.repeat(contentWidth) + BOX.topRight);
	
	// Content lines with padding
	for (const line of lines) {
		const padding = contentWidth - line.length - 1;
		output.push(BOX.vertical + " " + line + " ".repeat(padding) + BOX.vertical);
	}
	
	// Bottom border
	output.push(BOX.bottomLeft + BOX.horizontal.repeat(contentWidth) + BOX.bottomRight);
	
	return output;
}

/**
 * Build usage lines for an account (for box display)
 * @param {object} account - Account object
 * @param {object} payload - Usage payload from API
 * @returns {string[]} Lines to display
 */
function buildAccountUsageLines(account, payload) {
	const lines = [];
	const usage = payload?.usage ?? payload;
	const rateLimit = usage?.rate_limit;
	const primaryWindow = rateLimit?.primary_window ?? usage?.primary ?? usage?.session ?? usage?.fiveHour;
	const secondaryWindow = rateLimit?.secondary_window ?? usage?.secondary ?? usage?.weekly ?? usage?.week;
	const session = parseWindow(primaryWindow);
	const weekly = parseWindow(secondaryWindow);
	
	// Extract profile info from token
	const profile = extractProfile(account.access);
	const planType = usage?.plan_type ?? profile.planType;
	const planDisplay = planType ? ` (${planType})` : "";
	
	// Header: label <email> (plan)
	const emailDisplay = profile.email ? ` <${profile.email}>` : "";
	lines.push(`${account.label}${emailDisplay}${planDisplay}`);
	lines.push("");
	
	if (payload.error) {
		lines.push(`Error: ${payload.error}`);
		return lines;
	}
	
	// 5h limit bar (session/primary window)
	if (session) {
		const remaining = session.remaining ?? (session.used !== undefined ? 100 - session.used : null);
		if (remaining !== null) {
			const reset = session.resetAfterSeconds ? formatResetTime(session.resetAfterSeconds, "inline") : "";
			lines.push(`5h limit:     ${printBar(remaining)} ${Math.round(remaining)}% left ${reset}`);
		}
	}
	
	// Weekly limit bar (secondary window)
	if (weekly) {
		const remaining = weekly.remaining ?? (weekly.used !== undefined ? 100 - weekly.used : null);
		if (remaining !== null) {
			const reset = weekly.resetAfterSeconds ? formatResetTime(weekly.resetAfterSeconds, "inline") : "";
			lines.push(`Weekly limit: ${printBar(remaining)} ${Math.round(remaining)}% left ${reset}`);
		}
	}
	
	return lines;
}

function formatClaudePercentLeft(percentLeft) {
	if (percentLeft === null || percentLeft === undefined || Number.isNaN(percentLeft)) {
		return "?";
	}
	return `${Math.round(percentLeft)}% left`;
}

function normalizePercentUsed(value) {
	if (value === null || value === undefined || Number.isNaN(value)) return null;
	let used = Number(value);
	if (used <= 1 && used >= 0) {
		used *= 100;
	}
	if (!Number.isFinite(used)) return null;
	return Math.min(100, Math.max(0, used));
}

function parseClaudeUtilizationWindow(window) {
	if (!window || typeof window !== "object") return null;
	const utilization = window.utilization ?? window.used_percent ?? window.usedPercent ?? window.percent_used;
	const remainingPercent = window.remaining_percent ?? window.remainingPercent ?? window.percent_remaining;
	const resetsAt = window.resets_at ?? window.resetsAt ?? window.reset_at ?? window.resetAt;
	let remaining = null;
	if (remainingPercent !== undefined) {
		remaining = Number(remainingPercent);
	} else {
		const used = normalizePercentUsed(utilization);
		if (used !== null) {
			remaining = 100 - used;
		}
	}
	if (remaining !== null && Number.isFinite(remaining)) {
		remaining = Math.min(100, Math.max(0, remaining));
	}
	return { remaining, resetsAt };
}

function formatResetAt(dateString) {
	if (!dateString) return "";
	const date = new Date(dateString);
	if (Number.isNaN(date.getTime())) return "";
	const seconds = Math.max(0, Math.floor((date.getTime() - Date.now()) / 1000));
	return formatResetTime(seconds, "inline");
}

function parseClaudeWindow(window) {
	if (!window || typeof window !== "object") return null;
	const usedPercent = window.used_percent ?? window.usedPercent ?? window.percent_used ?? window.percentUsed;
	const remainingPercent = window.remaining_percent ?? window.remainingPercent ?? window.percent_remaining ?? window.percentRemaining;
	const used = window.used ?? window.used_units ?? window.usedUnits ?? window.used_tokens ?? window.usedTokens;
	const remaining = window.remaining ?? window.remaining_units ?? window.remainingUnits ?? window.remaining_tokens ?? window.remainingTokens;
	const limit = window.limit ?? window.quota ?? window.total ?? window.max ?? window.maximum;
	const resets = window.resets_at ?? window.resetsAt ?? window.reset_at ?? window.resetAt ?? window.reset;
	const resetAfterSeconds = window.reset_after_seconds ?? window.resetAfterSeconds;

	let percentLeft = null;
	if (remainingPercent !== undefined) {
		percentLeft = remainingPercent;
	} else if (usedPercent !== undefined) {
		percentLeft = 100 - usedPercent;
	} else if (remaining !== undefined && Number.isFinite(limit) && limit > 0) {
		percentLeft = (remaining / limit) * 100;
	} else if (used !== undefined && Number.isFinite(limit) && limit > 0) {
		percentLeft = (1 - used / limit) * 100;
	}

	return { percentLeft, used, remaining, limit, resets, resetAfterSeconds };
}

function formatClaudeLabel(label) {
	if (!label) return "";
	return label
		.replace(/_/g, " ")
		.replace(/(^|\s)\S/g, (m) => m.toUpperCase())
		.trim();
}

function getClaudeUsageWindows(usage) {
	if (!usage || typeof usage !== "object") return [];
	const root = usage.usage ?? usage.quotas ?? usage.quota ?? usage;
	const windows = [];

	const seen = new Set();
	const pushWindow = (label, window) => {
		if (!window || typeof window !== "object") return;
		if (seen.has(label)) return;
		seen.add(label);
		windows.push({ label, window });
	};

	pushWindow("Session", root.session ?? root.sessions ?? root.fiveHour ?? root.five_hour ?? root.primary);
	pushWindow("Weekly", root.weekly ?? root.week ?? root.secondary);

	const modelContainer = root.models ?? root.model ?? root.usage_by_model ?? root.model_usage;
	if (modelContainer && typeof modelContainer === "object" && !Array.isArray(modelContainer)) {
		for (const [key, value] of Object.entries(modelContainer)) {
			pushWindow(formatClaudeLabel(key), value);
		}
	}

	pushWindow("Opus", root.opus ?? root.model_opus ?? root.claude_opus);

	return windows;
}

function formatClaudeOverageLine(overage) {
	if (!overage || typeof overage !== "object") return null;
	const limit = overage.limit ?? overage.spend_limit ?? overage.spendLimit ?? overage.overage_spend_limit;
	const used = overage.used ?? overage.spent ?? overage.spend ?? overage.amount_used;
	const remaining = overage.remaining ?? (limit !== undefined && used !== undefined ? limit - used : undefined);
	const enabled = overage.enabled ?? overage.is_enabled ?? overage.active;

	const parts = [];
	if (enabled !== undefined) {
		parts.push(enabled ? "enabled" : "disabled");
	}
	if (limit !== undefined) {
		parts.push(`limit ${limit}`);
	}
	if (remaining !== undefined) {
		parts.push(`remaining ${remaining}`);
	}
	if (!parts.length) return null;
	return `Overage: ${parts.join(", ")}`;
}

function buildClaudeUsageLines(payload) {
	const lines = [];

	const account = payload?.account ?? {};
	const email = account.email ?? account.email_address ?? account?.user?.email ?? account?.account?.email ?? null;
	const membership = Array.isArray(account.memberships)
		? account.memberships.find(m => normalizeClaudeOrgId(m?.organization?.uuid) === normalizeClaudeOrgId(payload?.orgId))
		: null;
	// Support both old format (from account API) and new OAuth format (from credentials)
	const plan = payload?.subscriptionType
		?? payload?.rateLimitTier
		?? account.plan
		?? account.plan_type
		?? account.planType
		?? account?.subscription?.plan
		?? membership?.organization?.rate_limit_tier
		?? (membership?.organization?.capabilities?.includes("claude_max") ? "claude_max" : null);
	let planDisplay = null;
	if (plan) {
		planDisplay = formatClaudeLabel(
			String(plan)
				.replace(/^default_/, "")
				.replace(/_\d+x$/i, "")
		);
	}
	const label = payload?.label ? ` (${payload.label})` : "";
	const header = `Claude${label}${email ? ` <${email}>` : ""}${planDisplay ? ` (${planDisplay})` : ""}`;

	lines.push(header);
	lines.push("");

	if (!payload || payload.success === false) {
		lines.push(`Error: ${payload?.error ?? "Claude usage unavailable"}`);
		return lines;
	}

	const usage = payload?.usage;
	let renderedUsage = false;
	if (usage && typeof usage === "object") {
		const fiveHour = parseClaudeUtilizationWindow(usage.five_hour ?? usage.fiveHour);
		if (fiveHour && fiveHour.remaining !== null) {
			const reset = formatResetAt(fiveHour.resetsAt);
			lines.push(`5h limit:     ${printBar(fiveHour.remaining)} ${Math.round(fiveHour.remaining)}% left ${reset}`.trimEnd());
			renderedUsage = true;
		}
		const weekly = parseClaudeUtilizationWindow(usage.seven_day ?? usage.sevenDay);
		if (weekly && weekly.remaining !== null) {
			const reset = formatResetAt(weekly.resetsAt);
			lines.push(`Weekly limit: ${printBar(weekly.remaining)} ${Math.round(weekly.remaining)}% left ${reset}`.trimEnd());
			renderedUsage = true;
		}
		const opus = parseClaudeUtilizationWindow(usage.seven_day_opus ?? usage.sevenDayOpus);
		if (opus && opus.remaining !== null) {
			const reset = formatResetAt(opus.resetsAt);
			lines.push(`Opus weekly:  ${printBar(opus.remaining)} ${Math.round(opus.remaining)}% left ${reset}`.trimEnd());
			renderedUsage = true;
		}
		const sonnet = parseClaudeUtilizationWindow(usage.seven_day_sonnet ?? usage.sevenDaySonnet);
		if (sonnet && sonnet.remaining !== null) {
			const reset = formatResetAt(sonnet.resetsAt);
			lines.push(`Sonnet weekly: ${printBar(sonnet.remaining)} ${Math.round(sonnet.remaining)}% left ${reset}`.trimEnd());
			renderedUsage = true;
		}
	}

	if (!renderedUsage) {
		const windows = getClaudeUsageWindows(payload.usage);
		if (windows.length) {
			for (const { label, window } of windows) {
				const parsed = parseClaudeWindow(window);
				if (!parsed) continue;
				const reset = parsed.resetAfterSeconds
					? formatResetTime(parsed.resetAfterSeconds)
					: parsed.resets ? `(resets ${parsed.resets})` : "";
				lines.push(`  ${label}: ${formatClaudePercentLeft(parsed.percentLeft)} ${reset}`.trimEnd());
			}
		} else {
			lines.push("  Usage: (no usage data)");
		}
	}

	const overageLine = formatClaudeOverageLine(payload.overage);
	if (overageLine) {
		lines.push(`  ${overageLine}`);
	}

	if (payload.orgId) {
		lines.push(`  Org: ${payload.orgId}`);
	}

	if (payload.source) {
		lines.push(`  Source: ${shortenPath(payload.source)}`);
	}

	if (payload.errors) {
		const parts = Object.entries(payload.errors).map(([key, value]) => `${key}=${value}`);
		lines.push(`  Partial errors: ${parts.join(", ")}`);
	}

	return lines;
}

function printHelp() {
	console.log(`${PRIMARY_CMD} - Manage and monitor OpenAI Codex and Claude accounts
Version: ${getPackageVersion()}

Usage:
  ${PRIMARY_CMD} <namespace> [command] [options]
  ${PRIMARY_CMD} [label]                       Check quota for all accounts (Codex + Claude)

Namespaces:
  codex             Manage OpenAI Codex accounts
  claude            Manage Claude accounts

Options:
  --json            Output in JSON format
  --no-browser      Print auth URL instead of opening browser
  --no-color        Disable colored output
  --version, -v     Show version number
  --help, -h        Show this help

Examples:
  ${PRIMARY_CMD}                   Check quota for all accounts (Codex + Claude)
  ${PRIMARY_CMD} codex             Show Codex command help
  ${PRIMARY_CMD} claude            Show Claude command help
  ${PRIMARY_CMD} codex quota       Check quota for Codex accounts
  ${PRIMARY_CMD} claude quota      Check quota for Claude accounts
  ${PRIMARY_CMD} codex add work    Add Codex account with label "work"
  ${PRIMARY_CMD} claude add work   Add Claude credential with label "work"
  ${PRIMARY_CMD} codex switch work Switch Codex/OpenCode/pi to "work"
  ${PRIMARY_CMD} claude switch work Switch Claude Code/OpenCode/pi to "work"

Account sources (checked in order):
  1. CODEX_ACCOUNTS env var (JSON array)
  2. ~/.codex-accounts.json
  3. ~/.opencode/openai-codex-auth-accounts.json
  4. ~/.codex/auth.json (Codex CLI format)

OpenCode & pi Integration:
  The 'switch' command updates Codex CLI (~/.codex/auth.json) plus
  OpenCode (~/.local/share/opencode/auth.json) and pi (~/.pi/agent/auth.json)
  authentication files when they exist, enabling seamless account switching.

Run '${PRIMARY_CMD} <namespace> <command> --help' for help on a specific command.
`);
}

function printHelpCodex() {
	console.log(`${PRIMARY_CMD} codex - Manage OpenAI Codex accounts

Usage:
  ${PRIMARY_CMD} codex [command] [options]

Commands:
  quota [label]     Check usage quota (default command)
  add [label]       Add a new account via OAuth browser flow
  switch <label>    Switch active account for Codex CLI, OpenCode, and pi
  list              List all accounts from all sources
  remove <label>    Remove an account from storage

Options:
  --json            Output in JSON format
  --no-browser      Print auth URL instead of opening browser
  --no-color        Disable colored output
  --help, -h        Show this help

Examples:
  ${PRIMARY_CMD} codex                   Check quota for Codex accounts
  ${PRIMARY_CMD} codex personal          Check quota for "personal" account
  ${PRIMARY_CMD} codex add work          Add new account with label "work"
  ${PRIMARY_CMD} codex switch personal   Switch to "personal" account
  ${PRIMARY_CMD} codex list              List all configured accounts
  ${PRIMARY_CMD} codex remove old        Remove "old" account
`);
}

function printHelpClaude() {
	console.log(`${PRIMARY_CMD} claude - Manage Claude credentials

Usage:
  ${PRIMARY_CMD} claude [command] [options]

Commands:
  quota [label]     Check Claude usage (default command)
  add [label]       Add a Claude credential (via OAuth or manual entry)
  switch <label>    Switch Claude Code, OpenCode, and pi credentials
  list              List Claude credentials
  remove <label>    Remove a Claude credential from storage

Options:
  --json            Output result in JSON format
  --oauth           Use OAuth browser authentication (recommended)
  --manual          Use manual token entry
  --no-browser      Print OAuth URL instead of opening browser
  --help, -h        Show this help

Examples:
  ${PRIMARY_CMD} claude                   Check Claude usage
  ${PRIMARY_CMD} claude quota work        Check Claude usage for "work"
  ${PRIMARY_CMD} claude add               Add Claude credential (prompts for method)
  ${PRIMARY_CMD} claude add work --oauth  Add via OAuth browser flow
  ${PRIMARY_CMD} claude switch work       Switch Claude Code/OpenCode/pi to "work"
  ${PRIMARY_CMD} claude list              List Claude credentials
  ${PRIMARY_CMD} claude remove old        Remove Claude credential "old"
`);
}

function printHelpClaudeAdd() {
	console.log(`${PRIMARY_CMD} claude add - Add a Claude credential

Usage:
  ${PRIMARY_CMD} claude add [label] [options]

Arguments:
  label             Optional label for the Claude credential (e.g., "work", "personal")

Options:
  --oauth           Use OAuth browser authentication (recommended)
                    Opens browser for secure authentication
  --manual          Use manual token entry
                    Paste sessionKey or OAuth token directly
  --no-browser      Print OAuth URL instead of opening browser
                    Use this in headless/SSH environments
  --json            Output result in JSON format
  --help, -h        Show this help

Description:
  Adds a Claude credential to ~/.claude-accounts.json.
  
  OAuth flow (recommended):
    1. Opens browser for authentication at claude.ai
    2. User copies code#state from browser
    3. Tool exchanges code for tokens automatically
  
  Manual flow:
    Prompts for sessionKey or OAuth token (one is required).

Examples:
  ${PRIMARY_CMD} claude add                       Interactive (prompts for method)
  ${PRIMARY_CMD} claude add work --oauth          OAuth browser flow
  ${PRIMARY_CMD} claude add work --manual         Manual token entry
	  ${PRIMARY_CMD} claude add work --oauth --no-browser  OAuth without opening browser
	  ${PRIMARY_CMD} claude add work --json           JSON output for scripting
`);
}

function printHelpClaudeSwitch() {
	console.log(`${PRIMARY_CMD} claude switch - Switch Claude credentials

Usage:
  ${PRIMARY_CMD} claude switch <label> [options]

Arguments:
  label             Required. Label of the Claude credential to switch to

Options:
  --json            Output result in JSON format
  --help, -h        Show this help

Description:
  Updates Claude Code (~/.claude/.credentials.json) and, when available,
  OpenCode (~/.local/share/opencode/auth.json) plus pi (~/.pi/agent/auth.json).

  Requires an OAuth-based Claude credential (add with --oauth).

Examples:
  ${PRIMARY_CMD} claude switch work
  ${PRIMARY_CMD} claude switch work --json
`);
}

function printHelpClaudeList() {
	console.log(`${PRIMARY_CMD} claude list - List Claude credentials

Usage:
  ${PRIMARY_CMD} claude list [options]

Options:
  --json            Output in JSON format
  --help, -h        Show this help

Description:
  Lists Claude credentials stored in CLAUDE_ACCOUNTS or ~/.claude-accounts.json.

Examples:
  ${PRIMARY_CMD} claude list
  ${PRIMARY_CMD} claude list --json
`);
}

function printHelpClaudeRemove() {
	console.log(`${PRIMARY_CMD} claude remove - Remove a Claude credential

Usage:
  ${PRIMARY_CMD} claude remove <label> [options]

Arguments:
  label             Required. Label of the Claude credential to remove

Options:
  --json            Output result in JSON format (skips confirmation)
  --help, -h        Show this help

Description:
  Removes a Claude credential from ~/.claude-accounts.json.
  Credentials stored in CLAUDE_ACCOUNTS env var cannot be removed via CLI.

Examples:
  ${PRIMARY_CMD} claude remove old
  ${PRIMARY_CMD} claude remove work --json
`);
}

function printHelpClaudeQuota() {
	console.log(`${PRIMARY_CMD} claude quota - Check Claude usage quota

Usage:
  ${PRIMARY_CMD} claude quota [label] [options]

Arguments:
  label             Optional. Check quota for a specific Claude credential

Options:
  --json            Output in JSON format
  --help, -h        Show this help

Description:
  Displays usage statistics for Claude accounts. Tokens are refreshed when
  available. Uses OAuth credentials when possible and falls back to legacy
  session credentials.

Examples:
  ${PRIMARY_CMD} claude quota
  ${PRIMARY_CMD} claude quota work
  ${PRIMARY_CMD} claude quota --json
`);
}

function printHelpAdd() {
	console.log(`${PRIMARY_CMD} codex add - Add a new account via OAuth browser flow

Usage:
	  ${PRIMARY_CMD} codex add [label] [options]

Arguments:
  label             Optional label for the account (e.g., "work", "personal")
                    If not provided, derived from email address

Options:
  --no-browser      Print the auth URL instead of opening browser
                    Use this in headless/SSH environments
  --json            Output result in JSON format
  --help, -h        Show this help

Description:
  Authenticates with OpenAI via OAuth in your browser and saves the
  account credentials to ~/.codex-accounts.json.
  
  The OAuth flow uses PKCE for security. A local server is started on
  port 1455 to receive the authentication callback.

Examples:
	  ${PRIMARY_CMD} codex add                     Add account (label from email)
	  ${PRIMARY_CMD} codex add work                Add account with label "work"
	  ${PRIMARY_CMD} codex add --no-browser        Print URL for manual browser auth

Environment:
  SSH/headless environments are auto-detected. The URL will be printed
  instead of opening a browser when SSH_CLIENT or SSH_TTY is set, or
  when DISPLAY/WAYLAND_DISPLAY is missing on Linux.
`);
}

function printHelpSwitch() {
	console.log(`${PRIMARY_CMD} codex switch - Switch the active account

Usage:
  ${PRIMARY_CMD} codex switch <label> [options]

Arguments:
  label             Required. Label of the account to switch to

Options:
  --json            Output result in JSON format
  --help, -h        Show this help

Description:
  Switches the active OpenAI account for Codex CLI, OpenCode, and pi.
  
  This command updates authentication files when they exist:
    1. ~/.codex/auth.json - Used by Codex CLI
    2. ~/.local/share/opencode/auth.json - Used by OpenCode (if exists)
    3. ~/.pi/agent/auth.json - Used by pi (if exists)
  
  The OpenCode auth file location respects XDG_DATA_HOME if set.
  If the optional auth files don't exist, only the Codex CLI file is updated.
  
  If the token is expired, it will be refreshed before switching.
  Any existing OPENAI_API_KEY in auth.json is preserved.

Examples:
  ${PRIMARY_CMD} codex switch personal         Switch to "personal" account
  ${PRIMARY_CMD} codex switch work --json      Switch to "work" with JSON output

See also:
  ${PRIMARY_CMD} codex list    Show all available accounts and their labels
`);
}

function printHelpList() {
	console.log(`${PRIMARY_CMD} codex list - List all configured accounts

Usage:
  ${PRIMARY_CMD} codex list [options]

Options:
	  --json            Output in JSON format
	  --help, -h        Show this help

Description:
  Lists all accounts from all configured sources with details:
  - Label and email address
  - Plan type (plus, free, etc.)
  - Token expiry status
  - Source file location
  - Active indicator (* for the current account in ~/.codex/auth.json)
  Accounts are deduplicated by ID to avoid showing duplicates
  when the same account is stored in multiple files.

Output columns:
  * = active        Currently active account
  label             Account identifier
  <email>           Email address from token
  Plan              ChatGPT plan type
  Expires           Token expiry (e.g., "9d 17h", "Expired")
  Source            File path where account is stored

Examples:
  ${PRIMARY_CMD} codex list                    Show all accounts
  ${PRIMARY_CMD} codex list --json             Get JSON output for scripting
`);
}

function printHelpRemove() {
	console.log(`${PRIMARY_CMD} codex remove - Remove an account from storage

Usage:
  ${PRIMARY_CMD} codex remove <label> [options]

Arguments:
  label             Required. Label of the account to remove

Options:
  --json            Output result in JSON format (skips confirmation)
  --help, -h        Show this help

Description:
  Removes an account from the multi-account storage file.
  
  - For accounts in ~/.codex-accounts.json: removes from the file
  - For the codex-cli account (~/.codex/auth.json): deletes the file
  - For accounts in CODEX_ACCOUNTS env var: shows error (modify env directly)

Safety:
  - Prompts for confirmation before removing (unless --json)
  - Warns when removing the last account in a file
  - Warns when removing the codex-cli account (clears authentication)

Examples:
  ${PRIMARY_CMD} codex remove old              Remove "old" account with confirmation
  ${PRIMARY_CMD} codex remove work --json      Remove "work" account (no prompt)

See also:
  ${PRIMARY_CMD} codex list    Show all accounts and their sources
`);
}

function printHelpQuota() {
	console.log(`${PRIMARY_CMD} codex quota - Check usage quota for accounts

Usage:
	  ${PRIMARY_CMD} codex quota [label] [options]

Arguments:
  label             Optional. Check quota for a specific account only
                    If not provided, shows quota for all accounts

Options:
	  --json            Output in JSON format
	  --help, -h        Show this help

Description:
  Displays usage statistics for OpenAI Codex and Claude accounts:
  - Session usage (queries per session)
  - Weekly usage (queries per 7-day period)
  - Available credits

  This command shows Codex usage only. Use '${PRIMARY_CMD} claude quota' for Claude.

  Accounts are deduplicated by ID to avoid showing the same account
  multiple times when sourced from different files.

  Tokens are automatically refreshed if expired.

Examples:
	  ${PRIMARY_CMD} codex quota                 Check all Codex accounts
	  ${PRIMARY_CMD} codex quota personal        Check "personal" account only
	  ${PRIMARY_CMD} codex quota --json          JSON output for all Codex accounts
	  ${PRIMARY_CMD} codex quota work --json     JSON output for "work" account
	  ${PRIMARY_CMD} claude quota                Check Claude accounts
`);
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth PKCE utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate PKCE code verifier and challenge for OAuth flow
 * @returns {{ verifier: string, challenge: string }}
 */
function generatePKCE() {
	// Generate 32 random bytes and encode as base64url
	const verifier = randomBytes(32)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");
	
	// Generate SHA256 hash of verifier and encode as base64url
	const challenge = createHash("sha256")
		.update(verifier)
		.digest("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");
	
	return { verifier, challenge };
}

/**
 * Generate random state string for OAuth CSRF protection
 * @returns {string} 64-character hex string (32 random bytes)
 */
function generateState() {
	return randomBytes(32).toString("hex");
}

/**
 * Build the OAuth authorization URL with all required parameters
 * @param {string} codeChallenge - PKCE code challenge (base64url-encoded SHA256)
 * @param {string} state - Random state string for CSRF protection
 * @returns {string} Complete authorization URL
 */
function buildAuthUrl(codeChallenge, state) {
	const params = new URLSearchParams({
		response_type: "code",
		client_id: CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		scope: SCOPE,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
		state: state,
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
		originator: "codex_cli_rs",
	});
	// Use %20 instead of + for spaces (matches official Codex CLI)
	return `${AUTHORIZE_URL}?${params.toString().replace(/\+/g, "%20")}`;
}

/**
 * Check if a port is available for binding
 * @param {number} port - Port number to check
 * @returns {Promise<boolean>} True if port is available, false if in use
 */
function checkPortAvailable(port) {
	return new Promise((resolve) => {
		const server = createServer();
		
		server.once("error", (err) => {
			if (err.code === "EADDRINUSE") {
				resolve(false);
			} else {
				// Other errors - treat as unavailable to be safe
				resolve(false);
			}
		});
		
		server.once("listening", () => {
			// Port is available - close immediately and report success
			server.close(() => {
				resolve(true);
			});
		});
		
		server.listen(port, "127.0.0.1");
	});
}

/**
 * Detect if running in a headless environment (SSH, no display)
 * Used to determine whether to open browser or print URL for manual copy
 * @returns {boolean} True if headless environment detected
 */
function isHeadlessEnvironment() {
	// Check for SSH session
	if (process.env.SSH_CLIENT || process.env.SSH_TTY) {
		return true;
	}
	
	// On Linux, check for display server
	if (process.platform === "linux") {
		if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
			return true;
		}
	}
	
	return false;
}

/**
 * Open a URL in the default browser, or print URL if headless/--no-browser
 * @param {string} url - URL to open
 * @param {{ noBrowser?: boolean }} options - Options including --no-browser flag
 * @returns {boolean} True if browser was opened, false if URL was printed
 */
function openBrowser(url, options = {}) {
	// If --no-browser flag or headless environment, print URL instead
	if (options.noBrowser || isHeadlessEnvironment()) {
		console.log("\nOpen this URL in your browser to authenticate:");
		console.log(`\n  ${url}\n`);
		return false;
	}
	
	// Platform-specific browser open commands
	let cmd;
	let args;
	
	switch (process.platform) {
		case "darwin":
			cmd = "open";
			args = [url];
			break;
		case "win32":
			cmd = "cmd";
			args = ["/c", "start", "", url];
			break;
		default:
			// Linux and other Unix-like systems
			cmd = "xdg-open";
			args = [url];
			break;
	}
	
	try {
		// Spawn detached process so it doesn't block the CLI
		const child = spawn(cmd, args, {
			detached: true,
			stdio: "ignore",
		});
		
		// Unref to allow the parent process to exit independently
		child.unref();
		
		console.log("\nOpening browser for authentication...");
		return true;
	} catch {
		// If spawn fails, fall back to printing URL
		console.log("\nCould not open browser. Open this URL manually:");
		console.log(`\n  ${url}\n`);
		return false;
	}
}

/**
 * HTML page shown to user after successful OAuth callback
 * Minimal, self-contained page that closes automatically after 3 seconds
 */
const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authentication Successful</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    p { font-size: 1.1rem; opacity: 0.9; }
    .checkmark {
      font-size: 4rem;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="checkmark">✓</div>
    <h1>Authentication Successful</h1>
    <p>You can close this window and return to the terminal.</p>
  </div>
  <script>setTimeout(() => window.close(), 3000);</script>
</body>
</html>`;

/**
 * Error HTML page shown when OAuth callback has an error
 * @param {string} message - Error message to display
 * @returns {string} HTML page content
 */
function getErrorHtml(message) {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authentication Failed</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%);
      color: white;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    p { font-size: 1.1rem; opacity: 0.9; }
    .icon {
      font-size: 4rem;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">✗</div>
    <h1>Authentication Failed</h1>
    <p>${message}</p>
    <p>You can close this window and try again.</p>
  </div>
</body>
</html>`;
}

/**
 * Exchange authorization code for tokens using the OAuth token endpoint
 * @param {string} code - Authorization code from OAuth callback
 * @param {string} codeVerifier - PKCE code verifier used when generating the challenge
 * @returns {Promise<{accessToken: string, refreshToken: string, idToken: string, expires: number, accountId: string, email: string | null}>}
 * @throws {Error} If token exchange fails
 */
async function exchangeCodeForTokens(code, codeVerifier) {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code: code,
		client_id: CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		code_verifier: codeVerifier,
	});
	
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: body.toString(),
	});
	
	if (!res.ok) {
		let errorMessage = `HTTP ${res.status}`;
		try {
			const errorJson = await res.json();
			if (errorJson.error_description) {
				errorMessage = errorJson.error_description;
			} else if (errorJson.error) {
				errorMessage = errorJson.error;
			}
		} catch {
			// Response not JSON - use HTTP status message
		}
		throw new Error(`Token exchange failed: ${errorMessage}`);
	}
	
	const json = await res.json();
	
	// Validate required fields
	if (!json.access_token) {
		throw new Error("Token exchange failed: Missing access_token in response");
	}
	if (!json.refresh_token) {
		throw new Error("Token exchange failed: Missing refresh_token in response");
	}
	if (typeof json.expires_in !== "number") {
		throw new Error("Token exchange failed: Missing or invalid expires_in in response");
	}
	
	// Calculate expires timestamp (milliseconds since epoch)
	const expires = Date.now() + json.expires_in * 1000;
	
	// Extract account_id and email from id_token JWT claims
	const idToken = json.id_token || null;
	let accountId = null;
	let email = null;
	
	// Try to get account_id from access_token first (more reliable)
	accountId = extractAccountId(json.access_token);
	
	// Extract email from id_token if present
	if (idToken) {
		const idPayload = decodeJWT(idToken);
		if (idPayload) {
			email = idPayload.email || null;
			// Fallback: get account_id from id_token if not in access_token
			if (!accountId) {
				accountId = idPayload[JWT_CLAIM]?.chatgpt_account_id || null;
			}
		}
	}
	
	// If still no account_id, try extracting from access_token profile
	if (!accountId) {
		const profile = extractProfile(json.access_token);
		email = email || profile.email;
	}
	
	if (!accountId) {
		throw new Error("Token exchange failed: Could not extract account_id from tokens");
	}
	
	return {
		accessToken: json.access_token,
		refreshToken: json.refresh_token,
		idToken: idToken,
		expires: expires,
		accountId: accountId,
		email: email,
	};
}

/**
 * Start local HTTP server to receive OAuth callback
 * Server listens on port 1455 for /auth/callback path
 * @param {string} expectedState - State string to verify against CSRF attacks
 * @returns {Promise<{code: string, state: string}>} Resolves with auth code and state, rejects on error/timeout
 */
function startCallbackServer(expectedState) {
	return new Promise((resolve, reject) => {
		let serverClosed = false;
		let timeoutId = null;
		let sigintHandler = null;
		
		const server = createHttpServer((req, res) => {
			// Only handle /auth/callback path
			const url = new URL(req.url, `http://${req.headers.host}`);
			
			if (url.pathname !== "/auth/callback") {
				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("Not Found");
				return;
			}
			
			// Parse query parameters
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			const error = url.searchParams.get("error");
			const errorDescription = url.searchParams.get("error_description");
			
			// Handle error response from OAuth provider
			if (error) {
				const message = errorDescription || error;
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(getErrorHtml(message));
				cleanup();
				reject(new Error(`OAuth error: ${message}`));
				return;
			}
			
			// Validate required parameters
			if (!code) {
				res.writeHead(400, { "Content-Type": "text/html" });
				res.end(getErrorHtml("Missing authorization code"));
				cleanup();
				reject(new Error("Missing authorization code in callback"));
				return;
			}
			
			if (!state) {
				res.writeHead(400, { "Content-Type": "text/html" });
				res.end(getErrorHtml("Missing state parameter"));
				cleanup();
				reject(new Error("Missing state parameter in callback"));
				return;
			}
			
			// Verify state matches to prevent CSRF attacks
			if (state !== expectedState) {
				res.writeHead(400, { "Content-Type": "text/html" });
				res.end(getErrorHtml("State mismatch - possible CSRF attack"));
				cleanup();
				reject(new Error("State mismatch. Possible CSRF attack."));
				return;
			}
			
			// Success! Serve success page and resolve
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(SUCCESS_HTML);
			cleanup();
			resolve({ code, state });
		});
		
		/**
		 * Clean up server resources
		 */
		function cleanup() {
			if (serverClosed) return;
			serverClosed = true;
			
			// Clear timeout
			if (timeoutId) {
				clearTimeout(timeoutId);
				timeoutId = null;
			}
			
			// Remove SIGINT handler
			if (sigintHandler) {
				process.removeListener("SIGINT", sigintHandler);
				sigintHandler = null;
			}
			
			// Close server
			server.close();
		}
		
		// Handle server errors
		server.on("error", (err) => {
			cleanup();
			if (err.code === "EADDRINUSE") {
				reject(new Error(`Port 1455 is in use. Close other ${PRIMARY_CMD} instances and retry.`));
			} else {
				reject(new Error(`Server error: ${err.message}`));
			}
		});
		
		// Set timeout for authentication (default 2 minutes)
		timeoutId = setTimeout(() => {
			cleanup();
			reject(new Error(`Authentication timed out after 2 minutes. Run '${PRIMARY_CMD} codex add' to try again.`));
		}, OAUTH_TIMEOUT_MS);
		
		// Handle Ctrl+C gracefully
		sigintHandler = () => {
			console.log("\nAuthentication cancelled.");
			cleanup();
			reject(new Error("Authentication cancelled by user."));
		};
		process.on("SIGINT", sigintHandler);
		
		// Start listening on localhost only (security)
		server.listen(1455, "127.0.0.1", () => {
			// Server is ready - caller will open browser
		});
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude OAuth browser flow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the Claude OAuth authorization URL with PKCE
 * Claude uses a device code flow where users copy code#state from the browser
 * @param {string} codeChallenge - PKCE code challenge (base64url-encoded SHA256)
 * @param {string} state - Random state string for CSRF protection
 * @returns {string} Complete authorization URL
 */
function buildClaudeAuthUrl(codeChallenge, state) {
	const params = new URLSearchParams({
		response_type: "code",
		client_id: CLAUDE_OAUTH_CLIENT_ID,
		redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
		scope: CLAUDE_OAUTH_SCOPES,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
		state: state,
		code: "true", // Display code in browser for user to copy
	});
	// Use %20 instead of + for spaces
	return `${CLAUDE_OAUTH_AUTHORIZE_URL}?${params.toString().replace(/\+/g, "%20")}`;
}

/**
 * Parse user input containing Claude OAuth code and state
 * Accepts formats:
 *   - "code#state" (code with state suffix)
 *   - "code" (code only, state validation skipped)
 *   - Full callback URL: https://console.anthropic.com/oauth/code/callback?code=...&state=...
 * @param {string} input - User input string
 * @param {string} expectedState - Expected state for CSRF validation
 * @returns {{ code: string, state: string | null }} Parsed code and optional state
 */
function parseClaudeCodeState(input) {
	const trimmed = (input ?? "").trim();
	if (!trimmed) {
		return { code: null, state: null };
	}

	// Check if it's a full callback URL
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
		try {
			const url = new URL(trimmed);
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			return { code: code || null, state: state || null };
		} catch {
			return { code: null, state: null };
		}
	}

	// Check for code#state format
	if (trimmed.includes("#")) {
		const [code, state] = trimmed.split("#", 2);
		return { code: code || null, state: state || null };
	}

	// Plain code only
	return { code: trimmed, state: null };
}

/**
 * Exchange Claude authorization code for tokens
 * @param {string} code - Authorization code from callback
 * @param {string} codeVerifier - PKCE code verifier
 * @param {string} state - OAuth state for CSRF validation
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresIn: number }>}
 */
async function exchangeClaudeCodeForTokens(code, codeVerifier, state) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), OAUTH_TIMEOUT_MS);

	try {
		const body = {
			grant_type: "authorization_code",
			code: code,
			state: state,
			redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
			client_id: CLAUDE_OAUTH_CLIENT_ID,
			code_verifier: codeVerifier,
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
			throw new Error(`Token exchange failed: ${response.status} ${text}`);
		}

		const data = await response.json();

		return {
			accessToken: data.access_token,
			refreshToken: data.refresh_token || null,
			expiresIn: data.expires_in || 3600,
		};
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Refresh a Claude OAuth token using the refresh token
 * @param {string} refreshToken - The refresh token
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresIn: number }>}
 */
async function refreshClaudeToken(refreshToken) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), OAUTH_TIMEOUT_MS);

	try {
		const body = {
			grant_type: "refresh_token",
			refresh_token: refreshToken,
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
			refreshToken: data.refresh_token || refreshToken,
			expiresIn: data.expires_in || 3600,
		};
	} finally {
		clearTimeout(timeout);
	}
}

function isClaudeOauthTokenExpiring(expiresAt) {
	if (!expiresAt) return false;
	return expiresAt <= Date.now() + CLAUDE_OAUTH_REFRESH_BUFFER_MS;
}

/**
 * Ensure a Claude OAuth access token is fresh, refreshing and persisting if needed.
 * @param {{ label: string, accessToken: string, refreshToken?: string | null, expiresAt?: number | null, scopes?: string[] | null, source?: string }} account
 * @returns {Promise<boolean>}
 */
async function ensureFreshClaudeOAuthToken(account) {
	if (!isClaudeOauthTokenExpiring(account.expiresAt)) return true;
	if (!account.refreshToken) return false;

	const previousAccessToken = account.accessToken;
	const previousRefreshToken = account.refreshToken;

	try {
		const refreshed = await refreshClaudeToken(account.refreshToken);
		if (!refreshed?.accessToken) return false;
		account.accessToken = refreshed.accessToken;
		account.refreshToken = refreshed.refreshToken ?? account.refreshToken;
		account.expiresAt = Date.now() + refreshed.expiresIn * 1000;
		persistClaudeOAuthTokens(account, {
			previousAccessToken,
			previousRefreshToken,
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Run the Claude OAuth browser flow to get tokens
 * @param {{ noBrowser: boolean }} flags - CLI flags
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: number, scopes: string }>}
 */
async function handleClaudeOAuthFlow(flags) {
	// 1. Generate PKCE code verifier and challenge
	const { verifier, challenge } = generatePKCE();

	// 2. Generate random state for CSRF protection
	const state = generateState();

	// 3. Build authorization URL
	const authUrl = buildClaudeAuthUrl(challenge, state);

	// 4. Print instructions
	console.log("\nStarting Claude OAuth authentication...\n");

	// 5. Open browser or print URL
	openBrowser(authUrl, { noBrowser: flags.noBrowser });

	// 6. Prompt user to paste code
	console.log("After authenticating in the browser, you will see a code.");
	console.log("Copy the entire code (including any #state portion) and paste it below.\n");

	const input = await promptInput("Paste code#state here: ");
	const { code, state: returnedState } = parseClaudeCodeState(input);

	if (!code) {
		throw new Error("No authorization code provided. Authentication cancelled.");
	}

	// 7. Validate state if provided (CSRF protection)
	if (returnedState && returnedState !== state) {
		throw new Error("State mismatch. Possible CSRF attack. Please try again.");
	}

	// 8. Exchange code for tokens
	console.log("\nExchanging code for tokens...");
	const stateToSend = returnedState ?? state;
	const tokens = await exchangeClaudeCodeForTokens(code, verifier, stateToSend);

	// 9. Calculate expiry timestamp
	const expiresAt = Date.now() + (tokens.expiresIn * 1000);

	return {
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		expiresAt: expiresAt,
		scopes: CLAUDE_OAUTH_SCOPES,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcommand handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle add subcommand - add a new OAuth account via browser flow
 * @param {string[]} args - Non-flag arguments (e.g., optional label)
 * @param {{ json: boolean, noBrowser: boolean }} flags - Parsed flags
 */
async function handleAdd(args, flags) {
	// Extract optional label from args (can be overridden after auth)
	let label = args[0] || null;
	
	try {
		// 1. Check if port is available before starting
		const portAvailable = await checkPortAvailable(1455);
		if (!portAvailable) {
			throw new Error(`Port 1455 is in use. Close other ${PRIMARY_CMD} instances and retry.`);
		}
		
		// 2. Generate PKCE code verifier and challenge
		const { verifier, challenge } = generatePKCE();
		
		// 3. Generate random state for CSRF protection
		const state = generateState();
		
		// 4. Build authorization URL
		const authUrl = buildAuthUrl(challenge, state);
		
		// 5. Print starting message
		console.log("Starting OAuth authentication...");
		
		// 6. Start callback server (in background)
		const callbackPromise = startCallbackServer(state);
		
		// 7. Open browser or print URL
		openBrowser(authUrl, { noBrowser: flags.noBrowser });
		
		// 8. Wait for callback with auth code
		console.log("Waiting for browser authentication...");
		const { code, state: returnedState } = await callbackPromise;
		
		// 9. Verify state matches (already done in startCallbackServer, but double-check)
		if (returnedState !== state) {
			throw new Error("State mismatch. Possible CSRF attack.");
		}
		
		// 10. Exchange code for tokens
		console.log("Exchanging code for tokens...");
		const tokens = await exchangeCodeForTokens(code, verifier);
		
		// 11. Derive label from email if not provided
		if (!label && tokens.email) {
			// Use email prefix as suggested label (e.g., "john" from "john@example.com")
			label = tokens.email.split("@")[0].toLowerCase().replace(/[^a-z0-9_-]/g, "");
		}
		if (!label) {
			// Fallback to generic label with timestamp
			label = `account-${Date.now()}`;
		}
		
		// 12. Check for duplicate labels
		const existingLabels = getAllLabels();
		if (existingLabels.includes(label)) {
			throw new Error(`Label "${label}" already exists. Use a different label or remove the existing one.\nExisting labels: ${existingLabels.join(", ")}`);
		}
		
		// 13. Validate label format (alphanumeric with hyphens/underscores)
		if (!/^[a-zA-Z0-9_-]+$/.test(label)) {
			throw new Error(`Invalid label "${label}". Use only letters, numbers, hyphens, and underscores.`);
		}
		
		// 14. Create new account object
		const newAccount = {
			label: label,
			accountId: tokens.accountId,
			access: tokens.accessToken,
			refresh: tokens.refreshToken,
			idToken: tokens.idToken,
			expires: tokens.expires,
		};
		
		// 15. Determine target file and save
		const targetPath = MULTI_ACCOUNT_PATHS[0]; // ~/.codex-accounts.json
		let accounts = [];
		
		// Read existing accounts if file exists
		if (existsSync(targetPath)) {
			try {
				const raw = readFileSync(targetPath, "utf-8");
				const parsed = JSON.parse(raw);
				accounts = Array.isArray(parsed) ? parsed : parsed?.accounts ?? [];
			} catch {
				// If file is corrupted, start fresh
				accounts = [];
			}
		}
		
		// Append new account
		accounts.push(newAccount);
		
		// Write to file atomically (write to temp, then rename)
		const dir = dirname(targetPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		
		writeFileAtomic(targetPath, JSON.stringify({ accounts }, null, 2) + "\n", { mode: 0o600 });
		
		// 16. Print success message (human-readable OR JSON, not both)
		if (flags.json) {
			console.log(JSON.stringify({
				success: true,
				label: label,
				email: tokens.email,
				accountId: tokens.accountId,
				source: targetPath,
			}, null, 2));
		} else {
			const emailDisplay = tokens.email ? ` <${tokens.email}>` : "";
		const lines = [
			colorize(`Added account ${label}${emailDisplay}`, GREEN),
			"",
			`Saved to: ${shortenPath(targetPath)}`,
			"",
			`Run 'cq codex switch ${label}' to activate this account`,
		];
			const boxLines = drawBox(lines);
			console.log(boxLines.join("\n"));
		}
	} catch (error) {
		// Handle specific error types with user-friendly messages (JSON OR human-readable, not both)
		if (flags.json) {
			console.log(JSON.stringify({
				success: false,
				error: error.message,
			}, null, 2));
		} else if (error.message.includes("Port 1455")) {
			console.error(colorize(`Error: ${error.message}`, RED));
		} else if (error.message.includes("timed out")) {
			console.error(colorize(`Error: ${error.message}`, RED));
		} else if (error.message.includes("cancelled")) {
			console.error(colorize(`Error: ${error.message}`, RED));
		} else if (error.message.includes("State mismatch")) {
			console.error(colorize("Error: State mismatch. Possible CSRF attack.", RED));
		} else if (error.message.includes("Token exchange failed")) {
			console.error(colorize(`Error: ${error.message}`, RED));
		} else if (error.message.includes("OAuth error")) {
			console.error(colorize(`Error: Authentication was denied or cancelled.`, RED));
		} else {
			console.error(colorize(`Error: ${error.message}`, RED));
		}
		
		process.exit(1);
	}
}

/**
 * Handle switch subcommand - switch active account for Codex CLI/OpenCode/pi auth files
 * @param {string[]} args - Non-flag arguments (label is required)
 * @param {{ json: boolean }} flags - Parsed flags
 */
async function handleSwitch(args, flags) {
	// 1. Extract required label
	const label = args[0];
	if (!label) {
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: "Missing required label argument" }, null, 2));
		} else {
			console.error(colorize(`Usage: ${PRIMARY_CMD} codex switch <label>`, RED));
			console.error("Switches the active account in ~/.codex/auth.json");
		}
		process.exit(1);
	}
	
	try {
		// 2. Find account by label from all sources
		const account = findAccountByLabel(label);
		if (!account) {
			const allLabels = getAllLabels();
			if (flags.json) {
				console.log(JSON.stringify({ 
					success: false, 
					error: `Account "${label}" not found`,
					availableLabels: allLabels,
				}, null, 2));
			} else if (allLabels.length === 0) {
				console.error(colorize(`Account "${label}" not found. No accounts configured.`, RED));
				console.error(`Run '${PRIMARY_CMD} codex add' to add an account via OAuth.`);
			} else {
				console.error(colorize(`Account "${label}" not found.`, RED));
				console.error(`Available: ${allLabels.join(", ")}`);
			}
			process.exit(1);
		}
		
		// 3. Refresh token if needed (create a temporary array for ensureFreshToken)
		const accountsForRefresh = [account];
		const tokenOk = await ensureFreshToken(account, accountsForRefresh);
		if (!tokenOk) {
			if (flags.json) {
				console.log(JSON.stringify({ 
					success: false, 
					error: `Failed to refresh token for "${label}". Re-authentication may be required.`,
				}, null, 2));
			} else {
				console.error(colorize(`Error: Failed to refresh token for "${label}". Re-authentication may be required.`, RED));
				console.error(`Run '${PRIMARY_CMD} codex add' to re-authenticate this account.`);
			}
			process.exit(1);
		}
		
		// 4. Read existing ~/.codex/auth.json to preserve OPENAI_API_KEY
		let existingAuth = {};
		const codexAuthPath = getCodexCliAuthPath();
		if (existsSync(codexAuthPath)) {
			try {
				const raw = readFileSync(codexAuthPath, "utf-8");
				existingAuth = JSON.parse(raw);
			} catch {
				// If corrupted, start fresh
				existingAuth = {};
			}
		}
		
		// 5. Build new auth.json structure (matching Codex CLI format)
		const tokens = {
			access_token: account.access,
			refresh_token: account.refresh,
			account_id: account.accountId,
			expires_at: Math.floor(account.expires / 1000), // Convert ms to seconds
		};
		
		// Only include id_token if it exists (Codex CLI rejects null)
		if (account.idToken) {
			tokens.id_token = account.idToken;
		}
		
		const newAuth = {
			// Preserve existing OPENAI_API_KEY if present
			...(existingAuth.OPENAI_API_KEY !== undefined ? { OPENAI_API_KEY: existingAuth.OPENAI_API_KEY } : {}),
			tokens,
			last_refresh: new Date().toISOString(),
			// Track which managed account we switched to (for detecting native login divergence)
			codex_quota_label: label,
		};
		
		// 6. Create ~/.codex directory if needed
		const codexDir = dirname(codexAuthPath);
		if (!existsSync(codexDir)) {
			mkdirSync(codexDir, { recursive: true });
		}
		
		// 7. Write auth.json atomically (temp file + rename) with 0600 permissions
		writeFileAtomic(codexAuthPath, JSON.stringify(newAuth, null, 2) + "\n", { mode: 0o600 });
		
		// 8. Update OpenCode auth.json if present
		const opencodeUpdate = updateOpencodeAuth(account);
		if (opencodeUpdate.error && !flags.json) {
			console.error(colorize(`Warning: ${opencodeUpdate.error}`, YELLOW));
		}
		
		// 9. Update pi auth.json if present
		const piUpdate = updatePiAuth(account);
		if (piUpdate.error && !flags.json) {
			console.error(colorize(`Warning: ${piUpdate.error}`, YELLOW));
		}
		
		// 10. Get profile info for display
		const profile = extractProfile(account.access);
		
		// 11. Print confirmation (JSON OR human-readable, not both)
		if (flags.json) {
			const output = {
				success: true,
				label: label,
				email: profile.email,
				accountId: account.accountId,
				authPath: codexAuthPath,
			};
			if (opencodeUpdate.updated) {
				output.opencodeAuthPath = opencodeUpdate.path;
			} else if (opencodeUpdate.error) {
				output.opencodeAuthError = opencodeUpdate.error;
			}
			if (piUpdate.updated) {
				output.piAuthPath = piUpdate.path;
			} else if (piUpdate.error) {
				output.piAuthError = piUpdate.error;
			}
			console.log(JSON.stringify(output, null, 2));
		} else {
			const emailDisplay = profile.email ? ` <${profile.email}>` : "";
			const planDisplay = profile.planType ? ` (${profile.planType})` : "";
			const lines = [
				colorize(`Switched to ${label}${emailDisplay}${planDisplay}`, GREEN),
				"",
				`Codex CLI: ${shortenPath(codexAuthPath)}`,
			];
			if (opencodeUpdate.updated) {
				lines.push(`OpenCode:  ${shortenPath(opencodeUpdate.path)}`);
			}
			if (piUpdate.updated) {
				lines.push(`pi:        ${shortenPath(piUpdate.path)}`);
			}
			const boxLines = drawBox(lines);
			console.log(boxLines.join("\n"));
		}
	} catch (error) {
		if (flags.json) {
			console.log(JSON.stringify({
				success: false,
				error: error.message,
			}, null, 2));
		} else {
			console.error(colorize(`Error: ${error.message}`, RED));
		}
		
		process.exit(1);
	}
}

/**
 * Get the currently active account_id from ~/.codex/auth.json
 * @returns {string | null} Active account ID or null if not found
 */
function getActiveAccountId() {
	const codexAuthPath = getCodexCliAuthPath();
	if (!existsSync(codexAuthPath)) return null;
	
	try {
		const raw = readFileSync(codexAuthPath, "utf-8");
		const parsed = JSON.parse(raw);
		const tokens = parsed?.tokens;
		if (tokens?.access_token) {
			return extractAccountId(tokens.access_token);
		}
	} catch {
		// Invalid JSON or read error
	}
	return null;
}

/**
 * Get detailed info about the currently active account from ~/.codex/auth.json
 * Includes tracked label if set by codex-quota switch command
 * @returns {{ accountId: string | null, trackedLabel: string | null, source: "codex-quota" | "native" | null }}
 */
function getActiveAccountInfo() {
	const codexAuthPath = getCodexCliAuthPath();
	if (!existsSync(codexAuthPath)) {
		return { accountId: null, trackedLabel: null, source: null };
	}
	
	try {
		const raw = readFileSync(codexAuthPath, "utf-8");
		const parsed = JSON.parse(raw);
		const tokens = parsed?.tokens;
		const trackedLabel = parsed?.codex_quota_label ?? null;
		
		if (tokens?.access_token) {
			const accountId = extractAccountId(tokens.access_token);
			// Determine source: if we have our label marker, it was set by codex-quota
			const source = trackedLabel ? "codex-quota" : "native";
			return { accountId, trackedLabel, source };
		}
	} catch {
		// Invalid JSON or read error
	}
	return { accountId: null, trackedLabel: null, source: null };
}

/**
 * Format expiry time as human-readable duration
 * @param {number | undefined} expires - Expiry timestamp in milliseconds
 * @returns {{ status: string, display: string }} Status and display string
 */
function formatExpiryStatus(expires) {
	if (!expires) {
		return { status: "unknown", display: "Unknown" };
	}
	
	const now = Date.now();
	const diff = expires - now;
	
	if (diff <= 0) {
		return { status: "expired", display: "Expired" };
	}
	
	// Warn if expiring within 5 minutes
	if (diff < 5 * 60 * 1000) {
		const mins = Math.ceil(diff / 60000);
		return { status: "expiring", display: `Expiring in ${mins}m` };
	}
	
	// Format remaining time
	const hours = Math.floor(diff / (60 * 60 * 1000));
	const mins = Math.floor((diff % (60 * 60 * 1000)) / 60000);
	
	if (hours > 24) {
		const days = Math.floor(hours / 24);
		const remainingHours = hours % 24;
		return { status: "valid", display: `${days}d ${remainingHours}h` };
	}
	
	if (hours > 0) {
		return { status: "valid", display: `${hours}h ${mins}m` };
	}
	
	return { status: "valid", display: `${mins}m` };
}

/**
 * Shorten a path for display (replace home directory with ~)
 * @param {string} filePath - Full file path
 * @returns {string} Shortened path
 */
function shortenPath(filePath) {
	const home = homedir();
	if (filePath.startsWith(home)) {
		return "~" + filePath.slice(home.length);
	}
	return filePath;
}

/**
 * Handle list subcommand - list all accounts from all sources
 * @param {{ json: boolean }} flags - Parsed flags
 */
async function handleList(flags) {
	const accounts = loadAllAccounts();
	
	// Handle zero accounts case
	if (!accounts.length) {
		if (flags.json) {
			console.log(JSON.stringify({ accounts: [] }, null, 2));
			return;
		}
		console.log("No accounts found.");
		console.log("\nSearched:");
		console.log("  - CODEX_ACCOUNTS env var");
		for (const p of MULTI_ACCOUNT_PATHS) {
			console.log(`  - ${p}`);
		}
		console.log(`  - ${getCodexCliAuthPath()}`);
	console.log(`\nRun '${PRIMARY_CMD} codex add' to add an account via OAuth.`);
		return;
	}
	
	// Get active account info from ~/.codex/auth.json
	const activeInfo = getActiveAccountInfo();
	const { accountId: activeAccountId, trackedLabel, source: authSource } = activeInfo;
	
	// Detect divergence: native login occurred if accountId exists but trackedLabel doesn't match
	// any managed account, or if authSource is "native"
	let divergenceDetected = false;
	let nativeAccountId = null;
	
	if (activeAccountId && authSource === "native") {
		// Native login detected (no codex_quota_label in auth.json)
		divergenceDetected = true;
		nativeAccountId = activeAccountId;
	}
	
	// Build account details for each account
	const accountDetails = accounts.map(account => {
		const profile = extractProfile(account.access);
		const expiry = formatExpiryStatus(account.expires);
		
		// isActive: matches our tracked label (set by codex-quota switch)
		const isActive = trackedLabel !== null && account.label === trackedLabel;
		
		// isNativeActive: accountId matches but not tracked by us (native login)
		const isNativeActive = !isActive && account.accountId === nativeAccountId;
		
		return {
			label: account.label,
			email: profile.email,
			accountId: account.accountId,
			planType: profile.planType,
			expires: account.expires,
			expiryStatus: expiry.status,
			expiryDisplay: expiry.display,
			source: account.source,
			isActive,
			isNativeActive,
		};
	});
	
	// JSON output
	if (flags.json) {
		const output = {
			accounts: accountDetails,
			activeInfo: {
				trackedLabel,
				accountId: activeAccountId,
				source: authSource,
				divergence: divergenceDetected,
			},
		};
		console.log(JSON.stringify(output, null, 2));
		return;
	}
	
	// Human-readable output with box styling
	const lines = [];
	if (accounts.length) {
		lines.push(`Accounts (${accounts.length} total)`);
		lines.push("");
	}
	
	for (let i = 0; i < accountDetails.length; i++) {
		const detail = accountDetails[i];
		
		// Active indicator:
		// * = active account set by codex-quota
		// ~ = native login (not set by us, but currently active in auth.json)
		//   = inactive
		let activeMarker = " ";
		let statusText = "";
		if (detail.isActive) {
			activeMarker = "*";
			statusText = " [active]";
		} else if (detail.isNativeActive) {
			activeMarker = "~";
			statusText = " [native]";
		}
		
		// Label and email with plan
		const emailDisplay = detail.email ? ` <${detail.email}>` : "";
		const planDisplay = detail.planType ? ` (${detail.planType})` : "";
		lines.push(`${activeMarker} ${detail.label}${emailDisplay}${planDisplay}${statusText}`);
		
		// Details line with expiry and source
		const expiryColor = detail.expiryStatus === "expired" ? "Expired" : 
		                    detail.expiryStatus === "expiring" ? detail.expiryDisplay :
		                    `Expires: ${detail.expiryDisplay}`;
		lines.push(`  ${expiryColor} | ${shortenPath(detail.source)}`);
		
		// Add spacing between accounts (but not after the last one)
		if (i < accountDetails.length - 1) {
			lines.push("");
		}
	}
	
	// Legend - show appropriate legend based on what markers are present
	const hasActive = accountDetails.some(a => a.isActive);
	const hasNativeActive = accountDetails.some(a => a.isNativeActive);
	
	if (hasActive || hasNativeActive) {
		lines.push("");
		if (hasActive) {
			lines.push("* = active (set by cq codex switch)");
		}
		if (hasNativeActive) {
			lines.push("~ = native login (run 'cq codex switch' to manage)");
		}
	}

	if (lines.length) {
		const boxLines = drawBox(lines);
		console.log(boxLines.join("\n"));
	}

}

/**
 * Handle Claude list subcommand - list Claude credentials
 * @param {{ json: boolean }} flags - Parsed flags
 */
async function handleClaudeList(flags) {
	const claudeAccounts = loadClaudeAccounts();

	if (!claudeAccounts.length) {
		if (flags.json) {
			console.log(JSON.stringify({ accounts: [] }, null, 2));
			return;
		}
		console.log("No Claude accounts found.");
		console.log("\nSearched:");
		console.log("  - CLAUDE_ACCOUNTS env var");
		for (const p of CLAUDE_MULTI_ACCOUNT_PATHS) {
			console.log(`  - ${p}`);
		}
		console.log(`\nRun '${PRIMARY_CMD} claude add' to add a Claude credential.`);
		return;
	}

	if (flags.json) {
		const output = {
			accounts: claudeAccounts.map(account => ({
				label: account.label,
				source: account.source,
				hasSessionKey: Boolean(account.sessionKey ?? findClaudeSessionKey(account.cookies)),
				hasOauthToken: Boolean(account.oauthToken),
				orgId: account.orgId ?? null,
			})),
		};
		console.log(JSON.stringify(output, null, 2));
		return;
	}

	const claudeLines = [];
	claudeLines.push(`Claude Accounts (${claudeAccounts.length} total)`);
	claudeLines.push("");
	for (let i = 0; i < claudeAccounts.length; i++) {
		const account = claudeAccounts[i];
		const authParts = [];
		if (account.sessionKey ?? findClaudeSessionKey(account.cookies)) {
			authParts.push("sessionKey");
		}
		if (account.oauthToken) {
			authParts.push("oauthToken");
		}
		const authDisplay = authParts.length ? authParts.join("+") : "unknown";
		claudeLines.push(`${account.label}`);
		claudeLines.push(`  Auth: ${authDisplay} | ${shortenPath(account.source)}`);
		if (i < claudeAccounts.length - 1) {
			claudeLines.push("");
		}
	}
	const claudeBox = drawBox(claudeLines);
	console.log(claudeBox.join("\n"));
}

/**
 * Prompt for confirmation using readline
 * @param {string} message - Message to display
 * @returns {Promise<boolean>} True if user confirms (y/Y), false otherwise
 */
async function promptConfirm(message) {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	
	return new Promise((resolve) => {
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y");
		});
	});
}

async function promptInput(message, options = {}) {
	const { allowEmpty = false } = options;
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => {
		rl.question(message, (answer) => {
			rl.close();
			if (allowEmpty) {
				resolve(answer);
				return;
			}
			resolve(answer.trim());
		});
	});
}

/**
 * Handle remove subcommand - remove an account from multi-account file
 * @param {string[]} args - Non-flag arguments (label is required)
 * @param {{ json: boolean }} flags - Parsed flags
 */
async function handleRemove(args, flags) {
	const label = args[0];
	if (!label) {
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: "Missing required label argument" }, null, 2));
		} else {
			console.error(colorize(`Usage: ${PRIMARY_CMD} codex remove <label>`, RED));
			console.error("Removes an account from the multi-account file.");
		}
		process.exit(1);
	}
	
	// Find the account
	const account = findAccountByLabel(label);
	if (!account) {
		const availableLabels = getAllLabels();
		if (flags.json) {
			console.log(JSON.stringify({ 
				success: false, 
				error: `Account "${label}" not found`,
				availableLabels 
			}, null, 2));
		} else {
			console.error(colorize(`Account "${label}" not found.`, RED));
			if (availableLabels.length) {
				console.error(`Available labels: ${availableLabels.join(", ")}`);
			} else {
				console.error("No accounts configured.");
			}
		}
		process.exit(1);
	}
	
	const source = account.source;
	
	// Check source type
	if (source === "env") {
		if (flags.json) {
			console.log(JSON.stringify({ 
				success: false, 
				error: "Cannot remove account from CODEX_ACCOUNTS env var. Modify the env var directly." 
			}, null, 2));
		} else {
			console.error(colorize("Cannot remove account from CODEX_ACCOUNTS env var.", RED));
			console.error("Modify the env var directly to remove this account.");
		}
		process.exit(1);
	}
	
	// Handle Codex CLI auth.json (single account file)
	const codexAuthPath = getCodexCliAuthPath();
	if (source === codexAuthPath) {
		if (!flags.json) {
			console.log(colorize("Warning: This will clear your Codex CLI authentication.", YELLOW));
			console.log(`You will need to re-authenticate using 'codex auth' or '${PRIMARY_CMD} codex add'.`);
			const confirmed = await promptConfirm("Continue?");
			if (!confirmed) {
				console.log("Cancelled.");
				process.exit(0);
			}
		}
		
		// Delete the auth.json file
		try {
			unlinkSync(codexAuthPath);
			if (flags.json) {
				console.log(JSON.stringify({ 
					success: true, 
					label, 
					source: shortenPath(codexAuthPath),
					message: "Codex CLI auth cleared" 
				}, null, 2));
			} else {
				const lines = [
					colorize(`Removed account ${label}`, GREEN),
					"",
					`Deleted: ${shortenPath(codexAuthPath)}`,
				];
				console.log(drawBox(lines).join("\n"));
			}
		} catch (err) {
			if (flags.json) {
				console.log(JSON.stringify({ success: false, error: err.message }, null, 2));
			} else {
				console.error(colorize(`Error removing auth file: ${err.message}`, RED));
			}
			process.exit(1);
		}
		return;
	}
	
	// Handle multi-account files
	// Count accounts in the same source file
	const allAccounts = loadAllAccounts();
	const accountsInSameFile = allAccounts.filter(a => a.source === source);
	
	if (accountsInSameFile.length === 1) {
		if (!flags.json) {
			console.log(colorize("Warning: This is the only account in this file.", YELLOW));
			console.log(`The file will be deleted: ${shortenPath(source)}`);
			const confirmed = await promptConfirm("Continue?");
			if (!confirmed) {
				console.log("Cancelled.");
				process.exit(0);
			}
		}
	}
	
	// Read the file directly (to preserve any extra fields)
	let existingAccounts = [];
	try {
		const raw = readFileSync(source, "utf-8");
		const parsed = JSON.parse(raw);
		existingAccounts = Array.isArray(parsed) ? parsed : parsed?.accounts ?? [];
	} catch {
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: `Failed to read ${source}` }, null, 2));
		} else {
			console.error(colorize(`Error reading ${source}`, RED));
		}
		process.exit(1);
	}
	
	// Filter out the account with matching label
	const updatedAccounts = existingAccounts.filter(a => a.label !== label);
	
	if (updatedAccounts.length === existingAccounts.length) {
		// This shouldn't happen if findAccountByLabel worked, but handle it gracefully
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: `Account "${label}" not found in ${source}` }, null, 2));
		} else {
			console.error(colorize(`Account "${label}" not found in ${shortenPath(source)}`, RED));
		}
		process.exit(1);
	}
	
	// Write back or delete
	try {
		if (updatedAccounts.length === 0) {
			// No accounts left - delete the file
			unlinkSync(source);
			if (flags.json) {
				console.log(JSON.stringify({ 
					success: true, 
					label, 
					source: shortenPath(source),
					message: "File deleted (no accounts remaining)" 
				}, null, 2));
			} else {
				const lines = [
					colorize(`Removed account ${label}`, GREEN),
					"",
					`Deleted: ${shortenPath(source)} (no accounts remaining)`,
				];
				console.log(drawBox(lines).join("\n"));
			}
		} else {
			// Write updated accounts atomically
			const output = { accounts: updatedAccounts };
			writeFileAtomic(source, JSON.stringify(output, null, 2) + "\n", { mode: 0o600 });
			
			if (flags.json) {
				console.log(JSON.stringify({ 
					success: true, 
					label, 
					source: shortenPath(source),
					remainingAccounts: updatedAccounts.length 
				}, null, 2));
			} else {
				const lines = [
					colorize(`Removed account ${label}`, GREEN),
					"",
					`Updated: ${shortenPath(source)} (${updatedAccounts.length} account(s) remaining)`,
				];
				console.log(drawBox(lines).join("\n"));
			}
		}
	} catch (err) {
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: err.message }, null, 2));
		} else {
			console.error(colorize(`Error writing ${shortenPath(source)}: ${err.message}`, RED));
		}
		process.exit(1);
	}
}

/**
 * Handle Claude remove subcommand - remove a Claude account from storage
 * @param {string[]} args - Non-flag arguments (label is required)
 * @param {{ json: boolean }} flags - Parsed flags
 */
async function handleClaudeRemove(args, flags) {
	const label = args[0];
	if (!label) {
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: "Missing required label argument" }, null, 2));
		} else {
			console.error(colorize(`Usage: ${PRIMARY_CMD} claude remove <label>`, RED));
			console.error("Removes a Claude credential from the multi-account file.");
		}
		process.exit(1);
	}

	const account = findClaudeAccountByLabel(label);
	if (!account) {
		const availableLabels = getClaudeLabels();
		if (flags.json) {
			console.log(JSON.stringify({
				success: false,
				error: `Claude account "${label}" not found`,
				availableLabels,
			}, null, 2));
		} else {
			console.error(colorize(`Claude account "${label}" not found.`, RED));
			if (availableLabels.length) {
				console.error(`Available labels: ${availableLabels.join(", ")}`);
			} else {
				console.error("No Claude accounts configured.");
			}
		}
		process.exit(1);
	}

	if (account.source === "env") {
		if (flags.json) {
			console.log(JSON.stringify({
				success: false,
				error: "Cannot remove account from CLAUDE_ACCOUNTS env var. Modify the env var directly.",
			}, null, 2));
		} else {
			console.error(colorize("Cannot remove account from CLAUDE_ACCOUNTS env var.", RED));
			console.error("Modify the env var directly to remove this account.");
		}
		process.exit(1);
	}

	const source = account.source;
	if (!CLAUDE_MULTI_ACCOUNT_PATHS.includes(source)) {
		if (flags.json) {
			console.log(JSON.stringify({
				success: false,
				error: `Cannot remove Claude account from ${source}. Remove it from the owning tool instead.`,
			}, null, 2));
		} else {
			console.error(colorize(`Cannot remove Claude account from ${shortenPath(source)}.`, RED));
			console.error("Remove it from the owning tool instead.");
		}
		process.exit(1);
	}

	let existingAccounts = [];
	try {
		const raw = readFileSync(source, "utf-8");
		const parsed = JSON.parse(raw);
		existingAccounts = Array.isArray(parsed) ? parsed : parsed?.accounts ?? [];
	} catch {
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: `Failed to read ${source}` }, null, 2));
		} else {
			console.error(colorize(`Error reading ${shortenPath(source)}`, RED));
		}
		process.exit(1);
	}

	const updatedAccounts = existingAccounts.filter(a => a.label !== label);
	if (updatedAccounts.length === existingAccounts.length) {
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: `Claude account "${label}" not found in ${source}` }, null, 2));
		} else {
			console.error(colorize(`Claude account "${label}" not found in ${shortenPath(source)}`, RED));
		}
		process.exit(1);
	}

	if (updatedAccounts.length === 0 && !flags.json) {
		console.log(colorize("Warning: This is the only Claude account in this file.", YELLOW));
		console.log(`The file will be deleted: ${shortenPath(source)}`);
		const confirmed = await promptConfirm("Continue?");
		if (!confirmed) {
			console.log("Cancelled.");
			process.exit(0);
		}
	}

	try {
		if (updatedAccounts.length === 0) {
			unlinkSync(source);
			if (flags.json) {
				console.log(JSON.stringify({
					success: true,
					label,
					source: shortenPath(source),
					message: "File deleted (no accounts remaining)",
				}, null, 2));
			} else {
				const lines = [
					colorize(`Removed Claude account ${label}`, GREEN),
					"",
					`Deleted: ${shortenPath(source)} (no accounts remaining)`,
				];
				console.log(drawBox(lines).join("\n"));
			}
		} else {
			writeFileAtomic(source, JSON.stringify({ accounts: updatedAccounts }, null, 2) + "\n", { mode: 0o600 });
			if (flags.json) {
				console.log(JSON.stringify({
					success: true,
					label,
					source: shortenPath(source),
					remainingAccounts: updatedAccounts.length,
				}, null, 2));
			} else {
				const lines = [
					colorize(`Removed Claude account ${label}`, GREEN),
					"",
					`Updated: ${shortenPath(source)} (${updatedAccounts.length} account(s) remaining)`,
				];
				console.log(drawBox(lines).join("\n"));
			}
		}
	} catch (err) {
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: err.message }, null, 2));
		} else {
			console.error(colorize(`Error writing ${shortenPath(source)}: ${err.message}`, RED));
		}
		process.exit(1);
	}
}

/**
 * Handle Claude switch subcommand - switch Claude Code/OpenCode/pi credentials
 * @param {string[]} args - Non-flag arguments (label is required)
 * @param {{ json: boolean }} flags - Parsed flags
 */
async function handleClaudeSwitch(args, flags) {
	const label = args[0];
	if (!label) {
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: "Missing required label argument" }, null, 2));
		} else {
			console.error(colorize(`Usage: ${PRIMARY_CMD} claude switch <label>`, RED));
			console.error("Switches Claude credentials in Claude Code, OpenCode, and pi.");
		}
		process.exit(1);
	}

	const account = findClaudeAccountByLabel(label);
	if (!account) {
		const availableLabels = getClaudeLabels();
		if (flags.json) {
			console.log(JSON.stringify({
				success: false,
				error: `Claude account "${label}" not found`,
				availableLabels,
			}, null, 2));
		} else {
			console.error(colorize(`Claude account "${label}" not found.`, RED));
			if (availableLabels.length) {
				console.error(`Available: ${availableLabels.join(", ")}`);
			} else {
				console.error(`Run '${PRIMARY_CMD} claude add' to add a Claude credential.`);
			}
		}
		process.exit(1);
	}

	if (!account.oauthToken) {
		const message = "Claude switch requires an OAuth token. Re-add with --oauth or provide an oauthToken.";
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: message }, null, 2));
		} else {
			console.error(colorize(`Error: ${message}`, RED));
		}
		process.exit(1);
	}

	const credentialsUpdate = updateClaudeCredentials(account);
	if (credentialsUpdate.error) {
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: credentialsUpdate.error }, null, 2));
		} else {
			console.error(colorize(`Error: ${credentialsUpdate.error}`, RED));
		}
		process.exit(1);
	}

	const opencodeUpdate = updateOpencodeClaudeAuth(account);
	if (opencodeUpdate.error && !flags.json) {
		console.error(colorize(`Warning: ${opencodeUpdate.error}`, YELLOW));
	}
	const piUpdate = updatePiClaudeAuth(account);
	if (piUpdate.error && !flags.json) {
		console.error(colorize(`Warning: ${piUpdate.error}`, YELLOW));
	}

	if (flags.json) {
		const output = {
			success: true,
			label,
			claudeCredentialsPath: credentialsUpdate.path,
		};
		if (opencodeUpdate.updated) {
			output.opencodeAuthPath = opencodeUpdate.path;
		} else if (opencodeUpdate.error) {
			output.opencodeAuthError = opencodeUpdate.error;
		}
		if (piUpdate.updated) {
			output.piAuthPath = piUpdate.path;
		} else if (piUpdate.error) {
			output.piAuthError = piUpdate.error;
		}
		console.log(JSON.stringify(output, null, 2));
		return;
	}

	const lines = [
		colorize(`Switched Claude credentials to ${label}`, GREEN),
		"",
		`Claude Code: ${shortenPath(credentialsUpdate.path)}`,
	];
	if (opencodeUpdate.updated) {
		lines.push(`OpenCode: ${shortenPath(opencodeUpdate.path)}`);
	}
	if (piUpdate.updated) {
		lines.push(`pi: ${shortenPath(piUpdate.path)}`);
	}
	console.log(drawBox(lines).join("\n"));
}

/**
 * Handle Claude add subcommand - add a Claude credential interactively
 * Supports two authentication methods:
 *   - OAuth browser flow (--oauth): Opens browser for authentication
 *   - Manual entry (--manual): Paste sessionKey/token directly
 * @param {string[]} args - Non-flag arguments (optional label)
 * @param {{ json: boolean, noBrowser: boolean, oauth: boolean, manual: boolean }} flags - Parsed flags
 */
async function handleClaudeAdd(args, flags) {
	let label = args[0] || null;
	try {
		// Check for conflicting flags
		if (flags.oauth && flags.manual) {
			throw new Error("Cannot use both --oauth and --manual flags. Choose one authentication method.");
		}

		const existingAccounts = loadClaudeAccounts();
		const existingLabels = new Set(existingAccounts.map(a => a.label));

		// Prompt for label if not provided
		if (!label) {
			label = (await promptInput("Label (e.g., work, personal): ")).trim();
		}
		if (!label) {
			throw new Error("Label is required");
		}
		if (!/^[a-zA-Z0-9_-]+$/.test(label)) {
			throw new Error(`Invalid label "${label}". Use only letters, numbers, hyphens, and underscores.`);
		}
		if (existingLabels.has(label)) {
			throw new Error(`Label "${label}" already exists. Choose a different label.`);
		}

		// Determine authentication method
		let useOAuth = flags.oauth;
		if (!flags.oauth && !flags.manual) {
			// Prompt for choice
			console.log("\nChoose authentication method:");
			console.log("  [1] OAuth (recommended) - Authenticate via browser");
			console.log("  [2] Manual - Paste sessionKey/token directly\n");
			const choice = (await promptInput("Enter choice (1 or 2): ")).trim();
			useOAuth = choice === "1";
		}

		let newAccount;
		let viaMethod;

		if (useOAuth) {
			// OAuth browser flow
			const tokens = await handleClaudeOAuthFlow({ noBrowser: flags.noBrowser });
			newAccount = {
				label,
				sessionKey: null,
				oauthToken: tokens.accessToken,
				oauthRefreshToken: tokens.refreshToken,
				oauthExpiresAt: tokens.expiresAt,
				oauthScopes: tokens.scopes,
				cfClearance: null,
				orgId: null,
			};
			viaMethod = "via OAuth";
		} else {
			// Manual entry flow
			console.log("\nPaste your Claude sessionKey or OAuth token.");
			const sessionKeyInput = await promptInput("sessionKey (sk-ant-...): ", { allowEmpty: true });
			const oauthTokenInput = await promptInput("oauthToken (optional): ", { allowEmpty: true });
			const cfClearanceInput = await promptInput("cfClearance (optional): ", { allowEmpty: true });
			const orgIdInput = await promptInput("orgId (optional): ", { allowEmpty: true });

			let parsedInput = null;
			if (sessionKeyInput && sessionKeyInput.trim().startsWith("{")) {
				try {
					parsedInput = JSON.parse(sessionKeyInput);
				} catch {
					parsedInput = null;
				}
			}

			const sessionKey = findClaudeSessionKey(parsedInput ?? sessionKeyInput) ?? null;
			const oauthToken = oauthTokenInput?.trim()
				|| parsedInput?.claudeAiOauth?.accessToken
				|| parsedInput?.claude_ai_oauth?.accessToken
				|| parsedInput?.accessToken
				|| parsedInput?.access_token
				|| null;
			const cfClearance = cfClearanceInput?.trim() || null;
			const orgId = orgIdInput?.trim() || null;

			if (!sessionKey && !oauthToken) {
				throw new Error("Provide at least a sessionKey or an OAuth token.");
			}

			newAccount = {
				label,
				sessionKey,
				oauthToken,
				cfClearance,
				orgId,
			};
			viaMethod = "";
		}

		const accounts = [...existingAccounts, newAccount];
		const targetPath = saveClaudeAccounts(accounts);

		if (flags.json) {
			console.log(JSON.stringify({
				success: true,
				label,
				method: useOAuth ? "oauth" : "manual",
				source: targetPath,
			}, null, 2));
			return;
		}

		const credentialText = viaMethod ? `Added Claude credential ${label} (${viaMethod})` : `Added Claude credential ${label}`;
		const lines = [
			colorize(credentialText, GREEN),
			"",
			`Saved to: ${shortenPath(targetPath)}`,
			"",
			`Run '${PRIMARY_CMD} claude quota' to check Claude usage`,
		];
		console.log(drawBox(lines).join("\n"));
	} catch (error) {
		if (flags.json) {
			console.log(JSON.stringify({
				success: false,
				error: error.message,
			}, null, 2));
		} else {
			console.error(colorize(`Error: ${error.message}`, RED));
		}
		process.exit(1);
	}
}

/**
 * Handle Codex subcommand entrypoint
 * @param {string[]} args - Codex subcommand args
 * @param {{ json: boolean, noBrowser: boolean, noColor: boolean }} flags - Parsed flags
 */
async function handleCodex(args, flags) {
	const subcommand = args[0];
	const subArgs = args.slice(1);

	if (!subcommand) {
		printHelpCodex();
		return;
	}

	switch (subcommand) {
		case "quota":
			await handleQuota(subArgs, flags, "codex");
			break;
		case "add":
			await handleAdd(subArgs, flags);
			break;
		case "switch":
			await handleSwitch(subArgs, flags);
			break;
		case "list":
			await handleList(flags);
			break;
		case "remove":
			await handleRemove(subArgs, flags);
			break;
		case "help":
			printHelpCodex();
			break;
		default:
			printHelpCodex();
			process.exit(1);
	}
}

/**
 * Handle Claude subcommand entrypoint
 * @param {string[]} args - Claude subcommand args
 * @param {{ json: boolean, noBrowser: boolean, oauth: boolean, manual: boolean }} flags - Parsed flags
 */
async function handleClaude(args, flags) {
	const subcommand = args[0];
	const subArgs = args.slice(1);

	if (!subcommand) {
		printHelpClaude();
		return;
	}

	switch (subcommand) {
		case "quota":
			await handleQuota(subArgs, flags, "claude");
			break;
		case "add":
			await handleClaudeAdd(subArgs, flags);
			break;
		case "list":
			await handleClaudeList(flags);
			break;
		case "switch":
			await handleClaudeSwitch(subArgs, flags);
			break;
		case "remove":
			await handleClaudeRemove(subArgs, flags);
			break;
		case "help":
			printHelpClaude();
			break;
		default:
			printHelpClaude();
			process.exit(1);
	}
}

/**
 * Handle quota subcommand (default behavior)
 * By default, shows both Codex and Claude accounts
 * @param {string[]} args - Non-flag arguments (e.g., label filter)
 * @param {{ json: boolean }} flags - Parsed flags
 * @param {"all" | "codex" | "claude"} scope - Which accounts to show
 */
async function handleQuota(args, flags, scope = "all") {
	const labelFilter = args[0];
	
	// Determine which account types to show:
	// - scope "all": show both (default)
	// - scope "codex": show only Codex
	// - scope "claude": show only Claude
	const showCodex = scope === "all" || scope === "codex";
	const showClaude = scope === "all" || scope === "claude";
	
	// Use loadAllAccounts() which includes deduplication by accountId
	const allAccounts = showCodex ? loadAllAccounts() : [];
	const hasOpenAiAccounts = allAccounts.length > 0;

	// Check if we have any accounts to show
	if (!hasOpenAiAccounts && !showClaude) {
		if (flags.json) {
			console.log(JSON.stringify({ 
				success: false, 
				error: "No Codex accounts found",
				searchedLocations: [
					"CODEX_ACCOUNTS env var",
					...MULTI_ACCOUNT_PATHS,
					getCodexCliAuthPath(),
				],
			}, null, 2));
		} else {
			console.error(colorize("No Codex accounts found.", RED));
			console.error("\nSearched:");
			console.error("  - CODEX_ACCOUNTS env var");
			for (const p of MULTI_ACCOUNT_PATHS) {
				console.error(`  - ${p}`);
			}
			console.error(`  - ${getCodexCliAuthPath()}`);
				console.error(`\nRun '${PRIMARY_CMD} codex add' to add an account.`);
		}
		process.exit(1);
	}

	let accounts = [];
	if (hasOpenAiAccounts && showCodex) {
		accounts = labelFilter 
			? allAccounts.filter(a => a.label === labelFilter)
			: allAccounts;
	}

	if (labelFilter && showCodex && !accounts.length && hasOpenAiAccounts) {
		if (flags.json) {
			console.log(JSON.stringify({ 
				success: false, 
				error: `Account "${labelFilter}" not found`,
				availableLabels: allAccounts.map(a => a.label),
			}, null, 2));
		} else {
			console.error(colorize(`Account "${labelFilter}" not found.`, RED));
			console.error("Available:", allAccounts.map(a => a.label).join(", "));
		}
		process.exit(1);
	}

	const results = [];

	for (const account of accounts) {
		const tokenOk = await ensureFreshToken(account, allAccounts);
		if (!tokenOk) {
			results.push({ account, usage: { error: "Token refresh failed - re-auth required" } });
			continue;
		}
		const usage = await fetchUsage(account);
		results.push({ account, usage });
	}

	let claudeResults = null;
	if (showClaude) {
		const wantsClaudeLabel = scope === "claude" && Boolean(labelFilter);
		const oauthAccounts = loadAllClaudeOAuthAccounts();
		const filteredOauthAccounts = wantsClaudeLabel
			? oauthAccounts.filter(account => account.label === labelFilter)
			: oauthAccounts;

		if (filteredOauthAccounts.length) {
			const rawResults = await Promise.all(
				filteredOauthAccounts.map(account => fetchClaudeOAuthUsageForAccount(account))
			);
			claudeResults = deduplicateClaudeResultsByUsage(rawResults);
		} else {
			const claudeAccounts = loadClaudeAccounts();
			const filteredClaudeAccounts = wantsClaudeLabel
				? claudeAccounts.filter(account => account.label === labelFilter)
				: claudeAccounts;

			if (filteredClaudeAccounts.length) {
				const rawResults = await Promise.all(
					filteredClaudeAccounts.map(account => fetchClaudeUsageForCredentials(account))
				);
				claudeResults = deduplicateClaudeResultsByUsage(rawResults);
			} else if (wantsClaudeLabel) {
				const availableLabels = new Set([
					...oauthAccounts.map(account => account.label),
					...claudeAccounts.map(account => account.label),
				]);
				const labelList = Array.from(availableLabels);
				if (flags.json) {
					console.log(JSON.stringify({
						success: false,
						error: `Claude account "${labelFilter}" not found`,
						availableLabels: labelList,
					}, null, 2));
				} else {
					console.error(colorize(`Claude account "${labelFilter}" not found.`, RED));
					if (labelList.length) {
						console.error(`Available: ${labelList.join(", ")}`);
					}
				}
				process.exit(1);
			} else {
				const legacyResult = await fetchClaudeUsage();
				if (legacyResult.success || legacyResult.usage) {
					claudeResults = [legacyResult];
				}
			}
		}
	}

	// Check if we have anything to show
	const hasCodexResults = results.length > 0;
	const hasClaudeResults = claudeResults && claudeResults.length > 0;
	
	if (!hasCodexResults && !hasClaudeResults) {
		if (flags.json) {
			console.log(JSON.stringify({ 
				success: false, 
				error: "No accounts found",
			}, null, 2));
		} else {
			console.error(colorize("No accounts found.", RED));
			const codexMessage = `Run '${PRIMARY_CMD} codex add' to add a Codex account.`;
			const claudeMessage = `Run '${PRIMARY_CMD} claude add' to add a Claude account.`;
			if (scope === "codex") {
				console.error(`\n${codexMessage}`);
			} else if (scope === "claude") {
				console.error(`\n${claudeMessage}`);
			} else {
				console.error(`\n${codexMessage}`);
				console.error(claudeMessage);
			}
		}
		process.exit(1);
	}

	if (flags.json) {
		const openaiOutput = results.map(({ account, usage }) => {
			const profile = extractProfile(account.access);
			return {
				label: account.label,
				email: profile.email,
				accountId: account.accountId,
				planType: profile.planType,
				usage,
				source: account.source,
			};
		});
		// Always output both fields when showing both, or just the relevant one
		if (showCodex && showClaude) {
			console.log(JSON.stringify({
				codex: openaiOutput,
				claude: claudeResults ?? [],
			}, null, 2));
		} else if (showClaude) {
			console.log(JSON.stringify(claudeResults ?? [], null, 2));
		} else {
			console.log(JSON.stringify(openaiOutput, null, 2));
		}
		return;
	}

	for (const { account, usage } of results) {
		const lines = buildAccountUsageLines(account, usage);
		const boxLines = drawBox(lines);
		console.log(boxLines.join("\n"));
	}

	if (claudeResults) {
		for (const result of claudeResults) {
			const lines = buildClaudeUsageLines(result);
			const boxLines = drawBox(lines);
			console.log(boxLines.join("\n"));
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const args = process.argv.slice(2);
	
	// Parse flags
	const flags = {
		json: args.includes("--json"),
		noBrowser: args.includes("--no-browser"),
		noColor: args.includes("--no-color"),
		oauth: args.includes("--oauth"),
		manual: args.includes("--manual"),
	};
	
	// Set global noColorFlag for supportsColor() function
	noColorFlag = flags.noColor;
	
	const legacyFlagUsed = args.includes("--claude") || args.includes("--codex");
	if (legacyFlagUsed) {
		console.error(colorize("Error: --claude/--codex flags were replaced by namespaces.", RED));
		console.error(`Use '${PRIMARY_CMD} claude' or '${PRIMARY_CMD} codex' instead.`);
		process.exit(1);
	}

	// Extract non-flag arguments
	const nonFlagArgs = args.filter(a => !a.startsWith("--") && a !== "-h");
	const firstArg = nonFlagArgs[0];
	const namespace = firstArg === "codex" || firstArg === "claude" ? firstArg : null;
	const namespaceArgs = namespace ? nonFlagArgs.slice(1) : nonFlagArgs;
	const subcommand = namespace ? namespaceArgs[0] : null;
	const subArgs = namespace ? namespaceArgs.slice(1) : namespaceArgs;
	
	// Handle --version flag
	if (args.includes("--version") || args.includes("-v")) {
		console.log(getPackageVersion());
		return;
	}
	
	const legacyCommands = ["add", "switch", "list", "remove", "quota"];
	if (!namespace && firstArg && legacyCommands.includes(firstArg)) {
		console.error(colorize(`Error: '${firstArg}' now requires a namespace.`, RED));
		console.error(`Use '${PRIMARY_CMD} codex ${firstArg}' or '${PRIMARY_CMD} claude ${firstArg}'.`);
		process.exit(1);
	}

	// Handle --help: show main help or subcommand-specific help
	if (args.includes("--help") || args.includes("-h")) {
		if (!namespace) {
			printHelp();
			return;
		}
		if (namespace === "codex") {
			switch (subcommand) {
				case "add":
					printHelpAdd();
					break;
				case "switch":
					printHelpSwitch();
					break;
				case "list":
					printHelpList();
					break;
				case "remove":
					printHelpRemove();
					break;
				case "quota":
					printHelpQuota();
					break;
				default:
					printHelpCodex();
					break;
			}
			return;
		}
		switch (subcommand) {
			case "add":
				printHelpClaudeAdd();
				break;
			case "switch":
				printHelpClaudeSwitch();
				break;
			case "list":
				printHelpClaudeList();
				break;
			case "remove":
				printHelpClaudeRemove();
				break;
			case "quota":
				printHelpClaudeQuota();
				break;
			default:
				printHelpClaude();
				break;
		}
		return;
	}
	
	// Route to appropriate handler based on subcommand
	if (namespace === "codex") {
		await handleCodex(namespaceArgs, flags);
		return;
	}
	if (namespace === "claude") {
		await handleClaude(namespaceArgs, flags);
		return;
	}

	// Default behavior: run combined quota command
	await handleQuota(nonFlagArgs, flags, "all");
}

// Only run main() when executed directly (not imported for testing)
// Resolve symlinks to handle globally linked binaries (e.g., bun link, npm link)
function getResolvedArgv1() {
	try {
		const arg = process.argv[1];
		if (!arg) return null;
		// Resolve symlinks to get the real path
		return realpathSync(arg);
	} catch {
		return process.argv[1] || null;
	}
}
const resolvedArgv1 = getResolvedArgv1();
const isMain = resolvedArgv1 && (
	import.meta.url === `file://${resolvedArgv1}` ||
	import.meta.url === `file://${process.argv[1]}`
);
if (isMain) {
	main().catch(e => {
		console.error(e.message);
		process.exit(1);
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports for testing
// ─────────────────────────────────────────────────────────────────────────────

export {
	// Account loading functions
	loadAccountsFromEnv,
	loadAccountsFromFile,
	loadAccountFromCodexCli,
	loadAllAccounts,
	findAccountByLabel,
	getAllLabels,
	isValidAccount,
	loadClaudeAccountsFromEnv,
	loadClaudeAccountsFromFile,
	loadClaudeAccounts,
	isValidClaudeAccount,
	
	// Deduplication functions
	deduplicateAccountsByEmail,
	deduplicateClaudeOAuthAccounts,
	
	// Claude OAuth functions
	loadClaudeOAuthFromClaudeCode,
	loadClaudeOAuthFromOpenCode,
	loadClaudeOAuthFromEnv,
	loadAllClaudeOAuthAccounts,
	fetchClaudeOAuthUsage,
	fetchClaudeOAuthUsageForAccount,
	ensureFreshClaudeOAuthToken,
	persistClaudeOAuthTokens,
	
	// OAuth PKCE utilities
	generatePKCE,
	generateState,
	buildAuthUrl,
	checkPortAvailable,
	isHeadlessEnvironment,
	openBrowser,
	startCallbackServer,
	exchangeCodeForTokens,
	
	// Claude OAuth browser flow
	buildClaudeAuthUrl,
	parseClaudeCodeState,
	exchangeClaudeCodeForTokens,
	refreshClaudeToken,
	handleClaudeOAuthFlow,
	
	// JWT utilities
	decodeJWT,
	extractAccountId,
	extractProfile,
	
	// List helpers (for testing)
	getActiveAccountId,
	getActiveAccountInfo,
	formatExpiryStatus,
	shortenPath,
	
	// Subcommand handlers (for testing)
	handleSwitch,
	handleRemove,
	handleClaudeAdd,
	
	// Color utilities
	supportsColor,
	colorize,
	setNoColorFlag,
	
	// Constants (for testing)
	MULTI_ACCOUNT_PATHS,
	CODEX_CLI_AUTH_PATH,
	PRIMARY_CMD,
	CLAUDE_MULTI_ACCOUNT_PATHS,

	
	// Help functions (for testing)
	printHelp,
	printHelpAdd,
	printHelpClaude,
	printHelpClaudeAdd,
	printHelpSwitch,
	printHelpList,
	printHelpRemove,
	printHelpQuota,
};
