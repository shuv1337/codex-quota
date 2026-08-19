/**
 * OpenCode Go dashboard configuration, HTML parsing, and usage fetch.
 * Zero dependencies; uses only platform globals available in Node.js 18+.
 */

import {
	OPENCODE_GO_DASHBOARD_BASE_URL,
	OPENCODE_GO_TIMEOUT_MS,
} from "./constants.js";

const OPENCODE_GO_USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
	+ "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

const WINDOW_FIELDS = [
	["rollingUsage", /\brolling(?:\s+usage)?\b/i],
	["weeklyUsage", /\bweekly(?:\s+usage)?\b/i],
	["monthlyUsage", /\bmonthly(?:\s+usage)?\b/i],
];

/**
 * Resolve OpenCode Go dashboard credentials from environment variables.
 * @param {Record<string, string | undefined>} [env=process.env] - Environment values
 * @returns {{ state: "none" } | {
 * 	state: "incomplete",
 * 	missing: string[],
 * 	error: string,
 * } | {
 * 	state: "configured",
 * 	account: {
 * 		label: string,
 * 		workspaceId: string,
 * 		authCookie: string,
 * 		source: "env:OPENCODE_GO_*",
 * 	},
 * }}
 */
export function resolveOpenCodeGoDashboardConfig(env = process.env) {
	const workspaceId = stringValue(env?.OPENCODE_GO_WORKSPACE_ID);
	const authCookie = stringValue(env?.OPENCODE_GO_AUTH_COOKIE);

	if (!workspaceId && !authCookie) return { state: "none" };

	const missing = [];
	if (!workspaceId) missing.push("OPENCODE_GO_WORKSPACE_ID");
	if (!authCookie) missing.push("OPENCODE_GO_AUTH_COOKIE");
	if (missing.length > 0) {
		return {
			state: "incomplete",
			missing,
			error: `OpenCode Go dashboard configuration is incomplete; missing ${missing.join(" and ")}`,
		};
	}

	return {
		state: "configured",
		account: {
			label: stringValue(env?.OPENCODE_GO_LABEL) ?? "go",
			workspaceId,
			authCookie,
			source: "env:OPENCODE_GO_*",
		},
	};
}

/**
 * Configuration locations checked for OpenCode Go dashboard access.
 * @returns {string[]}
 */
export function getOpenCodeGoSearchLocations() {
	return [
		"~/.shuvquota.env (OPENCODE_GO_* entries)",
		"OPENCODE_GO_WORKSPACE_ID env var",
		"OPENCODE_GO_AUTH_COOKIE env var",
	];
}

/**
 * Parse a dashboard reset phrase into seconds.
 * @param {unknown} text - Text such as "Resets in 5 hours 10 minutes"
 * @returns {number | null}
 */
