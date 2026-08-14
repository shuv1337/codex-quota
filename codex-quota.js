#!/usr/bin/env node

/**
 * Standalone Codex quota checker for multiple OAuth accounts
 * Zero dependencies - uses Node.js built-ins only
 *
 * This is a thin entry point. All logic lives in lib/ modules.
 * Barrel re-exports below maintain backward compatibility for tests and consumers.
 */

import { realpathSync } from "node:fs";

// Load ~/.codex-quota.env before any module reads process.env
import { loadEnvFile } from "./lib/env.js";
loadEnvFile();

// ─── Imports from lib modules ────────────────────────────────────────────────

import { PRIMARY_CMD, MULTI_ACCOUNT_PATHS, CODEX_CLI_AUTH_PATH, CLAUDE_MULTI_ACCOUNT_PATHS } from "./lib/constants.js";
import { GREEN, RED, YELLOW, setNoColorFlag, supportsColor, colorize, getPackageVersion } from "./lib/color.js";
import { decodeJWT, extractAccountId, extractProfile } from "./lib/jwt.js";
import {
	printHelp, printHelpCodex, printHelpClaude, printHelpFactory, printHelpFactoryQuota,
	printHelpGrok, printHelpGrokQuota,
	printHelpSynthetic, printHelpSyntheticQuota,
	printHelpAntigravity, printHelpAntigravityQuota,
	printHelpOpenCodeGo, printHelpOpenCodeGoQuota,
	printHelpAdd, printHelpCodexReauth, printHelpSwitch, printHelpCodexSync,
	printHelpList, printHelpRemove, printHelpQuota,
	printHelpClaudeAdd, printHelpClaudeReauth, printHelpClaudeSwitch, printHelpClaudeSync,
	printHelpClaudeList, printHelpClaudeRemove, printHelpClaudeQuota,
	printHelpProxx,
} from "./lib/display.js";
import {
	handleCodex,
	handleClaude,
	handleFactory,
	handleFactoryQuota,
	handleQuota,
	handleProxx,
	handleGrok,
	handleSynthetic,
	handleAntigravity,
	handleOpenCodeGo,
} from "./lib/handlers.js";

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
	const args = process.argv.slice(2);

	// Parse flags
	const nativeFlag = args.includes("--native");
	const flags = {
		json: args.includes("--json"),
		compact: args.includes("--compact") || args.includes("-c"),
		noBrowser: args.includes("--no-browser"),
		noColor: args.includes("--no-color"),
		oauth: args.includes("--oauth"),
		manual: args.includes("--manual"),
		dryRun: args.includes("--dry-run"),
		showEmail: args.includes("--show-email"),
		noFactory: args.includes("--no-factory"),
		native: nativeFlag,
		local: args.includes("--local") || !nativeFlag,
	};

	// Parse --billing-day flag for Factory quota
	const billingDayIdx = args.indexOf("--billing-day");
	if (billingDayIdx !== -1 && billingDayIdx + 1 < args.length) {
		const raw = args[billingDayIdx + 1];
		const parsed = parseInt(raw, 10);
		if (Number.isFinite(parsed)) {
			flags.billingDay = parsed;
		} else {
			console.error(colorize(`Error: Invalid --billing-day value: ${raw}`, RED));
			process.exit(1);
		}
	}

	// Parse --base-url flag for proxx
	const baseUrlIdx = args.indexOf("--base-url");
	if (baseUrlIdx !== -1 && baseUrlIdx + 1 < args.length) {
		flags.proxxBaseUrl = args[baseUrlIdx + 1];
	}
	// Parse --token flag for proxx
	const tokenIdx = args.indexOf("--token");
	if (tokenIdx !== -1 && tokenIdx + 1 < args.length) {
		flags.proxxToken = args[tokenIdx + 1];
	}

	// Set global noColorFlag for supportsColor() function
	setNoColorFlag(flags.noColor);

	const legacyFlagUsed = args.includes("--claude") || args.includes("--codex");
	if (legacyFlagUsed) {
		console.error(colorize("Error: --claude/--codex flags were replaced by namespaces.", RED));
		console.error(`Use '${PRIMARY_CMD} claude' or '${PRIMARY_CMD} codex' instead.`);
		process.exit(1);
	}

	// Extract non-flag arguments
	// Filter out flags and their values (e.g., --billing-day N)
	const flagsWithValues = new Set();
	if (billingDayIdx !== -1 && billingDayIdx + 1 < args.length) {
		flagsWithValues.add(billingDayIdx + 1);
	}
	if (baseUrlIdx !== -1 && baseUrlIdx + 1 < args.length) {
		flagsWithValues.add(baseUrlIdx + 1);
	}
	if (tokenIdx !== -1 && tokenIdx + 1 < args.length) {
		flagsWithValues.add(tokenIdx + 1);
	}
	const nonFlagArgs = args.filter((a, i) => !a.startsWith("-") && !flagsWithValues.has(i));
	const firstArg = nonFlagArgs[0];
	const namespace = firstArg === "codex" || firstArg === "claude" || firstArg === "factory"
		|| firstArg === "grok" || firstArg === "synthetic" || firstArg === "antigravity"
		|| firstArg === "opencode-go"
		|| firstArg === "proxx"
		? firstArg
		: null;
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
		if (namespace === "claude") {
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
	if (namespace === "factory") {
		switch (subcommand) {
			case "quota": printHelpFactoryQuota(); break;
			default: printHelpFactory(); break;
		}
		return;
	}
	if (namespace === "grok") {
		switch (subcommand) {
			case "quota": printHelpGrokQuota(); break;
			default: printHelpGrok(); break;
		}
		return;
	}
	if (namespace === "synthetic") {
		switch (subcommand) {
			case "quota": printHelpSyntheticQuota(); break;
			default: printHelpSynthetic(); break;
		}
		return;
	}
	if (namespace === "antigravity") {
		switch (subcommand) {
			case "quota": printHelpAntigravityQuota(); break;
			default: printHelpAntigravity(); break;
		}
		return;
	}
	if (namespace === "opencode-go") {
		switch (subcommand) {
			case "quota": printHelpOpenCodeGoQuota(); break;
			default: printHelpOpenCodeGo(); break;
		}
		return;
	}
	if (namespace === "proxx") {
		printHelpProxx();
		return;
	}
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
	if (namespace === "factory") {
		await handleFactory(namespaceArgs, flags);
		return;
	}
	if (namespace === "grok") {
		await handleGrok(namespaceArgs, flags);
		return;
	}
	if (namespace === "synthetic") {
		await handleSynthetic(namespaceArgs, flags);
		return;
	}
	if (namespace === "antigravity") {
		await handleAntigravity(namespaceArgs, flags);
		return;
	}
	if (namespace === "opencode-go") {
		await handleOpenCodeGo(namespaceArgs, flags);
		return;
	}
	if (namespace === "proxx") {
		await handleProxx(namespaceArgs, flags);
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
	deduplicateClaudeResultsByUsage,
	buildClaudeUsageFingerprint,
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

// Codex usage functions
export { fetchUsage, fetchResetCredits, mergeResetCredits } from "./lib/codex-usage.js";

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
	formatBankedResetExpiration,
	parseBankedResetCredits,
	normalizePercentUsed,
	parseClaudeUtilizationWindow,
	parseClaudeLimitWindow,
	getClaudeLimitDescriptor,
	getClaudeLimitWindows,
	drawBox,
	drawQuotaBox,
	QUOTA_BOX_MAX_WIDTH,
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
	formatTokenCount,
	buildAccountUsageLines,
	buildClaudeUsageLines,
	buildFactoryUsageLines,
	printHelpFactory,
	printHelpFactoryQuota,
	printHelpGrok,
	printHelpGrokQuota,
	buildGrokUsageLines,
	formatGrokPeriodReset,
	printHelpSynthetic,
	printHelpSyntheticQuota,
	buildSyntheticUsageLines,
	formatSyntheticReset,
	printHelpAntigravity,
	printHelpAntigravityQuota,
	buildAntigravityUsageLines,
	formatAntigravityReset,
	formatClaudeLabel,
	printHelpOpenCodeGo,
	printHelpOpenCodeGoQuota,
	buildOpenCodeGoUsageLines,
	formatOpenCodeGoReset,
	redactEmail,
	formatEmailDisplay,
	visibleLength,
	measureLinesWidth,
	sharedBoxMinWidth,
	formatQuotaBarLine,
	QUOTA_LABEL_WIDTH,
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
	handleFactory,
	handleFactoryAdd,
	handleFactorySwitch,
	handleFactoryRemove,
	handleFactoryList,
	handleFactoryQuota,
	handleGrok,
	handleGrokQuota,
	handleSynthetic,
	handleSyntheticQuota,
	handleAntigravity,
	handleAntigravityQuota,
	handleOpenCodeGo,
	handleOpenCodeGoQuota,
	buildOpenCodeGoJsonOutput,
	handleQuota,
} from "./lib/handlers.js";

// Color utilities
export { supportsColor, colorize, setNoColorFlag } from "./lib/color.js";

// Constants (for testing)
export {
	MULTI_ACCOUNT_PATHS,
	CODEX_CLI_AUTH_PATH,
	PRIMARY_CMD,
	CLAUDE_MULTI_ACCOUNT_PATHS,
	USAGE_URL,
	RESET_CREDITS_URL,
	OPENCODE_GO_DASHBOARD_BASE_URL,
	OPENCODE_GO_TIMEOUT_MS,
} from "./lib/constants.js";

// Factory constants (for testing)
export {
	FACTORY_API_BASE,
	FACTORY_USAGE_URL,
	FACTORY_TIMEOUT_MS,
	FACTORY_MULTI_ACCOUNT_PATH,
	FACTORY_AUTH_FILE_PATH,
	FACTORY_AUTH_KEY_PATH,
	FACTORY_OAUTH_REFRESH_BUFFER_MS,
	FACTORY_PLAN_TIERS,
} from "./lib/constants.js";

// Factory crypto utilities (for testing)
export {
	decryptAuthV2,
	encryptAuthV2,
	generateAuthKey,
	readAuthV2Files,
	writeAuthV2Files,
} from "./lib/factory-crypto.js";

// Factory account utilities (for testing)
export {
	isValidFactoryAccount,
	loadFactoryAccountsFromEnv,
	loadFactoryAccountsFromFile,
	extractFactoryProfile,
	loadFactoryAccountFromAuthV2,
	loadAllFactoryAccounts,
	getFactoryActiveLabel,
	findFactoryAccountByLabel,
	getAllFactoryLabels,
} from "./lib/factory-accounts.js";

// Factory usage utilities (for testing)
export {
	computeBillingPeriod,
	sumDailyTokens,
	extractModelBreakdown,
	fetchFactoryUsage,
} from "./lib/factory-usage.js";

// Factory token refresh (for testing)
export {
	isFactoryTokenExpiring,
	refreshFactoryToken,
	persistFactoryTokens,
	ensureFreshFactoryToken,
} from "./lib/factory-tokens.js";

// Token match field maps (for testing)
export { FACTORY_TOKEN_FIELDS, XAI_TOKEN_FIELDS, ANTIGRAVITY_TOKEN_FIELDS } from "./lib/token-match.js";

// Proxx exports
export { handleProxx, handleProxxQuota } from "./lib/handlers.js";
export { fetchProxxOpenAiQuota } from "./lib/proxx-usage.js";
export { printHelpProxx } from "./lib/display.js";

// Grok / SuperGrok exports
export {
	XAI_OAUTH_CLIENT_ID,
	XAI_OAUTH_TOKEN_URL,
	XAI_OAUTH_USERINFO_URL,
	XAI_OAUTH_REFRESH_BUFFER_MS,
	GROK_BILLING_URL,
	GROK_TIMEOUT_MS,
	GROK_PI_AUTH_PATHS,
	GROK_HERMES_AUTH_PATH,
	GROK_OPENCODE_AUTH_PATH,
	GROK_PLAN_OVERRIDE_PATH,
} from "./lib/constants.js";
export {
	formatCodexPlanLabel,
	formatClaudePlanLabel,
	formatGrokPlanLabel,
	humanizePlanSlug,
	CLAUDE_PLAN_CHOICES,
	GROK_PLAN_CHOICES,
} from "./lib/plans.js";
export {
	extractGrokProfile,
	resolveGrokExpiresAt,
	isValidGrokAccount,
	candidateFromRawTokens,
	loadGrokPlanOverride,
	loadGrokAccountsFromPiAuth,
	loadGrokAccountsFromOpencodeAuth,
	loadGrokAccountsFromHermesAuth,
	loadGrokAccountsFromEnv,
	mergeGrokAccountCandidates,
	loadAllGrokAccounts,
	findGrokAccountByLabel,
	getAllGrokLabels,
	getGrokSearchLocations,
} from "./lib/grok-accounts.js";
export {
	isGrokTokenExpiring,
	refreshGrokToken,
	sourceMatchesRotatedTokens,
	persistGrokTokens,
	ensureFreshGrokToken,
} from "./lib/grok-tokens.js";
export {
	normalizeGrokCreditsBilling,
	fetchGrokUsage,
	enrichGrokAccountFromUserinfo,
} from "./lib/grok-usage.js";

// Synthetic exports
export {
	SYNTHETIC_QUOTAS_URL,
	SYNTHETIC_TIMEOUT_MS,
	SYNTHETIC_INTEGRATION_DB_PATH,
} from "./lib/constants.js";
export {
	normalizeSyntheticAccount,
	loadSyntheticAccountsFromEnv,
	loadSyntheticAccountsFromIntegrationDb,
	loadAllSyntheticAccounts,
	getSyntheticSearchLocations,
} from "./lib/synthetic-accounts.js";
export { normalizeSyntheticQuotas, fetchSyntheticUsage } from "./lib/synthetic-usage.js";

// Google AI Pro / Antigravity exports
export {
	ANTIGRAVITY_TOKEN_URL,
	ANTIGRAVITY_CLOUD_CODE_URL,
	ANTIGRAVITY_TIMEOUT_MS,
	ANTIGRAVITY_OAUTH_REFRESH_BUFFER_MS,
	ANTIGRAVITY_METHOD_ID,
	ANTIGRAVITY_USER_AGENT,
	ANTIGRAVITY_V1_ACCOUNTS_PATH,
	ANTIGRAVITY_INTEGRATION_DB_PATHS,
} from "./lib/constants.js";
export {
	resolveAntigravityExpiresAt,
	splitAntigravityRefresh,
	normalizeAntigravityAccount,
	loadAntigravityAccountsFromEnv,
	loadAntigravityAccountsFromV1File,
	loadAntigravityAccountsFromIntegrationDb,
	loadAllAntigravityAccounts,
	getAllAntigravityLabels,
	getAntigravitySearchLocations,
	getAntigravityIntegrationDbPaths,
} from "./lib/antigravity-accounts.js";
export {
	isAntigravityTokenExpiring,
	refreshAntigravityToken,
	ensureFreshAntigravityToken,
} from "./lib/antigravity-tokens.js";
export {
	normalizeAntigravityQuota,
	loadAntigravityProjectId,
	fetchAntigravityUsage,
} from "./lib/antigravity-usage.js";

// OpenCode Go dashboard exports
export {
	resolveOpenCodeGoDashboardConfig,
	getOpenCodeGoSearchLocations,
	parseOpenCodeGoResetSeconds,
	parseOpenCodeGoDashboardHtml,
	fetchOpenCodeGoUsage,
} from "./lib/opencode-go-usage.js";

// Env loader
export { loadEnvFile, ENV_FILE_PATH } from "./lib/env.js";
