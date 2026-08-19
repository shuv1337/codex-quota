/**
 * Secure local HTTP server and quota normalization for the shuvquota PWA.
 * Zero dependencies: Node.js built-ins only.
 */

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	formatClaudePlanLabel,
	formatCodexPlanLabel,
	formatGrokPlanLabel,
} from "./plans.js";

export const DEFAULT_SHUVQUOTA_HOST = "127.0.0.1";
export const DEFAULT_SHUVQUOTA_PORT = 4789;
export const DEFAULT_QUOTA_CACHE_MS = 10_000;
export const DEFAULT_QUOTA_FAILURE_COOLDOWN_MS = 2_000;
export const DEFAULT_QUOTA_TIMEOUT_MS = 60_000;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SHUVQUOTA_WEB_ROOT = resolve(MODULE_DIR, "../web");
export const DEFAULT_SHUVQUOTA_CLI_PATH = resolve(MODULE_DIR, "../shuvquota.js");

const PROVIDERS = [
	{ id: "codex", name: "Codex" },
	{ id: "claude", name: "Claude" },
	{ id: "grok", name: "SuperGrok" },
	{ id: "synthetic", name: "Synthetic" },
	{ id: "antigravity", name: "Antigravity" },
	{ id: "opencode-go", name: "OpenCode Go" },
];

