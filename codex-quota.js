#!/usr/bin/env node

/**
 * Standalone Codex quota checker for multiple OAuth accounts
 * Zero dependencies - uses Node.js built-ins only
 * 
 * Usage:
 *   node codex-quota.js              # Check all accounts
 *   node codex-quota.js --json       # JSON output
 *   node codex-quota.js <label>      # Check specific account
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
const CLAUDE_API_BASE = "https://claude.ai/api";
const CLAUDE_ORIGIN = "https://claude.ai";
const CLAUDE_ORGS_URL = `${CLAUDE_API_BASE}/organizations`;
const CLAUDE_ACCOUNT_URL = `${CLAUDE_API_BASE}/account`;
const CLAUDE_TIMEOUT_MS = 15000;
const CLAUDE_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// CLI command names
const PRIMARY_CMD = "codex-quota";

const MULTI_ACCOUNT_PATHS = [
	join(homedir(), ".codex-accounts.json"),
	join(homedir(), ".opencode", "openai-codex-auth-accounts.json"),
];

const CODEX_CLI_AUTH_PATH = join(homedir(), ".codex", "auth.json");
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
 * Load ALL accounts from ALL sources (env, file paths, codex-cli)
 * Each account includes a `source` property indicating its origin
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
	
	return all;
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
	return typeof value === "string" && value.startsWith("sk-ant-oat");
}

function findClaudeSessionKey(value) {
	if (isClaudeSessionKey(value)) return value;
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
		const attempts = [
			{ mode: "cookie", bearer: null },
			{ mode: "bearer", bearer: sessionKey },
			{ mode: "bearer", bearer: oauthToken },
			{ mode: "cookie+bearer", bearer: sessionKey },
			{ mode: "cookie+bearer", bearer: oauthToken },
		];
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
	const plan = account.plan
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
				.replace(/_\\d+x$/i, "")
		);
	}
	const header = `Claude${email ? ` <${email}>` : ""}${planDisplay ? ` (${planDisplay})` : ""}`;

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
	console.log(`${PRIMARY_CMD} - Manage and monitor OpenAI Codex accounts

Usage:
  ${PRIMARY_CMD} [command] [options]

Commands:
  quota [label]     Check usage quota (default command)
  add [label]       Add a new account via OAuth browser flow
  switch <label>    Switch active account for Codex CLI and OpenCode
  list              List all accounts from all sources
  remove <label>    Remove an account from storage

Options:
  --json            Output in JSON format
  --no-browser      Print auth URL instead of opening browser
  --no-color        Disable colored output
  --claude          Include Claude Code usage (uses ~/.claude/.credentials.json)
  --version, -v     Show version number
  --help, -h        Show this help

Examples:
  ${PRIMARY_CMD}                   Check quota for all accounts
  ${PRIMARY_CMD} personal          Check quota for "personal" account
  ${PRIMARY_CMD} add work          Add new account with label "work"
  ${PRIMARY_CMD} switch personal   Switch to "personal" account
  ${PRIMARY_CMD} list              List all configured accounts
  ${PRIMARY_CMD} remove old        Remove "old" account

Account sources (checked in order):
  1. CODEX_ACCOUNTS env var (JSON array)
  2. ~/.codex-accounts.json
  3. ~/.opencode/openai-codex-auth-accounts.json
  4. ~/.codex/auth.json (Codex CLI format)

OpenCode Integration:
  The 'switch' command updates both Codex CLI (~/.codex/auth.json) and
  OpenCode (~/.local/share/opencode/auth.json) authentication files,
  allowing seamless account switching across both tools.

Run '${PRIMARY_CMD} <command> --help' for help on a specific command.
`);
}

function printHelpAdd() {
	console.log(`${PRIMARY_CMD} add - Add a new account via OAuth browser flow

Usage:
  ${PRIMARY_CMD} add [label] [options]

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
  ${PRIMARY_CMD} add                     Add account (label from email)
  ${PRIMARY_CMD} add work                Add account with label "work"
  ${PRIMARY_CMD} add --no-browser        Print URL for manual browser auth

Environment:
  SSH/headless environments are auto-detected. The URL will be printed
  instead of opening a browser when SSH_CLIENT or SSH_TTY is set, or
  when DISPLAY/WAYLAND_DISPLAY is missing on Linux.
`);
}

function printHelpSwitch() {
	console.log(`${PRIMARY_CMD} switch - Switch the active account

Usage:
  ${PRIMARY_CMD} switch <label> [options]

Arguments:
  label             Required. Label of the account to switch to

Options:
  --json            Output result in JSON format
  --help, -h        Show this help

Description:
  Switches the active OpenAI account for both Codex CLI and OpenCode.
  
  This command updates two authentication files:
    1. ~/.codex/auth.json - Used by Codex CLI
    2. ~/.local/share/opencode/auth.json - Used by OpenCode (if exists)
  
  The OpenCode auth file location respects XDG_DATA_HOME if set.
  If the OpenCode auth file doesn't exist, only the Codex CLI file is updated.
  
  If the token is expired, it will be refreshed before switching.
  Any existing OPENAI_API_KEY in auth.json is preserved.

Examples:
  ${PRIMARY_CMD} switch personal         Switch to "personal" account
  ${PRIMARY_CMD} switch work --json      Switch to "work" with JSON output

See also:
  ${PRIMARY_CMD} list    Show all available accounts and their labels
`);
}

function printHelpList() {
	console.log(`${PRIMARY_CMD} list - List all configured accounts

Usage:
  ${PRIMARY_CMD} list [options]

Options:
  --json            Output in JSON format
  --claude          Include Claude Code usage (uses ~/.claude/.credentials.json)
  --help, -h        Show this help

Description:
  Lists all accounts from all configured sources with details:
  - Label and email address
  - Plan type (plus, free, etc.)
  - Token expiry status
  - Source file location
  - Active indicator (* for the current account in ~/.codex/auth.json)

Output columns:
  * = active        Currently active account
  label             Account identifier
  <email>           Email address from token
  Plan              ChatGPT plan type
  Expires           Token expiry (e.g., "9d 17h", "Expired")
  Source            File path where account is stored

Examples:
  ${PRIMARY_CMD} list                    Show all accounts
  ${PRIMARY_CMD} list --json             Get JSON output for scripting
`);
}

function printHelpRemove() {
	console.log(`${PRIMARY_CMD} remove - Remove an account from storage

Usage:
  ${PRIMARY_CMD} remove <label> [options]

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
  ${PRIMARY_CMD} remove old              Remove "old" account with confirmation
  ${PRIMARY_CMD} remove work --json      Remove "work" account (no prompt)

See also:
  ${PRIMARY_CMD} list    Show all accounts and their sources
`);
}

function printHelpQuota() {
	console.log(`${PRIMARY_CMD} quota - Check usage quota for accounts

Usage:
  ${PRIMARY_CMD} quota [label] [options]
  ${PRIMARY_CMD} [label] [options]          (quota is the default command)

Arguments:
  label             Optional. Check quota for a specific account only
                    If not provided, shows quota for all accounts

Options:
  --json            Output in JSON format
  --help, -h        Show this help

Description:
  Displays usage statistics for OpenAI Codex accounts:
  - Session usage (queries per session)
  - Weekly usage (queries per 7-day period)
  - Available credits

  With --claude, also shows Claude Code subscription usage.

  Tokens are automatically refreshed if expired.

Examples:
  ${PRIMARY_CMD}                         Check all accounts
  ${PRIMARY_CMD} personal                Check "personal" account only
  ${PRIMARY_CMD} quota --json            JSON output for all accounts
  ${PRIMARY_CMD} quota work --json       JSON output for "work" account
  ${PRIMARY_CMD} --claude                Include Claude Code usage
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
			reject(new Error(`Authentication timed out after 2 minutes. Run '${PRIMARY_CMD} add' to try again.`));
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
				`Run 'cq switch ${label}' to activate this account`,
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
 * Handle switch subcommand - switch active account in ~/.codex/auth.json
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
			console.error(colorize(`Usage: ${PRIMARY_CMD} switch <label>`, RED));
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
				console.error(`Run '${PRIMARY_CMD} add' to add an account via OAuth.`);
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
				console.error(`Run '${PRIMARY_CMD} add' to re-authenticate this account.`);
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
		
		// 9. Get profile info for display
		const profile = extractProfile(account.access);
		
		// 10. Print confirmation (JSON OR human-readable, not both)
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
		console.log(`\nRun '${PRIMARY_CMD} add' to add an account via OAuth.`);
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
	lines.push(`Accounts (${accounts.length} total)`);
	lines.push("");
	
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
			lines.push("* = active (set by cq switch)");
		}
		if (hasNativeActive) {
			lines.push("~ = native login (run 'cq switch' to manage)");
		}
	}
	
	const boxLines = drawBox(lines);
	console.log(boxLines.join("\n"));
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
			console.error(colorize(`Usage: ${PRIMARY_CMD} remove <label>`, RED));
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
			console.log(`You will need to re-authenticate using 'codex auth' or '${PRIMARY_CMD} add'.`);
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
 * Handle quota subcommand (default behavior)
 * @param {string[]} args - Non-flag arguments (e.g., label filter)
 * @param {{ json: boolean, claude?: boolean }} flags - Parsed flags
 */
