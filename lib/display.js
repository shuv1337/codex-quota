/**
 * Bars, boxes, usage lines, help text.
 * Depends on: lib/constants.js, lib/color.js, lib/jwt.js
 */

import { PRIMARY_CMD } from "./constants.js";
import { GREEN, RED, YELLOW, colorize, getPackageVersion } from "./color.js";
import { extractProfile } from "./jwt.js";
import { normalizeClaudeOrgId } from "./claude-usage.js";
import {
	formatClaudePlanLabel,
	formatCodexPlanLabel,
	formatGrokPlanLabel,
} from "./plans.js";

export function parseWindow(window) {
	if (!window) return null;
	const used = window.used_percent ?? window.usedPercent ?? window.percent_used;
	const remaining = window.remaining_percent ?? window.remainingPercent;
	const resets = window.resets_at ?? window.resetsAt ?? window.reset_at;
	const resetAfterSeconds = window.reset_after_seconds ?? window.resetAfterSeconds;
	const limitWindowSeconds = window.limit_window_seconds ?? window.limitWindowSeconds;
	return { used, remaining, resets, resetAfterSeconds, limitWindowSeconds };
}

/**
 * Whether a Codex rate-limit window represents a weekly quota.
 * The API formerly returned a 5-hour primary window and weekly secondary window.
 * Weekly-only plans now return their 7-day quota as the primary window instead.
 * @param {object | null} window - Parsed rate-limit window
 * @returns {boolean}
 */
export function isCodexWeeklyWindow(window) {
	return Number(window?.limitWindowSeconds) >= 6 * 24 * 60 * 60;
}

export function formatPercent(used, remaining) {
	// Prefer showing remaining (matches Codex CLI /status display)
	if (remaining !== undefined) return `${Math.round(remaining)}% left`;
	if (used !== undefined) return `${Math.round(100 - used)}% left`;
	return null;
}

// normalizeClaudeOrgId and isClaudeAuthError are imported from ./claude-usage.js

