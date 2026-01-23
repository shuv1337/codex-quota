#!/usr/bin/env node

/**
 * Example: Fetch Claude Pro/Max usage via OAuth API
 * 
 * This demonstrates fetching quota/usage data from Anthropic's OAuth usage endpoint
 * using credentials from Claude Code or OpenCode.
 * 
 * Endpoint: GET https://api.anthropic.com/api/oauth/usage
 * Required headers:
 *   - Authorization: Bearer <access_token>
 *   - anthropic-version: 2023-06-01
 *   - anthropic-beta: oauth-2025-04-20
 * 
 * Required scope: user:profile (inference-only tokens won't work)
 * 
 * Credential sources (checked in order):
 *   1. ~/.claude/.credentials.json (Claude Code)
 *   2. ~/.local/share/opencode/auth.json (OpenCode)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_BETA = "oauth-2025-04-20";
const TIMEOUT_MS = 15000;

// Credential file paths
const CLAUDE_CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
const OPENCODE_AUTH_PATH = join(
	process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
	"opencode",
	"auth.json"
);

// ─────────────────────────────────────────────────────────────────────────────
// Load OAuth token from credential sources
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load Claude OAuth access token from Claude Code credentials
 * @returns {{ token: string, source: string, metadata?: object } | null}
 */
function loadFromClaudeCode() {
	if (!existsSync(CLAUDE_CREDENTIALS_PATH)) return null;

	try {
		const raw = readFileSync(CLAUDE_CREDENTIALS_PATH, "utf-8");
		const parsed = JSON.parse(raw);
		const oauth = parsed?.claudeAiOauth;

		if (!oauth?.accessToken) return null;

		return {
			token: oauth.accessToken,
			source: CLAUDE_CREDENTIALS_PATH,
			metadata: {
				refreshToken: oauth.refreshToken,
				expiresAt: oauth.expiresAt,
				scopes: oauth.scopes,
				subscriptionType: oauth.subscriptionType,
				rateLimitTier: oauth.rateLimitTier,
			},
		};
	} catch {
		return null;
	}
}

/**
 * Load Claude OAuth access token from OpenCode auth.json
 * @returns {{ token: string, source: string, metadata?: object } | null}
 */
function loadFromOpenCode() {
	if (!existsSync(OPENCODE_AUTH_PATH)) return null;

	try {
		const raw = readFileSync(OPENCODE_AUTH_PATH, "utf-8");
		const parsed = JSON.parse(raw);
		const anthropic = parsed?.anthropic;

		if (!anthropic?.access) return null;

		return {
			token: anthropic.access,
			source: OPENCODE_AUTH_PATH,
			metadata: {
				refreshToken: anthropic.refresh,
				expiresAt: anthropic.expires,
			},
		};
	} catch {
		return null;
	}
}

/**
 * Load OAuth token from available sources
 * @returns {{ token: string, source: string, metadata?: object } | null}
 */