async function handleQuota(args, flags) {
	const labelFilter = args[0];
	const includeClaude = Boolean(flags.claude);
	const allAccounts = loadAccounts();
	const hasOpenAiAccounts = allAccounts.length > 0;

	if (!hasOpenAiAccounts && !includeClaude) {
		if (flags.json) {
			console.log(JSON.stringify({ 
				success: false, 
				error: "No accounts found",
				searchedLocations: [
					"CODEX_ACCOUNTS env var",
					...MULTI_ACCOUNT_PATHS,
					getCodexCliAuthPath(),
				],
			}, null, 2));
		} else {
			console.error(colorize("No accounts found.", RED));
			console.error("\nSearched:");
			console.error("  - CODEX_ACCOUNTS env var");
			for (const p of MULTI_ACCOUNT_PATHS) {
				console.error(`  - ${p}`);
			}
			console.error(`  - ${getCodexCliAuthPath()}`);
			console.error("\nRun 'codex-quota.js --help' for account format.");
		}
		process.exit(1);
	}

	let accounts = [];
	if (hasOpenAiAccounts) {
		accounts = labelFilter 
			? allAccounts.filter(a => a.label === labelFilter)
			: allAccounts;
	}

	if (labelFilter && !accounts.length) {
		if (hasOpenAiAccounts) {
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
		} else {
			if (flags.json) {
				console.log(JSON.stringify({ 
					success: false, 
					error: `No OpenAI accounts found for "${labelFilter}"`,
				}, null, 2));
			} else {
				console.error(colorize(`No OpenAI accounts found for "${labelFilter}".`, RED));
				console.error("Add an account with 'codex-quota add' or omit the label.");
			}
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

	let claudeResult = null;
	if (includeClaude) {
		claudeResult = await fetchClaudeUsage();
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
		if (includeClaude) {
			console.log(JSON.stringify({
				openai: openaiOutput,
				claude: claudeResult,
			}, null, 2));
			return;
		}
		console.log(JSON.stringify(openaiOutput, null, 2));
		return;
	}

	for (const { account, usage } of results) {
		const lines = buildAccountUsageLines(account, usage);
		const boxLines = drawBox(lines);
		console.log(boxLines.join("\n"));
	}

	if (includeClaude) {
		const lines = buildClaudeUsageLines(claudeResult);
		const boxLines = drawBox(lines);
		console.log(boxLines.join("\n"));
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
		claude: args.includes("--claude"),
	};
	
	// Set global noColorFlag for supportsColor() function
	noColorFlag = flags.noColor;
	
	// Extract non-flag arguments
	const nonFlagArgs = args.filter(a => !a.startsWith("--") && a !== "-h");
	
	// Extract subcommand and remaining args
	// Known subcommands: add, switch, list, remove, quota (explicit)
	const SUBCOMMANDS = ["add", "switch", "list", "remove", "quota"];
	const firstArg = nonFlagArgs[0];
	const isSubcommand = firstArg && SUBCOMMANDS.includes(firstArg);
	
	const subcommand = isSubcommand ? firstArg : null;
	const subArgs = isSubcommand ? nonFlagArgs.slice(1) : nonFlagArgs;
	
	// Handle --version flag
	if (args.includes("--version") || args.includes("-v")) {
		// Read version from package.json (relative to this script)
		const packagePath = join(dirname(import.meta.url.replace("file://", "")), "package.json");
		try {
			const pkg = JSON.parse(readFileSync(packagePath, "utf-8"));
			console.log(pkg.version || "unknown");
		} catch {
			console.log("unknown");
		}
		return;
	}
	
	// Handle --help: show main help or subcommand-specific help
	if (args.includes("--help") || args.includes("-h")) {
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
				printHelp();
				break;
		}
		return;
	}
	
	// Route to appropriate handler based on subcommand
	switch (subcommand) {
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
		case "quota":
		default:
			// Default behavior: run quota command
			await handleQuota(subArgs, flags);
			break;
	}
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
	
	// OAuth PKCE utilities
	generatePKCE,
	generateState,
	buildAuthUrl,
	checkPortAvailable,
	isHeadlessEnvironment,
	openBrowser,
	startCallbackServer,
	exchangeCodeForTokens,
	
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
	
	// Color utilities
	supportsColor,
	colorize,
	setNoColorFlag,
	
	// Constants (for testing)
	MULTI_ACCOUNT_PATHS,
	CODEX_CLI_AUTH_PATH,
	PRIMARY_CMD,

	
	// Help functions (for testing)
	printHelp,
	printHelpAdd,
	printHelpSwitch,
	printHelpList,
	printHelpRemove,
	printHelpQuota,
};