export function parseOpenCodeGoResetSeconds(text) {
	if (typeof text !== "string") return null;
	const normalized = htmlText(text).toLowerCase();
	if (!normalized) return null;
	if (/\b(?:resets?|resetting)(?:\s+right)?\s+now\b|\breset-now\b|^now$/.test(normalized)) {
		return 0;
	}

	const unitSeconds = {
		d: 86400,
		day: 86400,
		days: 86400,
		h: 3600,
		hr: 3600,
		hrs: 3600,
		hour: 3600,
		hours: 3600,
		m: 60,
		min: 60,
		mins: 60,
		minute: 60,
		minutes: 60,
		s: 1,
		sec: 1,
		secs: 1,
		second: 1,
		seconds: 1,
	};
	const pattern = /(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;
	let matched = false;
	let seconds = 0;
	for (const match of normalized.matchAll(pattern)) {
		matched = true;
		seconds += Number(match[1]) * unitSeconds[match[2].toLowerCase()];
	}
	if (!matched || !Number.isFinite(seconds)) return null;
	return Math.max(0, Math.round(seconds));
}

/**
 * Parse the authenticated OpenCode Go dashboard HTML into normalized windows.
 * @param {unknown} html - Dashboard HTML
 * @param {{ nowMs?: number }} [options] - Parsing options
 * @returns {{
 * 	source: "dashboard",
 * 	rollingUsage?: object,
 * 	weeklyUsage?: object,
 * 	monthlyUsage?: object,
 * } | null}
 */
export function parseOpenCodeGoDashboardHtml(html, options = {}) {
	if (typeof html !== "string" || html.trim() === "") return null;
	const suppliedNow = Number.isFinite(options.nowMs) ? new Date(options.nowMs) : null;
	const nowMs = suppliedNow && !Number.isNaN(suppliedNow.getTime())
		? suppliedNow.getTime()
		: Date.now();
	const parsed = {};

	for (const [field, values] of parseHydrationWindows(html)) {
		parsed[field] = normalizeWindow(values.usagePercent, values.resetInSec, nowMs);
	}

	const itemPattern = /<[a-z][\w:-]*\b[^>]*\bdata-slot\s*=\s*(?:"usage-item"|'usage-item'|usage-item\b)[^>]*>/gi;
	const starts = [...html.matchAll(itemPattern)].map((match) => match.index ?? 0);
	for (let index = 0; index < starts.length; index++) {
		const segment = html.slice(starts[index], starts[index + 1] ?? html.length);
		const label = readSlotText(segment, "usage-label");
		const value = readSlotText(segment, "usage-value");
		const reset = readSlotText(segment, "reset-time");
		const field = fieldForLabel(label);
		const usagePercent = parsePercent(value);
		const resetInSec = parseOpenCodeGoResetSeconds(reset);
		if (!field || usagePercent === null || resetInSec === null) continue;
		parsed[field] = normalizeWindow(usagePercent, resetInSec, nowMs);
	}

	const usage = { source: "dashboard" };
	for (const [field] of WINDOW_FIELDS) {
		if (parsed[field]) usage[field] = parsed[field];
	}
	return Object.keys(usage).length > 1 ? usage : null;
}

/**
 * Fetch and parse the authenticated OpenCode Go dashboard.
 * @param {object} account - Account with workspaceId and authCookie
 * @param {{
 * 	fetchFn?: typeof fetch,
 * 	timeoutMs?: number,
 * 	baseUrl?: string,
 * 	nowMs?: number,
 * }} [options] - Fetch options
 * @returns {Promise<{ success: boolean, usage?: object, error?: string, status?: number }>}
 */
export async function fetchOpenCodeGoUsage(account, options = {}) {
	const workspaceId = stringValue(account?.workspaceId);
	const authCookie = stringValue(account?.authCookie);
	if (!workspaceId || !authCookie) {
		return {
			success: false,
			error: "OpenCode Go dashboard configuration is incomplete",
		};
	}

	const fetchFn = options.fetchFn ?? fetch;
	const baseUrl = stringValue(options.baseUrl) ?? OPENCODE_GO_DASHBOARD_BASE_URL;
	const timeoutMs = Number.isFinite(options.timeoutMs)
		? Math.max(0, options.timeoutMs)
		: OPENCODE_GO_TIMEOUT_MS;
	const url = `${baseUrl.replace(/\/+$/, "")}/workspace/${encodeURIComponent(workspaceId)}/go`;
	const controller = new AbortController();
	let timeout;

	try {
		const timeoutPromise = new Promise((_, reject) => {
			timeout = setTimeout(() => {
				controller.abort();
				const error = new Error("Request timed out");
				error.name = "AbortError";
				reject(error);
			}, timeoutMs);
		});
		const response = await Promise.race([
			fetchFn(url, {
				method: "GET",
				headers: {
					Accept: "text/html",
					"User-Agent": OPENCODE_GO_USER_AGENT,
					Cookie: `auth=${authCookie}`,
				},
				signal: controller.signal,
			}),
			timeoutPromise,
		]);

		if (response.status === 401 || response.status === 403) {
			return {
				success: false,
				error: "OpenCode Go sign-in required; refresh OPENCODE_GO_AUTH_COOKIE",
				status: response.status,
			};
		}
		if (!response.ok) {
			return {
				success: false,
				error: `OpenCode Go dashboard returned HTTP ${response.status}`,
				status: response.status,
			};
		}

		const html = await Promise.race([response.text(), timeoutPromise]);
		const usage = parseOpenCodeGoDashboardHtml(html, { nowMs: options.nowMs });
		if (!usage) {
			return {
				success: false,
				error: "OpenCode Go dashboard could not be read; refresh OPENCODE_GO_AUTH_COOKIE",
			};
		}
		return { success: true, usage };
	} catch (error) {
		if (error?.name === "AbortError") {
			return { success: false, error: "OpenCode Go dashboard request timed out" };
		}
		return { success: false, error: "OpenCode Go dashboard request failed" };
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function stringValue(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed || null;
}

/**
 * @param {string} value
 * @returns {string}
 */
function decodeHtmlEntities(value) {
	return value.replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi,
		(match, decimal, hexadecimal, named) => {
			if (decimal) return String.fromCodePoint(Number(decimal));
			if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
			return {
				amp: "&",
				lt: "<",
				gt: ">",
				quot: "\"",
				apos: "'",
				nbsp: " ",
			}[named.toLowerCase()] ?? match;
		});
}

/**
 * @param {string} value
 * @returns {string}
 */
function htmlText(value) {
	return decodeHtmlEntities(value)
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * @param {string} segment
 * @param {string} slot
 * @returns {string}
 */
function readSlotText(segment, slot) {
	const escaped = slot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(
		`<([a-z][\\w:-]*)\\b[^>]*\\bdata-slot\\s*=\\s*(?:"${escaped}"|'${escaped}'|${escaped}\\b)[^>]*>`
		+ "([\\s\\S]*?)<\\/\\1\\s*>",
		"i",
	);
	const match = segment.match(pattern);
	return match ? htmlText(match[2]) : "";
}

/**
 * @param {string} label
 * @returns {string | null}
 */
function fieldForLabel(label) {
	for (const [field, pattern] of WINDOW_FIELDS) {
		if (pattern.test(label)) return field;
	}
	return null;
}

/**
 * @param {string} value
 * @returns {number | null}
 */
function parsePercent(value) {
	const match = value.match(/(-?(?:\d+(?:\.\d*)?|\.\d+))\s*%/);
	if (!match) return null;
	const parsed = Number(match[1]);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {number} usagePercent
 * @param {number} resetInSec
 * @param {number} nowMs
 * @returns {{ usagePercent: number, remainingPercent: number, resetInSec: number, resetAt: string }}
 */
function normalizeWindow(usagePercent, resetInSec, nowMs) {
	const safeReset = Math.max(0, Math.round(resetInSec));
	const remainingPercent = Math.max(0, Math.min(100, 100 - usagePercent));
	return {
		usagePercent,
		remainingPercent: Number(remainingPercent.toFixed(12)),
		resetInSec: safeReset,
		resetAt: new Date(nowMs + safeReset * 1000).toISOString(),
	};
}

/**
 * Extract a balanced object beginning at an opening brace.
 * @param {string} text
 * @param {number} start
 * @returns {string | null}
 */
function balancedObject(text, start) {
	let depth = 0;
	let quote = null;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const character = text[index];
		if (quote) {
			if (escaped) {
				escaped = false;
			} else if (character === "\\") {
				escaped = true;
			} else if (character === quote) {
				quote = null;
			}
			continue;
		}
		if (character === "\"" || character === "'") {
			quote = character;
			continue;
		}
		if (character === "{") depth++;
		if (character === "}") {
			depth--;
			if (depth === 0) return text.slice(start, index + 1);
		}
	}
	return null;
}

/**
 * Parse SolidJS hydration object fields as a fallback when rendered slots change.
 * @param {string} html
 * @returns {Array<[string, { usagePercent: number, resetInSec: number }] >}
 */
function parseHydrationWindows(html) {
	const serialized = decodeHtmlEntities(html)
		.replace(/\\u0022/gi, "\"")
		.replace(/\\u003a/gi, ":")
		.replace(/\\"/g, "\"");
	const windows = [];
	for (const [field] of WINDOW_FIELDS) {
		const fieldPattern = new RegExp(`(?:"|')?${field}(?:"|')?\\s*:\\s*\\{`, "g");
		for (const match of serialized.matchAll(fieldPattern)) {
			const start = (match.index ?? 0) + match[0].lastIndexOf("{");
			const object = balancedObject(serialized, start);
			if (!object) continue;
			const usageMatch = object.match(
				/(?:"|')?usagePercent(?:"|')?\s*:\s*(?:"|')?(-?(?:\d+(?:\.\d*)?|\.\d+))/,
			);
			const resetMatch = object.match(
				/(?:"|')?resetInSec(?:"|')?\s*:\s*(?:"|')?(-?(?:\d+(?:\.\d*)?|\.\d+))/,
			);
			const usagePercent = Number(usageMatch?.[1]);
			const resetInSec = Number(resetMatch?.[1]);
			if (!Number.isFinite(usagePercent) || !Number.isFinite(resetInSec)) continue;
			windows.push([field, { usagePercent, resetInSec }]);
			break;
		}
	}
	return windows;
}