function loadOAuthToken() {
	// Try Claude Code credentials first
	const claudeCode = loadFromClaudeCode();
	if (claudeCode) return claudeCode;

	// Fall back to OpenCode credentials
	const opencode = loadFromOpenCode();
	if (opencode) return opencode;

	return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch usage from OAuth API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch Claude usage data via OAuth API
 * @param {string} accessToken - OAuth access token
 * @returns {Promise<{ success: boolean, data?: object, error?: string }>}
 */
async function fetchClaudeOAuthUsage(accessToken) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

	try {
		const res = await fetch(CLAUDE_OAUTH_USAGE_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"anthropic-version": ANTHROPIC_VERSION,
				"anthropic-beta": ANTHROPIC_BETA,
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

// ─────────────────────────────────────────────────────────────────────────────
// Display formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a usage window for display
 * @param {string} label - Window label (e.g., "5h Session")
 * @param {object} window - Window data from API
 */
function formatWindow(label, window) {
	if (!window) return null;

	const used = window.utilization ?? 0;
	const remaining = 100 - used;
	const resetAt = window.resets_at;

	// Build progress bar (20 chars wide)
	const filled = Math.round((remaining / 100) * 20);
	const bar = "█".repeat(filled) + "░".repeat(20 - filled);

	// Format reset time
	let resetStr = "";
	if (resetAt) {
		const resetDate = new Date(resetAt);
		const now = new Date();
		const diffMs = resetDate - now;
		const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
		const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

		if (diffHours >= 24) {
			const days = Math.floor(diffHours / 24);
			resetStr = `(resets in ${days}d ${diffHours % 24}h)`;
		} else if (diffHours > 0) {
			resetStr = `(resets in ${diffHours}h ${diffMins}m)`;
		} else if (diffMins > 0) {
			resetStr = `(resets in ${diffMins}m)`;
		}
	}

	return `${label.padEnd(14)} [${bar}] ${Math.round(remaining)}% left ${resetStr}`;
}

/**
 * Display usage data in a human-readable format
 * @param {object} data - Usage data from API
 * @param {object} credentials - Credential metadata
 */
function displayUsage(data, credentials) {
	console.log("\n╭─────────────────────────────────────────────────────────────────╮");
	console.log("│ Claude Usage                                                    │");
	console.log("├─────────────────────────────────────────────────────────────────┤");

	// Show subscription info if available
	if (credentials.metadata?.subscriptionType) {
		const tier = credentials.metadata.rateLimitTier?.replace("default_", "").replace(/_/g, " ") || "";
		console.log(`│ Plan: ${credentials.metadata.subscriptionType} ${tier}`.padEnd(66) + "│");
		console.log("│                                                                 │");
	}

	// 5-hour session window
	const fiveHour = formatWindow("5h Session:", data.five_hour);
	if (fiveHour) {
		console.log(`│ ${fiveHour}`.padEnd(66) + "│");
	}

	// 7-day weekly window
	const sevenDay = formatWindow("Weekly:", data.seven_day);
	if (sevenDay) {
		console.log(`│ ${sevenDay}`.padEnd(66) + "│");
	}

	// Sonnet-specific weekly (if present)
	if (data.seven_day_sonnet?.utilization !== undefined && data.seven_day_sonnet.utilization > 0) {
		const sonnet = formatWindow("Sonnet Weekly:", data.seven_day_sonnet);
		if (sonnet) {
			console.log(`│ ${sonnet}`.padEnd(66) + "│");
		}
	}

	// Opus-specific weekly (if present)
	if (data.seven_day_opus?.utilization !== undefined) {
		const opus = formatWindow("Opus Weekly:", data.seven_day_opus);
		if (opus) {
			console.log(`│ ${opus}`.padEnd(66) + "│");
		}
	}

	// Extra usage (pay-as-you-go overflow)
	if (data.extra_usage?.is_enabled) {
		const extra = data.extra_usage;
		const used = extra.used_credits ?? 0;
		const limit = extra.monthly_limit ?? "unlimited";
		console.log(`│ Extra Usage: $${used} / $${limit}`.padEnd(66) + "│");
	}

	console.log("├─────────────────────────────────────────────────────────────────┤");
	console.log(`│ Source: ${credentials.source}`.padEnd(66) + "│");
	console.log("╰─────────────────────────────────────────────────────────────────╯\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const args = process.argv.slice(2);
	const jsonOutput = args.includes("--json");

	// Load credentials
	const credentials = loadOAuthToken();
	if (!credentials) {
		const error = {
			success: false,
			error: "No Claude OAuth credentials found",
			searchedPaths: [CLAUDE_CREDENTIALS_PATH, OPENCODE_AUTH_PATH],
		};
		if (jsonOutput) {
			console.log(JSON.stringify(error, null, 2));
		} else {
			console.error("Error: No Claude OAuth credentials found");
			console.error("Searched:");
			console.error(`  - ${CLAUDE_CREDENTIALS_PATH}`);
			console.error(`  - ${OPENCODE_AUTH_PATH}`);
			console.error("\nRun 'claude /login' to authenticate Claude Code.");
		}
		process.exit(1);
	}

	// Check token expiry
	if (credentials.metadata?.expiresAt) {
		const expiresAt = new Date(credentials.metadata.expiresAt);
		if (expiresAt < new Date()) {
			const error = {
				success: false,
				error: "OAuth token expired",
				expiresAt: credentials.metadata.expiresAt,
				source: credentials.source,
			};
			if (jsonOutput) {
				console.log(JSON.stringify(error, null, 2));
			} else {
				console.error("Error: OAuth token expired");
				console.error(`Expired at: ${expiresAt.toISOString()}`);
				console.error("\nRun 'claude /login' to refresh credentials.");
			}
			process.exit(1);
		}
	}

	// Fetch usage
	const result = await fetchClaudeOAuthUsage(credentials.token);

	if (jsonOutput) {
		console.log(JSON.stringify({
			...result,
			source: credentials.source,
			metadata: credentials.metadata,
		}, null, 2));
		process.exit(result.success ? 0 : 1);
	}

	if (!result.success) {
		console.error(`Error: ${result.error}`);
		process.exit(1);
	}

	displayUsage(result.data, credentials);
}

main().catch((err) => {
	console.error(`Fatal error: ${err.message}`);
	process.exit(1);
});