const MIME_TYPES = new Map([
	[".avif", "image/avif"],
	[".css", "text/css; charset=utf-8"],
	[".gif", "image/gif"],
	[".htm", "text/html; charset=utf-8"],
	[".html", "text/html; charset=utf-8"],
	[".ico", "image/x-icon"],
	[".jpeg", "image/jpeg"],
	[".jpg", "image/jpeg"],
	[".js", "text/javascript; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".map", "application/json; charset=utf-8"],
	[".mjs", "text/javascript; charset=utf-8"],
	[".png", "image/png"],
	[".svg", "image/svg+xml"],
	[".txt", "text/plain; charset=utf-8"],
	[".webmanifest", "application/manifest+json; charset=utf-8"],
	[".webp", "image/webp"],
	[".woff", "font/woff"],
	[".woff2", "font/woff2"],
]);

const SECURITY_HEADERS = Object.freeze({
	"Content-Security-Policy": [
		"default-src 'self'",
		"base-uri 'none'",
		"connect-src 'self'",
		"font-src 'self'",
		"form-action 'none'",
		"frame-ancestors 'none'",
		"img-src 'self'",
		"manifest-src 'self'",
		"object-src 'none'",
		"script-src 'self'",
		"style-src 'self'",
		"worker-src 'self'",
	].join("; "),
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
});

/**
 * Error carrying only a browser-safe category. Raw CLI output is never retained.
 */
export class QuotaLoadError extends Error {
	/**
	 * @param {string} code
	 * @param {string} safeMessage
	 */
	constructor(code, safeMessage) {
		super(safeMessage);
		this.name = "QuotaLoadError";
		this.code = code;
		this.safeMessage = safeMessage;
	}
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function objectValue(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? /** @type {Record<string, unknown>} */ (value)
		: null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function numberValue(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function clampPercent(value) {
	const parsed = numberValue(value);
	if (parsed === null) return null;
	return Math.min(100, Math.max(0, parsed));
}

/**
 * Claude historically returned ratios for non-integer values below one.
 * @param {unknown} value
 * @returns {number | null}
 */
function clampClaudePercent(value) {
	let parsed = numberValue(value);
	if (parsed === null) return null;
	if (parsed > 0 && parsed < 1) parsed *= 100;
	return Math.min(100, Math.max(0, parsed));
}

/**
 * Convert untrusted display text into a short, control-free string.
 * @param {unknown} value
 * @param {number} [maxLength=80]
 * @returns {string | null}
 */
export function sanitizeDisplayText(value, maxLength = 80) {
	if (typeof value !== "string") return null;
	const text = value
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/[<>&]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, maxLength);
	return text || null;
}

/**
 * Mask an email while keeping enough of its domain to distinguish accounts.
 * Invalid email-like values are omitted instead of being reflected to the PWA.
 * @param {unknown} value
 * @returns {string | null}
 */
export function maskEmail(value) {
	const email = sanitizeDisplayText(value, 254);
	if (!email) return null;
	const at = email.lastIndexOf("@");
	if (at <= 0 || at === email.length - 1) return null;
	const local = email.slice(0, at).trim();
	const domain = email.slice(at + 1).trim().toLowerCase();
	if (!local || !/^[a-z0-9.-]+$/i.test(domain) || !domain.includes(".")) return null;
	return `${local.charAt(0)}***@${domain}`;
}

/**
 * Return a stable ISO timestamp from ISO text, epoch seconds/milliseconds, or a
 * relative number of seconds.
 * @param {unknown} value
 * @param {Date} now
 * @param {boolean} [relative=false]
 * @returns {string | null}
 */
function isoTimestamp(value, now, relative = false) {
	const numeric = numberValue(value);
	let date;
	if (numeric !== null) {
		if (relative) {
			date = new Date(now.getTime() + numeric * 1000);
		} else {
			date = new Date(Math.abs(numeric) >= 1e12 ? numeric : numeric * 1000);
		}
	} else if (typeof value === "string" && value.trim()) {
		date = new Date(value);
	} else {
		return null;
	}
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * @param {Record<string, unknown>} window
 * @param {Date} now
 * @param {{ claude?: boolean, defaultWindowSeconds?: number }} [options]
 * @returns {{ usedPercent: number, remainingPercent: number, resetAt: string | null, windowSeconds: number | null } | null}
 */
function normalizeWindowValues(window, now, options = {}) {
	const percentFn = options.claude ? clampClaudePercent : clampPercent;
	let usedPercent = percentFn(
		window.used_percent ?? window.usedPercent ?? window.percent_used
			?? window.percentUsed ?? window.usagePercent ?? window.percent ?? window.utilization,
	);
	let remainingPercent = percentFn(
		window.remaining_percent ?? window.remainingPercent
			?? window.percent_remaining ?? window.percentRemaining,
	);
	if (usedPercent === null && remainingPercent !== null) usedPercent = 100 - remainingPercent;
	if (remainingPercent === null && usedPercent !== null) remainingPercent = 100 - usedPercent;
	if (usedPercent === null || remainingPercent === null) return null;

	const resetAbsolute = window.reset_at ?? window.resetAt ?? window.resets_at ?? window.resetsAt;
	const resetRelative = window.reset_after_seconds ?? window.resetAfterSeconds ?? window.resetInSec;
	const resetAt = isoTimestamp(resetAbsolute, now) ?? isoTimestamp(resetRelative, now, true);
	const parsedWindowSeconds = numberValue(
		window.limit_window_seconds ?? window.limitWindowSeconds
			?? window.window_seconds ?? window.windowSeconds,
	);
	const windowSeconds = parsedWindowSeconds !== null && parsedWindowSeconds >= 0
		? parsedWindowSeconds
		: options.defaultWindowSeconds ?? null;
	return {
		usedPercent: clampPercent(usedPercent),
		remainingPercent: clampPercent(remainingPercent),
		resetAt,
		windowSeconds,
	};
}

/**
 * @param {string} value
 * @returns {string}
 */
function slug(value) {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)
		|| "limit";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function humanize(value) {
	const text = sanitizeDisplayText(value, 60);
	if (!text) return "Additional limit";
	return text.replace(/[_-]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

/**
 * @param {Array<object>} windows
 * @param {Set<string>} seen
 * @param {string} id
 * @param {string} label
 * @param {Record<string, unknown> | null} rawWindow
 * @param {Date} now
 * @param {{ claude?: boolean, defaultWindowSeconds?: number }} [options]
 */
function addWindow(windows, seen, id, label, rawWindow, now, options = {}) {
	if (!rawWindow || seen.has(id)) return;
	const values = normalizeWindowValues(rawWindow, now, options);
	if (!values) return;
	seen.add(id);
	windows.push({ id, label, ...values });
}

/**
 * @param {unknown} error
 * @returns {string | null}
 */
function safeQuotaError(error) {
	const message = typeof error === "string" ? error : "";
	if (!message) return null;
	if (/timeout|timed out|abort/i.test(message)) return "Quota request timed out";
	if (/401|403|auth|token|login|session|credential/i.test(message)) return "Authentication required";
	if (/no accounts?|not found/i.test(message)) return "No accounts found";
	const http = message.match(/http\s+(\d{3})/i);
	if (http) return `Quota service returned HTTP ${http[1]}`;
	return "Quota data unavailable";
}

/**
 * @param {Record<string, unknown>} usage
 * @returns {{ availableCount: number, expirations: string[] } | null}
 */
function normalizeBankedResets(usage) {
	const raw = objectValue(usage.rate_limit_reset_credits ?? usage.rateLimitResetCredits);
	if (!raw) return null;
	const credits = Array.isArray(raw.credits) ? raw.credits : [];
	const expirations = credits
		.map(credit => {
			const item = objectValue(credit);
			return item ? isoTimestamp(item.expires_at ?? item.expiresAt, new Date(0)) : null;
		})
		.filter(Boolean)
		.sort()
		.slice(0, 100);
	const count = numberValue(raw.available_count ?? raw.availableCount);
	return {
		availableCount: Math.max(0, Math.floor(count ?? expirations.length)),
		expirations,
	};
}

/**
 * @param {Record<string, unknown>} entry
 * @param {number} index
 * @param {Date} now
 * @returns {object}
 */
function normalizeCodexAccount(entry, index, now) {
	const rawUsage = objectValue(entry.usage);
	const usage = objectValue(rawUsage?.usage) ?? rawUsage ?? {};
	const rateLimit = objectValue(usage.rate_limit ?? usage.rateLimit) ?? {};
	const primary = objectValue(rateLimit.primary_window ?? rateLimit.primaryWindow
		?? usage.primary ?? usage.session ?? usage.fiveHour);
	const secondary = objectValue(rateLimit.secondary_window ?? rateLimit.secondaryWindow
		?? usage.secondary ?? usage.weekly ?? usage.week);
	const windows = [];
	const seen = new Set();
	const primarySeconds = numberValue(primary?.limit_window_seconds ?? primary?.limitWindowSeconds);
	const primaryIsWeekly = primarySeconds !== null && primarySeconds >= 6 * 24 * 60 * 60;
	addWindow(
		windows,
		seen,
		primaryIsWeekly ? "weekly" : "session",
		primaryIsWeekly ? "Weekly" : "Session",
		primary,
		now,
	);
	addWindow(windows, seen, "weekly", "Weekly", secondary, now);

	const additional = Array.isArray(usage.additional_rate_limits)
		? usage.additional_rate_limits
		: Array.isArray(usage.additionalRateLimits) ? usage.additionalRateLimits : [];
	additional.forEach((rawAdditional, additionalIndex) => {
		const item = objectValue(rawAdditional);
		if (!item) return;
		const name = humanize(item.limit_name ?? item.limitName ?? item.name ?? `Additional ${additionalIndex + 1}`);
		const key = slug(name);
		const nested = objectValue(item.rate_limit ?? item.rateLimit) ?? item;
		addWindow(
			windows,
			seen,
			`additional-${key}-primary`,
			name,
			objectValue(nested.primary_window ?? nested.primaryWindow ?? nested.window ?? nested),
			now,
		);
		addWindow(
			windows,
			seen,
			`additional-${key}-secondary`,
			`${name} weekly`,
			objectValue(nested.secondary_window ?? nested.secondaryWindow),
			now,
		);
	});

	const entryError = safeQuotaError(entry.error ?? rawUsage?.error);
	const partialError = entryError ?? (windows.length === 0 && rawUsage ? "Quota data unavailable" : null);
	const status = entryError
		? "error"
		: windows.length === 0
			? "unavailable"
			: windows.some(window => window.remainingPercent <= 20) ? "attention" : "ok";
	const account = {
		label: sanitizeDisplayText(entry.label) ?? `Account ${index + 1}`,
		email: maskEmail(entry.email),
		plan: sanitizeDisplayText(
			formatCodexPlanLabel(
				entry.planType ?? entry.plan_type ?? usage.plan_type ?? usage.planType,
				{ planOverride: entry.planOverride ?? entry.plan_override },
			),
		),
		status,
		windows,
	};
	const bankedResets = normalizeBankedResets(usage);
	if (bankedResets) account.bankedResets = bankedResets;
	return { account, partialError };
}

/**
 * @param {Record<string, unknown>} scope
 * @returns {string | null}
 */
function claudeScopeName(scope) {
	const model = scope.model;
	if (typeof model === "string") return sanitizeDisplayText(model);
	const modelObject = objectValue(model);
	const modelName = modelObject?.display_name ?? modelObject?.displayName ?? modelObject?.name;
	if (modelName) return sanitizeDisplayText(modelName);
	const surface = scope.surface;
	if (typeof surface === "string") return sanitizeDisplayText(surface);
	const surfaceObject = objectValue(surface);
	return sanitizeDisplayText(
		surfaceObject?.display_name ?? surfaceObject?.displayName ?? surfaceObject?.name,
	);
}

/**
 * @param {Record<string, unknown>} entry
 * @param {number} index
 * @param {Date} now
 * @returns {object}
 */
function normalizeClaudeAccount(entry, index, now) {
	const usageOuter = objectValue(entry.usage) ?? {};
	const usage = objectValue(usageOuter.usage ?? usageOuter.quotas ?? usageOuter.quota) ?? usageOuter;
	const windows = [];
	const seen = new Set();
	const legacy = [
		["session", "Session", usage.five_hour ?? usage.fiveHour, 5 * 60 * 60],
		["weekly", "Weekly", usage.seven_day ?? usage.sevenDay, 7 * 24 * 60 * 60],
		["opus-weekly", "Opus weekly", usage.seven_day_opus ?? usage.sevenDayOpus, 7 * 24 * 60 * 60],
		["sonnet-weekly", "Sonnet weekly", usage.seven_day_sonnet ?? usage.sevenDaySonnet, 7 * 24 * 60 * 60],
		["fable-weekly", "Fable weekly", usage.seven_day_fable ?? usage.sevenDayFable, 7 * 24 * 60 * 60],
	];
	for (const [id, label, rawWindow, seconds] of legacy) {
		addWindow(windows, seen, id, label, objectValue(rawWindow), now, {
			claude: true,
			defaultWindowSeconds: seconds,
		});
	}

	const limits = Array.isArray(usage.limits) ? usage.limits : [];
	limits.forEach((rawLimit, limitIndex) => {
		const limit = objectValue(rawLimit);
		if (!limit) return;
		const kind = String(limit.kind ?? "");
		const group = String(limit.group ?? "");
		const scopedName = claudeScopeName(objectValue(limit.scope) ?? {});
		let id;
		let label;
		let defaultWindowSeconds = null;
		if (scopedName) {
			id = `${slug(scopedName)}-${group === "weekly" || kind.startsWith("weekly") ? "weekly" : "limit"}`;
			label = `${humanize(scopedName)}${id.endsWith("weekly") ? " weekly" : ""}`;
			if (id.endsWith("weekly")) defaultWindowSeconds = 7 * 24 * 60 * 60;
		} else if (group === "session" || kind === "session") {
			id = "session";
			label = "Session";
			defaultWindowSeconds = 5 * 60 * 60;
		} else if (kind === "weekly_all" || group === "weekly") {
			id = "weekly";
			label = "Weekly";
			defaultWindowSeconds = 7 * 24 * 60 * 60;
		} else {
			id = `limit-${limitIndex + 1}`;
			label = humanize(kind || group || `Limit ${limitIndex + 1}`);
		}
		addWindow(windows, seen, id, label, limit, now, {
			claude: true,
			defaultWindowSeconds,
		});
	});

	const accountObject = objectValue(entry.account) ?? {};
	const nestedAccount = objectValue(accountObject.account) ?? {};
	const entryError = safeQuotaError(entry.error);
	const partial = objectValue(entry.errors);
	const partialError = entryError ?? (partial ? "Some quota data is unavailable" : null);
	const status = entry.success === false || entryError
		? "error"
		: windows.length === 0
			? "unavailable"
			: windows.some(window => window.remainingPercent <= 20) ? "attention" : "ok";
	return {
		account: {
			label: sanitizeDisplayText(entry.label) ?? `Account ${index + 1}`,
			email: maskEmail(
				accountObject.email ?? accountObject.email_address
					?? nestedAccount.email ?? entry.email,
			),
			plan: sanitizeDisplayText(
				formatClaudePlanLabel(
					entry.subscriptionType
						?? accountObject.plan
						?? accountObject.plan_type
						?? accountObject.planType,
					entry.rateLimitTier
						?? accountObject.rateLimitTier
						?? accountObject.rate_limit_tier,
					{
						planOverride: entry.planOverride
							?? entry.plan_override
							?? accountObject.planOverride,
					},
				),
			),
			status,
			windows,
		},
		partialError,
	};
}

/**
 * @param {Record<string, unknown>} entry
 * @param {number} index
 * @param {Date} now
 * @returns {object}
 */
function normalizeGrokAccount(entry, index, now) {
	const usage = objectValue(entry.usage) ?? {};
	const period = objectValue(usage.period) ?? {};
	const startAt = isoTimestamp(period.start, now);
	const resetAt = isoTimestamp(period.end, now);
	const periodSeconds = startAt && resetAt
		? Math.max(0, (Date.parse(resetAt) - Date.parse(startAt)) / 1000)
		: null;
	const windows = [];
	const mainPercent = clampPercent(usage.creditUsagePercent ?? usage.credit_usage_percent);
	if (mainPercent !== null) {
		windows.push({
			id: "credits",
			label: "Credits",
			usedPercent: mainPercent,
			remainingPercent: 100 - mainPercent,
			resetAt,
			windowSeconds: periodSeconds,
		});
	}
	const products = Array.isArray(usage.products) ? usage.products : [];
	const seen = new Set(["credits"]);
	products.forEach((rawProduct, productIndex) => {
		const product = objectValue(rawProduct);
		if (!product) return;
		const percent = clampPercent(product.usagePercent ?? product.usage_percent);
		if (percent === null) return;
		const label = humanize(product.product ?? `Product ${productIndex + 1}`);
		let id = `product-${slug(label)}`;
		if (seen.has(id)) id = `${id}-${productIndex + 1}`;
		seen.add(id);
		windows.push({
			id,
			label,
			usedPercent: percent,
			remainingPercent: 100 - percent,
			resetAt,
			windowSeconds: periodSeconds,
		});
	});
	const entryError = safeQuotaError(entry.error);
	const status = entryError
		? "error"
		: windows.length === 0
			? "unavailable"
			: windows.some(window => window.remainingPercent <= 20) ? "attention" : "ok";
	return {
		account: {
			label: sanitizeDisplayText(entry.label) ?? `Account ${index + 1}`,
			email: maskEmail(entry.email),
			plan: sanitizeDisplayText(
				formatGrokPlanLabel(entry.tier, {
					plan: entry.plan,
					planType: entry.planType,
					planOverride: entry.planOverride ?? entry.plan_override,
				}),
			),
			status,
			windows,
		},
		partialError: entryError,
	};
}

/**
 * @param {Record<string, unknown>} entry
 * @param {number} index
 * @param {Date} now
 * @returns {object}
 */
function normalizeSyntheticAccount(entry, index, now) {
	const usage = objectValue(entry.usage) ?? {};
	const windows = [];
	const seen = new Set();
	const rolling = objectValue(usage.rollingFiveHourLimit);
	addWindow(windows, seen, "5h", "5h", rolling && {
		remainingPercent: rolling.percentRemaining,
		resetAt: rolling.nextTickAt,
	}, now, { defaultWindowSeconds: 5 * 60 * 60 });
	const weekly = objectValue(usage.weeklyTokenLimit);
	addWindow(windows, seen, "weekly", "Weekly", weekly && {
		remainingPercent: weekly.percentRemaining,
		resetAt: weekly.nextRegenAt,
	}, now, { defaultWindowSeconds: 7 * 24 * 60 * 60 });
	const subscription = objectValue(usage.subscription);
	addWindow(windows, seen, "requests", "Requests", subscription && {
		remainingPercent: subscription.percentRemaining,
		resetAt: subscription.renewsAt,
	}, now);
	const search = objectValue(usage.searchHourly);
	addWindow(windows, seen, "search", "Search", search && {
		remainingPercent: search.percentRemaining,
		resetAt: search.renewsAt,
	}, now, { defaultWindowSeconds: 60 * 60 });
	const entryError = safeQuotaError(entry.error);
	const status = entryError
		? "error"
		: windows.length === 0
			? "unavailable"
			: windows.some(window => window.remainingPercent <= 20) ? "attention" : "ok";
	return {
		account: {
			label: sanitizeDisplayText(entry.label) ?? `Account ${index + 1}`,
			email: null,
			plan: "Synthetic",
			status,
			windows,
		},
		partialError: entryError,
	};
}

function normalizeAntigravityAccount(entry, index, now) {
	const usage = objectValue(entry.usage) ?? {};
	const groups = Array.isArray(usage.groups) ? usage.groups : [];
	const windows = [];
	const seen = new Set();
	for (const rawGroup of groups) {
		const group = objectValue(rawGroup);
		if (!group) continue;
		const groupName = sanitizeDisplayText(group.displayName ?? group.id) ?? "Models";
		const buckets = Array.isArray(group.buckets) ? group.buckets : [];
		for (const rawBucket of buckets) {
			const bucket = objectValue(rawBucket);
			if (!bucket) continue;
			const remaining = clampPercent(
				typeof bucket.percentRemaining === "number"
					? bucket.percentRemaining
					: typeof bucket.remainingFraction === "number"
						? bucket.remainingFraction * 100
						: null,
			);
			if (remaining === null) continue;
			const windowName = sanitizeDisplayText(bucket.window) === "5h"
				? "5h"
				: sanitizeDisplayText(bucket.window) === "weekly"
					? "Weekly"
					: sanitizeDisplayText(bucket.displayName) ?? "Limit";
			const label = groupName === "Gemini Models" || slug(groupName) === "gemini"
				? windowName
				: `${humanize(groupName)} ${windowName}`.trim();
			let id = slug(`${group.id ?? groupName}-${bucket.bucketId ?? windowName}`);
			if (seen.has(id)) id = `${id}-${windows.length + 1}`;
			seen.add(id);
			windows.push({
				id,
				label,
				usedPercent: 100 - remaining,
				remainingPercent: remaining,
				resetAt: isoTimestamp(bucket.resetTime ?? bucket.reset_time, now),
				windowSeconds: bucket.window === "5h" ? 5 * 60 * 60
					: bucket.window === "weekly" ? 7 * 24 * 60 * 60
					: null,
			});
		}
	}
	const entryError = safeQuotaError(entry.error);
	const status = entryError
		? "error"
		: windows.length === 0
			? "unavailable"
			: windows.some(window => window.remainingPercent <= 20) ? "attention" : "ok";
	const paidTier = sanitizeDisplayText(entry.paidTier ?? entry.paid_tier);
	return {
		account: {
			label: sanitizeDisplayText(entry.label) ?? `Account ${index + 1}`,
			email: maskEmail(entry.email),
			plan: paidTier === "g1-pro-tier" ? "Google AI Pro" : paidTier,
			status,
			windows,
		},
		partialError: entryError,
	};
}

function normalizeOpenCodeGoAccount(entry, index, now) {
	const usage = objectValue(entry.usage) ?? {};
	const windows = [];
	const seen = new Set();
	addWindow(
		windows,
		seen,
		"rolling",
		"5h",
		objectValue(usage.rollingUsage),
		now,
		{ defaultWindowSeconds: 5 * 60 * 60 },
	);
	addWindow(
		windows,
		seen,
		"weekly",
		"Weekly",
		objectValue(usage.weeklyUsage),
		now,
		{ defaultWindowSeconds: 7 * 24 * 60 * 60 },
	);
	addWindow(
		windows,
		seen,
		"monthly",
		"Monthly",
		objectValue(usage.monthlyUsage),
		now,
	);

	const entryError = safeQuotaError(entry.error);
	const status = entryError
		? "error"
		: windows.length === 0
			? "unavailable"
			: windows.some(window => window.remainingPercent <= 20) ? "attention" : "ok";
	return {
		account: {
			label: sanitizeDisplayText(entry.label) ?? `Account ${index + 1}`,
			email: null,
			plan: "Go",
			status,
			windows,
		},
		partialError: entryError,
	};
}

const NORMALIZERS = {
	codex: normalizeCodexAccount,
	claude: normalizeClaudeAccount,
	grok: normalizeGrokAccount,
	synthetic: normalizeSyntheticAccount,
	antigravity: normalizeAntigravityAccount,
	"opencode-go": normalizeOpenCodeGoAccount,
};

/**
 * Build the only DTO exposed to the browser. Unknown input fields are discarded.
 * @param {unknown} raw
 * @param {Date | string | number} [now]
 * @returns {{ schemaVersion: 1, generatedAt: string, providers: object[], summary: object, divergence: { codex: boolean, claude: boolean } }}
 */
export function buildQuotaSnapshot(raw, now = new Date()) {
	const generatedDate = now instanceof Date ? new Date(now.getTime()) : new Date(now);
	const safeNow = Number.isNaN(generatedDate.getTime()) ? new Date(0) : generatedDate;
	const root = objectValue(raw) ?? {};
	const globalError = safeQuotaError(root.error);
	const providers = PROVIDERS.map(providerInfo => {
		const providerRaw = root[providerInfo.id];
		const entries = Array.isArray(providerRaw) ? providerRaw : [];
		const normalized = entries
			.map((entry, index) => {
				const item = objectValue(entry);
				return item ? NORMALIZERS[providerInfo.id](item, index, safeNow) : null;
			})
			.filter(Boolean);
		const accountErrors = normalized.map(item => item.partialError).filter(Boolean);
		const providerObject = {
			id: providerInfo.id,
			name: providerInfo.name,
			accounts: normalized.map(item => item.account),
		};
		const providerError = safeQuotaError(objectValue(providerRaw)?.error)
			?? accountErrors[0]
			?? globalError;
		if (providerError) providerObject.error = providerError;
		return providerObject;
	});
	const accounts = providers.flatMap(provider => provider.accounts);
	const attention = accounts.filter(account => account.status === "attention" || account.status === "error").length;
	const summary = {
		providerCount: providers.length,
		accountCount: accounts.length,
	};
	if (attention > 0) summary.attention = attention;
	const divergence = objectValue(root.divergence) ?? {};
	return {
		schemaVersion: 1,
		generatedAt: safeNow.toISOString(),
		providers,
		summary,
		divergence: {
			codex: divergenceValue(divergence.codex) ?? entriesDiverged(root.codex),
			claude: divergenceValue(divergence.claude) ?? entriesDiverged(root.claude),
		},
	};
}

/**
 * @param {unknown} value
 * @returns {boolean | null}
 */
function divergenceValue(value) {
	if (typeof value === "boolean") return value;
	const detail = objectValue(value);
	return typeof detail?.diverged === "boolean" ? detail.diverged : null;
}

/**
 * @param {unknown} entries
 * @returns {boolean}
 */
function entriesDiverged(entries) {
	if (!Array.isArray(entries)) return false;
	return entries.some(entry => Boolean(objectValue(objectValue(entry)?.divergence)?.diverged));
}

/**
 * Execute the CLI without a shell. A non-zero CLI that still produced JSON is
 * allowed through so the normalizer can turn its safe status into the DTO.
 * @param {{ execFileFn?: typeof execFile, cliPath?: string, timeoutMs?: number }} [options]
 * @returns {Promise<string>}
 */
export function executeQuotaCli(options = {}) {
	const execFileFn = options.execFileFn ?? execFile;
	const cliPath = options.cliPath ?? DEFAULT_SHUVQUOTA_CLI_PATH;
	const timeoutMs = options.timeoutMs ?? DEFAULT_QUOTA_TIMEOUT_MS;
	return new Promise((resolvePromise, rejectPromise) => {
		execFileFn(
			process.execPath,
			[cliPath, "--json", "--no-color", "--local", "--no-factory"],
			{
				encoding: "utf8",
				maxBuffer: 2 * 1024 * 1024,
				shell: false,
				timeout: timeoutMs,
				windowsHide: true,
			},
			(error, stdout) => {
				const output = typeof stdout === "string" ? stdout.trim() : "";
				if (error) {
					if (error.killed || error.code === "ETIMEDOUT" || error.signal === "SIGTERM") {
						rejectPromise(new QuotaLoadError("CLI_TIMEOUT", "Quota request timed out"));
						return;
					}
					if (output) {
						try {
							JSON.parse(output);
							resolvePromise(output);
							return;
						} catch {
							// Fall through to the generic, non-reflective failure.
						}
					}
					rejectPromise(new QuotaLoadError("CLI_FAILED", "Quota data unavailable"));
					return;
				}
				resolvePromise(output);
			},
		);
	});
}

/**
 * Create a single-flight quota loader with a short success cache and failure
 * cooldown. This prevents concurrent PWA refreshes from racing token rotation.
 * @param {{ execute?: () => Promise<string | object>, cacheMs?: number, failureCooldownMs?: number, now?: () => Date }} [options]
 * @returns {{ getSnapshot: () => Promise<object>, clear: () => void }}
 */
export function createQuotaLoader(options = {}) {
	const execute = options.execute ?? (() => executeQuotaCli());
	const cacheMs = options.cacheMs ?? DEFAULT_QUOTA_CACHE_MS;
	const failureCooldownMs = options.failureCooldownMs ?? DEFAULT_QUOTA_FAILURE_COOLDOWN_MS;
	const now = options.now ?? (() => new Date());
	let inFlight = null;
	let cached = null;
	let cachedAt = 0;
	let failure = null;
	let failedAt = 0;

	const getSnapshot = async () => {
		const currentMs = now().getTime();
		if (cached && currentMs - cachedAt < cacheMs) return cached;
		if (failure && currentMs - failedAt < failureCooldownMs) throw failure;
		if (inFlight) return inFlight;

		inFlight = (async () => {
			const startedAt = now();
			try {
				const result = await execute();
				let raw;
				if (typeof result === "string") {
					try {
						raw = JSON.parse(result);
					} catch {
						throw new QuotaLoadError("INVALID_JSON", "Quota data unavailable");
					}
				} else {
					raw = result;
				}
				const completedAt = now();
				const snapshot = {
					...buildQuotaSnapshot(raw, completedAt),
					scanDurationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
				};
				cached = snapshot;
				cachedAt = completedAt.getTime();
				failure = null;
				return snapshot;
			} catch (error) {
				failure = error instanceof QuotaLoadError
					? error
					: new QuotaLoadError("CLI_FAILED", "Quota data unavailable");
				failedAt = now().getTime();
				throw failure;
			} finally {
				inFlight = null;
			}
		})();
		return inFlight;
	};

	return {
		getSnapshot,
		clear() {
			cached = null;
			failure = null;
			cachedAt = 0;
			failedAt = 0;
		},
	};
}

/**
 * @param {string | string[] | undefined} configured
 * @param {string} bindHost
 * @returns {Set<string>}
 */
export function buildAllowedHosts(configured, bindHost = DEFAULT_SHUVQUOTA_HOST) {
	const values = Array.isArray(configured)
		? configured
		: typeof configured === "string" ? configured.split(",") : [];
	const hosts = new Set(["localhost", "127.0.0.1", "::1"]);
	for (const value of [bindHost, ...values]) {
		const normalized = normalizeHostName(value);
		if (normalized) hosts.add(normalized);
	}
	return hosts;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeHostName(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim().toLowerCase();
	if (!trimmed || /[\s/@\\?#]/.test(trimmed)) return null;
	try {
		const parsed = new URL(`http://${trimmed}`);
		if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
			return null;
		}
		return parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
	} catch {
		return null;
	}
}

/**
 * @param {unknown} header
 * @param {Set<string>} allowedHosts
 * @returns {boolean}
 */
export function isAllowedHost(header, allowedHosts) {
	const normalized = normalizeHostName(header);
	return normalized !== null && allowedHosts.has(normalized);
}

/**
 * @param {import("node:http").ServerResponse} response
 */
function applySecurityHeaders(response) {
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
		response.setHeader(name, value);
	}
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {number} statusCode
 * @param {Buffer | string} body
 * @param {string} contentType
 * @param {boolean} headOnly
 * @param {Record<string, string>} [headers]
 */
function sendResponse(response, statusCode, body, contentType, headOnly, headers = {}) {
	const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
	applySecurityHeaders(response);
	response.statusCode = statusCode;
	response.setHeader("Content-Type", contentType);
	response.setHeader("Content-Length", String(payload.length));
	for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
	response.end(headOnly ? undefined : payload);
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {number} statusCode
 * @param {object} value
 * @param {boolean} headOnly
 */
function sendApiJson(response, statusCode, value, headOnly) {
	sendResponse(
		response,
		statusCode,
		`${JSON.stringify(value)}\n`,
		"application/json; charset=utf-8",
		headOnly,
		{
			"Cache-Control": "private, no-store, max-age=0",
			Expires: "0",
			Pragma: "no-cache",
		},
	);
}

/**
 * @param {Date} now
 * @param {unknown} error
 * @returns {object}
 */
function buildUnavailableSnapshot(now, error) {
	const message = error instanceof QuotaLoadError ? error.safeMessage : "Quota data unavailable";
	const snapshot = buildQuotaSnapshot({ error: message }, now);
	return snapshot;
}

/**
 * Resolve a decoded URL path beneath webRoot, rejecting traversal and symlink
 * escapes. Returns null for invalid or missing files.
 * @param {string} rawUrl
 * @param {string} webRoot
 * @returns {Promise<string | null>}
 */
export async function resolveStaticFile(rawUrl, webRoot = DEFAULT_SHUVQUOTA_WEB_ROOT) {
	const rawPath = String(rawUrl || "/").split(/[?#]/, 1)[0] || "/";
	let decoded;
	try {
		decoded = decodeURIComponent(rawPath);
	} catch {
		return null;
	}
	if (!decoded.startsWith("/") || decoded.includes("\0") || decoded.includes("\\")) return null;
	if (decoded.split("/").some(segment => segment === "..")) return null;
	const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
	const rootPath = resolve(webRoot);
	const candidate = resolve(rootPath, relativePath);
	const lexicalRelative = relative(rootPath, candidate);
	if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
		return null;
	}
	try {
		const rootRealPath = await realpath(rootPath);
		let filePath = candidate;
		let fileStat = await stat(filePath);
		if (fileStat.isDirectory()) {
			filePath = join(filePath, "index.html");
			fileStat = await stat(filePath);
		}
		if (!fileStat.isFile()) return null;
		const fileRealPath = await realpath(filePath);
		const realRelative = relative(rootRealPath, fileRealPath);
		if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
			return null;
		}
		return fileRealPath;
	} catch {
		return null;
	}
}

/**
 * @param {string} filePath
 * @returns {string}
 */
export function getMimeType(filePath) {
	return MIME_TYPES.get(extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

/**
 * Create the shuvquota request handler.
 * @param {{ webRoot?: string, quotaLoader?: { getSnapshot: () => Promise<object> } | (() => Promise<object>), host?: string, allowedHosts?: string | string[] | Set<string>, now?: () => Date }} [options]
 * @returns {import("node:http").RequestListener}
 */
export function createShuvquotaHandler(options = {}) {
	const webRoot = options.webRoot ?? DEFAULT_SHUVQUOTA_WEB_ROOT;
	const defaultLoader = createQuotaLoader();
	const getSnapshot = typeof options.quotaLoader === "function"
		? options.quotaLoader
		: options.quotaLoader?.getSnapshot?.bind(options.quotaLoader) ?? defaultLoader.getSnapshot;
	const allowedHosts = options.allowedHosts instanceof Set
		? options.allowedHosts
		: buildAllowedHosts(options.allowedHosts, options.host ?? DEFAULT_SHUVQUOTA_HOST);
	const now = options.now ?? (() => new Date());

	return async (request, response) => {
		const method = request.method ?? "GET";
		const headOnly = method === "HEAD";
		if (!isAllowedHost(request.headers.host, allowedHosts)) {
			sendResponse(response, 421, "Misdirected Request\n", "text/plain; charset=utf-8", headOnly);
			return;
		}
		if (request.headers["sec-fetch-site"] === "cross-site") {
			sendResponse(response, 403, "Forbidden\n", "text/plain; charset=utf-8", headOnly);
			return;
		}
		if (method !== "GET" && method !== "HEAD") {
			response.setHeader("Allow", "GET, HEAD");
			sendResponse(response, 405, "Method Not Allowed\n", "text/plain; charset=utf-8", false);
			return;
		}

		const path = String(request.url ?? "/").split(/[?#]/, 1)[0];
		if (path === "/api/health") {
			sendApiJson(response, 200, { status: "ok", service: "shuvquota", schemaVersion: 1 }, headOnly);
			return;
		}
		if (path === "/api/quota") {
			try {
				const snapshot = await getSnapshot();
				sendApiJson(response, 200, snapshot, headOnly);
			} catch (error) {
				sendApiJson(response, 503, buildUnavailableSnapshot(now(), error), headOnly);
			}
			return;
		}
		if (path.startsWith("/api/")) {
			sendApiJson(response, 404, { error: "Not found" }, headOnly);
			return;
		}

		const filePath = await resolveStaticFile(request.url ?? "/", webRoot);
		if (!filePath) {
			sendResponse(response, 404, "Not Found\n", "text/plain; charset=utf-8", headOnly, {
				"Cache-Control": "no-store",
			});
			return;
		}
		try {
			const contents = await readFile(filePath);
			const basename = filePath.slice(filePath.lastIndexOf(sep) + 1);
			const extension = extname(filePath).toLowerCase();
			const cacheControl = basename === "index.html" || basename === "sw.js"
				|| extension === ".webmanifest" || extension === ".js" || extension === ".css"
				? "no-cache"
				: "public, max-age=3600";
			sendResponse(response, 200, contents, getMimeType(filePath), headOnly, {
				"Cache-Control": cacheControl,
			});
		} catch {
			sendResponse(response, 404, "Not Found\n", "text/plain; charset=utf-8", headOnly, {
				"Cache-Control": "no-store",
			});
		}
	};
}

/**
 * Create the shuvquota HTTP server.
 * @param {Parameters<typeof createShuvquotaHandler>[0]} [options]
 * @returns {import("node:http").Server}
 */
export function createShuvquotaServer(options = {}) {
	return createServer(createShuvquotaHandler(options));
}
