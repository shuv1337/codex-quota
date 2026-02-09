/**
 * Bars, boxes, usage lines, help text.
 * Depends on: lib/constants.js, lib/color.js, lib/jwt.js
 */

import { PRIMARY_CMD } from "./constants.js";
import { GREEN, RED, YELLOW, colorize, getPackageVersion } from "./color.js";
import { extractProfile } from "./jwt.js";
import { normalizeClaudeOrgId } from "./claude-usage.js";

export function parseWindow(window) {
	if (!window) return null;
	const used = window.used_percent ?? window.usedPercent ?? window.percent_used;
	const remaining = window.remaining_percent ?? window.remainingPercent;
	const resets = window.resets_at ?? window.resetsAt ?? window.reset_at;
	const resetAfterSeconds = window.reset_after_seconds ?? window.resetAfterSeconds;
	return { used, remaining, resets, resetAfterSeconds };
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

export function formatUsage(payload) {
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

export function printBar(remaining, width = 20) {
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
export function drawBox(lines, minWidth = 70) {
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
export function buildAccountUsageLines(account, payload) {
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
	
	// Header: Codex (label) <email> (plan) — matches Claude format
	const labelDisplay = account.label ? ` (${account.label})` : "";
	const emailDisplay = profile.email ? ` <${profile.email}>` : "";
	lines.push(`Codex${labelDisplay}${emailDisplay}${planDisplay}`);
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
	if (value === null || value === undefined || Number.isNaN(value)) return null;
	let used = Number(value);
	if (used <= 1 && used >= 0) {
		used *= 100;
	}
	if (!Number.isFinite(used)) return null;
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

export function formatResetAt(dateString) {
	if (!dateString) return "";
	const date = new Date(dateString);
	if (Number.isNaN(date.getTime())) return "";
	const seconds = Math.max(0, Math.floor((date.getTime() - Date.now()) / 1000));
	return formatResetTime(seconds, "inline");
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

export function buildClaudeUsageLines(payload) {
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

export function printHelp() {
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
  --local           Use only stored account files; skip harness token checks
  --dry-run         Preview sync without writing files
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
  4. ~/.codex/auth.json (Codex CLI format)

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
  ${PRIMARY_CMD} codex remove old        Remove "old" account
  ${PRIMARY_CMD} codex sync              Sync the activeLabel account
  ${PRIMARY_CMD} codex sync --dry-run    Preview sync without writing

Notes:
  - switch and sync update activeLabel in ~/.codex-accounts.json when available
  - list/quota warn when CLI auth diverges (use '${PRIMARY_CMD} codex sync')
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
  ${PRIMARY_CMD} claude list              List Claude credentials
  ${PRIMARY_CMD} claude remove old        Remove Claude credential "old"
  ${PRIMARY_CMD} claude sync              Sync the activeLabel account
  ${PRIMARY_CMD} claude sync --dry-run    Preview sync without writing

Notes:
  - switch and sync update activeLabel in ~/.claude-accounts.json when available
  - session-key-only accounts cannot be synced (OAuth required)
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
  --local           Skip harness token checks and divergence warnings
  --help, -h        Show this help

Description:
  Lists Claude credentials stored in CLAUDE_ACCOUNTS or ~/.claude-accounts.json.
  The activeLabel account is marked with '*'.
  OAuth-based accounts are checked for divergence in Claude CLI stores.
  Use --local to suppress harness checks and only use stored account files.

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
  --local           Skip harness token checks and divergence warnings
  --help, -h        Show this help

Description:
  Displays usage statistics for Claude accounts. Tokens are refreshed when
  available. Uses OAuth credentials when possible and falls back to legacy
  session credentials.
  OAuth-based accounts are checked for divergence in Claude CLI stores.
  Use --local to suppress harness checks and only use stored account files.

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
	  --local           Skip harness token checks and divergence warnings
	  --help, -h        Show this help

Description:
  Lists all accounts from all configured sources with details:
  - Label and email address
  - Plan type (plus, free, etc.)
  - Token expiry status
  - Source file location
  - Active indicator (* for the activeLabel account)
  Accounts are deduplicated by email for display and prefer the
  activeLabel account when duplicates exist.
  If CLI auth diverges from activeLabel, a warning is shown with a sync hint.
  Use --local to suppress harness checks and only use stored account files.

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
	  --local           Skip harness token checks and divergence warnings
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
  If CLI auth diverges from activeLabel, a warning is shown with a sync hint.
  Use --local to suppress these checks and only use stored account files.

Examples:
	  ${PRIMARY_CMD} codex quota                 Check all Codex accounts
	  ${PRIMARY_CMD} codex quota personal        Check "personal" account only
	  ${PRIMARY_CMD} codex quota --json          JSON output for all Codex accounts
	  ${PRIMARY_CMD} codex quota work --json     JSON output for "work" account
	  ${PRIMARY_CMD} claude quota                Check Claude accounts
`);
}


import { homedir } from "node:os";

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