export function formatResetTime(seconds, style = "parentheses") {
	if (!seconds) return "";
	
	const resetDate = new Date(Date.now() + seconds * 1000);
	const hours = Math.floor(seconds / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	
	// Format time as HH:MM
	const timeStr = resetDate.toLocaleTimeString("en-US", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
	
	if (style === "compact") {
		if (hours >= 24) {
			const day = resetDate.getDate();
			const month = resetDate.toLocaleDateString("en-US", { month: "short" });
			return `${day} ${month} ${timeStr}`;
		}
		return timeStr;
	}
	
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

/**
 * Format a banked reset expiration timestamp in the machine's local timezone.
 * @param {string | number | Date | null} timestamp - Reset expiration timestamp
 * @param {boolean} [compact=false] - Whether to use the single-line format
 * @returns {string}
 */
export function formatBankedResetExpiration(timestamp, compact = false) {
	if (!timestamp) return "not set";
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return "not set";
	return date.toLocaleString("en-US", compact ? {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
		timeZoneName: "short",
	} : {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
		hour12: true,
		timeZoneName: "short",
	});
}

/**
 * Read banked reset-credit details from a Codex usage payload.
 * @param {object} usage - Codex usage payload
 * @returns {{ availableCount: number, credits: object[] } | null}
 */
export function parseBankedResetCredits(usage) {
	const raw = usage?.rate_limit_reset_credits ?? usage?.rateLimitResetCredits;
	if (!raw || typeof raw !== "object") return null;

	const credits = Array.isArray(raw.credits) ? raw.credits : [];
	const rawCount = raw.available_count ?? raw.availableCount;
	const parsedCount = Number(rawCount);
	const availableCount = Number.isFinite(parsedCount) ? parsedCount : credits.length;
	return { availableCount, credits };
}

export function formatUsage(payload) {
	const usage = payload?.usage ?? payload;
	
	// Handle new API format: rate_limit.primary_window / secondary_window
	const rateLimit = usage?.rate_limit;
	const primaryWindow = rateLimit?.primary_window ?? usage?.primary ?? usage?.session ?? usage?.fiveHour;
	const secondaryWindow = rateLimit?.secondary_window ?? usage?.secondary ?? usage?.weekly ?? usage?.week;
	const tertiaryWindow = usage?.tertiary ?? usage?.monthly ?? usage?.month;
	
	const primary = parseWindow(primaryWindow);
	const secondary = parseWindow(secondaryWindow);
	const session = primary && !isCodexWeeklyWindow(primary) ? primary : null;
	const weekly = primary && isCodexWeeklyWindow(primary) ? primary : secondary;
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

export function printBar(remaining, width = 20) {
	// Bar shows remaining quota: full = 100% left, empty = 0% left (matches Codex CLI)
	const filled = Math.round((remaining / 100) * width);
	const empty = width - filled;
	const bar = "█".repeat(filled) + "░".repeat(empty);
	return `[${bar}]`;
}

/**
 * Shared label column width for quota bar rows across Codex/Claude/Factory/Grok.
 * Bars always start at this column so multi-provider boxes line up.
 * Includes the trailing spaces after "Label:" — bar is appended with no extra space.
 */
export const QUOTA_LABEL_WIDTH = 14;

/**
 * Format a standard quota bar line with a fixed label column.
 * Example: "Weekly limit: [████░░░░] 64% left (resets 12:01 on 19 Jul)"
 * @param {string} label - Label without trailing colon (e.g. "Weekly limit", "Credits", "Api")
 * @param {number} remaining - Percent remaining (0–100)
 * @param {string} [resetOrSuffix=""] - Optional reset phrase or extra suffix (may include leading space or not)
 * @returns {string}
 */
export function formatQuotaBarLine(label, remaining, resetOrSuffix = "") {
	const prefix = `${String(label)}:`.padEnd(QUOTA_LABEL_WIDTH);
	const pct = Number.isFinite(remaining) ? Math.round(remaining) : 0;
	const suffix = resetOrSuffix
		? (String(resetOrSuffix).startsWith(" ") ? resetOrSuffix : ` ${resetOrSuffix}`)
		: "";
	return `${prefix}${printBar(pct)} ${pct}% left${suffix}`.trimEnd();
}

export function getCompactQuotaColor(remaining) {
	if (remaining === null || remaining === undefined || Number.isNaN(remaining)) {
		return YELLOW;
	}
	if (remaining <= 20) return RED;
	if (remaining <= 60) return YELLOW;
	return GREEN;
}

export function formatCompactPercent(remaining) {
	return `${String(Math.round(remaining)).padStart(3)}%`;
}

/**
 * Redact an email for terminal display.
 * Keeps the first local-part character and full domain: user@example.com → u***@example.com
 * @param {string | null | undefined} email
 * @returns {string | null}
 */
export function redactEmail(email) {
	if (typeof email !== "string") return null;
	const trimmed = email.trim();
	if (!trimmed) return null;
	const at = trimmed.lastIndexOf("@");
	if (at <= 0 || at === trimmed.length - 1) return "***";
	const local = trimmed.slice(0, at);
	const domain = trimmed.slice(at + 1);
	return `${local.charAt(0)}***@${domain}`;
}

/**
 * Format an email for quota headers. Redacted by default; full with showEmail.
 * @param {string | null | undefined} email
 * @param {{ showEmail?: boolean }} [flags]
 * @returns {string} " <email>" or "" when absent
 */
export function formatEmailDisplay(email, flags = {}) {
	if (typeof email !== "string" || !email.trim()) return "";
	const value = flags.showEmail ? email.trim() : redactEmail(email);
	return value ? ` <${value}>` : "";
}

export function formatCompactMetric(label, remaining, reset = "", options = {}) {
	const labelWidth = options.labelWidth ?? String(label).length;
	const metric = `${String(label).padEnd(labelWidth)} ${formatCompactPercent(remaining)}${reset ? ` ${reset}` : ""}`;
	return colorize(metric, getCompactQuotaColor(remaining));
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

/** ANSI SGR sequences used by colorize() — strip for visible width. */
const ANSI_SGR_RE = /\[[0-9;]*m/g;
const ANSI_RESET = "\x1b[0m";

/**
 * Visible string length excluding ANSI color codes.
 * @param {string | null | undefined} text
 * @returns {number}
 */
export function visibleLength(text) {
	return String(text ?? "").replace(ANSI_SGR_RE, "").length;
}

/**
 * Max visible content width across lines.
 * @param {string[]} lines
 * @returns {number}
 */
export function measureLinesWidth(lines) {
	if (!Array.isArray(lines) || lines.length === 0) return 0;
	return lines.reduce((max, line) => Math.max(max, visibleLength(line)), 0);
}

/**
 * Shared min content width so multiple boxes render at the same outer width.
 * @param {Array<string[]>} lineSets
 * @param {number} [floor=70]
 * @returns {number}
 */
export function sharedBoxMinWidth(lineSets, floor = 70) {
	const widest = (Array.isArray(lineSets) ? lineSets : [])
		.reduce((max, lines) => Math.max(max, measureLinesWidth(lines)), 0);
	return Math.max(floor, widest);
}

/**
 * Convert a string into visible character cells while retaining active ANSI styling.
 * @param {string} text
 * @returns {Array<{char: string, style: string}>}
 */
function toVisibleCells(text) {
	const value = String(text ?? "");
	const cells = [];
	let activeStyle = "";
	let offset = 0;

	for (const match of value.matchAll(ANSI_SGR_RE)) {
		for (const char of value.slice(offset, match.index)) {
			cells.push({ char, style: activeStyle });
		}
		activeStyle = match[0] === ANSI_RESET ? "" : activeStyle + match[0];
		offset = match.index + match[0].length;
	}

	for (const char of value.slice(offset)) {
		cells.push({ char, style: activeStyle });
	}
	return cells;
}

/**
 * Restore ANSI styling for visible character cells, resetting before box padding.
 * @param {Array<{char: string, style: string}>} cells
 * @returns {string}
 */
function renderVisibleCells(cells) {
	let output = "";
	let activeStyle = "";
	for (const cell of cells) {
		if (cell.style !== activeStyle) {
			if (activeStyle) output += ANSI_RESET;
			if (cell.style) output += cell.style;
			activeStyle = cell.style;
		}
		output += cell.char;
	}
	if (activeStyle) output += ANSI_RESET;
	return output;
}

function trimCellStart(cells) {
	let start = 0;
	while (start < cells.length && /\s/.test(cells[start].char)) start++;
	return cells.slice(start);
}

function trimCellEnd(cells) {
	let end = cells.length;
	while (end > 0 && /\s/.test(cells[end - 1].char)) end--;
	return cells.slice(0, end);
}

/**
 * Choose a continuation column that preserves the line's visual hierarchy.
 * Quota rows align under the bar; other labelled rows align under their value.
 * @param {Array<{char: string, style: string}>} cells
 * @param {number} maxWidth
 * @returns {number}
 */
function continuationIndent(cells, maxWidth) {
	const text = cells.map(cell => cell.char).join("");
	const leading = text.match(/^\s*/)?.[0].length ?? 0;
	const barIndex = text.indexOf("[");
	const colonIndex = text.indexOf(":", leading);
	let preferred = leading || 2;

	if (barIndex > leading && barIndex <= 20) {
		preferred = barIndex;
	} else if (colonIndex >= leading && colonIndex <= 20) {
		preferred = colonIndex + 1;
		while (text[preferred] === " ") preferred++;
	}

	return Math.min(preferred, Math.floor(maxWidth / 2));
}

/**
 * Wrap one line to a visible width, preserving ANSI styling and useful indentation.
 * @param {string} line
 * @param {number} maxWidth
 * @returns {string[]}
 */
function wrapBoxLine(line, maxWidth) {
	const width = Math.max(1, Math.floor(maxWidth));
	let remaining = trimCellEnd(toVisibleCells(line));
	if (remaining.length <= width) return [renderVisibleCells(remaining)];

	const indentWidth = continuationIndent(remaining, width);
	const wrapped = [];
	let isFirst = true;

	while (remaining.length) {
		const content = isFirst ? remaining : trimCellStart(remaining);
		const contentText = content.map(cell => cell.char).join("");
		const shouldUseShortIndent = !isFirst
			&& contentText.startsWith("(resets ")
			&& content.length + indentWidth > width
			&& content.length + 2 <= width;
		const currentIndentWidth = shouldUseShortIndent ? 2 : indentWidth;
		const indent = isFirst
			? []
			: Array.from({ length: currentIndentWidth }, () => ({ char: " ", style: "" }));
		const candidate = [...indent, ...content];

		if (candidate.length <= width) {
			wrapped.push(renderVisibleCells(trimCellEnd(candidate)));
			break;
		}

		const candidateText = candidate.map(cell => cell.char).join("");
		const resetStart = candidateText.indexOf("(resets ");
		const resetEnd = resetStart >= 0 ? candidateText.indexOf(")", resetStart) : -1;
		const semanticBreak = resetStart > indent.length
			&& resetStart < width
			&& (resetEnd === -1 || resetEnd >= width);
		let breakAt = semanticBreak ? resetStart : width;
		if (!semanticBreak && !/\s/.test(candidate[width]?.char ?? "")) {
			for (let index = width - 1; index > indent.length; index--) {
				if (/\s/.test(candidate[index].char)) {
					breakAt = index;
					break;
				}
			}
		}

		let segment = trimCellEnd(candidate.slice(0, breakAt));
		if (!segment.length) {
			breakAt = width;
			segment = candidate.slice(0, breakAt);
		}
		wrapped.push(renderVisibleCells(segment));

		const consumed = Math.max(1, breakAt - indent.length);
		remaining = trimCellStart(content.slice(consumed));
		isFirst = false;
	}

	return wrapped.length ? wrapped : [""];
}

/**
 * Draw a box around content lines
 * @param {string[]} lines - Lines to display inside the box
 * @param {number} minWidth - Minimum content width before padding (default 70).
 *   Pass the same minWidth to multiple drawBox calls so boxes align.
 * @param {number | null} [maxOuterWidth=process.stdout.columns] - Maximum outer width.
 *   Defaults to the live terminal width when available; null preserves the natural width.
 * @returns {string[]} Lines with box characters
 */
export function drawBox(lines, minWidth = 70, maxOuterWidth = process.stdout.columns) {
	const naturalOuterWidth = Math.max(minWidth, measureLinesWidth(lines)) + 4;
	const availableWidth = Number(maxOuterWidth);
	const outerWidth = Number.isFinite(availableWidth) && availableWidth > 0
		? Math.min(naturalOuterWidth, Math.max(4, Math.floor(availableWidth)))
		: naturalOuterWidth;
	const contentWidth = outerWidth - 2;
	const lineWidth = Math.max(1, outerWidth - 4);
	const wrappedLines = (Array.isArray(lines) ? lines : [])
		.flatMap(line => wrapBoxLine(line, lineWidth));

	const output = [];

	// Top border
	output.push(BOX.topLeft + BOX.horizontal.repeat(contentWidth) + BOX.topRight);

	// Content lines with padding (ANSI-aware so colored text still aligns)
	for (const line of wrappedLines) {
		const padding = Math.max(0, contentWidth - visibleLength(line) - 1);
		output.push(BOX.vertical + " " + line + " ".repeat(padding) + BOX.vertical);
	}

	// Bottom border
	output.push(BOX.bottomLeft + BOX.horizontal.repeat(contentWidth) + BOX.bottomRight);

	return output;
}

/** Preferred quota-card width, narrow enough to survive common split-pane resizing. */
export const QUOTA_BOX_MAX_WIDTH = 50;

/**
 * Draw a quota card at the preferred narrow width, shrinking further for smaller terminals.
 * @param {string[]} lines - Quota lines to display inside the box
 * @param {number} [minWidth=70] - Natural shared content width before the quota cap
 * @returns {string[]} Boxed quota lines
 */
export function drawQuotaBox(lines, minWidth = 70) {
	const terminalWidth = Number(process.stdout.columns);
	const maxWidth = Number.isFinite(terminalWidth) && terminalWidth > 0
		? Math.min(QUOTA_BOX_MAX_WIDTH, Math.floor(terminalWidth))
		: QUOTA_BOX_MAX_WIDTH;
	return drawBox(lines, minWidth, maxWidth);
}

/**
 * Build usage lines for an account (for box display)
 * @param {object} account - Account object
 * @param {object} payload - Usage payload from API
 * @returns {string[]} Lines to display
 */
export function buildAccountUsageLines(account, payload, flags = {}) {
	const lines = [];
	const usage = payload?.usage ?? payload;
	const rateLimit = usage?.rate_limit;
	const primaryWindow = rateLimit?.primary_window ?? usage?.primary ?? usage?.session ?? usage?.fiveHour;
	const secondaryWindow = rateLimit?.secondary_window ?? usage?.secondary ?? usage?.weekly ?? usage?.week;
	const primary = parseWindow(primaryWindow);
	const secondary = parseWindow(secondaryWindow);
	const session = primary && !isCodexWeeklyWindow(primary) ? primary : null;
	const weekly = primary && isCodexWeeklyWindow(primary) ? primary : secondary;
	const bankedResets = parseBankedResetCredits(usage);
	
	// Extract profile info from token
	const profile = extractProfile(account.access);
	const planType = usage?.plan_type ?? profile.planType;
	const planLabel = formatCodexPlanLabel(planType, { planOverride: account.planOverride });
	const planDisplay = planLabel ? ` (${planLabel})` : "";
	
	// Header: Codex (label) <email> (plan) — matches Claude format
	// Emails are redacted by default; pass --show-email / flags.showEmail to reveal.
	const labelDisplay = account.label ? ` (${account.label})` : "";
	const emailDisplay = formatEmailDisplay(profile.email, flags);
	const header = `Codex${labelDisplay}${emailDisplay}${planDisplay}`;
	
	if (flags.compact) {
		const parts = [];
		if (payload.error) {
			parts.push(header, colorize(`error: ${payload.error}`, RED));
			return [parts.join(" | ")];
		}
		if (session) {
			const remaining = session.remaining ?? (session.used !== undefined ? 100 - session.used : null);
			if (remaining !== null) {
				const reset = session.resetAfterSeconds ? formatResetTime(session.resetAfterSeconds, "compact") : "";
				parts.push(formatCompactMetric("5h", remaining, reset));
			}
		}
		if (weekly) {
			const remaining = weekly.remaining ?? (weekly.used !== undefined ? 100 - weekly.used : null);
			if (remaining !== null) {
				const reset = weekly.resetAfterSeconds ? formatResetTime(weekly.resetAfterSeconds, "compact") : "";
				parts.push(formatCompactMetric("7d", remaining, reset));
			}
		}
		if (bankedResets) {
			const expirations = bankedResets.credits.map(credit => (
				formatBankedResetExpiration(credit?.expires_at ?? credit?.expiresAt, true)
			));
			const expirationDisplay = expirations.length ? ` (${expirations.join("; ")})` : "";
			parts.push(`banked ${bankedResets.availableCount}${expirationDisplay}`);
		}
		parts.push(header);
		return [parts.join(" | ")];
	}
	
	lines.push(header);
	lines.push("");
	
	if (payload.error) {
		lines.push(`Error: ${payload.error}`);
		if (account.source) {
			lines.push(`  Source: ${shortenPath(account.source)}`);
		}
		return lines;
	}
	
	// 5h limit bar (session/primary window)
	if (session) {
		const remaining = session.remaining ?? (session.used !== undefined ? 100 - session.used : null);
		if (remaining !== null) {
			const reset = session.resetAfterSeconds ? formatResetTime(session.resetAfterSeconds, "inline") : "";
			lines.push(formatQuotaBarLine("5h limit", remaining, reset));
		}
	}
	
	// Weekly limit bar (secondary window)
	if (weekly) {
		const remaining = weekly.remaining ?? (weekly.used !== undefined ? 100 - weekly.used : null);
		if (remaining !== null) {
			const reset = weekly.resetAfterSeconds ? formatResetTime(weekly.resetAfterSeconds, "inline") : "";
			lines.push(formatQuotaBarLine("Weekly limit", remaining, reset));
		}
	}

	if (bankedResets) {
		lines.push(`Banked resets: ${bankedResets.availableCount}`);
		bankedResets.credits.forEach((credit, index) => {
			const expiration = formatBankedResetExpiration(credit?.expires_at ?? credit?.expiresAt);
			const prefix = index === 0 ? "  Expires: " : "           ";
			lines.push(`${prefix}${expiration}`);
		});
	}
	
	if (account.source) {
		lines.push(`  Source: ${shortenPath(account.source)}`);
	}
	
	return lines;
}

export function formatClaudePercentLeft(percentLeft) {
	if (percentLeft === null || percentLeft === undefined || Number.isNaN(percentLeft)) {
		return "?";
	}
	return `${Math.round(percentLeft)}% left`;
}

export function normalizePercentUsed(value) {
	if (value === null || value === undefined) return null;
	let used = Number(value);
	if (!Number.isFinite(used)) return null;

	// Claude OAuth usage now reports percentage points (0-100).
	// Keep integer values like 1 as 1% used; only treat fractional values
	// in (0, 1) as ratio form for backward compatibility.
	if (used > 0 && used < 1) {
		used *= 100;
	}

	return Math.min(100, Math.max(0, used));
}

export function parseClaudeUtilizationWindow(window) {
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

export function formatResetAt(dateString, style = "inline") {
	if (!dateString) return "";
	const date = new Date(dateString);
	if (Number.isNaN(date.getTime())) return "";
	const seconds = Math.max(0, Math.floor((date.getTime() - Date.now()) / 1000));
	return formatResetTime(seconds, style);
}

export function parseClaudeWindow(window) {
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

export function formatClaudeLabel(label) {
	if (!label) return "";
	return label
		.replace(/_/g, " ")
		.replace(/(^|\s)\S/g, (m) => m.toUpperCase())
		.trim();
}

export function parseClaudeLimitWindow(limit) {
	if (!limit || typeof limit !== "object") return null;
	const remainingPercent = limit.remaining_percent ?? limit.remainingPercent ?? limit.percent_remaining;
	const usedPercent = limit.percent ?? limit.utilization ?? limit.used_percent ?? limit.usedPercent ?? limit.percent_used;
	const resetsAt = limit.resets_at ?? limit.resetsAt ?? limit.reset_at ?? limit.resetAt;

	let remaining = null;
	if (remainingPercent !== undefined) {
		remaining = Number(remainingPercent);
	} else {
		const used = normalizePercentUsed(usedPercent);
		if (used !== null) {
			remaining = 100 - used;
		}
	}

	if (remaining !== null && Number.isFinite(remaining)) {
		remaining = Math.min(100, Math.max(0, remaining));
	}

	return { remaining, resetsAt };
}

function getClaudeScopedLimitName(scope) {
	const model = scope?.model;
	if (typeof model === "string") return model;
	const modelName = model?.display_name ?? model?.displayName ?? model?.name ?? model?.id;
	if (modelName) return modelName;

	const surface = scope?.surface;
	if (typeof surface === "string") return surface;
	return surface?.display_name ?? surface?.displayName ?? surface?.name ?? surface?.id ?? null;
}

export function getClaudeLimitDescriptor(limit) {
	if (!limit || typeof limit !== "object") return null;
	const kind = String(limit.kind ?? "");
	const group = String(limit.group ?? "");
	const scopedName = getClaudeScopedLimitName(limit.scope);

	if (scopedName) {
		const label = formatClaudeLabel(scopedName);
		const isWeekly = group === "weekly" || kind.startsWith("weekly");
		return {
			key: `model:${label.toLowerCase()}:${isWeekly ? "weekly" : group || kind || "scoped"}`,
			label: `${label}${isWeekly ? " weekly" : ""}`,
			compactLabel: label.toLowerCase(),
		};
	}

	if (group === "session" || kind === "session") {
		return { key: "session", label: "5h limit", compactLabel: "5h" };
	}
	if (kind === "weekly_all" || (group === "weekly" && !limit.scope)) {
		return { key: "weekly", label: "Weekly limit", compactLabel: "7d" };
	}

	const fallback = formatClaudeLabel(kind || group || "limit");
	return {
		key: `${group || "limit"}:${kind || fallback.toLowerCase()}`,
		label: fallback,
		compactLabel: fallback.toLowerCase(),
	};
}

export function getClaudeLimitWindows(usage) {
	if (!usage || typeof usage !== "object") return [];
	const root = usage.usage ?? usage.quotas ?? usage.quota ?? usage;
	if (!Array.isArray(root.limits)) return [];

	const windows = [];
	for (const limit of root.limits) {
		const descriptor = getClaudeLimitDescriptor(limit);
		const parsed = parseClaudeLimitWindow(limit);
		if (!descriptor || !parsed || parsed.remaining === null) continue;
		windows.push({ ...descriptor, window: limit, parsed });
	}
	return windows;
}

export function getClaudeUsageWindows(usage) {
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

export function formatClaudeOverageLine(overage) {
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

export function buildClaudeUsageLines(payload, flags = {}) {
	const lines = [];

	const account = payload?.account ?? {};
	const email = account.email ?? account.email_address ?? account?.user?.email ?? account?.account?.email ?? null;
	const membership = Array.isArray(account.memberships)
		? account.memberships.find(m => normalizeClaudeOrgId(m?.organization?.uuid) === normalizeClaudeOrgId(payload?.orgId))
		: null;
	// Support both old format (from account API) and new OAuth format (from credentials).
	// Prefer rateLimitTier SKU (includes Max 5x / 20x) over coarse subscriptionType.
	const planLabel = formatClaudePlanLabel(
		payload?.subscriptionType
			?? account.plan
			?? account.plan_type
			?? account.planType
			?? account?.subscription?.plan
			?? (membership?.organization?.capabilities?.includes("claude_max") ? "claude_max" : null),
		payload?.rateLimitTier
			?? membership?.organization?.rate_limit_tier
			?? null,
		{ planOverride: payload?.planOverride ?? account.planOverride },
	);
	const planDisplay = planLabel || null;
	const label = payload?.label ? ` (${payload.label})` : "";
	const emailDisplay = formatEmailDisplay(email, flags);
	const header = `Claude${label}${emailDisplay}${planDisplay ? ` (${planDisplay})` : ""}`;

	if (flags.compact) {
		const parts = [];
		if (!payload || payload.success === false) {
			parts.push(header, colorize(`error: ${payload?.error ?? "Claude usage unavailable"}`, RED));
			return [parts.join(" | ")];
		}

		const usage = payload?.usage;
		let renderedUsage = false;
		const renderedLimitKeys = new Set();
		if (usage && typeof usage === "object") {
			const fiveHour = parseClaudeUtilizationWindow(usage.five_hour ?? usage.fiveHour);
			if (fiveHour && fiveHour.remaining !== null) {
				const reset = formatResetAt(fiveHour.resetsAt, "compact");
				parts.push(formatCompactMetric("5h", fiveHour.remaining, reset));
				renderedLimitKeys.add("session");
				renderedUsage = true;
			}
			const weekly = parseClaudeUtilizationWindow(usage.seven_day ?? usage.sevenDay);
			if (weekly && weekly.remaining !== null) {
				const reset = formatResetAt(weekly.resetsAt, "compact");
				parts.push(formatCompactMetric("7d", weekly.remaining, reset));
				renderedLimitKeys.add("weekly");
				renderedUsage = true;
			}
			const opus = parseClaudeUtilizationWindow(usage.seven_day_opus ?? usage.sevenDayOpus);
			if (opus && opus.remaining !== null) {
				const reset = formatResetAt(opus.resetsAt, "compact");
				parts.push(formatCompactMetric("opus", opus.remaining, reset, { labelWidth: 6 }));
				renderedLimitKeys.add("model:opus:weekly");
				renderedUsage = true;
			}
			const sonnet = parseClaudeUtilizationWindow(usage.seven_day_sonnet ?? usage.sevenDaySonnet);
			if (sonnet && sonnet.remaining !== null) {
				const reset = formatResetAt(sonnet.resetsAt, "compact");
				parts.push(formatCompactMetric("sonnet", sonnet.remaining, reset, { labelWidth: 6 }));
				renderedLimitKeys.add("model:sonnet:weekly");
				renderedUsage = true;
			}
			const fable = parseClaudeUtilizationWindow(usage.seven_day_fable ?? usage.sevenDayFable);
			if (fable && fable.remaining !== null) {
				const reset = formatResetAt(fable.resetsAt, "compact");
				parts.push(formatCompactMetric("fable", fable.remaining, reset, { labelWidth: 6 }));
				renderedLimitKeys.add("model:fable:weekly");
				renderedUsage = true;
			}
			for (const limit of getClaudeLimitWindows(usage)) {
				if (renderedLimitKeys.has(limit.key)) continue;
				const reset = formatResetAt(limit.parsed.resetsAt, "compact");
				parts.push(formatCompactMetric(limit.compactLabel, limit.parsed.remaining, reset, {
					labelWidth: Math.max(6, limit.compactLabel.length),
				}));
				renderedUsage = true;
			}
		}
		if (!renderedUsage) {
			const windows = getClaudeUsageWindows(payload?.usage);
			if (windows.length) {
				for (const { label: windowLabel, window } of windows) {
					const parsed = parseClaudeWindow(window);
					if (!parsed || parsed.percentLeft === null || parsed.percentLeft === undefined) continue;
					const reset = parsed.resetAfterSeconds
						? formatResetTime(parsed.resetAfterSeconds, "compact")
						: parsed.resets || "";
					parts.push(formatCompactMetric(windowLabel.toLowerCase(), parsed.percentLeft, reset, {
						labelWidth: Math.max(6, windowLabel.length),
					}));
				}
			}
		}
		parts.push(header);
		if (payload.errors) {
			const errorParts = Object.entries(payload.errors).map(([key, value]) => `${key}=${value}`);
			parts.push(colorize(`partial ${errorParts.join(", ")}`, YELLOW));
		}
		return [parts.join(" | ")];
	}

	lines.push(header);
	lines.push("");

	if (!payload || payload.success === false) {
		lines.push(`Error: ${payload?.error ?? "Claude usage unavailable"}`);
		return lines;
	}

	const usage = payload?.usage;
	let renderedUsage = false;
	const renderedLimitKeys = new Set();
	if (usage && typeof usage === "object") {
		const fiveHour = parseClaudeUtilizationWindow(usage.five_hour ?? usage.fiveHour);
		if (fiveHour && fiveHour.remaining !== null) {
			const reset = formatResetAt(fiveHour.resetsAt);
			lines.push(formatQuotaBarLine("5h limit", fiveHour.remaining, reset));
			renderedLimitKeys.add("session");
			renderedUsage = true;
		}
		const weekly = parseClaudeUtilizationWindow(usage.seven_day ?? usage.sevenDay);
		if (weekly && weekly.remaining !== null) {
			const reset = formatResetAt(weekly.resetsAt);
			lines.push(formatQuotaBarLine("Weekly limit", weekly.remaining, reset));
			renderedLimitKeys.add("weekly");
			renderedUsage = true;
		}
		const opus = parseClaudeUtilizationWindow(usage.seven_day_opus ?? usage.sevenDayOpus);
		if (opus && opus.remaining !== null) {
			const reset = formatResetAt(opus.resetsAt);
			lines.push(formatQuotaBarLine("Opus weekly", opus.remaining, reset));
			renderedLimitKeys.add("model:opus:weekly");
			renderedUsage = true;
		}
		const sonnet = parseClaudeUtilizationWindow(usage.seven_day_sonnet ?? usage.sevenDaySonnet);
		if (sonnet && sonnet.remaining !== null) {
			const reset = formatResetAt(sonnet.resetsAt);
			lines.push(formatQuotaBarLine("Sonnet weekly", sonnet.remaining, reset));
			renderedLimitKeys.add("model:sonnet:weekly");
			renderedUsage = true;
		}
		const fable = parseClaudeUtilizationWindow(usage.seven_day_fable ?? usage.sevenDayFable);
		if (fable && fable.remaining !== null) {
			const reset = formatResetAt(fable.resetsAt);
			lines.push(formatQuotaBarLine("Fable weekly", fable.remaining, reset));
			renderedLimitKeys.add("model:fable:weekly");
			renderedUsage = true;
		}
		for (const limit of getClaudeLimitWindows(usage)) {
			if (renderedLimitKeys.has(limit.key)) continue;
			const reset = formatResetAt(limit.parsed.resetsAt);
			lines.push(formatQuotaBarLine(limit.label, limit.parsed.remaining, reset));
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

export function printHelp() {
	console.log(`${PRIMARY_CMD} - Monitor Codex, Claude, Factory, Grok, Synthetic, Antigravity, and OpenCode Go quota
Version: ${getPackageVersion()}

Usage:
  ${PRIMARY_CMD} <namespace> [command] [options]
  ${PRIMARY_CMD} [label]                       Check all configured quota providers

Namespaces:
  codex             Manage OpenAI Codex accounts
  claude            Manage Claude accounts
  factory           Manage Factory.ai accounts
  grok              Check SuperGrok / xAI OAuth quota
  synthetic         Check Synthetic API quota
  antigravity       Check Google AI Pro / Antigravity quota
  opencode-go       Check OpenCode Go dashboard quota
  proxx             Pull usage from a proxx server (no re-auth needed)

Options:
  --json            Output in JSON format
  --compact, -c     Compact quota output (single-line summaries)
  --show-email      Show full account emails (redacted by default)
  --local           Use only stored account files; skip native app token checks
  --native          Include native app auth files in reads/checks (old behavior)
  --dry-run         Preview sync without writing files
  --no-browser      Print auth URL instead of opening browser
  --no-color        Disable colored output
  --version, -v     Show version number
  --help, -h        Show this help

Examples:
  ${PRIMARY_CMD}                   Check all configured quota providers
  ${PRIMARY_CMD} codex             Show Codex command help
  ${PRIMARY_CMD} claude            Show Claude command help
  ${PRIMARY_CMD} factory           Show Factory command help
  ${PRIMARY_CMD} grok              Show Grok command help
  ${PRIMARY_CMD} synthetic         Check Synthetic quota
  ${PRIMARY_CMD} antigravity       Check Google AI Pro quota
  ${PRIMARY_CMD} opencode-go       Check OpenCode Go quota
  ${PRIMARY_CMD} proxx quota       Pull OpenAI quota from proxx server
  ${PRIMARY_CMD} codex quota       Check quota for Codex accounts
  ${PRIMARY_CMD} claude quota      Check quota for Claude accounts
  ${PRIMARY_CMD} factory quota     Check quota for Factory accounts
  ${PRIMARY_CMD} grok quota        Check SuperGrok weekly credits
  ${PRIMARY_CMD} synthetic quota   Check Synthetic request and token limits
  ${PRIMARY_CMD} antigravity quota Check Google AI Pro 5h and weekly Gemini quota
  ${PRIMARY_CMD} opencode-go quota Check OpenCode Go 5h, weekly, and monthly usage
  ${PRIMARY_CMD} codex add work    Add Codex account with label "work"
  ${PRIMARY_CMD} claude add work   Add Claude credential with label "work"
  ${PRIMARY_CMD} codex reauth work Re-authenticate existing "work" account
  ${PRIMARY_CMD} claude reauth work Re-authenticate existing "work" account
  ${PRIMARY_CMD} codex switch work Switch Codex/OpenCode/pi to "work"
  ${PRIMARY_CMD} claude switch work Switch Claude Code/OpenCode/pi to "work"
  ${PRIMARY_CMD} codex sync        Sync active Codex account to CLI auth files
  ${PRIMARY_CMD} codex sync --dry-run  Preview Codex sync without writing
  ${PRIMARY_CMD} claude sync --dry-run Preview Claude sync without writing

Account sources (checked in order):
  1. CODEX_ACCOUNTS env var (JSON array)
  2. ~/.codex-accounts.json
  3. ~/.opencode/openai-codex-auth-accounts.json

  Native app auth files are no longer imported by default to avoid refreshing
  tokens owned by Codex CLI / OpenCode / pi. Use --native to include those
  auth files in reads/checks when needed.

OpenCode & pi Integration:
  The 'switch' and 'sync' commands update Codex CLI (~/.codex/auth.json) plus
  OpenCode (~/.local/share/opencode/auth.json) and pi (~/.pi/agent/auth.json)
  authentication files when they exist, enabling seamless account switching.
  The activeLabel marker in multi-account files is used for sync and divergence
  warnings in list/quota output.

Run '${PRIMARY_CMD} <namespace> <command> --help' for help on a specific command.
`);
}

export function printHelpCodex() {
	console.log(`${PRIMARY_CMD} codex - Manage OpenAI Codex accounts

Usage:
  ${PRIMARY_CMD} codex [command] [options]

Commands:
  quota [label]     Check usage quota (default command)
  add [label]       Add a new account via OAuth browser flow
  reauth <label>    Re-authenticate an existing account via OAuth
  switch <label>    Switch active account for Codex CLI, OpenCode, and pi
  sync              Sync activeLabel to Codex CLI, OpenCode, and pi
  list              List all accounts from all sources
  rename <old> <new> Rename an account label
  remove <label>    Remove an account from storage

Options:
  --json            Output in JSON format
  --dry-run         Preview sync without writing files
  --no-browser      Print auth URL instead of opening browser
  --no-color        Disable colored output
  --help, -h        Show this help

Examples:
  ${PRIMARY_CMD} codex                   Check quota for Codex accounts
  ${PRIMARY_CMD} codex personal          Check quota for "personal" account
  ${PRIMARY_CMD} codex add work          Add new account with label "work"
  ${PRIMARY_CMD} codex reauth work       Re-authenticate "work" account
  ${PRIMARY_CMD} codex switch personal   Switch to "personal" account
  ${PRIMARY_CMD} codex list              List all configured accounts
  ${PRIMARY_CMD} codex rename prolite "Pro 20x"  Rename account label
  ${PRIMARY_CMD} codex remove old        Remove "old" account
  ${PRIMARY_CMD} codex sync              Sync the activeLabel account
  ${PRIMARY_CMD} codex sync --dry-run    Preview sync without writing

Notes:
  - switch and sync update activeLabel in ~/.codex-accounts.json when available
  - list/quota warn when CLI auth diverges (use '${PRIMARY_CMD} codex sync')
  - JWT plan type "prolite" displays as "Pro 20x" in CLI/web UI
`);
}

export function printHelpClaude() {
	console.log(`${PRIMARY_CMD} claude - Manage Claude credentials

Usage:
  ${PRIMARY_CMD} claude [command] [options]

Commands:
  quota [label]     Check Claude usage (default command)
  add [label]       Add a Claude credential (via OAuth or manual entry)
  reauth <label>    Re-authenticate an existing Claude account via OAuth
  switch <label>    Switch Claude Code, OpenCode, and pi credentials
  sync              Sync activeLabel to Claude Code, OpenCode, and pi
  list              List Claude credentials
  set-plan <label> <Pro|Max 5x|Max 20x|clear>
                    Override plan label shown in CLI/web UI
  remove <label>    Remove a Claude credential from storage

Options:
  --json            Output result in JSON format
  --dry-run         Preview sync without writing files
  --oauth           Use OAuth browser authentication (recommended)
  --manual          Use manual token entry
  --no-browser      Print OAuth URL instead of opening browser
  --help, -h        Show this help

Examples:
  ${PRIMARY_CMD} claude                   Check Claude usage
  ${PRIMARY_CMD} claude quota work        Check Claude usage for "work"
  ${PRIMARY_CMD} claude add               Add Claude credential (prompts for method)
  ${PRIMARY_CMD} claude add work --oauth  Add via OAuth browser flow
  ${PRIMARY_CMD} claude reauth work       Re-authenticate "work" account
  ${PRIMARY_CMD} claude switch work       Switch Claude Code/OpenCode/pi to "work"
  ${PRIMARY_CMD} claude set-plan work "Max 20x"
  ${PRIMARY_CMD} claude list              List Claude credentials
  ${PRIMARY_CMD} claude remove old        Remove Claude credential "old"
  ${PRIMARY_CMD} claude sync              Sync the activeLabel account
  ${PRIMARY_CMD} claude sync --dry-run    Preview sync without writing

Notes:
  - switch and sync update activeLabel in ~/.claude-accounts.json when available
  - session-key-only accounts cannot be synced (OAuth required)
  - plan SKU auto-reads from Claude credentials (e.g. default_claude_max_20x → Max 20x)
`);
}

export function printHelpClaudeAdd() {
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

export function printHelpClaudeReauth() {
	console.log(`${PRIMARY_CMD} claude reauth - Re-authenticate an existing Claude account

Usage:
  ${PRIMARY_CMD} claude reauth <label> [options]

Arguments:
  label             Required. Label of the Claude account to re-authenticate

Options:
  --no-browser      Print the OAuth URL instead of opening browser
                    Use this in headless/SSH environments
  --json            Output result in JSON format
  --help, -h        Show this help

Description:
  Re-authenticates an existing Claude account via the OAuth browser flow.
  This is useful when your tokens have expired and cannot be refreshed,
  or when you need to reset your authentication.

  Unlike 'add', this command:
    - Requires an existing account with the specified label
    - Updates the existing entry instead of creating a new one
    - Preserves any extra fields in the account configuration
    - Always uses OAuth (no manual token entry)

  If the re-authenticated account is the active account, CLI auth files
  (Claude Code, OpenCode, pi) will also be updated automatically.

Examples:
  ${PRIMARY_CMD} claude reauth work                Re-authenticate "work" account
  ${PRIMARY_CMD} claude reauth work --no-browser   Print URL for manual browser auth
  ${PRIMARY_CMD} claude reauth work --json         JSON output for scripting

See also:
  ${PRIMARY_CMD} claude add     Add a new Claude account
  ${PRIMARY_CMD} claude list    Show all configured Claude accounts
`);
}

export function printHelpClaudeSwitch() {
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
  Also updates activeLabel in ~/.claude-accounts.json when available.

Examples:
  ${PRIMARY_CMD} claude switch work
  ${PRIMARY_CMD} claude switch work --json

See also:
  ${PRIMARY_CMD} claude sync
`);
}

export function printHelpClaudeSync() {
	console.log(`${PRIMARY_CMD} claude sync - Sync activeLabel to Claude auth files

Usage:
  ${PRIMARY_CMD} claude sync [options]

Options:
  --dry-run         Preview what would be synced without writing files
  --json            Output result in JSON format
  --help, -h        Show this help

Description:
  Pushes the activeLabel Claude account from ~/.claude-accounts.json to:
  - Claude Code (~/.claude/.credentials.json)
  - OpenCode (~/.local/share/opencode/auth.json) when present
  - pi (~/.pi/agent/auth.json) when present

  Only OAuth-based accounts can be synced. Session-key-only accounts are
  skipped with a warning.

Examples:
  ${PRIMARY_CMD} claude sync
  ${PRIMARY_CMD} claude sync --dry-run
  ${PRIMARY_CMD} claude sync --json

See also:
  ${PRIMARY_CMD} claude switch <label>
  ${PRIMARY_CMD} claude list
`);
}

export function printHelpClaudeList() {
	console.log(`${PRIMARY_CMD} claude list - List Claude credentials

Usage:
  ${PRIMARY_CMD} claude list [options]

Options:
  --json            Output in JSON format
  --local           Skip native app token checks and divergence warnings (default)
  --native          Include native app auth files in reads/checks
  --help, -h        Show this help

Description:
  Lists Claude credentials stored in CLAUDE_ACCOUNTS or ~/.claude-accounts.json.
  The activeLabel account is marked with '*'.
  OAuth-based accounts are loaded only from shuvquota-managed sources by
  default so native app tokens are not imported and refreshed accidentally.
  Use --native to include Claude Code / OpenCode native auth files.
  Use --local to explicitly suppress native app checks and only use stored
  account files.

Examples:
  ${PRIMARY_CMD} claude list
  ${PRIMARY_CMD} claude list --json
`);
}

export function printHelpClaudeRemove() {
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

export function printHelpClaudeQuota() {
	console.log(`${PRIMARY_CMD} claude quota - Check Claude usage quota

Usage:
  ${PRIMARY_CMD} claude quota [label] [options]

Arguments:
  label             Optional. Check quota for a specific Claude credential

Options:
  --json            Output in JSON format
  --compact, -c     Compact output (single-line summaries)
  --local           Skip native app token checks and divergence warnings (default)
  --native          Include native app auth files in reads/checks
  --help, -h        Show this help

Description:
  Displays usage statistics for Claude accounts. Tokens are refreshed when
  available. Uses OAuth credentials when possible and falls back to legacy
  session credentials.
  Native Claude app auth files are ignored by default to avoid importing and
  refreshing tokens owned by Claude Code / OpenCode.
  OAuth-based accounts are checked for divergence in Claude CLI stores only
  when --native is used.
  Use --local to explicitly suppress native app checks and only use stored
  account files.

Examples:
  ${PRIMARY_CMD} claude quota
  ${PRIMARY_CMD} claude quota work
  ${PRIMARY_CMD} claude quota --json
`);
}

export function printHelpAdd() {
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

export function printHelpCodexReauth() {
	console.log(`${PRIMARY_CMD} codex reauth - Re-authenticate an existing account

Usage:
  ${PRIMARY_CMD} codex reauth <label> [options]

Arguments:
  label             Required. Label of the account to re-authenticate

Options:
  --no-browser      Print the auth URL instead of opening browser
                    Use this in headless/SSH environments
  --json            Output result in JSON format
  --help, -h        Show this help

Description:
  Re-authenticates an existing Codex account via the OAuth browser flow.
  This is useful when your tokens have expired and cannot be refreshed,
  or when you need to reset your authentication.

  Unlike 'add', this command:
    - Requires an existing account with the specified label
    - Updates the existing entry instead of creating a new one
    - Preserves any extra fields in the account configuration

  If the re-authenticated account is the active account, CLI auth files
  (Codex CLI, OpenCode, pi) will also be updated automatically.

Examples:
  ${PRIMARY_CMD} codex reauth work                Re-authenticate "work" account
  ${PRIMARY_CMD} codex reauth work --no-browser   Print URL for manual browser auth
  ${PRIMARY_CMD} codex reauth work --json         JSON output for scripting

See also:
  ${PRIMARY_CMD} codex add     Add a new account
  ${PRIMARY_CMD} codex list    Show all configured accounts
`);
}

export function printHelpSwitch() {
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

  Also updates activeLabel in your multi-account file when available.
  
  If the token is expired, it will be refreshed before switching.
  Any existing OPENAI_API_KEY in auth.json is preserved.

Examples:
  ${PRIMARY_CMD} codex switch personal         Switch to "personal" account
  ${PRIMARY_CMD} codex switch work --json      Switch to "work" with JSON output

See also:
  ${PRIMARY_CMD} codex list    Show all available accounts and their labels
  ${PRIMARY_CMD} codex sync    Re-sync activeLabel to CLI auth files
`);
}

export function printHelpCodexSync() {
	console.log(`${PRIMARY_CMD} codex sync - Sync activeLabel to CLI auth files

Usage:
  ${PRIMARY_CMD} codex sync [options]

Options:
  --dry-run         Preview what would be synced without writing files
  --json            Output result in JSON format
  --help, -h        Show this help

Description:
  Pushes the activeLabel account from your multi-account file to:
  - Codex CLI (~/.codex/auth.json)
  - OpenCode (~/.local/share/opencode/auth.json) when present
  - pi (~/.pi/agent/auth.json) when present

  This is useful after a native CLI login has diverged from the tracked
  activeLabel account.

Examples:
  ${PRIMARY_CMD} codex sync
  ${PRIMARY_CMD} codex sync --dry-run
  ${PRIMARY_CMD} codex sync --json

See also:
  ${PRIMARY_CMD} codex switch <label>
  ${PRIMARY_CMD} codex list
`);
}

export function printHelpList() {
	console.log(`${PRIMARY_CMD} codex list - List all configured accounts

Usage:
  ${PRIMARY_CMD} codex list [options]

Options:
	  --json            Output in JSON format
	  --local           Skip native app token checks and divergence warnings (default)
	  --native          Include native app auth files in reads/checks
	  --help, -h        Show this help

Description:
  Lists all accounts from shuvquota-managed sources with details:
  - Label and email address
  - Plan type (plus, free, etc.)
  - Token expiry status
  - Source file location
  - Active indicator (* for the activeLabel account)
  Accounts are deduplicated by email for display and prefer the
  activeLabel account when duplicates exist.
  Native app auth files are ignored by default to avoid importing external
  app tokens into shuvquota refresh flows.
  If CLI auth diverges from activeLabel, a warning is shown with a sync hint
  when --native is used.
  Use --local to explicitly suppress native app checks and only use stored
  account files.

Output columns:
  * = active        Active account from activeLabel
  ~ = CLI auth      CLI account when it diverges from activeLabel
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

export function printHelpRemove() {
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

export function printHelpQuota() {
	console.log(`${PRIMARY_CMD} codex quota - Check usage quota for accounts

Usage:
	  ${PRIMARY_CMD} codex quota [label] [options]

Arguments:
  label             Optional. Check quota for a specific account only
                    If not provided, shows quota for all accounts

Options:
	  --json            Output in JSON format
	  --compact, -c     Compact output (single-line summaries)
	  --local           Skip native app token checks and divergence warnings (default)
	  --native          Include native app auth files in reads/checks
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
  Native app auth files are ignored by default to avoid refreshing tokens
  owned by Codex CLI / OpenCode / pi.
  If CLI auth diverges from activeLabel, a warning is shown with a sync hint
  when --native is used.
  Use --local to explicitly suppress native app checks and only use stored
  account files.

Examples:
	  ${PRIMARY_CMD} codex quota                 Check all Codex accounts
	  ${PRIMARY_CMD} codex quota personal        Check "personal" account only
	  ${PRIMARY_CMD} codex quota --json          JSON output for all Codex accounts
	  ${PRIMARY_CMD} codex quota work --json     JSON output for "work" account
	  ${PRIMARY_CMD} claude quota                Check Claude accounts
`);
}

export function printHelpProxx() {
	console.log(`${PRIMARY_CMD} proxx - Pull usage data from a proxx server

Usage:
  ${PRIMARY_CMD} proxx quota [options]

Options:
  --json            Output in JSON format
  --compact, -c     Compact output (single-line summaries)
  --base-url URL    Proxx API base URL (default: http://localhost:8789)
  --token TOKEN     Bearer token for the proxx API
  --account-id ID   Restrict to a single OpenAI account
  --help, -h       Show this help

Description:
  Fetches OpenAI quota snapshots from a proxx server instead of re-authenticating
  each account locally. Uses the proxx API endpoint /api/v1/credentials/openai/quota.

Examples:
  ${PRIMARY_CMD} proxx quota
  ${PRIMARY_CMD} proxx quota --json
  ${PRIMARY_CMD} proxx quota --base-url http://localhost:8789
`);
}

export function printHelpFactory() {
	console.log(`${PRIMARY_CMD} factory - Manage Factory.ai accounts

Usage:
  ${PRIMARY_CMD} factory [command] [options]

Commands:
  quota [label]     Check Factory usage quota (default command)
  add [label]       Add a Factory account from Droid CLI auth
  switch <label>    Switch active Factory account (writes auth.v2 files)
  remove <label>    Remove a Factory account
  list              List all Factory accounts

Options:
  --json            Output in JSON format
  --billing-day N   Set billing period start day (1–31, default: 1)
  --no-color        Disable colored output
  --help, -h        Show this help

Examples:
  ${PRIMARY_CMD} factory                   Check Factory usage
  ${PRIMARY_CMD} factory quota             Check Factory usage (explicit)
  ${PRIMARY_CMD} factory quota work        Check usage for "work" account
  ${PRIMARY_CMD} factory quota --json      JSON output for scripting
  ${PRIMARY_CMD} factory quota --billing-day 15  Custom billing period
  ${PRIMARY_CMD} factory add work          Add account with label "work"
  ${PRIMARY_CMD} factory switch personal   Switch to "personal" account
  ${PRIMARY_CMD} factory remove work       Remove "work" account
  ${PRIMARY_CMD} factory list              List all Factory accounts
  ${PRIMARY_CMD} factory list --json       List in JSON format
`);
}

export function printHelpFactoryQuota() {
	console.log(`${PRIMARY_CMD} factory quota - Check Factory usage quota

Usage:
  ${PRIMARY_CMD} factory quota [label] [options]

Arguments:
  label             Optional. Check quota for a specific Factory account

Options:
  --json            Output in JSON format
  --compact, -c     Compact output (single-line summaries)
  --billing-day N   Set billing period start day (1–31, default: 1)
  --no-color        Disable colored output
  --help, -h        Show this help

Description:
  Displays token usage statistics for Factory.ai accounts. Shows monthly
  token consumption with a visual usage bar, per-model breakdown, and
  billing period dates.

  Accounts are loaded from:
    1. FACTORY_ACCOUNTS env var (JSON array)
    2. ~/.factory-accounts.json
    3. ~/.factory/auth.v2.file (single-account fallback)

Examples:
  ${PRIMARY_CMD} factory quota                 Check all Factory accounts
  ${PRIMARY_CMD} factory quota work            Check "work" account only
  ${PRIMARY_CMD} factory quota --json          JSON output for all Factory accounts
  ${PRIMARY_CMD} factory quota --billing-day 15  Use 15th-to-15th billing period
`);
}

export function printHelpGrok() {
	console.log(`${PRIMARY_CMD} grok - Check SuperGrok / xAI OAuth quota

Usage:
  ${PRIMARY_CMD} grok [command] [options]

Commands:
  quota [label]     Check SuperGrok weekly credits (default command)
  set-plan <SuperGrok|SuperGrok Heavy|clear>
                    Override plan label shown in CLI/web UI

Options:
  --json            Output in JSON format
  --compact, -c     Compact output (single-line summaries)
  --no-color        Disable colored output
  --help, -h        Show this help

Description:
  Reads live SuperGrok OAuth tokens from existing tools (pi/shuvpi, OpenCode,
  Hermes) and reports weekly credit usage from cli-chat-proxy.grok.com.

  When a token is refreshed, the new access + refresh tokens are written back
  to every store that held the previous refresh so other agents stay in sync.

  JWT tier is mapped automatically (tier 5 → SuperGrok Heavy). Use set-plan
  when the tier claim is missing or wrong.

Examples:
  ${PRIMARY_CMD} grok
  ${PRIMARY_CMD} grok quota
  ${PRIMARY_CMD} grok set-plan "SuperGrok Heavy"
  ${PRIMARY_CMD} grok quota --json
  ${PRIMARY_CMD} grok quota --compact
`);
}

export function printHelpGrokQuota() {
	console.log(`${PRIMARY_CMD} grok quota - Check SuperGrok weekly credits

Usage:
  ${PRIMARY_CMD} grok quota [label] [options]

Arguments:
  label             Optional. Check quota for a specific Grok account label

Options:
  --json            Output in JSON format
  --compact, -c     Compact output (single-line summaries)
  --no-color        Disable colored output
  --help, -h        Show this help

Description:
  Displays SuperGrok weekly credit usage (overall percent, Api / GrokBuild
  product split, prepaid balance, and period reset). Tokens are loaded from:
    1. GROK_ACCOUNTS env var (JSON array)
    2. pi / shuvpi / shuvhelm auth.json (xai / xai-oauth)
    3. OpenCode auth.json (xai)
    4. Hermes auth.json (xai-oauth pool/provider)

Examples:
  ${PRIMARY_CMD} grok quota
  ${PRIMARY_CMD} grok quota --json
  ${PRIMARY_CMD} grok quota --compact
`);
}

export function printHelpSynthetic() {
	console.log(`${PRIMARY_CMD} synthetic - Check Synthetic API quota

Usage:
  ${PRIMARY_CMD} synthetic [quota] [label] [options]

Commands:
  quota [label]     Check request and token quota (default command)

Options:
  --json            Output in JSON format
  --compact, -c     Compact output (single-line summary)
  --no-color        Disable colored output
  --help, -h        Show this help

Credential sources:
  1. SYNTHETIC_API_KEY env var
  2. SYNTHETIC_ACCOUNTS env var (JSON array)
  3. shuvcode integration-v2 credential database

Examples:
  ${PRIMARY_CMD} synthetic
  ${PRIMARY_CMD} synthetic quota --json
  ${PRIMARY_CMD} synthetic quota --compact
`);
}

export function printHelpAntigravity() {
	console.log(`${PRIMARY_CMD} antigravity - Check Google AI Pro / Antigravity quota

Usage:
  ${PRIMARY_CMD} antigravity [quota] [label] [options]

Commands:
  quota [label]     Check Gemini 5-hour and weekly quota (default command)

Options:
  --json            Output in JSON format
  --compact, -c     Compact output (single-line summary)
  --no-color        Disable colored output
  --help, -h        Show this help

Description:
  Reads Google AI Pro OAuth from shuvcode/OpenCode, the V1
  antigravity-accounts.json file, or ANTIGRAVITY_* env vars, then reports
  Cloud Code Gemini and unused Claude/GPT buckets.

  Refresh stays in memory. Google does not rotate this refresh token, and
  writing it back would race the shuvcode credential store.

Examples:
  ${PRIMARY_CMD} antigravity
  ${PRIMARY_CMD} antigravity quota
  ${PRIMARY_CMD} antigravity quota --json
  ${PRIMARY_CMD} antigravity quota --compact
`);
}

export function printHelpAntigravityQuota() {
	console.log(`${PRIMARY_CMD} antigravity quota - Check Google AI Pro quota

Usage:
  ${PRIMARY_CMD} antigravity quota [label] [options]

Arguments:
  label             Optional Google AI Pro account label

Options:
  --json            Output in JSON format
  --compact, -c     Compact output (single-line summary)
  --no-color        Disable colored output
  --help, -h        Show this help

Description:
  Displays remaining Gemini 5-hour and weekly quota plus unused Claude/GPT
  buckets. retrieveUserQuotaSummary does not consume generate quota.

Credential sources:
  1. ANTIGRAVITY_REFRESH / ANTIGRAVITY_ACCOUNTS env vars
  2. ~/.local/share/opencode/antigravity-accounts.json
  3. shuvcode/OpenCode google-ai-pro OAuth in opencode.db

Refresh requires ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET
in ~/.shuvquota.env.
`);
}

export function printHelpSyntheticQuota() {
	console.log(`${PRIMARY_CMD} synthetic quota - Check Synthetic API quota

Usage:
  ${PRIMARY_CMD} synthetic quota [label] [options]

Arguments:
  label             Optional Synthetic credential label

Options:
  --json            Output in JSON format
  --compact, -c     Compact output (single-line summary)
  --no-color        Disable colored output
  --help, -h        Show this help

Description:
  Displays rolling 5-hour tokens, weekly credits, subscription requests, and
  hourly search requests. The /quotas request does not consume quota.
`);
}

export function printHelpOpenCodeGo() {
	console.log(`${PRIMARY_CMD} opencode-go - Check OpenCode Go quota

Usage:
  ${PRIMARY_CMD} opencode-go [quota] [label] [options]

Commands:
  quota [label]     Check 5-hour, weekly, and monthly usage (default command)

Options:
  --json            Output in JSON format
  --compact, -c     Compact output (single-line summary)
  --no-color        Disable colored output
  --help, -h        Show this help

Configuration:
  OPENCODE_GO_WORKSPACE_ID   Workspace ID from the OpenCode Go dashboard URL
  OPENCODE_GO_AUTH_COOKIE    Value of the signed-in opencode.ai auth cookie
  OPENCODE_GO_LABEL          Optional display label (default: go)

Store these values in ~/.shuvquota.env with file mode 600. The dashboard
cookie expires and must be replaced after the OpenCode web session ends.

Examples:
  ${PRIMARY_CMD} opencode-go
  ${PRIMARY_CMD} opencode-go quota
  ${PRIMARY_CMD} opencode-go quota --json
  ${PRIMARY_CMD} opencode-go quota --compact
`);
}

export function printHelpOpenCodeGoQuota() {
	console.log(`${PRIMARY_CMD} opencode-go quota - Check OpenCode Go quota

Usage:
  ${PRIMARY_CMD} opencode-go quota [label] [options]

Arguments:
  label             Optional configured OpenCode Go display label

Options:
  --json            Output in JSON format
  --compact, -c     Compact output (single-line summary)
  --no-color        Disable colored output
  --help, -h        Show this help

Description:
  Reads the authenticated OpenCode Go dashboard and reports its rolling
  5-hour, weekly, and monthly usage windows. API keys are not used for this
  request because the public Go usage endpoint is not currently available.

Examples:
  ${PRIMARY_CMD} opencode-go quota
  ${PRIMARY_CMD} opencode-go quota --json
  ${PRIMARY_CMD} opencode-go quota --compact
`);
}

import { homedir } from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// Token Formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a token count with comma separators (e.g., 5000000 → "5,000,000").
 * Returns "0" for null, undefined, or NaN. Truncates decimals.
 * @param {number | null | undefined} n - Token count
 * @returns {string}
 */
export function formatTokenCount(n) {
	if (n === null || n === undefined || !Number.isFinite(n)) return "0";
	const int = Math.trunc(n);
	const isNeg = int < 0;
	const abs = Math.abs(int);
	const str = String(abs);
	let result = "";
	for (let i = 0; i < str.length; i++) {
		if (i > 0 && (str.length - i) % 3 === 0) result += ",";
		result += str[i];
	}
	return isNeg ? `-${result}` : result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory Usage Display
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build usage lines for a Factory account (for box display).
 * Follows the pattern of buildAccountUsageLines and buildClaudeUsageLines.
 * @param {object} account - Factory account object { label, email, org, source, ... }
 * @param {object | null} payload - Usage payload from fetchFactoryUsage
 * @param {object} flags - CLI flags { noColor, ... }
 * @returns {string[]} Lines to display
 */
export function buildFactoryUsageLines(account, payload, flags = {}) {
	const lines = [];

	// Header: Factory (label) <email> (org)
	// Emails are redacted by default; pass --show-email / flags.showEmail to reveal.
	const labelDisplay = account?.label ? ` (${account.label})` : "";
	const emailDisplay = formatEmailDisplay(account?.email, flags);
	const orgDisplay = account?.org ? ` (${account.org})` : "";
	const header = `Factory${labelDisplay}${emailDisplay}${orgDisplay}`;

	if (flags.compact) {
		const parts = [];
		if (!payload || payload.success === false) {
			parts.push(header, colorize(`error: ${payload?.error ?? "Factory usage unavailable"}`, RED));
			return [parts.join(" | ")];
		}

		const usage = payload.usage;
		if (!usage) {
			parts.push(header, colorize("error: Factory usage unavailable", RED));
			return [parts.join(" | ")];
		}

		const used = usage.used ?? 0;
		const limit = usage.limit ?? 0;
		if (limit > 0) {
			const remaining = Math.max(0, Math.min(100, 100 - (usage.percent ?? 0)));
			parts.push(colorize(`mo ${formatCompactPercent(remaining)} ${formatTokenCount(used)}/${formatTokenCount(limit)}`,
				getCompactQuotaColor(remaining)));
		} else {
			parts.push(`mo  n/a ${formatTokenCount(used)} used`);
		}
		parts.push(header);
		if (usage.billingPeriod?.start && usage.billingPeriod?.end) {
			parts.push(`${usage.billingPeriod.start}—${usage.billingPeriod.end}`);
		}
		return [parts.join(" | ")];
	}

	lines.push(header);
	lines.push("");

	// Error case: missing payload or error response
	if (!payload || payload.success === false) {
		lines.push(`Error: ${payload?.error ?? "Factory usage unavailable"}`);
		if (account?.source) {
			lines.push(`  Source: ${shortenPath(account.source)}`);
		}
		return lines;
	}

	const usage = payload.usage;
	if (!usage) {
		lines.push("Error: Factory usage unavailable");
		if (account?.source) {
			lines.push(`  Source: ${shortenPath(account.source)}`);
		}
		return lines;
	}

	const used = usage.used ?? 0;
	const limit = usage.limit ?? 0;

	// Monthly usage bar
	if (limit > 0) {
		const remaining = Math.max(0, Math.min(100, 100 - (usage.percent ?? 0)));
		lines.push(formatQuotaBarLine(
			"Monthly",
			remaining,
			`(${formatTokenCount(used)} / ${formatTokenCount(limit)} tokens)`,
		));
	} else {
		const prefix = "Monthly:".padEnd(QUOTA_LABEL_WIDTH);
		lines.push(`${prefix}${formatTokenCount(used)} tokens used — no limit set`);
	}

	// Per-model breakdown
	const byModel = usage.byModel;
	if (Array.isArray(byModel) && byModel.length > 0) {
		lines.push("");
		for (const model of byModel) {
			lines.push(`  ${model.model_id}: ${formatTokenCount(model.billable_tokens)} tokens`);
		}
	}

	// Billing period
	if (usage.billingPeriod?.start && usage.billingPeriod?.end) {
		lines.push(`  Period: ${usage.billingPeriod.start} — ${usage.billingPeriod.end}`);
	}

	// Source
	if (account?.source) {
		lines.push(`  Source: ${shortenPath(account.source)}`);
	}

	return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenCode Go Usage Display
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format an OpenCode Go reset timestamp or relative duration.
 * @param {object | null | undefined} window - Normalized usage window
 * @param {"inline" | "compact"} [style="inline"]
 * @returns {string}
 */
export function formatOpenCodeGoReset(window, style = "inline") {
	let seconds = window?.resetInSec == null ? Number.NaN : Number(window.resetInSec);
	if (window?.resetAt) {
		const resetAt = new Date(window.resetAt).getTime();
		if (Number.isFinite(resetAt)) {
			seconds = Math.max(0, Math.floor((resetAt - Date.now()) / 1000));
		}
	}
	if (!Number.isFinite(seconds) || seconds < 0) return "";
	return formatResetTime(seconds, style);
}

/**
 * Build usage lines for an OpenCode Go dashboard account.
 * @param {object} account - Safe account metadata containing only a display label/source
 * @param {object | null} payload - Result from fetchOpenCodeGoUsage
 * @param {object} flags - CLI flags
 * @returns {string[]}
 */
export function buildOpenCodeGoUsageLines(account, payload, flags = {}) {
	const labelDisplay = account?.label ? ` (${account.label})` : "";
	const header = `OpenCode Go${labelDisplay}`;
	const usage = payload?.success === false ? null : payload?.usage;
	const windows = [
		{ compactLabel: "5h", label: "5h limit", value: usage?.rollingUsage },
		{ compactLabel: "week", label: "Weekly limit", value: usage?.weeklyUsage },
		{ compactLabel: "month", label: "Monthly limit", value: usage?.monthlyUsage },
	];

	if (!payload || payload.success === false || !usage) {
		const error = payload?.error ?? "OpenCode Go usage unavailable";
		if (flags.compact) {
			return [`${header} | ${colorize(`error: ${error}`, RED)}`];
		}
		return [header, "", `Error: ${error}`];
	}

	const normalized = windows.flatMap(window => {
		const remainingValue = window.value?.remainingPercent == null
			? null
			: Number(window.value.remainingPercent);
		const usageValue = window.value?.usagePercent == null
			? null
			: Number(window.value.usagePercent);
		const remaining = remainingValue !== null && Number.isFinite(remainingValue)
			? remainingValue
			: usageValue !== null && Number.isFinite(usageValue) ? 100 - usageValue : null;
		if (!Number.isFinite(remaining)) return [];
		return [{ ...window, remaining: Math.max(0, Math.min(100, remaining)) }];
	});

	if (!normalized.length) {
		if (flags.compact) {
			return [`${header} | ${colorize("error: no usage windows found", RED)}`];
		}
		return [header, "", "Error: No usage windows found"];
	}

	if (flags.compact) {
		const parts = normalized.map(window => formatCompactMetric(
			window.compactLabel,
			window.remaining,
			formatOpenCodeGoReset(window.value, "compact"),
		));
		parts.push(header);
		return [parts.join(" | ")];
	}

	const lines = [header, ""];
	for (const window of normalized) {
		lines.push(formatQuotaBarLine(
			window.label,
			window.remaining,
			formatOpenCodeGoReset(window.value, "inline"),
		));
	}
	lines.push("  Source: OpenCode dashboard");
	return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Grok / SuperGrok Usage Display
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a Grok billing period end as Codex/Claude-style "(resets HH:MM on D Mon)".
 * @param {string | null | undefined} periodEnd - ISO timestamp
 * @param {"inline" | "compact"} [style="inline"]
 * @returns {string}
 */
export function formatGrokPeriodReset(periodEnd, style = "inline") {
	if (!periodEnd) return "";
	const end = new Date(periodEnd);
	if (Number.isNaN(end.getTime())) return "";
	const seconds = Math.max(0, Math.floor((end.getTime() - Date.now()) / 1000));
	return formatResetTime(seconds, style);
}

/**
 * Build usage lines for a SuperGrok account (weekly credits).
 * Layout mirrors Codex/Claude: aligned limit labels, bar, "% left", optional reset.
 * @param {object} account
 * @param {object | null} payload - Result from fetchGrokUsage
 * @param {object} flags
 * @returns {string[]}
 */
export function buildGrokUsageLines(account, payload, flags = {}) {
	const lines = [];

	const labelDisplay = account?.label ? ` (${account.label})` : "";
	const emailDisplay = formatEmailDisplay(account?.email, flags);
	const planLabel = formatGrokPlanLabel(account?.tier, {
		plan: account?.plan,
		planType: account?.planType,
		planOverride: account?.planOverride,
	});
	const planDisplay = planLabel ? ` · ${planLabel}` : "";
	const header = `Grok${labelDisplay}${emailDisplay}${planDisplay}`;

	if (flags.compact) {
		const parts = [];
		if (!payload || payload.success === false) {
			parts.push(header, colorize(`error: ${payload?.error ?? "Grok usage unavailable"}`, RED));
			return [parts.join(" | ")];
		}
		const usage = payload.usage;
		if (!usage) {
			parts.push(header, colorize("error: Grok usage unavailable", RED));
			return [parts.join(" | ")];
		}
		const usedPercent = usage.creditUsagePercent ?? 0;
		const remaining = Math.max(0, Math.min(100, 100 - usedPercent));
		const reset = formatGrokPeriodReset(usage.period?.end, "compact");
		parts.push(formatCompactMetric("credits", remaining, reset));
		for (const product of usage.products ?? []) {
			const productRemaining = Math.max(0, Math.min(100, 100 - (product.usagePercent ?? 0)));
			const label = String(product.product || "product").toLowerCase().slice(0, 8);
			parts.push(formatCompactMetric(label, productRemaining));
		}
		if (usage.prepaidBalance != null && Number.isFinite(usage.prepaidBalance) && usage.prepaidBalance > 0) {
			parts.push(`prepaid ${formatTokenCount(usage.prepaidBalance)}`);
		}
		parts.push(header);
		return [parts.join(" | ")];
	}

	lines.push(header);
	lines.push("");

	if (!payload || payload.success === false) {
		lines.push(`Error: ${payload?.error ?? "Grok usage unavailable"}`);
		if (account?.source) {
			lines.push(`  Source: ${shortenPath(account.source)}`);
		}
		return lines;
	}

	const usage = payload.usage;
	if (!usage) {
		lines.push("Error: Grok usage unavailable");
		if (account?.source) {
			lines.push(`  Source: ${shortenPath(account.source)}`);
		}
		return lines;
	}

	const usedPercent = usage.creditUsagePercent;
	if (usedPercent != null && Number.isFinite(usedPercent)) {
		const remaining = Math.max(0, Math.min(100, 100 - usedPercent));
		const reset = formatGrokPeriodReset(usage.period?.end, "inline");
		lines.push(formatQuotaBarLine("Credits", remaining, reset));
	} else {
		lines.push(`${"Credits:".padEnd(QUOTA_LABEL_WIDTH)}n/a`);
	}

	const products = Array.isArray(usage.products) ? usage.products : [];
	for (const product of products) {
		const productUsed = product.usagePercent ?? 0;
		const productRemaining = Math.max(0, Math.min(100, 100 - productUsed));
		lines.push(formatQuotaBarLine(product.product, productRemaining));
	}

	if (usage.prepaidBalance != null && Number.isFinite(usage.prepaidBalance) && usage.prepaidBalance > 0) {
		lines.push(`  Prepaid: ${formatTokenCount(usage.prepaidBalance)} credits`);
	}

	if (account?.source) {
		const sourceCount = Array.isArray(account.sources) ? account.sources.length : 1;
		const extra = sourceCount > 1 ? ` (+${sourceCount - 1} more)` : "";
		lines.push(`  Source: ${shortenPath(account.source)}${extra}`);
	}

	return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic Usage Display
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a Synthetic reset or regeneration timestamp.
 * @param {string | null | undefined} timestamp
 * @param {"inline" | "compact"} [style="inline"]
 * @returns {string}
 */
export function formatSyntheticReset(timestamp, style = "inline") {
	if (!timestamp) return "";
	const resetAt = new Date(timestamp).getTime();
	if (!Number.isFinite(resetAt)) return "";
	return formatResetTime(Math.max(0, Math.floor((resetAt - Date.now()) / 1000)), style);
}

/**
 * Build quota display lines for a Synthetic credential.
 * @param {object} account
 * @param {object | null} payload
 * @param {object} flags
 * @returns {string[]}
 */
export function buildSyntheticUsageLines(account, payload, flags = {}) {
	const labelDisplay = account?.label ? ` (${account.label})` : "";
	const header = `Synthetic${labelDisplay}`;
	const usage = payload?.success === false ? null : payload?.usage;
	if (!payload || payload.success === false || !usage) {
		const error = payload?.error ?? "Synthetic quota unavailable";
		return flags.compact
			? [`${header} | ${colorize(`error: ${error}`, RED)}`]
			: [header, "", `Error: ${error}`];
	}

	const windows = [
		{
			compactLabel: "5h",
			label: "5h tokens",
			value: usage.rollingFiveHourLimit,
			resetAt: usage.rollingFiveHourLimit?.nextTickAt,
			suffix: usage.rollingFiveHourLimit
				? `${formatTokenCount(usage.rollingFiveHourLimit.remaining)}/${formatTokenCount(usage.rollingFiveHourLimit.max)}`
				: "",
		},
		{
			compactLabel: "week",
			label: "Weekly credits",
			value: usage.weeklyTokenLimit,
			resetAt: usage.weeklyTokenLimit?.nextRegenAt,
			suffix: usage.weeklyTokenLimit?.remainingCredits && usage.weeklyTokenLimit?.maxCredits
				? `${usage.weeklyTokenLimit.remainingCredits}/${usage.weeklyTokenLimit.maxCredits}` : "",
		},
		{
			compactLabel: "requests",
			label: "Requests",
			value: usage.subscription,
			resetAt: usage.subscription?.renewsAt,
			suffix: usage.subscription
				? `${formatTokenCount(usage.subscription.remaining)}/${formatTokenCount(usage.subscription.limit)}`
				: "",
		},
		{
			compactLabel: "search",
			label: "Search hourly",
			value: usage.searchHourly,
			resetAt: usage.searchHourly?.renewsAt,
			suffix: usage.searchHourly
				? `${formatTokenCount(usage.searchHourly.remaining)}/${formatTokenCount(usage.searchHourly.limit)}`
				: "",
		},
	].filter(window => Number.isFinite(window.value?.percentRemaining));

	if (flags.compact) {
		const parts = windows.map(window => formatCompactMetric(
			window.compactLabel,
			window.value.percentRemaining,
			formatSyntheticReset(window.resetAt, "compact"),
		));
		parts.push(header);
		return [parts.join(" | ")];
	}

	const lines = [header, ""];
	for (const window of windows) {
		const reset = formatSyntheticReset(window.resetAt, "inline");
		lines.push(formatQuotaBarLine(
			window.label,
			window.value.percentRemaining,
			[window.suffix, reset].filter(Boolean).join(" "),
		));
	}
	if (usage.weeklyTokenLimit?.nextRegenCredits) {
		lines.push(`  Next weekly regeneration: ${usage.weeklyTokenLimit.nextRegenCredits}`);
	}
	if (account?.source) lines.push(`  Source: ${shortenPath(account.source)}`);
	return lines;
}

/**
 * Format an Antigravity Cloud Code reset timestamp.
 * @param {string | null | undefined} timestamp
 * @param {"inline" | "compact"} [style="inline"]
 * @returns {string}
 */
export function formatAntigravityReset(timestamp, style = "inline") {
	if (!timestamp) return "";
	const resetAt = new Date(timestamp).getTime();
	if (!Number.isFinite(resetAt)) return "";
	return formatResetTime(Math.max(0, Math.floor((resetAt - Date.now()) / 1000)), style);
}

/**
 * Build quota display lines for a Google AI Pro / Antigravity account.
 * @param {object} account
 * @param {object | null} payload
 * @param {object} flags
 * @returns {string[]}
 */
export function buildAntigravityUsageLines(account, payload, flags = {}) {
	const labelDisplay = account?.label ? ` (${account.label})` : "";
	const emailDisplay = formatEmailDisplay(account?.email, flags);
	const plan = account?.paidTier === "g1-pro-tier" ? "Google AI Pro" : account?.paidTier;
	const planDisplay = plan ? ` · ${plan}` : "";
	const header = `Antigravity${labelDisplay}${emailDisplay}${planDisplay}`;
	const usage = payload?.success === false ? null : payload?.usage;
	if (!payload || payload.success === false || !usage) {
		const error = payload?.error ?? "Antigravity quota unavailable";
		return flags.compact
			? [`${header} | ${colorize(`error: ${error}`, RED)}`]
			: [header, "", `Error: ${error}`];
	}

	const windows = [];
	for (const group of usage.groups ?? []) {
		const groupPrefix = group.id === "gemini" ? "Gemini" : group.id === "3p" ? "3P" : group.displayName;
		for (const bucket of group.buckets ?? []) {
			if (!Number.isFinite(bucket.percentRemaining)) continue;
			const compactLabel = bucket.window === "5h" || /5.?h/i.test(bucket.bucketId)
				? `${groupPrefix === "Gemini" ? "5h" : "3p-5h"}`
				: bucket.window === "weekly" || /week/i.test(bucket.bucketId)
					? `${groupPrefix === "Gemini" ? "week" : "3p-week"}`
					: bucket.bucketId;
			windows.push({
				compactLabel,
				label: `${groupPrefix} ${bucket.window === "5h" ? "5h" : bucket.window === "weekly" ? "weekly" : bucket.displayName}`,
				percentRemaining: bucket.percentRemaining,
				resetAt: bucket.resetTime,
			});
		}
	}

	if (flags.compact) {
		const parts = windows.map(window => formatCompactMetric(
			window.compactLabel,
			window.percentRemaining,
			formatAntigravityReset(window.resetAt, "compact"),
		));
		parts.push(header);
		return [parts.join(" | ")];
	}

	const lines = [header, ""];
	for (const window of windows) {
		lines.push(formatQuotaBarLine(
			window.label,
			window.percentRemaining,
			formatAntigravityReset(window.resetAt, "inline"),
		));
	}
	if (account?.source) lines.push(`  Source: ${shortenPath(account.source)}`);
	return lines;
}

/**
 * Format expiry time as human-readable duration
 * @param {number | undefined} expires - Expiry timestamp in milliseconds
 * @returns {{ status: string, display: string }} Status and display string
 */
export function formatExpiryStatus(expires) {
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
export function shortenPath(filePath) {
	const home = homedir();
	if (filePath.startsWith(home)) {
		return "~" + filePath.slice(home.length);
	}
	return filePath;
}
