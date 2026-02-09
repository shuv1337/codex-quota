#!/usr/bin/env node

/**
 * Standalone Codex quota checker for multiple OAuth accounts
 * Zero dependencies - uses Node.js built-ins only
 *
 * This is a thin entry point. All logic lives in lib/ modules.
 * Barrel re-exports below maintain backward compatibility for tests and consumers.
 */

import { realpathSync } from "node:fs";

// ─── Imports from lib modules ────────────────────────────────────────────────

import { PRIMARY_CMD, MULTI_ACCOUNT_PATHS, CODEX_CLI_AUTH_PATH, CLAUDE_MULTI_ACCOUNT_PATHS } from "./lib/constants.js";
import { GREEN, RED, YELLOW, setNoColorFlag, supportsColor, colorize, getPackageVersion } from "./lib/color.js";
import { decodeJWT, extractAccountId, extractProfile } from "./lib/jwt.js";
import {
	printHelp, printHelpCodex, printHelpClaude,
	printHelpAdd, printHelpCodexReauth, printHelpSwitch, printHelpCodexSync,
	printHelpList, printHelpRemove, printHelpQuota,
	printHelpClaudeAdd, printHelpClaudeReauth, printHelpClaudeSwitch, printHelpClaudeSync,
	printHelpClaudeList, printHelpClaudeRemove, printHelpClaudeQuota,
} from "./lib/display.js";
import { handleCodex, handleClaude, handleQuota } from "./lib/handlers.js";

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
	const args = process.argv.slice(2);

	// Parse flags
	const flags = {
		json: args.includes("--json"),
		noBrowser: args.includes("--no-browser"),
		noColor: args.includes("--no-color"),
		oauth: args.includes("--oauth"),
		manual: args.includes("--manual"),
		dryRun: args.includes("--dry-run"),
		local: args.includes("--local"),
	};

	// Set global noColorFlag for supportsColor() function
	setNoColorFlag(flags.noColor);

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

	// Handle --version flag
	if (args.includes("--version") || args.includes("-v")) {
		console.log(getPackageVersion());
		return;
	}

	const legacyCommands = ["add", "reauth", "switch", "list", "remove", "quota", "sync"];
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
				case "add": printHelpAdd(); break;
				case "reauth": printHelpCodexReauth(); break;
				case "switch": printHelpSwitch(); break;
				case "sync": printHelpCodexSync(); break;
				case "list": printHelpList(); break;
				case "remove": printHelpRemove(); break;
				case "quota": printHelpQuota(); break;
				default: printHelpCodex(); break;
			}
			return;
		}
		switch (subcommand) {
			case "add": printHelpClaudeAdd(); break;
			case "reauth": printHelpClaudeReauth(); break;
			case "switch": printHelpClaudeSwitch(); break;
			case "sync": printHelpClaudeSync(); break;
			case "list": printHelpClaudeList(); break;
			case "remove": printHelpClaudeRemove(); break;
			case "quota": printHelpClaudeQuota(); break;
			default: printHelpClaude(); break;
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
function getResolvedArgv1() {
	try {
		const arg = process.argv[1];
		if (!arg) return null;
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

// ─── Barrel re-exports for backward compatibility (tests + external consumers) ──

// Account loading functions
export {
	loadAccountsFromEnv,
	loadAccountsFromFile,
	loadAccountFromCodexCli,
	loadAllAccounts,
	loadAllAccountsNoDedup,
	findAccountByLabel,
	getAllLabels,
	isValidAccount,
} from "./lib/codex-accounts.js";

export {
	loadClaudeAccountsFromEnv,
	loadClaudeAccountsFromFile,
	loadClaudeAccounts,
	isValidClaudeAccount,
} from "./lib/claude-accounts.js";

// Deduplication functions
export { deduplicateAccountsByEmail } from "./lib/codex-accounts.js";
export { deduplicateClaudeOAuthAccounts } from "./lib/claude-usage.js";

// Claude OAuth functions
export {
	loadClaudeOAuthFromClaudeCode,
	loadClaudeOAuthFromOpenCode,
	loadClaudeOAuthFromEnv,
	loadAllClaudeOAuthAccounts,
	fetchClaudeOAuthUsage,
	fetchClaudeOAuthUsageForAccount,
} from "./lib/claude-usage.js";

export {
	ensureFreshClaudeOAuthToken,
	persistClaudeOAuthTokens,
	refreshClaudeToken,
} from "./lib/claude-tokens.js";

export {
	ensureFreshToken,
	persistOpenAiOAuthTokens,
} from "./lib/codex-tokens.js";

// OAuth PKCE utilities
export {
	generatePKCE,
	generateState,
	buildAuthUrl,
	checkPortAvailable,
	isHeadlessEnvironment,
	openBrowser,
	startCallbackServer,
	exchangeCodeForTokens,
} from "./lib/oauth.js";

// Claude OAuth browser flow
export {
	buildClaudeAuthUrl,
	parseClaudeCodeState,
	exchangeClaudeCodeForTokens,
	handleClaudeOAuthFlow,
} from "./lib/claude-oauth.js";

// JWT utilities
export { decodeJWT, extractAccountId, extractProfile } from "./lib/jwt.js";

// Divergence helpers (for testing)
export {
	detectCodexDivergence,
	detectClaudeDivergence,
	findFresherOpenAiOAuthStore,
	findFresherClaudeOAuthStore,
	readOpencodeOpenAiOauthStore,
	readPiOpenAiOauthStore,
	readCodexCliOpenAiOauthStore,
	getActiveAccountId,
	getActiveAccountInfo,
	handleCodexSync,
	handleClaudeSync,
} from "./lib/sync.js";

// Display helpers (for testing)
export {
	shortenPath,
	formatExpiryStatus,
	drawBox,
	printHelp,
	printHelpAdd,
	printHelpCodexReauth,
	printHelpClaude,
	printHelpClaudeAdd,
	printHelpClaudeReauth,
	printHelpClaudeSync,
	printHelpSwitch,
	printHelpCodexSync,
	printHelpList,
	printHelpRemove,
	printHelpQuota,
} from "./lib/display.js";

// Subcommand handlers (for testing)
export {
	handleSwitch,
	handleCodexReauth,
	handleRemove,
	handleClaudeAdd,
	handleClaudeReauth,
	handleClaudeSwitch,
	handleClaudeRemove,
} from "./lib/handlers.js";

// Color utilities
export { supportsColor, colorize, setNoColorFlag } from "./lib/color.js";

// Constants (for testing)
export { MULTI_ACCOUNT_PATHS, CODEX_CLI_AUTH_PATH, PRIMARY_CMD, CLAUDE_MULTI_ACCOUNT_PATHS } from "./lib/constants.js";
