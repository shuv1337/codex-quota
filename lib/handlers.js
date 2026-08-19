/**
 * Subcommand handlers (add, switch, sync, list, remove, quota, etc.)
 * Depends on: most other modules
 */

import { existsSync, readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import {
	MULTI_ACCOUNT_PATHS,
	CLAUDE_CREDENTIALS_PATH,
	CLAUDE_MULTI_ACCOUNT_PATHS,
	PRIMARY_CMD,
	FACTORY_MULTI_ACCOUNT_PATH,
	FACTORY_AUTH_FILE_PATH,
	FACTORY_AUTH_KEY_PATH,
	GROK_PLAN_OVERRIDE_PATH,
	SHUVQUOTA_LABEL_KEY,
} from "./constants.js";
import { GREEN, RED, YELLOW, colorize } from "./color.js";
import { getPackageVersion } from "./color.js";
import {
	shortenPath,
	drawBox,
	drawQuotaBox,
	buildAccountUsageLines,
	buildClaudeUsageLines,
	buildFactoryUsageLines,
	buildGrokUsageLines,
	buildSyntheticUsageLines,
	buildAntigravityUsageLines,
	buildOpenCodeGoUsageLines,
	formatEmailDisplay,
	formatExpiryStatus,
	printHelp,
	printHelpCodex,
	printHelpClaude,
	printHelpFactory,
	printHelpFactoryQuota,
	printHelpGrok,
	printHelpGrokQuota,
	printHelpSynthetic,
	printHelpAntigravity,
	printHelpOpenCodeGo,
	printHelpOpenCodeGoQuota,
	printHelpAdd,
	printHelpCodexReauth,
	printHelpSwitch,
	printHelpCodexSync,
	printHelpList,
	printHelpRemove,
	printHelpQuota,
	printHelpClaudeAdd,
	printHelpClaudeReauth,
	printHelpClaudeSwitch,
	printHelpClaudeSync,
	printHelpClaudeList,
	printHelpClaudeRemove,
	printHelpClaudeQuota,
	printHelpProxx,
	formatResetTime,
	printBar,
	sharedBoxMinWidth,
	formatQuotaBarLine,
} from "./display.js";
import {
	generatePKCE,
	generateState,
	buildAuthUrl,
	checkPortAvailable,
	openBrowser,
	startCallbackServer,
	exchangeCodeForTokens,
} from "./oauth.js";
import {
	buildClaudeAuthUrl,
	parseClaudeCodeState,
	exchangeClaudeCodeForTokens,
	handleClaudeOAuthFlow,
} from "./claude-oauth.js";
import {
	loadAccountsFromEnv,
	loadAccountsFromFile,
	loadAccountFromCodexCli,
	loadAllAccounts,
	loadAllAccountsNoDedup,
	findAccountByLabel,
	getAllLabels,
	isValidAccount,
	readCodexActiveStoreContainer,
	getCodexActiveLabelInfo,
} from "./codex-accounts.js";
import {
	loadClaudeAccounts,
	loadClaudeAccountsFromFile,
	findClaudeAccountByLabel,
	getClaudeLabels,
	getClaudeActiveLabelInfo,
	readClaudeActiveStoreContainer,
	findClaudeSessionKey,
} from "./claude-accounts.js";
import {
	updateOpencodeAuth,
	updatePiAuth,
	persistOpenAiOAuthTokens,
	ensureFreshToken,
} from "./codex-tokens.js";
import {
	updateClaudeCredentials,
	updateOpencodeClaudeAuth,
	updatePiClaudeAuth,
	persistClaudeOAuthTokens,
	ensureFreshClaudeOAuthToken,
} from "./claude-tokens.js";
import { fetchUsage } from "./codex-usage.js";
import { fetchProxxOpenAiQuota } from "./proxx-usage.js";
import {
	loadClaudeOAuthFromClaudeCode,
	loadClaudeOAuthFromOpenCode,
	loadClaudeOAuthFromEnv,
	loadAllClaudeOAuthAccounts,
	fetchClaudeOAuthUsage,
	fetchClaudeOAuthUsageForAccount,
	fetchClaudeUsage,
	deduplicateClaudeOAuthAccounts,
	deduplicateClaudeResultsByUsage,
} from "./claude-usage.js";
import { readMultiAccountContainer, writeMultiAccountContainer, mapContainerAccounts } from "./container.js";
import { writeFileAtomic } from "./fs.js";
import { getOpencodeAuthPath, getCodexCliAuthPath, getPiAuthPath } from "./paths.js";
import { extractAccountId, extractProfile } from "./jwt.js";
import { promptConfirm, promptInput } from "./prompts.js";
import {
	detectCodexDivergence,
	detectClaudeDivergence,
	setCodexActiveLabel,
	setClaudeActiveLabel,
	getActiveAccountId,
	getActiveAccountInfo,
	findFresherOpenAiOAuthStore,
	findFresherClaudeOAuthStore,
	findClaudeOAuthRecoveryStore,
	findCodexAccountByLabelInFiles,
	clearShuvquotaLabelForRemovedAccount,
	maybeImportClaudeOauthStores,
	getActiveClaudeAccountFromStore,
	handleCodexSync,
	handleClaudeSync,
} from "./sync.js";
import {
	loadAllFactoryAccounts,
	findFactoryAccountByLabel,
	getAllFactoryLabels,
	extractFactoryProfile,
	getFactoryActiveLabel,
} from "./factory-accounts.js";
import { fetchFactoryUsage } from "./factory-usage.js";
import { ensureFreshFactoryToken } from "./factory-tokens.js";
import { decryptAuthV2, readAuthV2Files, writeAuthV2Files } from "./factory-crypto.js";
import {
	loadAllGrokAccounts,
	getAllGrokLabels,
	getGrokSearchLocations,
} from "./grok-accounts.js";
import { ensureFreshGrokToken } from "./grok-tokens.js";
import { fetchGrokUsage, enrichGrokAccountFromUserinfo } from "./grok-usage.js";
import {
	loadAllSyntheticAccounts,
	getSyntheticSearchLocations,
} from "./synthetic-accounts.js";
import { fetchSyntheticUsage } from "./synthetic-usage.js";
import {
	loadAllAntigravityAccounts,
	getAllAntigravityLabels,
	getAntigravitySearchLocations,
} from "./antigravity-accounts.js";
import { ensureFreshAntigravityToken } from "./antigravity-tokens.js";
import { fetchAntigravityUsage } from "./antigravity-usage.js";
import {
	resolveOpenCodeGoDashboardConfig,
	getOpenCodeGoSearchLocations,
	fetchOpenCodeGoUsage,
} from "./opencode-go-usage.js";
import {
	CLAUDE_PLAN_CHOICES,
	GROK_PLAN_CHOICES,
	formatClaudePlanLabel,
	formatCodexPlanLabel,
	formatGrokPlanLabel,
} from "./plans.js";

/**
 * @param {string} label
 * @returns {boolean}
 */
function isValidAccountLabel(label) {
	return typeof label === "string"
		&& label.trim().length > 0
		&& /^[a-zA-Z0-9][a-zA-Z0-9 _.-]*$/.test(label.trim());
}

/**
 * @param {string} filePath
 * @param {string} oldLabel
 * @param {string} newLabel
 * @returns {{ updated: boolean, path: string, activeLabelUpdated: boolean }}
 */
function renameAccountInContainer(filePath, oldLabel, newLabel) {
	const container = readMultiAccountContainer(filePath);
	if (!container.exists || container.rootType === "invalid") {
		return { updated: false, path: filePath, activeLabelUpdated: false };
	}
	let changed = false;
	const accounts = container.accounts.map((raw) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
		if (raw.label !== oldLabel) return raw;
		changed = true;
		return { ...raw, label: newLabel };
	});
	if (!changed) return { updated: false, path: filePath, activeLabelUpdated: false };

	const overrides = {};
	let activeLabelUpdated = false;
	if (container.activeLabel === oldLabel) {
		overrides.activeLabel = newLabel;
		activeLabelUpdated = true;
	}
	if (container.rootType === "array") {
		writeFileAtomic(filePath, `${JSON.stringify(accounts, null, 2)}\n`, { mode: 0o600 });
	} else {
		writeMultiAccountContainer(filePath, container, accounts, overrides, { mode: 0o600 });
	}
	return { updated: true, path: filePath, activeLabelUpdated };
}

/**
 * @param {string} filePath
 * @param {string} label
 * @param {{ planOverride?: string | null, subscriptionType?: string | null, rateLimitTier?: string | null }} fields
 * @returns {{ updated: boolean, path: string }}
 */
function patchAccountFieldsInContainer(filePath, label, fields) {
	const container = readMultiAccountContainer(filePath);
	if (!container.exists || container.rootType === "invalid") {
		return { updated: false, path: filePath };
	}
	let changed = false;
	const accounts = container.accounts.map((raw) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
		if (raw.label !== label) return raw;
		changed = true;
		const next = { ...raw };
		for (const [key, value] of Object.entries(fields)) {
			if (value === undefined) continue;
			if (value === null) delete next[key];
			else next[key] = value;
		}
		return next;
	});
	if (!changed) return { updated: false, path: filePath };
	if (container.rootType === "array") {
		writeFileAtomic(filePath, `${JSON.stringify(accounts, null, 2)}\n`, { mode: 0o600 });
	} else {
		writeMultiAccountContainer(filePath, container, accounts, {}, { mode: 0o600 });
	}
	return { updated: true, path: filePath };
}

// Handlers extracted from shuvquota.js
export async function handleAdd(args, flags) {
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
		const container = readMultiAccountContainer(targetPath);
		const accounts = [...container.accounts, newAccount];
		writeMultiAccountContainer(targetPath, container, accounts, {}, { mode: 0o600 });
		
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
 * Handle reauth subcommand - re-authenticate an existing Codex account via OAuth browser flow
 * This updates the existing account's tokens without changing the label
 * @param {string[]} args - Non-flag arguments (label is required)
 * @param {{ json: boolean, noBrowser: boolean }} flags - Parsed flags
 */
export async function handleCodexReauth(args, flags) {
	const label = args[0];
	if (!label) {
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: "Missing required label argument" }, null, 2));
		} else {
			console.error(colorize(`Usage: ${PRIMARY_CMD} codex reauth <label>`, RED));
			console.error("Re-authenticates an existing account via OAuth browser flow.");
		}
		process.exit(1);
	}

	try {
		// 1. Find existing account by label
		const existingAccount = findAccountByLabel(label);
		if (!existingAccount) {
			const allLabels = getAllLabels();
			if (flags.json) {
				console.log(JSON.stringify({
					success: false,
					error: `Account "${label}" not found`,
					availableLabels: allLabels,
				}, null, 2));
			} else if (allLabels.length === 0) {
				console.error(colorize(`Account "${label}" not found. No accounts configured.`, RED));
				console.error(`Run '${PRIMARY_CMD} codex add' to add an account.`);
			} else {
				console.error(colorize(`Account "${label}" not found.`, RED));
				console.error(`Available: ${allLabels.join(", ")}`);
			}
			process.exit(1);
		}

		const source = existingAccount.source;

		// 2. Check if account can be re-authenticated (must be in a multi-account file)
		if (source === "env") {
			if (flags.json) {
				console.log(JSON.stringify({
					success: false,
					error: "Cannot re-authenticate account from CODEX_ACCOUNTS env var. Modify the env var directly.",
				}, null, 2));
			} else {
				console.error(colorize("Cannot re-authenticate account from CODEX_ACCOUNTS env var.", RED));
				console.error("Modify the env var directly to update this account.");
			}
			process.exit(1);
		}

		// 3. Check if port is available before starting
		const portAvailable = await checkPortAvailable(1455);
		if (!portAvailable) {
			throw new Error(`Port 1455 is in use. Close other ${PRIMARY_CMD} instances and retry.`);
		}

		// 4. Generate PKCE code verifier and challenge
		const { verifier, challenge } = generatePKCE();

		// 5. Generate random state for CSRF protection
		const state = generateState();

		// 6. Build authorization URL
		const authUrl = buildAuthUrl(challenge, state);

		// 7. Print starting message
		console.log(`Re-authenticating account "${label}"...`);

		// 8. Start callback server (in background)
		const callbackPromise = startCallbackServer(state);

		// 9. Open browser or print URL
		openBrowser(authUrl, { noBrowser: flags.noBrowser });

		// 10. Wait for callback with auth code
		console.log("Waiting for browser authentication...");
		const { code, state: returnedState } = await callbackPromise;

		// 11. Verify state matches
		if (returnedState !== state) {
			throw new Error("State mismatch. Possible CSRF attack.");
		}

		// 12. Exchange code for tokens
		console.log("Exchanging code for tokens...");
		const tokens = await exchangeCodeForTokens(code, verifier);

		// 13. Update the account entry in the source file
		const container = readMultiAccountContainer(source);
		if (container.rootType === "invalid") {
			throw new Error(`Failed to parse ${source}`);
		}

		const updatedAccounts = container.accounts.map(entry => {
			if (!entry || typeof entry !== "object" || entry.label !== label) {
				return entry;
			}
			// Preserve any extra fields from the existing entry
			return {
				...entry,
				accountId: tokens.accountId,
				access: tokens.accessToken,
				refresh: tokens.refreshToken,
				idToken: tokens.idToken,
				expires: tokens.expires,
			};
		});

		writeMultiAccountContainer(source, container, updatedAccounts, {}, { mode: 0o600 });

		// 14. Update CLI auth files if this account is active
		const activeInfo = getCodexActiveLabelInfo();
		if (activeInfo.activeLabel === label) {
			// This is the active account - sync to CLI auth files
			const updatedAccount = {
				label,
				accountId: tokens.accountId,
				access: tokens.accessToken,
				refresh: tokens.refreshToken,
				idToken: tokens.idToken,
				expires: tokens.expires,
			};

			// Update Codex CLI auth.json
			const codexAuthPath = getCodexCliAuthPath();
			let existingAuth = {};
			if (existsSync(codexAuthPath)) {
				try {
					const raw = readFileSync(codexAuthPath, "utf-8");
					existingAuth = JSON.parse(raw);
				} catch {
					existingAuth = {};
				}
			}

			const codexTokens = {
				access_token: tokens.accessToken,
				refresh_token: tokens.refreshToken,
				account_id: tokens.accountId,
				expires_at: Math.floor(tokens.expires / 1000),
			};
			if (tokens.idToken) {
				codexTokens.id_token = tokens.idToken;
			}

			const newAuth = {
				...(existingAuth.OPENAI_API_KEY !== undefined ? { OPENAI_API_KEY: existingAuth.OPENAI_API_KEY } : {}),
				tokens: codexTokens,
				last_refresh: new Date().toISOString(),
				[SHUVQUOTA_LABEL_KEY]: label,
			};

			const codexDir = dirname(codexAuthPath);
			if (!existsSync(codexDir)) {
				mkdirSync(codexDir, { recursive: true });
			}
			writeFileAtomic(codexAuthPath, JSON.stringify(newAuth, null, 2) + "\n", { mode: 0o600 });

			// Update OpenCode and pi auth files
			updateOpencodeAuth(updatedAccount);
			updatePiAuth(updatedAccount);
		}

		// 15. Print success message
		if (flags.json) {
			console.log(JSON.stringify({
				success: true,
				label,
				email: tokens.email,
				accountId: tokens.accountId,
				source,
			}, null, 2));
		} else {
			const emailDisplay = tokens.email ? ` <${tokens.email}>` : "";
			const lines = [
				colorize(`Re-authenticated account ${label}${emailDisplay}`, GREEN),
				"",
				`Updated: ${shortenPath(source)}`,
			];
			if (activeInfo.activeLabel === label) {
				lines.push("");
				lines.push("CLI auth files also updated (active account)");
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
 * Handle switch subcommand - switch active account for Codex CLI/OpenCode/pi auth files
 * @param {string[]} args - Non-flag arguments (label is required)
 * @param {{ json: boolean }} flags - Parsed flags
 */
export async function handleSwitch(args, flags) {
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

		// 4. Update activeLabel in the source-of-truth multi-account file
		// Always set activeLabel regardless of account source - the label tracking
		// should work even for accounts loaded from env or single-account files
		let activeLabelPath = null;
		let activeLabelError = null;
		try {
			const activeUpdate = setCodexActiveLabel(label);
			activeLabelPath = activeUpdate.path;
		} catch (err) {
			activeLabelError = err?.message ?? String(err);
		}
		
		// 5. Read existing ~/.codex/auth.json to preserve OPENAI_API_KEY
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
		
		// 6. Build new auth.json structure (matching Codex CLI format)
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
			[SHUVQUOTA_LABEL_KEY]: label,
		};
		
		// 7. Create ~/.codex directory if needed
		const codexDir = dirname(codexAuthPath);
		if (!existsSync(codexDir)) {
			mkdirSync(codexDir, { recursive: true });
		}
		
		// 8. Write auth.json atomically (temp file + rename) with 0600 permissions
		writeFileAtomic(codexAuthPath, JSON.stringify(newAuth, null, 2) + "\n", { mode: 0o600 });
		
		// 9. Update OpenCode auth.json if present
		const opencodeUpdate = updateOpencodeAuth(account);
		if (opencodeUpdate.error && !flags.json) {
			console.error(colorize(`Warning: ${opencodeUpdate.error}`, YELLOW));
		}
		
		// 10. Update pi auth.json if present
		const piUpdate = updatePiAuth(account);
		if (piUpdate.error && !flags.json) {
			console.error(colorize(`Warning: ${piUpdate.error}`, YELLOW));
		}
		
		// 11. Get profile info for display
		const profile = extractProfile(account.access);
		
		// 12. Print confirmation (JSON OR human-readable, not both)
		if (flags.json) {
			const output = {
				success: true,
				label: label,
				email: profile.email,
				accountId: account.accountId,
				authPath: codexAuthPath,
			};
			if (activeLabelPath) {
				output.activeLabelPath = activeLabelPath;
			}
			if (activeLabelError) {
				output.activeLabelError = activeLabelError;
			}
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
			if (activeLabelError) {
				console.error(colorize(`Warning: Failed to update activeLabel: ${activeLabelError}`, YELLOW));
			}
			const emailDisplay = profile.email ? ` <${profile.email}>` : "";
			const planDisplay = profile.planType ? ` (${profile.planType})` : "";
			const lines = [
				colorize(`Switched to ${label}${emailDisplay}${planDisplay}`, GREEN),
				"",
				`Codex CLI: ${shortenPath(codexAuthPath)}`,
			];
			if (activeLabelPath) {
				lines.push(`Active label: ${shortenPath(activeLabelPath)}`);
			}
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
 * Handle sync subcommand - bi-directional sync for activeLabel account
 * 1. Pull: if a CLI store has the same refresh token but newer access/expires, pull it back
 * 2. Push: write the (now freshest) account tokens to all CLI auth files
 * @param {string[]} args - Non-flag arguments (unused)
 * @param {{ json: boolean, dryRun?: boolean }} flags - Parsed flags
 */
export async function handleList(flags) {
	const localMode = flags.local ?? !flags.native;
	const codexDivergence = localMode ? null : detectCodexDivergence({ allowMigration: false });
	const activeLabel = codexDivergence?.activeLabel ?? null;
	const accounts = loadAllAccounts(activeLabel, { local: localMode });
	
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
		if (!localMode) {
			console.log(`  - ${getCodexCliAuthPath()}`);
		}
		console.log(`\nRun '${PRIMARY_CMD} codex add' to add an account via OAuth.`);
		return;
	}
	
	const activeAccountId = codexDivergence?.activeAccount?.accountId ?? null;
	const cliAccountId = codexDivergence?.cliAccountId ?? null;
	const cliLabel = codexDivergence?.cliLabel ?? null;
	const divergenceDetected = codexDivergence?.diverged ?? false;
	const nativeAccountId = cliAccountId && (!activeAccountId || cliAccountId !== activeAccountId)
		? cliAccountId
		: null;
	
	// Build account details for each account
	const accountDetails = accounts.map(account => {
		const profile = extractProfile(account.access);
		const expiry = formatExpiryStatus(account.expires);
		
		const isActive = activeLabel !== null && account.label === activeLabel;
		const isNativeActive = !isActive && nativeAccountId !== null && account.accountId === nativeAccountId;
		
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
				activeLabel,
				activeAccountId,
				activeStorePath: codexDivergence?.activeStorePath ?? null,
				cliAccountId,
				cliLabel,
				divergence: divergenceDetected,
				migrated: codexDivergence?.migrated ?? false,
				local: localMode,
			},
		};
		console.log(JSON.stringify(output, null, 2));
		return;
	}

	if (divergenceDetected) {
		const activeLabelDisplay = activeLabel ?? "(none)";
		const activeIdDisplay = activeAccountId ?? "(unknown)";
		const cliLabelDisplay = cliLabel ?? "(unknown)";
		const cliIdDisplay = cliAccountId ?? "(unknown)";
		console.error(colorize("Warning: CLI auth diverged from activeLabel", YELLOW));
		console.error(`  Active: ${activeLabelDisplay} (${activeIdDisplay})`);
		console.error(`  CLI:    ${cliLabelDisplay} (${cliIdDisplay})`);
		console.error("");
		console.error(`Run '${PRIMARY_CMD} codex sync' to push active account to CLI.`);
		console.error("");
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
		// * = active account set by shuvquota
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
			lines.push("* = active (from activeLabel)");
		}
		if (hasNativeActive) {
			lines.push(`~ = CLI auth (run '${PRIMARY_CMD} codex sync' to realign)`);
		}
	}

	if (lines.length) {
		const boxLines = drawBox(lines);
		console.log(boxLines.join("\n"));
	}

}

/**
 * Handle Claude list subcommand - list Claude credentials
 * @param {{ json: boolean, local?: boolean, noFactory?: boolean }} flags - Parsed flags
 */
export async function handleClaudeList(flags) {
	const localMode = flags.local ?? !flags.native;
	if (!localMode) {
		const importResult = await maybeImportClaudeOauthStores({ json: flags.json });
		if (importResult.warnings.length && !flags.json) {
			for (const warning of importResult.warnings) {
				console.error(colorize(`Warning: ${warning}`, YELLOW));
			}
		}
	}
	const divergence = localMode ? null : detectClaudeDivergence();
	const activeLabel = divergence?.activeLabel ?? null;
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
				isActive: activeLabel !== null && account.label === activeLabel,
			})),
			activeInfo: {
				activeLabel,
				activeStorePath: divergence?.activeStorePath ?? null,
				divergence: divergence?.diverged ?? false,
				skipped: divergence?.skipped ?? false,
				skipReason: divergence?.skipReason ?? null,
				local: localMode,
			},
		};
		console.log(JSON.stringify(output, null, 2));
		return;
	}

	if (divergence?.diverged) {
		const divergedStores = divergence.stores
			.filter(store => store.considered && store.matches === false)
			.map(store => store.name);
		const storeDisplay = divergedStores.length ? divergedStores.join(", ") : "one or more stores";
		console.error(colorize(`Warning: Claude auth diverged from activeLabel (${activeLabel})`, YELLOW));
		console.error(`  Diverged stores: ${storeDisplay}`);
		console.error("");
		console.error(`Run '${PRIMARY_CMD} claude sync' to push active account to CLI.`);
		console.error("");
	} else if (divergence?.skipped && divergence.skipReason === "active-account-not-oauth" && activeLabel) {
		console.error("Note: Active Claude account has no OAuth tokens; skipping divergence check.");
		console.error("");
	}

	const claudeLines = [];
	claudeLines.push(`Claude Accounts (${claudeAccounts.length} total)`);
	claudeLines.push("");
	for (let i = 0; i < claudeAccounts.length; i++) {
		const account = claudeAccounts[i];
		const isActive = activeLabel !== null && account.label === activeLabel;
		const marker = isActive ? "*" : " ";
		const statusText = isActive ? " [active]" : "";
		const authParts = [];
		if (account.sessionKey ?? findClaudeSessionKey(account.cookies)) {
			authParts.push("sessionKey");
		}
		if (account.oauthToken) {
			authParts.push("oauthToken");
		}
		const authDisplay = authParts.length ? authParts.join("+") : "unknown";
		claudeLines.push(`${marker} ${account.label}${statusText}`);
		claudeLines.push(`  Auth: ${authDisplay} | ${shortenPath(account.source)}`);
		if (i < claudeAccounts.length - 1) {
			claudeLines.push("");
		}
	}
	if (activeLabel !== null) {
		claudeLines.push("");
		claudeLines.push("* = active (from activeLabel)");
	}
	const claudeBox = drawBox(claudeLines);
	console.log(claudeBox.join("\n"));
}

/**
 * Prompt for confirmation using readline
 * @param {string} message - Message to display
 * @returns {Promise<boolean>} True if user confirms (y/Y), false otherwise
 */
export async function handleRemove(args, flags) {
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

	const removedWasActive = detectCodexDivergence().activeLabel === label;
	let activeLabelCleared = false;
	let activeLabelClearError = null;
	let shuvquotaLabelCleared = false;
	let shuvquotaLabelClearError = null;
	
	// Handle multi-account files
	// Count accounts in the same source file
	const allAccounts = loadAllAccountsNoDedup();
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
	
	// Read the file container directly (to preserve any extra root fields)
	const container = readMultiAccountContainer(source);
	if (container.rootType === "invalid") {
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: `Failed to parse ${source}` }, null, 2));
		} else {
			console.error(colorize(`Error reading ${source}`, RED));
		}
		process.exit(1);
	}
	const existingAccounts = container.accounts;
	
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
		const fileDeleted = updatedAccounts.length === 0;
		if (fileDeleted) {
			// No accounts left - delete the file
			unlinkSync(source);
		} else {
			// Write updated accounts atomically
			writeMultiAccountContainer(source, container, updatedAccounts, {}, { mode: 0o600 });
		}

		if (removedWasActive) {
			try {
				const cleared = setCodexActiveLabel(null);
				activeLabelCleared = cleared.updated;
			} catch (err) {
				activeLabelClearError = err?.message ?? String(err);
			}
		}

		try {
			const cleared = clearShuvquotaLabelForRemovedAccount(account);
			shuvquotaLabelCleared = cleared.updated;
		} catch (err) {
			shuvquotaLabelClearError = err?.message ?? String(err);
		}

		if (flags.json) {
			const output = {
				success: true,
				label,
				source: shortenPath(source),
			};
			if (fileDeleted) {
				output.message = "File deleted (no accounts remaining)";
			} else {
				output.remainingAccounts = updatedAccounts.length;
			}
			if (removedWasActive) {
				output.activeLabelCleared = activeLabelCleared;
			}
			if (activeLabelClearError) {
				output.activeLabelError = activeLabelClearError;
			}
			if (shuvquotaLabelCleared) {
				output.shuvquotaLabelCleared = true;
			}
			if (shuvquotaLabelClearError) {
				output.shuvquotaLabelError = shuvquotaLabelClearError;
			}
			console.log(JSON.stringify(output, null, 2));
			return;
		}

		if (activeLabelClearError) {
			console.error(colorize(`Warning: Failed to clear activeLabel: ${activeLabelClearError}`, YELLOW));
		}
		if (shuvquotaLabelClearError) {
			console.error(colorize(`Warning: Failed to clear ${SHUVQUOTA_LABEL_KEY}: ${shuvquotaLabelClearError}`, YELLOW));
		}

		if (fileDeleted) {
			const lines = [
				colorize(`Removed account ${label}`, GREEN),
				"",
				`Deleted: ${shortenPath(source)} (no accounts remaining)`,
			];
			console.log(drawBox(lines).join("\n"));
		} else {
			const lines = [
				colorize(`Removed account ${label}`, GREEN),
				"",
				`Updated: ${shortenPath(source)} (${updatedAccounts.length} account(s) remaining)`,
			];
			console.log(drawBox(lines).join("\n"));
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
export async function handleClaudeRemove(args, flags) {
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

	const removedWasActive = getClaudeActiveLabelInfo().activeLabel === label;
	let activeLabelCleared = false;
	let activeLabelClearError = null;

	const container = readMultiAccountContainer(source);
	if (container.rootType === "invalid") {
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: `Failed to parse ${source}` }, null, 2));
		} else {
			console.error(colorize(`Error reading ${shortenPath(source)}`, RED));
		}
		process.exit(1);
	}
	const existingAccounts = container.accounts;

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
		const fileDeleted = updatedAccounts.length === 0;
		if (fileDeleted) {
			unlinkSync(source);
		} else {
			writeMultiAccountContainer(source, container, updatedAccounts, {}, { mode: 0o600 });
		}

		if (removedWasActive) {
			try {
				const cleared = setClaudeActiveLabel(null);
				activeLabelCleared = cleared.updated;
			} catch (err) {
				activeLabelClearError = err?.message ?? String(err);
			}
		}

		if (flags.json) {
			const output = {
				success: true,
				label,
				source: shortenPath(source),
			};
			if (fileDeleted) {
				output.message = "File deleted (no accounts remaining)";
			} else {
				output.remainingAccounts = updatedAccounts.length;
			}
			if (removedWasActive) {
				output.activeLabelCleared = activeLabelCleared;
			}
			if (activeLabelClearError) {
				output.activeLabelError = activeLabelClearError;
			}
			console.log(JSON.stringify(output, null, 2));
			return;
		}

		if (activeLabelClearError) {
			console.error(colorize(`Warning: Failed to clear activeLabel: ${activeLabelClearError}`, YELLOW));
		}

		if (fileDeleted) {
			const lines = [
				colorize(`Removed Claude account ${label}`, GREEN),
				"",
				`Deleted: ${shortenPath(source)} (no accounts remaining)`,
			];
			console.log(drawBox(lines).join("\n"));
		} else {
			const lines = [
				colorize(`Removed Claude account ${label}`, GREEN),
				"",
				`Updated: ${shortenPath(source)} (${updatedAccounts.length} account(s) remaining)`,
			];
			console.log(drawBox(lines).join("\n"));
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
export async function handleClaudeSwitch(args, flags) {
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

	let activeLabelPath = null;
	let activeLabelError = null;
	if (CLAUDE_MULTI_ACCOUNT_PATHS.includes(account.source)) {
		try {
			const activeUpdate = setClaudeActiveLabel(label);
			activeLabelPath = activeUpdate.path;
		} catch (err) {
			activeLabelError = err?.message ?? String(err);
		}
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
		if (activeLabelPath) {
			output.activeLabelPath = activeLabelPath;
		}
		if (activeLabelError) {
			output.activeLabelError = activeLabelError;
		}
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

	if (activeLabelError) {
		console.error(colorize(`Warning: Failed to update activeLabel: ${activeLabelError}`, YELLOW));
	}
	const lines = [
		colorize(`Switched Claude credentials to ${label}`, GREEN),
		"",
		`Claude Code: ${shortenPath(credentialsUpdate.path)}`,
	];
	if (activeLabelPath) {
		lines.push(`Active label: ${shortenPath(activeLabelPath)}`);
	}
	if (opencodeUpdate.updated) {
		lines.push(`OpenCode: ${shortenPath(opencodeUpdate.path)}`);
	}
	if (piUpdate.updated) {
		lines.push(`pi: ${shortenPath(piUpdate.path)}`);
	}
	console.log(drawBox(lines).join("\n"));
}

/**
 * Handle Claude sync subcommand - bi-directional sync for activeLabel account
 * 1. Pull: if a CLI store has the same refresh token but newer access/expires, pull it back
 * 2. Push: write the (now freshest) account tokens to all CLI auth files
 * @param {string[]} args - Non-flag arguments (unused)
 * @param {{ json: boolean, dryRun?: boolean }} flags - Parsed flags
 */
export async function handleClaudeAdd(args, flags) {
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

		const { path: targetPath, container } = readClaudeActiveStoreContainer();
		const accounts = [...container.accounts, newAccount];
		writeMultiAccountContainer(targetPath, container, accounts, {}, { mode: 0o600 });

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
 * Handle Claude reauth subcommand - re-authenticate an existing Claude account via OAuth browser flow
 * This updates the existing account's tokens without changing the label
 * @param {string[]} args - Non-flag arguments (label is required)
 * @param {{ json: boolean, noBrowser: boolean }} flags - Parsed flags
 */
export async function handleClaudeReauth(args, flags) {
	const label = args[0];
	if (!label) {
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: "Missing required label argument" }, null, 2));
		} else {
			console.error(colorize(`Usage: ${PRIMARY_CMD} claude reauth <label>`, RED));
			console.error("Re-authenticates an existing Claude account via OAuth browser flow.");
		}
		process.exit(1);
	}

	try {
		// 1. Find existing account by label
		const existingAccount = findClaudeAccountByLabel(label);
		if (!existingAccount) {
			const availableLabels = getClaudeLabels();
			if (flags.json) {
				console.log(JSON.stringify({
					success: false,
					error: `Claude account "${label}" not found`,
					availableLabels,
				}, null, 2));
			} else if (availableLabels.length === 0) {
				console.error(colorize(`Claude account "${label}" not found. No accounts configured.`, RED));
				console.error(`Run '${PRIMARY_CMD} claude add' to add an account.`);
			} else {
				console.error(colorize(`Claude account "${label}" not found.`, RED));
				console.error(`Available: ${availableLabels.join(", ")}`);
			}
			process.exit(1);
		}

		const source = existingAccount.source;

		// 2. Check if account can be re-authenticated (must be in a multi-account file)
		if (source === "env") {
			if (flags.json) {
				console.log(JSON.stringify({
					success: false,
					error: "Cannot re-authenticate account from CLAUDE_ACCOUNTS env var. Modify the env var directly.",
				}, null, 2));
			} else {
				console.error(colorize("Cannot re-authenticate account from CLAUDE_ACCOUNTS env var.", RED));
				console.error("Modify the env var directly to update this account.");
			}
			process.exit(1);
		}

		if (!CLAUDE_MULTI_ACCOUNT_PATHS.includes(source)) {
			if (flags.json) {
				console.log(JSON.stringify({
					success: false,
					error: `Cannot re-authenticate account from ${source}. Use the owning tool to re-authenticate.`,
				}, null, 2));
			} else {
				console.error(colorize(`Cannot re-authenticate account from ${shortenPath(source)}.`, RED));
				console.error("Use the owning tool to re-authenticate this account.");
			}
			process.exit(1);
		}

		// 3. Run OAuth flow
		console.log(`Re-authenticating Claude account "${label}"...`);
		const tokens = await handleClaudeOAuthFlow({ noBrowser: flags.noBrowser });

		// 4. Update the account entry in the source file
		const container = readMultiAccountContainer(source);
		if (container.rootType === "invalid") {
			throw new Error(`Failed to parse ${source}`);
		}

		const updatedAccounts = container.accounts.map(entry => {
			if (!entry || typeof entry !== "object" || entry.label !== label) {
				return entry;
			}
			// Preserve any extra fields from the existing entry
			return {
				...entry,
				oauthToken: tokens.accessToken,
				oauthRefreshToken: tokens.refreshToken,
				oauthExpiresAt: tokens.expiresAt,
				oauthScopes: tokens.scopes,
			};
		});

		writeMultiAccountContainer(source, container, updatedAccounts, {}, { mode: 0o600 });

		// 5. Update CLI auth files if this account is active
		const activeInfo = getClaudeActiveLabelInfo();
		if (activeInfo.activeLabel === label) {
			// This is the active account - sync to CLI auth files
			const updatedAccount = {
				oauthToken: tokens.accessToken,
				oauthRefreshToken: tokens.refreshToken,
				oauthExpiresAt: tokens.expiresAt,
				oauthScopes: tokens.scopes,
			};

			updateClaudeCredentials(updatedAccount);
			updateOpencodeClaudeAuth(updatedAccount);
			updatePiClaudeAuth(updatedAccount);
		}

		// 6. Print success message
		if (flags.json) {
			console.log(JSON.stringify({
				success: true,
				label,
				source,
			}, null, 2));
		} else {
			const lines = [
				colorize(`Re-authenticated Claude account ${label}`, GREEN),
				"",
				`Updated: ${shortenPath(source)}`,
			];
			if (activeInfo.activeLabel === label) {
				lines.push("");
				lines.push("CLI auth files also updated (active account)");
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
 * Rename a Codex multi-account label.
 * @param {string[]} args
 * @param {{ json?: boolean }} flags
 */
export async function handleCodexRename(args, flags) {
	const oldLabel = args[0];
	const newLabel = args.slice(1).join(" ").trim();
	if (!oldLabel || !newLabel) {
		const msg = `Usage: ${PRIMARY_CMD} codex rename <old-label> <new-label>`;
		if (flags.json) console.log(JSON.stringify({ success: false, error: msg }, null, 2));
		else console.error(colorize(msg, RED));
		process.exit(1);
	}
	if (!isValidAccountLabel(newLabel)) {
		const msg = `Invalid label "${newLabel}". Use letters, numbers, spaces, hyphens, underscores, or dots.`;
		if (flags.json) console.log(JSON.stringify({ success: false, error: msg }, null, 2));
		else console.error(colorize(msg, RED));
		process.exit(1);
	}
	if (oldLabel === newLabel) {
		if (flags.json) console.log(JSON.stringify({ success: true, label: newLabel, unchanged: true }, null, 2));
		else console.log(colorize(`Label already "${newLabel}"`, GREEN));
		return;
	}
	if (getAllLabels().includes(newLabel)) {
		const msg = `Label "${newLabel}" already exists.`;
		if (flags.json) console.log(JSON.stringify({ success: false, error: msg }, null, 2));
		else console.error(colorize(msg, RED));
		process.exit(1);
	}
	const account = findAccountByLabel(oldLabel);
	if (!account) {
		const msg = `Account "${oldLabel}" not found`;
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: msg, availableLabels: getAllLabels() }, null, 2));
		} else {
			console.error(colorize(`${msg}.`, RED));
		}
		process.exit(1);
	}
	if (account.source === "env") {
		const msg = "Cannot rename an account from CODEX_ACCOUNTS env var.";
		if (flags.json) console.log(JSON.stringify({ success: false, error: msg }, null, 2));
		else console.error(colorize(msg, RED));
		process.exit(1);
	}

	const updates = [];
	for (const path of MULTI_ACCOUNT_PATHS) {
		const result = renameAccountInContainer(path, oldLabel, newLabel);
		if (result.updated) updates.push(result);
	}
	if (!updates.length) {
		const msg = `Could not rename "${oldLabel}" in any multi-account file.`;
		if (flags.json) console.log(JSON.stringify({ success: false, error: msg }, null, 2));
		else console.error(colorize(msg, RED));
		process.exit(1);
	}

	if (flags.json) {
		console.log(JSON.stringify({
			success: true,
			oldLabel,
			label: newLabel,
			updatedPaths: updates.map((u) => u.path),
		}, null, 2));
		return;
	}
	console.log(drawBox([
		colorize(`Renamed ${oldLabel} → ${newLabel}`, GREEN),
		"",
		...updates.map((u) => `Updated: ${shortenPath(u.path)}`),
	]).join("\n"));
}

/**
 * Set a manual Claude plan override for web/CLI display.
 * @param {string[]} args
 * @param {{ json?: boolean }} flags
 */
export async function handleClaudeSetPlan(args, flags) {
	const label = args[0];
	const planInput = args.slice(1).join(" ").trim();
	if (!label || !planInput) {
		const msg = `Usage: ${PRIMARY_CMD} claude set-plan <label> <${CLAUDE_PLAN_CHOICES.join("|")}|clear>`;
		if (flags.json) console.log(JSON.stringify({ success: false, error: msg }, null, 2));
		else console.error(colorize(msg, RED));
		process.exit(1);
	}
	const account = findClaudeAccountByLabel(label);
	if (!account) {
		const msg = `Claude account "${label}" not found`;
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: msg, availableLabels: getClaudeLabels() }, null, 2));
		} else console.error(colorize(`${msg}.`, RED));
		process.exit(1);
	}

	let planOverride = null;
	if (planInput.toLowerCase() !== "clear" && planInput.toLowerCase() !== "auto") {
		planOverride = formatClaudePlanLabel(planInput, planInput);
		if (!CLAUDE_PLAN_CHOICES.includes(planOverride)) {
			const msg = `Unknown Claude plan "${planInput}". Choose: ${CLAUDE_PLAN_CHOICES.join(", ")}, or clear.`;
			if (flags.json) console.log(JSON.stringify({ success: false, error: msg }, null, 2));
			else console.error(colorize(msg, RED));
			process.exit(1);
		}
	}

	const updates = [];
	for (const path of CLAUDE_MULTI_ACCOUNT_PATHS) {
		const result = patchAccountFieldsInContainer(path, label, { planOverride });
		if (result.updated) updates.push(result);
	}
	if (!updates.length) {
		const msg = `Could not update plan for "${label}" in ~/.claude-accounts.json.`;
		if (flags.json) console.log(JSON.stringify({ success: false, error: msg }, null, 2));
		else console.error(colorize(msg, RED));
		process.exit(1);
	}

	const display = planOverride ?? formatClaudePlanLabel(account.subscriptionType, account.rateLimitTier) ?? "auto";
	if (flags.json) {
		console.log(JSON.stringify({
			success: true,
			label,
			planOverride,
			plan: display,
			updatedPaths: updates.map((u) => u.path),
		}, null, 2));
		return;
	}
	console.log(drawBox([
		colorize(`Claude ${label} plan → ${display}`, GREEN),
		"",
		...updates.map((u) => `Updated: ${shortenPath(u.path)}`),
	]).join("\n"));
}

/**
 * Set a manual Grok plan override via GROK_ACCOUNTS env is preferred; also
 * writes planOverride into matching pi/OpenCode auth entries when possible.
 * For Phase A (no managed container), store override in ~/.grok-plan-override.json.
 * @param {string[]} args
 * @param {{ json?: boolean }} flags
 */
export async function handleGrokSetPlan(args, flags) {
	const planInput = args.join(" ").trim();
	if (!planInput) {
		const msg = `Usage: ${PRIMARY_CMD} grok set-plan <${GROK_PLAN_CHOICES.join("|")}|clear>`;
		if (flags.json) console.log(JSON.stringify({ success: false, error: msg }, null, 2));
		else console.error(colorize(msg, RED));
		process.exit(1);
	}

	const overridePath = GROK_PLAN_OVERRIDE_PATH;
	let planOverride = null;
	if (planInput.toLowerCase() !== "clear" && planInput.toLowerCase() !== "auto") {
		planOverride = formatGrokPlanLabel(null, { planOverride: planInput });
		if (!GROK_PLAN_CHOICES.includes(planOverride)) {
			const msg = `Unknown Grok plan "${planInput}". Choose: ${GROK_PLAN_CHOICES.join(", ")}, or clear.`;
			if (flags.json) console.log(JSON.stringify({ success: false, error: msg }, null, 2));
			else console.error(colorize(msg, RED));
			process.exit(1);
		}
	}

	try {
		if (planOverride === null) {
			if (existsSync(overridePath)) unlinkSync(overridePath);
		} else {
			writeFileAtomic(overridePath, `${JSON.stringify({ planOverride }, null, 2)}\n`, { mode: 0o600 });
		}
	} catch (err) {
		const msg = `Failed to write ${overridePath}: ${err.message}`;
		if (flags.json) console.log(JSON.stringify({ success: false, error: msg }, null, 2));
		else console.error(colorize(msg, RED));
		process.exit(1);
	}

	if (flags.json) {
		console.log(JSON.stringify({ success: true, planOverride, path: overridePath }, null, 2));
		return;
	}
	console.log(drawBox([
		colorize(`Grok plan → ${planOverride ?? "auto"}`, GREEN),
		"",
		`Updated: ${shortenPath(overridePath)}`,
	]).join("\n"));
}

/**
 * Handle Codex subcommand entrypoint
 * @param {string[]} args - Codex subcommand args
 * @param {{ json: boolean, noBrowser: boolean, noColor: boolean }} flags - Parsed flags
 */
export async function handleCodex(args, flags) {
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
		case "reauth":
			await handleCodexReauth(subArgs, flags);
			break;
		case "switch":
			await handleSwitch(subArgs, flags);
			break;
		case "sync":
			await handleCodexSync(subArgs, flags);
			break;
		case "list":
			await handleList(flags);
			break;
		case "remove":
			await handleRemove(subArgs, flags);
			break;
		case "rename":
			await handleCodexRename(subArgs, flags);
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
export async function handleClaude(args, flags) {
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
		case "reauth":
			await handleClaudeReauth(subArgs, flags);
			break;
		case "list":
			await handleClaudeList(flags);
			break;
		case "switch":
			await handleClaudeSwitch(subArgs, flags);
			break;
		case "sync":
			await handleClaudeSync(subArgs, flags);
			break;
		case "remove":
			await handleClaudeRemove(subArgs, flags);
			break;
		case "set-plan":
			await handleClaudeSetPlan(subArgs, flags);
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
 * Handle Factory add subcommand — add a Factory account from Droid CLI auth.v2 files.
 *
 * Flow:
 * 1. Check auth.v2 files exist → error if missing (log in via 'droid' first).
 * 2. Read & decrypt auth.v2 → extract JWT profile (email, org, name, accountId).
 * 3. Validate label format (/^[a-zA-Z0-9_-]+$/), reject duplicates.
 * 4. Validate optional API key (must start with 'fk-') and plan limit (numeric > 0).
 * 5. Build account entry and write to container. Set as activeLabel.
 * 6. Confirm success. Support --json flag.
 *
 * Uses _-prefixed flags for test injection (paths, label, apiKey, planLimit).
 *
 * @param {string[]} args - Non-flag arguments
 * @param {{ json?: boolean, _authFilePath?: string, _keyFilePath?: string, _containerPath?: string, _label?: string, _apiKey?: string, _planLimit?: number }} flags
 */
export async function handleFactoryAdd(args, flags) {
	const authFilePath = flags._authFilePath ?? FACTORY_AUTH_FILE_PATH;
	const keyFilePath = flags._keyFilePath ?? FACTORY_AUTH_KEY_PATH;
	const containerPath = flags._containerPath ?? FACTORY_MULTI_ACCOUNT_PATH;

	try {
		// 1. Check auth.v2 files exist
		if (!existsSync(authFilePath) || !existsSync(keyFilePath)) {
			const msg = "Factory auth files not found. Log in via the 'droid' CLI first.";
			if (flags.json) {
				console.log(JSON.stringify({ success: false, error: msg }, null, 2));
			} else {
				console.error(colorize(`Error: ${msg}`, RED));
				console.error(`\nSearched:`);
				console.error(`  - ${authFilePath}`);
				console.error(`  - ${keyFilePath}`);
			}
			process.exit(1);
		}

		// 2. Read and decrypt auth.v2 files
		const tokens = readAuthV2Files(authFilePath, keyFilePath);
		if (!tokens?.accessToken) {
			const msg = "Failed to decrypt Factory auth files. The files may be corrupt or the key may be invalid.";
			if (flags.json) {
				console.log(JSON.stringify({ success: false, error: msg }, null, 2));
			} else {
				console.error(colorize(`Error: ${msg}`, RED));
			}
			process.exit(1);
		}

		// 3. Extract JWT profile
		const profile = extractFactoryProfile(tokens.accessToken);
		if (!profile.accountId) {
			const msg = "Failed to extract account info from Factory JWT. The token may be invalid.";
			if (flags.json) {
				console.log(JSON.stringify({ success: false, error: msg }, null, 2));
			} else {
				console.error(colorize(`Error: ${msg}`, RED));
			}
			process.exit(1);
		}

		// 4. Get label (from flags for testing, or prompt interactively)
		let label = flags._label ?? args[0] ?? null;
		if (!label) {
			label = (await promptInput("Label (e.g., work, personal): ")).trim();
		}
		if (!label) {
			const msg = "Label is required.";
			if (flags.json) {
				console.log(JSON.stringify({ success: false, error: msg }, null, 2));
			} else {
				console.error(colorize(`Error: ${msg}`, RED));
			}
			process.exit(1);
		}

		// Validate label format
		if (!/^[a-zA-Z0-9_-]+$/.test(label)) {
			const msg = `Invalid label "${label}". Use only letters, numbers, hyphens, and underscores.`;
			if (flags.json) {
				console.log(JSON.stringify({ success: false, error: msg }, null, 2));
			} else {
				console.error(colorize(`Error: ${msg}`, RED));
			}
			process.exit(1);
		}

		// Check for duplicate label in existing container
		const container = readMultiAccountContainer(containerPath);
		const existingLabels = container.accounts
			.filter(a => a && typeof a === "object")
			.map(a => a.label)
			.filter(Boolean);
		if (existingLabels.includes(label)) {
			const msg = `Label "${label}" already exists. Choose a different label.\nExisting labels: ${existingLabels.join(", ")}`;
			if (flags.json) {
				console.log(JSON.stringify({ success: false, error: `Label "${label}" already exists` }, null, 2));
			} else {
				console.error(colorize(`Error: ${msg}`, RED));
			}
			process.exit(1);
		}

		// 5. Get optional API key
		let apiKey = flags._apiKey ?? null;
		if (apiKey === undefined) apiKey = null;
		if (!apiKey && !flags._label && !flags.json) {
			// Interactive mode — prompt for optional API key
			const apiKeyInput = (await promptInput("API key (fk-..., optional, press Enter to skip): ")).trim();
			if (apiKeyInput) apiKey = apiKeyInput;
		}
		if (apiKey && !apiKey.startsWith("fk-")) {
			const msg = `Invalid API key. Factory API keys must start with 'fk-'.`;
			if (flags.json) {
				console.log(JSON.stringify({ success: false, error: msg }, null, 2));
			} else {
				console.error(colorize(`Error: ${msg}`, RED));
			}
			process.exit(1);
		}

		// 6. Get optional plan limit
		let planLimit = flags._planLimit ?? null;
		if (planLimit === undefined) planLimit = null;
		if (planLimit === null && !flags._label && !flags.json) {
			// Interactive mode — prompt for optional plan limit
			const limitInput = (await promptInput("Plan limit (e.g., 20000000, optional, press Enter to skip): ")).trim();
			if (limitInput) {
				const parsed = Number(limitInput);
				if (!Number.isFinite(parsed) || parsed <= 0) {
					const msg = `Invalid plan limit "${limitInput}". Must be a positive number.`;
					console.error(colorize(`Error: ${msg}`, RED));
					process.exit(1);
				}
				planLimit = parsed;
			}
		}
		if (planLimit !== null && (typeof planLimit !== "number" || !Number.isFinite(planLimit) || planLimit <= 0)) {
			const msg = `Invalid plan limit. Must be a positive number.`;
			if (flags.json) {
				console.log(JSON.stringify({ success: false, error: msg }, null, 2));
			} else {
				console.error(colorize(`Error: ${msg}`, RED));
			}
			process.exit(1);
		}

		// 7. Read raw auth.v2 file contents (to store in container without modifying originals)
		const authFileContent = readFileSync(authFilePath, "utf-8");
		const authKeyContent = readFileSync(keyFilePath, "utf-8").trim();

		// Build account entry
		const newAccount = {
			label,
			accountId: profile.accountId,
			email: profile.email,
			org: profile.org,
			name: profile.name,
			authFile: authFileContent,
			authKey: authKeyContent,
			source: containerPath,
		};
		if (apiKey) newAccount.apiKey = apiKey;
		if (planLimit !== null) newAccount.planLimit = planLimit;

		// 8. Write to container
		const accounts = [...container.accounts, newAccount];
		writeMultiAccountContainer(containerPath, container, accounts, { activeLabel: label }, { mode: 0o600 });

		// 9. Confirm success
		if (flags.json) {
			console.log(JSON.stringify({
				success: true,
				label,
				email: profile.email,
				org: profile.org,
				accountId: profile.accountId,
				source: containerPath,
			}, null, 2));
		} else {
			const emailDisplay = profile.email ? ` <${profile.email}>` : "";
			const orgDisplay = profile.org ? ` (${profile.org})` : "";
			const lines = [
				colorize(`Added Factory account ${label}${emailDisplay}${orgDisplay}`, GREEN),
				"",
				`Saved to: ${shortenPath(containerPath)}`,
				"",
				`Run '${PRIMARY_CMD} factory quota' to check Factory usage`,
			];
			const boxLines = drawBox(lines);
			console.log(boxLines.join("\n"));
		}
	} catch (error) {
		if (error.message?.startsWith("EXIT_")) throw error;
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
		} else {
			console.error(colorize(`Error: ${error.message}`, RED));
		}
		process.exit(1);
	}
}

/**
 * Handle Factory switch subcommand — switch active Factory account.
 *
 * Flow:
 * 1. Validate label argument (missing → usage message).
 * 2. Read container → find account by label (error with available labels if not found).
 * 3. Write account's authFile/authKey to ~/.factory/auth.v2.file and auth.v2.key via writeAuthV2Files.
 * 4. Update activeLabel in container. Write container with 0o600 permissions.
 * 5. Confirm switch with account details. Support --json flag.
 *
 * @param {string[]} args - Non-flag arguments (label is required)
 * @param {{ json?: boolean, _containerPath?: string, _authFilePath?: string, _keyFilePath?: string }} flags
 */
export async function handleFactorySwitch(args, flags) {
	const containerPath = flags._containerPath ?? FACTORY_MULTI_ACCOUNT_PATH;
	const authFilePath = flags._authFilePath ?? FACTORY_AUTH_FILE_PATH;
	const keyFilePath = flags._keyFilePath ?? FACTORY_AUTH_KEY_PATH;

	const label = args[0];
	if (!label) {
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: "Missing required label argument" }, null, 2));
		} else {
			console.error(colorize(`Usage: ${PRIMARY_CMD} factory switch <label>`, RED));
			console.error("Switches the active Factory account and writes auth.v2 files.");
		}
		process.exit(1);
	}

	try {
		// 1. Read container
		const container = readMultiAccountContainer(containerPath);
		if (!container.exists || container.rootType === "invalid") {
			const msg = "No Factory accounts configured.";
			if (flags.json) {
				console.log(JSON.stringify({ success: false, error: msg }, null, 2));
			} else {
				console.error(colorize(`Error: ${msg}`, RED));
				console.error(`Run '${PRIMARY_CMD} factory add' to add an account.`);
			}
			process.exit(1);
		}

		// 2. Find account by label
		const accounts = container.accounts.filter(a => a && typeof a === "object");
		const account = accounts.find(a => a.label === label) ?? null;
		if (!account) {
			const availableLabels = accounts.map(a => a.label).filter(Boolean);
			if (flags.json) {
				console.log(JSON.stringify({
					success: false,
					error: `Factory account "${label}" not found`,
					availableLabels,
				}, null, 2));
			} else {
				console.error(colorize(`Factory account "${label}" not found.`, RED));
				if (availableLabels.length) {
					console.error(`Available: ${availableLabels.join(", ")}`);
				} else {
					console.error(`Run '${PRIMARY_CMD} factory add' to add an account.`);
				}
			}
			process.exit(1);
		}

		// 3. Validate account has auth data
		if (!account.authFile || !account.authKey) {
			const msg = `Account "${label}" has no stored auth data. Re-add with '${PRIMARY_CMD} factory add'.`;
			if (flags.json) {
				console.log(JSON.stringify({ success: false, error: msg }, null, 2));
			} else {
				console.error(colorize(`Error: ${msg}`, RED));
			}
			process.exit(1);
		}

		// 4. Decrypt stored auth data, then write via writeAuthV2Files (atomic, fresh key)
		const decrypted = decryptAuthV2(account.authFile, account.authKey);
		if (!decrypted) {
			const msg = `Failed to decrypt stored auth data for "${label}". The account may be corrupt.`;
			if (flags.json) {
				console.log(JSON.stringify({ success: false, error: msg }, null, 2));
			} else {
				console.error(colorize(`Error: ${msg}`, RED));
			}
			process.exit(1);
		}

		const authWriteResult = writeAuthV2Files(authFilePath, keyFilePath, decrypted);
		if (!authWriteResult.success) {
			const msg = `Failed to write auth files: ${authWriteResult.error}`;
			if (flags.json) {
				console.log(JSON.stringify({ success: false, error: msg }, null, 2));
			} else {
				console.error(colorize(`Error: ${msg}`, RED));
			}
			process.exit(1);
		}

		// 5. Update activeLabel in container
		writeMultiAccountContainer(containerPath, container, container.accounts, { activeLabel: label }, { mode: 0o600 });

		// 6. Confirm switch
		if (flags.json) {
			console.log(JSON.stringify({
				success: true,
				label,
				email: account.email ?? null,
				org: account.org ?? null,
				accountId: account.accountId,
				authFilePath,
				keyFilePath,
				containerPath,
			}, null, 2));
		} else {
			const emailDisplay = account.email ? ` <${account.email}>` : "";
			const orgDisplay = account.org ? ` (${account.org})` : "";
			const lines = [
				colorize(`Switched to Factory account ${label}${emailDisplay}${orgDisplay}`, GREEN),
				"",
				`Auth file: ${shortenPath(authFilePath)}`,
				`Key file:  ${shortenPath(keyFilePath)}`,
				`Container: ${shortenPath(containerPath)}`,
			];
			const boxLines = drawBox(lines);
			console.log(boxLines.join("\n"));
		}
	} catch (error) {
		if (error.message?.startsWith("EXIT_")) throw error;
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
		} else {
			console.error(colorize(`Error: ${error.message}`, RED));
		}
		process.exit(1);
	}
}

/**
 * Handle Factory remove subcommand — remove a Factory account from the container.
 *
 * Flow:
 * 1. Validate label argument (missing → usage message).
 * 2. Read container → find account by label (error with available labels if not found).
 * 3. Prompt for confirmation (unless --json, which skips the prompt).
 * 4. Remove account from accounts array.
 *    - If removed account was active, set activeLabel to null.
 *    - If last account, delete the container file.
 * 5. Write container with 0o600 permissions.
 * 6. Support --json output.
 *
 * @param {string[]} args - Non-flag arguments (label is required)
 * @param {{ json?: boolean, _containerPath?: string, _skipConfirm?: boolean }} flags
 */
export async function handleFactoryRemove(args, flags) {
	const containerPath = flags._containerPath ?? FACTORY_MULTI_ACCOUNT_PATH;

	const label = args[0];
	if (!label) {
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: "Missing required label argument" }, null, 2));
		} else {
			console.error(colorize(`Usage: ${PRIMARY_CMD} factory remove <label>`, RED));
			console.error("Removes a Factory account from the multi-account file.");
		}
		process.exit(1);
	}

	try {
		// 1. Read container
		const container = readMultiAccountContainer(containerPath);
		if (!container.exists || container.rootType === "invalid") {
			const msg = "No Factory accounts configured.";
			if (flags.json) {
				console.log(JSON.stringify({ success: false, error: msg }, null, 2));
			} else {
				console.error(colorize(`Error: ${msg}`, RED));
				console.error(`Run '${PRIMARY_CMD} factory add' to add an account.`);
			}
			process.exit(1);
		}

		// 2. Find account by label
		const accounts = container.accounts.filter(a => a && typeof a === "object");
		const account = accounts.find(a => a.label === label) ?? null;
		if (!account) {
			const availableLabels = accounts.map(a => a.label).filter(Boolean);
			if (flags.json) {
				console.log(JSON.stringify({
					success: false,
					error: `Factory account "${label}" not found`,
					availableLabels,
				}, null, 2));
			} else {
				console.error(colorize(`Factory account "${label}" not found.`, RED));
				if (availableLabels.length) {
					console.error(`Available: ${availableLabels.join(", ")}`);
				} else {
					console.error(`Run '${PRIMARY_CMD} factory add' to add an account.`);
				}
			}
			process.exit(1);
		}

		// 3. Prompt for confirmation (skip if --json or _skipConfirm)
		if (!flags.json && !flags._skipConfirm) {
			const confirmed = await promptConfirm(`Remove Factory account "${label}"?`);
			if (!confirmed) {
				console.log("Cancelled.");
				return;
			}
		}

		// 4. Remove account from accounts array
		const updatedAccounts = container.accounts.filter(a => {
			if (!a || typeof a !== "object") return true;
			return a.label !== label;
		});

		const removedWasActive = container.activeLabel === label;
		const fileDeleted = updatedAccounts.length === 0;

		if (fileDeleted) {
			// Last account — delete the container file
			unlinkSync(containerPath);
		} else {
			// Write updated container with 0o600 permissions
			const overrides = removedWasActive ? { activeLabel: null } : {};
			writeMultiAccountContainer(containerPath, container, updatedAccounts, overrides, { mode: 0o600 });
		}

		// 5. Output
		if (flags.json) {
			const output = {
				success: true,
				label,
				source: shortenPath(containerPath),
			};
			if (fileDeleted) {
				output.message = "File deleted (no accounts remaining)";
			} else {
				output.remainingAccounts = updatedAccounts.length;
			}
			if (removedWasActive) {
				output.activeLabelCleared = true;
			}
			console.log(JSON.stringify(output, null, 2));
		} else {
			if (fileDeleted) {
				const lines = [
					colorize(`Removed Factory account ${label}`, GREEN),
					"",
					`Deleted: ${shortenPath(containerPath)} (no accounts remaining)`,
				];
				console.log(drawBox(lines).join("\n"));
			} else {
				const lines = [
					colorize(`Removed Factory account ${label}`, GREEN),
					"",
					`Updated: ${shortenPath(containerPath)} (${updatedAccounts.length} account(s) remaining)`,
				];
				if (removedWasActive) {
					lines.push("");
					lines.push("Active account cleared (no account is now active)");
				}
				console.log(drawBox(lines).join("\n"));
			}
		}
	} catch (error) {
		if (error.message?.startsWith("EXIT_")) throw error;
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
		} else {
			console.error(colorize(`Error: ${error.message}`, RED));
		}
		process.exit(1);
	}
}

/**
 * Handle Factory list subcommand — list all Factory accounts.
 *
 * Flow:
 * 1. Load Factory accounts via loadAllFactoryAccounts().
 * 2. If no accounts, show guidance to 'cq factory add'.
 * 3. For each account, display: active indicator, label, email, org, auth methods.
 * 4. When activeLabel is null, no active indicator shown.
 * 5. Support --json output.
 *
 * @param {string[]} args - Non-flag arguments (unused)
 * @param {{ json?: boolean, _containerPath?: string }} flags
 */
export async function handleFactoryList(args, flags) {
	const containerPath = flags._containerPath ?? FACTORY_MULTI_ACCOUNT_PATH;

	// Load accounts via the standard loader
	const accounts = loadAllFactoryAccounts();
	const activeLabel = getFactoryActiveLabel(containerPath);

	if (!accounts.length) {
		if (flags.json) {
			console.log(JSON.stringify({ accounts: [], activeLabel: null }, null, 2));
			return;
		}
		console.log("No Factory accounts found.");
		console.log("\nSearched:");
		console.log("  - FACTORY_ACCOUNTS env var");
		console.log(`  - ${FACTORY_MULTI_ACCOUNT_PATH}`);
		console.log(`  - ${FACTORY_AUTH_FILE_PATH}`);
		console.log(`\nRun '${PRIMARY_CMD} factory add' to add an account.`);
		return;
	}

	// Build account details
	const accountDetails = accounts.map(account => {
		const isActive = activeLabel !== null && account.label === activeLabel;
		const authMethods = [];
		if (account.authFile || account.accessToken || account.access_token) {
			authMethods.push("auth.v2");
		}
		if (account.apiKey) {
			authMethods.push("apiKey");
		}

		return {
			label: account.label,
			email: account.email ?? null,
			org: account.org ?? null,
			accountId: account.accountId,
			isActive,
			authMethods,
			source: account.source,
		};
	});

	// JSON output
	if (flags.json) {
		console.log(JSON.stringify({
			accounts: accountDetails,
			activeLabel,
		}, null, 2));
		return;
	}

	// Human-readable output
	const lines = [];
	lines.push(`Factory Accounts (${accounts.length} total)`);
	lines.push("");

	for (let i = 0; i < accountDetails.length; i++) {
		const detail = accountDetails[i];

		const activeMarker = detail.isActive ? "*" : " ";
		const statusText = detail.isActive ? " [active]" : "";

		const emailDisplay = detail.email ? ` <${detail.email}>` : "";
		const orgDisplay = detail.org ? ` (${detail.org})` : "";
		lines.push(`${activeMarker} ${detail.label}${emailDisplay}${orgDisplay}${statusText}`);

		const authDisplay = detail.authMethods.length ? detail.authMethods.join("+") : "none";
		lines.push(`  Auth: ${authDisplay} | ${shortenPath(detail.source)}`);

		if (i < accountDetails.length - 1) {
			lines.push("");
		}
	}

	if (activeLabel !== null) {
		lines.push("");
		lines.push("* = active (from activeLabel)");
	}

	const boxLines = drawBox(lines);
	console.log(boxLines.join("\n"));
}

/**
 * Handle Grok subcommand entrypoint
 * @param {string[]} args
 * @param {{ json: boolean, noColor?: boolean, compact?: boolean }} flags
 */
export async function handleGrok(args, flags) {
	const subcommand = args[0];
	const subArgs = args.slice(1);

	if (subcommand === "set-plan") {
		await handleGrokSetPlan(subArgs, flags);
		return;
	}

	// Phase A only has quota — bare `cq grok` and unknown labels run quota.
	if (!subcommand || subcommand === "quota") {
		await handleGrokQuota(subcommand === "quota" ? subArgs : args, flags);
		return;
	}

	if (subcommand === "help") {
		printHelpGrok();
		return;
	}

	console.error(colorize(`Unknown Grok command: ${subcommand}`, RED));
	console.error("");
	printHelpGrok();
	process.exit(1);
}

/**
 * Handle Grok quota — SuperGrok weekly credits from live auth stores.
 * @param {string[]} args
 * @param {{ json: boolean, noColor?: boolean, compact?: boolean }} flags
 */
export async function handleGrokQuota(args, flags) {
	const labelFilter = args[0];
	const allAccounts = loadAllGrokAccounts();

	if (!allAccounts.length) {
		if (flags.json) {
			console.log(JSON.stringify({
				success: false,
				error: "No Grok accounts found",
				searchedLocations: getGrokSearchLocations(),
			}, null, 2));
		} else {
			console.error(colorize("No Grok accounts found.", RED));
			console.error("\nSearched:");
			for (const loc of getGrokSearchLocations()) {
				console.error(`  - ${loc}`);
			}
			console.error("\nSign in with SuperGrok OAuth in pi, OpenCode, or Hermes first.");
		}
		process.exit(1);
	}

	const accounts = labelFilter
		? allAccounts.filter(a => a.label === labelFilter)
		: allAccounts;

	if (labelFilter && !accounts.length) {
		const availableLabels = getAllGrokLabels(allAccounts);
		if (flags.json) {
			console.log(JSON.stringify({
				success: false,
				error: `Grok account "${labelFilter}" not found`,
				availableLabels,
			}, null, 2));
		} else {
			console.error(colorize(`Grok account "${labelFilter}" not found.`, RED));
			if (availableLabels.length) {
				console.error(`Available: ${availableLabels.join(", ")}`);
			}
		}
		process.exit(1);
	}

	const results = [];
	for (const account of accounts) {
		const fresh = await ensureFreshGrokToken(account);
		if (!fresh.ok && !flags.json) {
			console.error(colorize(`Warning: Grok token refresh failed for ${account.label}: ${fresh.error}`, YELLOW));
			if (fresh.persistErrors?.length) {
				for (const err of fresh.persistErrors) {
					console.error(colorize(`  ${err}`, YELLOW));
				}
			}
		} else if (fresh.refreshed && fresh.persistErrors?.length && !flags.json) {
			for (const err of fresh.persistErrors) {
				console.error(colorize(`Warning: partial Grok token persist: ${err}`, YELLOW));
			}
		}
		await enrichGrokAccountFromUserinfo(account);
		const usage = await fetchGrokUsage(account);
		results.push({ account, usage, refresh: fresh });
	}

	if (flags.json) {
		const output = results.map(({ account, usage, refresh }) => ({
			label: account.label,
			email: account.email ?? null,
			accountId: account.accountId,
			teamId: account.teamId ?? null,
			tier: account.tier ?? null,
			plan: formatGrokPlanLabel(account.tier, {
				plan: account.plan,
				planType: account.planType,
				planOverride: account.planOverride,
			}),
			planOverride: account.planOverride ?? null,
			usage: usage.success ? usage.usage : null,
			error: usage.success ? undefined : usage.error,
			source: account.source,
			sources: (account.sources ?? []).map(s => ({
				kind: s.kind,
				path: s.path,
			})),
			refreshed: Boolean(refresh?.refreshed),
			refreshError: refresh?.ok ? undefined : refresh?.error,
			updatedPaths: refresh?.updatedPaths,
		}));
		console.log(JSON.stringify(output, null, 2));
		return;
	}

	for (const { account, usage } of results) {
		const lines = buildGrokUsageLines(account, usage, flags);
		if (flags.compact) {
			console.log(lines.join("\n"));
		} else {
			const boxLines = drawQuotaBox(lines);
			console.log(boxLines.join("\n"));
		}
	}
}

/**
 * Handle the Synthetic quota-only namespace.
 * @param {string[]} args
 * @param {{ json: boolean, noColor?: boolean, compact?: boolean }} flags
 */
export async function handleSynthetic(args, flags) {
	const subcommand = args[0];
	if (!subcommand || subcommand === "quota") {
		await handleSyntheticQuota(subcommand === "quota" ? args.slice(1) : args, flags);
		return;
	}
	if (subcommand === "help") {
		printHelpSynthetic();
		return;
	}
	console.error(colorize(`Unknown Synthetic command: ${subcommand}`, RED));
	console.error("");
	printHelpSynthetic();
	process.exit(1);
}

/**
 * Fetch and display Synthetic quota.
 * @param {string[]} args
 * @param {{ json: boolean, noColor?: boolean, compact?: boolean }} flags
 */
export async function handleSyntheticQuota(args, flags) {
	const labelFilter = args[0];
	const allAccounts = await loadAllSyntheticAccounts();
	if (!allAccounts.length) {
		if (flags.json) {
			console.log(JSON.stringify({
				success: false,
				error: "No Synthetic credentials found",
				searchedLocations: getSyntheticSearchLocations(),
			}, null, 2));
		} else {
			console.error(colorize("No Synthetic credentials found.", RED));
			console.error("\nSearched:");
			for (const location of getSyntheticSearchLocations()) {
				console.error(`  - ${location}`);
			}
		}
		process.exit(1);
	}

	const accounts = labelFilter
		? allAccounts.filter(account => account.label === labelFilter)
		: allAccounts;
	if (!accounts.length) {
		const availableLabels = allAccounts.map(account => account.label);
		if (flags.json) {
			console.log(JSON.stringify({
				success: false,
				error: `Synthetic credential "${labelFilter}" not found`,
				availableLabels,
			}, null, 2));
		} else {
			console.error(colorize(`Synthetic credential "${labelFilter}" not found.`, RED));
			console.error(`Available: ${availableLabels.join(", ")}`);
		}
		process.exit(1);
	}

	const results = await Promise.all(accounts.map(async account => ({
		account,
		usage: await fetchSyntheticUsage(account),
	})));
	if (flags.json) {
		console.log(JSON.stringify(results.map(({ account, usage }) => ({
			label: account.label,
			usage: usage.success ? usage.usage : null,
			error: usage.success ? undefined : usage.error,
			source: account.source,
		})), null, 2));
		return;
	}
	for (const { account, usage } of results) {
		const lines = buildSyntheticUsageLines(account, usage, flags);
		console.log(flags.compact ? lines.join("\n") : drawQuotaBox(lines).join("\n"));
	}
}

/**
 * Handle the Antigravity quota-only namespace.
 * @param {string[]} args
 * @param {{ json: boolean, noColor?: boolean, compact?: boolean }} flags
 */
export async function handleAntigravity(args, flags) {
	const subcommand = args[0];
	if (!subcommand || subcommand === "quota") {
		await handleAntigravityQuota(subcommand === "quota" ? args.slice(1) : args, flags);
		return;
	}
	if (subcommand === "help") {
		printHelpAntigravity();
		return;
	}
	console.error(colorize(`Unknown Antigravity command: ${subcommand}`, RED));
	console.error("");
	printHelpAntigravity();
	process.exit(1);
}

/**
 * Fetch and display Google AI Pro / Antigravity quota.
 * @param {string[]} args
 * @param {{ json: boolean, noColor?: boolean, compact?: boolean }} flags
 */
export async function handleAntigravityQuota(args, flags) {
	const labelFilter = args[0];
	const allAccounts = await loadAllAntigravityAccounts();
	if (!allAccounts.length) {
		if (flags.json) {
			console.log(JSON.stringify({
				success: false,
				error: "No Antigravity accounts found",
				searchedLocations: getAntigravitySearchLocations(),
			}, null, 2));
		} else {
			console.error(colorize("No Antigravity accounts found.", RED));
			console.error("\nSearched:");
			for (const location of getAntigravitySearchLocations()) {
				console.error(`  - ${location}`);
			}
			console.error("\nConnect Google AI Pro in shuvcode, or set ANTIGRAVITY_REFRESH.");
		}
		process.exit(1);
	}

	const accounts = labelFilter
		? allAccounts.filter(account => account.label === labelFilter)
		: allAccounts;
	if (!accounts.length) {
		const availableLabels = getAllAntigravityLabels(allAccounts);
		if (flags.json) {
			console.log(JSON.stringify({
				success: false,
				error: `Antigravity account "${labelFilter}" not found`,
				availableLabels,
			}, null, 2));
		} else {
			console.error(colorize(`Antigravity account "${labelFilter}" not found.`, RED));
			if (availableLabels.length) {
				console.error(`Available: ${availableLabels.join(", ")}`);
			}
		}
		process.exit(1);
	}

	const results = [];
	for (const account of accounts) {
		const fresh = await ensureFreshAntigravityToken(account);
		if (!fresh.ok && !flags.json) {
			console.error(colorize(
				`Warning: Antigravity token refresh failed for ${account.label}: ${fresh.error}`,
				YELLOW,
			));
		}
		const usage = await fetchAntigravityUsage(account);
		results.push({ account, usage, refresh: fresh });
	}
	if (flags.json) {
		console.log(JSON.stringify(results.map(({ account, usage, refresh }) => ({
			label: account.label,
			email: account.email ?? null,
			projectId: account.projectId ?? null,
			paidTier: account.paidTier ?? null,
			usage: usage.success ? usage.usage : null,
			error: usage.success ? undefined : usage.error,
			source: account.source,
			refreshed: Boolean(refresh?.refreshed),
			refreshError: refresh?.ok ? undefined : refresh?.error,
		})), null, 2));
		return;
	}
	for (const { account, usage } of results) {
		const lines = buildAntigravityUsageLines(account, usage, flags);
		console.log(flags.compact ? lines.join("\n") : drawQuotaBox(lines).join("\n"));
	}
}

/**
 * Keep only normalized quota fields before OpenCode Go data crosses a JSON boundary.
 * @param {unknown} value
 * @returns {object | null}
 */
function sanitizeOpenCodeGoWindow(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const output = {};
	for (const key of ["usagePercent", "remainingPercent", "resetInSec"]) {
		if (Number.isFinite(value[key])) output[key] = value[key];
	}
	if (typeof value.resetAt === "string") {
		const resetAt = new Date(value.resetAt);
		if (!Number.isNaN(resetAt.getTime())) output.resetAt = resetAt.toISOString();
	}
	return Object.keys(output).length ? output : null;
}

/**
 * Preserve only the bounded error vocabulary produced by the dashboard client.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function sanitizeOpenCodeGoError(value) {
	if (typeof value !== "string" || !value) return undefined;
	if (value.startsWith("OpenCode Go dashboard configuration is incomplete")) {
		return "OpenCode Go dashboard configuration is incomplete; set "
			+ "OPENCODE_GO_WORKSPACE_ID and OPENCODE_GO_AUTH_COOKIE";
	}
	if (value.includes("sign-in required")) {
		return "OpenCode Go sign-in required; refresh OPENCODE_GO_AUTH_COOKIE";
	}
	const status = value.match(/HTTP (\d{3})/);
	if (status) return `OpenCode Go dashboard returned HTTP ${status[1]}`;
	if (value.includes("could not be read")) {
		return "OpenCode Go dashboard could not be read; refresh OPENCODE_GO_AUTH_COOKIE";
	}
	if (value.includes("timed out")) return "OpenCode Go dashboard request timed out";
	if (value.includes("request failed")) return "OpenCode Go dashboard request failed";
	return "OpenCode Go usage unavailable";
}

/**
 * Build the secret-free OpenCode Go JSON representation used by CLI and PWA input.
 * @param {Array<{account?: object, usage?: object}> | null | undefined} results
 * @returns {object[]}
 */
export function buildOpenCodeGoJsonOutput(results) {
	return (Array.isArray(results) ? results : []).map(({ account, usage }) => {
		let safeUsage = null;
		if (usage?.success) {
			safeUsage = { source: "dashboard" };
			for (const field of ["rollingUsage", "weeklyUsage", "monthlyUsage"]) {
				const window = sanitizeOpenCodeGoWindow(usage.usage?.[field]);
				if (window) safeUsage[field] = window;
			}
		}
		return {
			label: typeof account?.label === "string" ? account.label : "go",
			usage: safeUsage,
			error: usage?.success ? undefined : sanitizeOpenCodeGoError(usage?.error),
			source: "dashboard",
		};
	});
}

/**
 * Handle the OpenCode Go subcommand entrypoint.
 * @param {string[]} args
 * @param {{ json: boolean, noColor?: boolean, compact?: boolean }} flags
 */
export async function handleOpenCodeGo(args, flags) {
	const subcommand = args[0];
	const subArgs = args.slice(1);

	if (!subcommand || subcommand === "quota") {
		await handleOpenCodeGoQuota(subcommand === "quota" ? subArgs : args, flags);
		return;
	}

	if (subcommand === "help") {
		printHelpOpenCodeGo();
		return;
	}

	console.error(colorize(`Unknown OpenCode Go command: ${subcommand}`, RED));
	console.error("");
	printHelpOpenCodeGo();
	process.exit(1);
}

/**
 * Fetch OpenCode Go quota from the authenticated workspace dashboard.
 * @param {string[]} args
 * @param {{ json: boolean, noColor?: boolean, compact?: boolean }} flags
 */
export async function handleOpenCodeGoQuota(args, flags) {
	const labelFilter = args[0];
	const config = resolveOpenCodeGoDashboardConfig();

	if (config.state !== "configured") {
		const error = config.error ?? "OpenCode Go dashboard is not configured";
		if (flags.json) {
			console.log(JSON.stringify({
				success: false,
				error,
				searchedLocations: getOpenCodeGoSearchLocations(),
			}, null, 2));
		} else {
			console.error(colorize(error, RED));
			console.error("");
			console.error("Set OPENCODE_GO_WORKSPACE_ID and OPENCODE_GO_AUTH_COOKIE");
			console.error("in ~/.shuvquota.env (mode 600), then retry.");
		}
		process.exit(1);
	}

	const account = config.account;
	if (labelFilter && account.label !== labelFilter) {
		if (flags.json) {
			console.log(JSON.stringify({
				success: false,
				error: `OpenCode Go account "${labelFilter}" not found`,
				availableLabels: [account.label],
			}, null, 2));
		} else {
			console.error(colorize(`OpenCode Go account "${labelFilter}" not found.`, RED));
			console.error(`Available: ${account.label}`);
		}
		process.exit(1);
	}

	const usage = await fetchOpenCodeGoUsage(account);
	if (flags.json) {
		console.log(JSON.stringify(buildOpenCodeGoJsonOutput([{ account, usage }]), null, 2));
		return;
	}

	const lines = buildOpenCodeGoUsageLines(account, usage, flags);
	if (flags.compact) {
		console.log(lines.join("\n"));
	} else {
		console.log(drawQuotaBox(lines).join("\n"));
	}
}

/**
 * Handle Factory subcommand entrypoint
 * @param {string[]} args - Factory subcommand args
 * @param {{ json: boolean, noColor: boolean }} flags - Parsed flags
 */
export async function handleFactory(args, flags) {
	const subcommand = args[0];
	const subArgs = args.slice(1);

	if (!subcommand) {
		printHelpFactory();
		return;
	}

	switch (subcommand) {
		case "quota":
			await handleFactoryQuota(subArgs, flags);
			break;
		case "add":
			await handleFactoryAdd(subArgs, flags);
			break;
		case "switch":
			await handleFactorySwitch(subArgs, flags);
			break;
		case "remove":
			await handleFactoryRemove(subArgs, flags);
			break;
		case "list":
			await handleFactoryList(subArgs, flags);
			break;
		case "help":
			printHelpFactory();
			break;
		default:
			console.error(colorize(`Unknown Factory command: ${subcommand}`, RED));
			console.error("");
			printHelpFactory();
			process.exit(1);
	}
}

/**
 * Handle Factory quota subcommand - display Factory usage for all accounts
 * @param {string[]} args - Non-flag arguments (e.g., label filter)
 * @param {{ json: boolean, noColor?: boolean, billingDay?: number }} flags - Parsed flags
 */
export async function handleFactoryQuota(args, flags) {
	const labelFilter = args[0];
	const billingDay = flags.billingDay ?? 1;

	// Load all Factory accounts
	const allAccounts = loadAllFactoryAccounts();

	if (!allAccounts.length) {
		if (flags.json) {
			console.log(JSON.stringify({
				success: false,
				error: "No Factory accounts found",
				searchedLocations: [
					"FACTORY_ACCOUNTS env var",
					FACTORY_MULTI_ACCOUNT_PATH,
					FACTORY_AUTH_FILE_PATH,
				],
			}, null, 2));
		} else {
			console.error(colorize("No Factory accounts found.", RED));
			console.error("\nSearched:");
			console.error("  - FACTORY_ACCOUNTS env var");
			console.error(`  - ${FACTORY_MULTI_ACCOUNT_PATH}`);
			console.error(`  - ${FACTORY_AUTH_FILE_PATH}`);
			console.error(`\nRun '${PRIMARY_CMD} factory add' to add an account.`);
		}
		process.exit(1);
	}

	// Apply label filter
	const accounts = labelFilter
		? allAccounts.filter(a => a.label === labelFilter)
		: allAccounts;

	if (labelFilter && !accounts.length) {
		const availableLabels = getAllFactoryLabels(allAccounts);
		if (flags.json) {
			console.log(JSON.stringify({
				success: false,
				error: `Factory account "${labelFilter}" not found`,
				availableLabels,
			}, null, 2));
		} else {
			console.error(colorize(`Factory account "${labelFilter}" not found.`, RED));
			if (availableLabels.length) {
				console.error(`Available: ${availableLabels.join(", ")}`);
			}
		}
		process.exit(1);
	}

	// Fetch usage for each account (refresh tokens first)
	const results = [];
	for (const account of accounts) {
		await ensureFreshFactoryToken(account, allAccounts);
		const usage = await fetchFactoryUsage(account, { billingDay });
		results.push({ account, usage });
	}

	// Output
	if (flags.json) {
		const output = results.map(({ account, usage }) => ({
			label: account.label,
			email: account.email ?? null,
			org: account.org ?? null,
			accountId: account.accountId,
			usage: usage.success ? usage.usage : null,
			error: usage.success ? undefined : usage.error,
			source: account.source,
		}));
		console.log(JSON.stringify(output, null, 2));
		return;
	}

	for (const { account, usage } of results) {
		const lines = buildFactoryUsageLines(account, usage, flags);
		const boxLines = drawQuotaBox(lines);
		console.log(boxLines.join("\n"));
	}
}

/**
 * Handle quota subcommand (default behavior)
 * By default, shows Codex, Claude, Factory, Grok, Synthetic, Antigravity, and OpenCode Go accounts
 * @param {string[]} args - Non-flag arguments (e.g., label filter)
 * @param {{ json: boolean, local?: boolean }} flags - Parsed flags
 * @param {"all" | "codex" | "claude" | "factory" | "grok" | "synthetic" | "antigravity" | "opencode-go"} scope
 * Which accounts to show
 */
export async function handleQuota(args, flags, scope = "all") {
	const labelFilter = args[0];
	const localMode = flags.local ?? !flags.native;
	
	// Determine which account types to show:
	// - scope "all": show all (default)
	// - scope "codex": show only Codex
	// - scope "claude": show only Claude
	// - scope "factory": show only Factory
	// - scope "grok": show only Grok
	// - scope "synthetic": show only Synthetic
	// - scope "antigravity": show only Antigravity
	// - scope "opencode-go": show only OpenCode Go
	const showCodex = scope === "all" || scope === "codex";
	const showClaude = scope === "all" || scope === "claude";
	const showFactory = (scope === "all" || scope === "factory") && !flags.noFactory;
	const showGrok = scope === "all" || scope === "grok";
	const showSynthetic = scope === "all" || scope === "synthetic";
	const showAntigravity = scope === "all" || scope === "antigravity";
	const showOpenCodeGo = scope === "all" || scope === "opencode-go";

	// Proxx-backed Codex usage: when PROXX_AUTH_TOKEN is configured, pull Codex
	// usage from the proxx server instead of refreshing local OAuth tokens.
	// Note: proxx is skipped in --local mode since it provides remote accounts.
	const proxxToken = flags.proxxToken ?? process.env.PROXX_AUTH_TOKEN;
	const proxxBaseUrl = flags.proxxBaseUrl ?? process.env.PROXX_BASE_URL ?? process.env.PROXX_URL;
	const useProxxForCodex = showCodex && !localMode && Boolean(proxxToken);

	let proxxResults = null;
	if (useProxxForCodex) {
		const proxxResult = await fetchProxxOpenAiQuota({
			baseUrl: proxxBaseUrl,
			authToken: proxxToken,
			accountId: labelFilter,
		});
		if (proxxResult.success) {
			const accounts = Array.isArray(proxxResult.data?.accounts) ? proxxResult.data.accounts : [];
			proxxResults = { data: proxxResult.data, accounts };
		} else if (!flags.json) {
			console.error(colorize(`Warning: Failed to fetch Codex usage from proxx: ${proxxResult.error}`, YELLOW));
		}
	}

	// Fall back to local Codex accounts when proxx is not configured or failed
	const skipLocalCodex = useProxxForCodex && proxxResults !== null;
	const codexDivergence = showCodex && !localMode && !skipLocalCodex ? detectCodexDivergence({ allowMigration: false }) : null;
	const codexActiveLabel = codexDivergence?.activeLabel ?? null;
	const allAccounts = showCodex && !skipLocalCodex ? loadAllAccounts(codexActiveLabel, { local: localMode }) : [];
	const hasOpenAiAccounts = allAccounts.length > 0 || (proxxResults !== null && proxxResults.accounts.length > 0);
	const claudeDivergence = showClaude && !localMode ? detectClaudeDivergence() : null;

	// Check if we have any accounts to show
	if (!hasOpenAiAccounts && showCodex && !showClaude && !showFactory && !showGrok
		&& !showSynthetic
		&& !showAntigravity
		&& !showOpenCodeGo) {
		if (flags.json) {
			console.log(JSON.stringify({ 
				success: false, 
				error: "No Codex accounts found",
				searchedLocations: [
					"CODEX_ACCOUNTS env var",
					...MULTI_ACCOUNT_PATHS,
					...(!localMode ? [getCodexCliAuthPath()] : []),
					...(proxxBaseUrl ? [`proxx: ${proxxBaseUrl}`] : []),
				],
			}, null, 2));
		} else {
			console.error(colorize("No Codex accounts found.", RED));
			console.error("\nSearched:");
			console.error("  - CODEX_ACCOUNTS env var");
			for (const p of MULTI_ACCOUNT_PATHS) {
				console.error(`  - ${p}`);
			}
			if (!localMode) {
				console.error(`  - ${getCodexCliAuthPath()}`);
			}
			console.error(`\nRun '${PRIMARY_CMD} codex add' to add an account.`);
		}
		process.exit(1);
	}

	let accounts = [];
	if (!skipLocalCodex && hasOpenAiAccounts && showCodex) {
		accounts = labelFilter 
			? allAccounts.filter(a => a.label === labelFilter)
			: allAccounts;
	}

	if (labelFilter && showCodex && !skipLocalCodex && !accounts.length && allAccounts.length > 0) {
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
		if (!localMode) {
			const importResult = await maybeImportClaudeOauthStores({ json: flags.json });
			if (importResult.warnings.length && !flags.json) {
				for (const warning of importResult.warnings) {
					console.error(colorize(`Warning: ${warning}`, YELLOW));
				}
			}
		}
		const wantsClaudeLabel = scope === "claude" && Boolean(labelFilter);
		const oauthAccounts = loadAllClaudeOAuthAccounts({ local: localMode });
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
			} else if (!localMode) {
				const legacyResult = await fetchClaudeUsage();
				if (legacyResult.success || legacyResult.usage) {
					claudeResults = [legacyResult];
				}
			}
		}
	}

	// Load Factory accounts and fetch usage when needed
	let factoryResults = null;
	if (showFactory) {
		const billingDay = flags.billingDay ?? 1;
		const factoryAccounts = loadAllFactoryAccounts();
		const filteredFactoryAccounts = labelFilter && scope === "factory"
			? factoryAccounts.filter(a => a.label === labelFilter)
			: factoryAccounts;

		if (filteredFactoryAccounts.length) {
			factoryResults = [];
			for (const account of filteredFactoryAccounts) {
				await ensureFreshFactoryToken(account, factoryAccounts);
				const usage = await fetchFactoryUsage(account, { billingDay });
				factoryResults.push({ account, usage });
			}
		} else if (scope === "factory" && labelFilter) {
			const availableLabels = getAllFactoryLabels(factoryAccounts);
			if (flags.json) {
				console.log(JSON.stringify({
					success: false,
					error: `Factory account "${labelFilter}" not found`,
					availableLabels,
				}, null, 2));
			} else {
				console.error(colorize(`Factory account "${labelFilter}" not found.`, RED));
				if (availableLabels.length) {
					console.error(`Available: ${availableLabels.join(", ")}`);
				}
			}
			process.exit(1);
		}
	}

	// Load Grok / SuperGrok accounts and fetch weekly credits when needed
	let grokResults = null;
	if (showGrok) {
		const grokAccounts = loadAllGrokAccounts();
		const filteredGrokAccounts = labelFilter && scope === "grok"
			? grokAccounts.filter(a => a.label === labelFilter)
			: grokAccounts;

		if (filteredGrokAccounts.length) {
			grokResults = [];
			for (const account of filteredGrokAccounts) {
				const fresh = await ensureFreshGrokToken(account);
				if (!fresh.ok && !flags.json) {
					console.error(colorize(`Warning: Grok token refresh failed for ${account.label}: ${fresh.error}`, YELLOW));
				}
				await enrichGrokAccountFromUserinfo(account);
				const usage = await fetchGrokUsage(account);
				grokResults.push({ account, usage, refresh: fresh });
			}
		} else if (scope === "grok" && labelFilter) {
			const availableLabels = getAllGrokLabels(grokAccounts);
			if (flags.json) {
				console.log(JSON.stringify({
					success: false,
					error: `Grok account "${labelFilter}" not found`,
					availableLabels,
				}, null, 2));
			} else {
				console.error(colorize(`Grok account "${labelFilter}" not found.`, RED));
				if (availableLabels.length) {
					console.error(`Available: ${availableLabels.join(", ")}`);
				}
			}
			process.exit(1);
		}
	}

	// Synthetic credentials are optional in combined output.
	let syntheticResults = null;
	if (showSynthetic) {
		const syntheticAccounts = await loadAllSyntheticAccounts();
		const filteredSyntheticAccounts = labelFilter && scope === "synthetic"
			? syntheticAccounts.filter(account => account.label === labelFilter)
			: syntheticAccounts;
		if (filteredSyntheticAccounts.length) {
			syntheticResults = await Promise.all(filteredSyntheticAccounts.map(async account => ({
				account,
				usage: await fetchSyntheticUsage(account),
			})));
		}
	}

	let antigravityResults = null;
	if (showAntigravity) {
		const antigravityAccounts = await loadAllAntigravityAccounts();
		const filteredAntigravityAccounts = labelFilter && scope === "antigravity"
			? antigravityAccounts.filter(account => account.label === labelFilter)
			: antigravityAccounts;
		if (filteredAntigravityAccounts.length) {
			antigravityResults = [];
			for (const account of filteredAntigravityAccounts) {
				const fresh = await ensureFreshAntigravityToken(account);
				if (!fresh.ok && !flags.json) {
					console.error(colorize(
						`Warning: Antigravity token refresh failed for ${account.label}: ${fresh.error}`,
						YELLOW,
					));
				}
				const usage = await fetchAntigravityUsage(account);
				antigravityResults.push({ account, usage, refresh: fresh });
			}
		} else if (scope === "antigravity" && labelFilter) {
			const availableLabels = getAllAntigravityLabels(antigravityAccounts);
			if (flags.json) {
				console.log(JSON.stringify({
					success: false,
					error: `Antigravity account "${labelFilter}" not found`,
					availableLabels,
				}, null, 2));
			} else {
				console.error(colorize(`Antigravity account "${labelFilter}" not found.`, RED));
				if (availableLabels.length) {
					console.error(`Available: ${availableLabels.join(", ")}`);
				}
			}
			process.exit(1);
		}
	}

	// Fetch OpenCode Go usage only when dashboard credentials are configured.
	// Missing configuration is optional in combined output; partial configuration
	// is surfaced as a provider error so it cannot fail silently.
	let openCodeGoResults = null;
	if (showOpenCodeGo) {
		const config = resolveOpenCodeGoDashboardConfig();
		if (config.state === "configured") {
			const usage = await fetchOpenCodeGoUsage(config.account);
			openCodeGoResults = [{ account: config.account, usage }];
		} else if (config.state === "incomplete") {
			openCodeGoResults = [{
				account: { label: process.env.OPENCODE_GO_LABEL || "go", source: "dashboard" },
				usage: { success: false, error: config.error },
			}];
		}
	}

	// Check if we have anything to show
	const hasCodexResults = results.length > 0 || (proxxResults !== null && proxxResults.accounts.length > 0);
	const hasClaudeResults = claudeResults && claudeResults.length > 0;
	const hasFactoryResults = factoryResults && factoryResults.length > 0;
	const hasGrokResults = grokResults && grokResults.length > 0;
	const hasSyntheticResults = syntheticResults && syntheticResults.length > 0;
	const hasAntigravityResults = antigravityResults && antigravityResults.length > 0;
	const hasOpenCodeGoResults = openCodeGoResults && openCodeGoResults.length > 0;
	
	if (!hasCodexResults && !hasClaudeResults && !hasFactoryResults && !hasGrokResults
		&& !hasSyntheticResults
		&& !hasAntigravityResults
		&& !hasOpenCodeGoResults) {
		if (flags.json) {
			console.log(JSON.stringify({ 
				success: false, 
				error: "No accounts found",
			}, null, 2));
		} else {
			console.error(colorize("No accounts found.", RED));
			const codexMessage = `Run '${PRIMARY_CMD} codex add' to add a Codex account.`;
			const claudeMessage = `Run '${PRIMARY_CMD} claude add' to add a Claude account.`;
			const factoryMessage = `Run '${PRIMARY_CMD} factory add' to add a Factory account.`;
			const grokMessage = `Sign in with SuperGrok OAuth in pi, OpenCode, or Hermes for Grok quota.`;
			const syntheticMessage = "Set SYNTHETIC_API_KEY or configure Synthetic in shuvcode.";
			const antigravityMessage = "Connect Google AI Pro in shuvcode, or set ANTIGRAVITY_REFRESH.";
			const openCodeGoMessage = "Configure OPENCODE_GO_WORKSPACE_ID and "
				+ "OPENCODE_GO_AUTH_COOKIE for OpenCode Go quota.";
			if (scope === "codex") {
				console.error(`\n${codexMessage}`);
			} else if (scope === "claude") {
				console.error(`\n${claudeMessage}`);
			} else if (scope === "factory") {
				console.error(`\n${factoryMessage}`);
			} else if (scope === "grok") {
				console.error(`\n${grokMessage}`);
			} else if (scope === "synthetic") {
				console.error(`\n${syntheticMessage}`);
			} else if (scope === "antigravity") {
				console.error(`\n${antigravityMessage}`);
			} else if (scope === "opencode-go") {
				console.error(`\n${openCodeGoMessage}`);
			} else {
				console.error(`\n${codexMessage}`);
				console.error(claudeMessage);
				console.error(factoryMessage);
				console.error(grokMessage);
				console.error(syntheticMessage);
				console.error(antigravityMessage);
				console.error(openCodeGoMessage);
			}
		}
		process.exit(1);
	}

	if (flags.json) {
		const localOpenaiOutput = results.map(({ account, usage }) => {
			const profile = extractProfile(account.access);
			const planType = usage?.plan_type ?? profile.planType;
			return {
				label: account.label,
				email: profile.email,
				accountId: account.accountId,
				planType,
				plan: formatCodexPlanLabel(planType, { planOverride: account.planOverride }),
				usage,
				source: account.source,
			};
		});
		const proxxOpenaiOutput = proxxResults ? proxxResults.accounts.map(a => ({
			label: a.displayName ?? a.accountId,
			email: a.email ?? null,
			accountId: a.accountId,
			planType: a.planType ?? null,
			plan: formatCodexPlanLabel(a.planType),
			usage: a,
			source: "proxx",
		})) : [];
		const openaiOutput = [...localOpenaiOutput, ...proxxOpenaiOutput];
		const codexDivergenceInfo = codexDivergence
			? {
				activeLabel: codexDivergence.activeLabel ?? null,
				activeAccountId: codexDivergence.activeAccount?.accountId ?? null,
				activeStorePath: codexDivergence.activeStorePath,
				cliAccountId: codexDivergence.cliAccountId ?? null,
				cliLabel: codexDivergence.cliLabel ?? null,
				diverged: codexDivergence.diverged,
				migrated: codexDivergence.migrated,
			}
			: null;
		const claudeDivergenceInfo = claudeDivergence
			? {
				activeLabel: claudeDivergence.activeLabel ?? null,
				activeStorePath: claudeDivergence.activeStorePath,
				diverged: claudeDivergence.diverged,
				skipped: claudeDivergence.skipped,
				skipReason: claudeDivergence.skipReason,
				stores: claudeDivergence.stores,
			}
			: null;
		const openaiOutputWithDivergence = codexDivergenceInfo
			? openaiOutput.map(item => ({ ...item, divergence: codexDivergenceInfo }))
			: openaiOutput;
		const claudeOutputWithDivergence = claudeDivergenceInfo
			? (claudeResults ?? []).map(item => (
				item && typeof item === "object"
					? { ...item, divergence: claudeDivergenceInfo }
					: item
			))
			: claudeResults ?? [];
		const factoryOutput = (factoryResults ?? []).map(({ account, usage }) => ({
			label: account.label,
			email: account.email ?? null,
			org: account.org ?? null,
			accountId: account.accountId,
			usage: usage.success ? usage.usage : null,
			error: usage.success ? undefined : usage.error,
			source: account.source,
		}));
		const grokOutput = (grokResults ?? []).map(({ account, usage, refresh }) => ({
			label: account.label,
			email: account.email ?? null,
			accountId: account.accountId,
			teamId: account.teamId ?? null,
			tier: account.tier ?? null,
			plan: formatGrokPlanLabel(account.tier, {
				plan: account.plan,
				planType: account.planType,
				planOverride: account.planOverride,
			}),
			planOverride: account.planOverride ?? null,
			usage: usage.success ? usage.usage : null,
			error: usage.success ? undefined : usage.error,
			source: account.source,
			refreshed: Boolean(refresh?.refreshed),
		}));
		const syntheticOutput = (syntheticResults ?? []).map(({ account, usage }) => ({
			label: account.label,
			usage: usage.success ? usage.usage : null,
			error: usage.success ? undefined : usage.error,
			source: account.source,
		}));
		const antigravityOutput = (antigravityResults ?? []).map(({ account, usage, refresh }) => ({
			label: account.label,
			email: account.email ?? null,
			projectId: account.projectId ?? null,
			paidTier: account.paidTier ?? null,
			usage: usage.success ? usage.usage : null,
			error: usage.success ? undefined : usage.error,
			source: account.source,
			refreshed: Boolean(refresh?.refreshed),
		}));
		const openCodeGoOutput = buildOpenCodeGoJsonOutput(openCodeGoResults);
		// Always output both fields when showing both, or just the relevant one
		if (scope === "all") {
			const payload = {
				codex: openaiOutputWithDivergence,
				claude: claudeOutputWithDivergence,
				...(showFactory ? { factory: factoryOutput } : {}),
				grok: grokOutput,
				synthetic: syntheticOutput,
				antigravity: antigravityOutput,
				"opencode-go": openCodeGoOutput,
			};
			payload.divergence = {
				codex: codexDivergenceInfo,
				claude: claudeDivergenceInfo,
			};
			console.log(JSON.stringify(payload, null, 2));
		} else if (showClaude) {
			console.log(JSON.stringify(claudeOutputWithDivergence, null, 2));
		} else if (showFactory) {
			console.log(JSON.stringify(factoryOutput, null, 2));
		} else if (showGrok) {
			console.log(JSON.stringify(grokOutput, null, 2));
		} else if (showSynthetic) {
			console.log(JSON.stringify(syntheticOutput, null, 2));
		} else if (showAntigravity) {
			console.log(JSON.stringify(antigravityOutput, null, 2));
		} else if (showOpenCodeGo) {
			console.log(JSON.stringify(openCodeGoOutput, null, 2));
		} else {
			console.log(JSON.stringify(openaiOutputWithDivergence, null, 2));
		}
		return;
	}

	if (showCodex && codexDivergence?.diverged) {
		const activeLabelDisplay = codexDivergence.activeLabel ?? "(none)";
		const activeIdDisplay = codexDivergence.activeAccount?.accountId ?? "(unknown)";
		const cliLabelDisplay = codexDivergence.cliLabel ?? "(unknown)";
		const cliIdDisplay = codexDivergence.cliAccountId ?? "(unknown)";
		console.error(colorize("Warning: CLI auth diverged from activeLabel", YELLOW));
		console.error(`  Active: ${activeLabelDisplay} (${activeIdDisplay})`);
		console.error(`  CLI:    ${cliLabelDisplay} (${cliIdDisplay})`);
		console.error("");
		console.error(`Run '${PRIMARY_CMD} codex sync' to push active account to CLI.`);
		console.error("");
	}

	if (showClaude && claudeDivergence?.diverged) {
		const activeLabelDisplay = claudeDivergence.activeLabel ?? "(none)";
		const divergedStores = claudeDivergence.stores
			.filter(store => store.considered && store.matches === false)
			.map(store => store.name);
		const storeDisplay = divergedStores.length ? divergedStores.join(", ") : "one or more stores";
		console.error(colorize(`Warning: Claude auth diverged from activeLabel (${activeLabelDisplay})`, YELLOW));
		console.error(`  Diverged stores: ${storeDisplay}`);
		console.error("");
		console.error(`Run '${PRIMARY_CMD} claude sync' to push active account to CLI.`);
		console.error("");
	} else if (showClaude && claudeDivergence?.skipped && claudeDivergence.skipReason === "active-account-not-oauth" && claudeDivergence.activeLabel) {
		console.error("Note: Active Claude account has no OAuth tokens; skipping divergence check.");
		console.error("");
	}

	// Build all box contents first so multi-provider output shares one outer width.
	/** @type {string[][]} */
	const boxContents = [];
	for (const { account, usage } of results) {
		boxContents.push(buildAccountUsageLines(account, usage, flags));
	}
	if (proxxResults) {
		for (const account of proxxResults.accounts) {
			boxContents.push(buildProxxAccountUsageLines(account, flags));
		}
	}
	if (claudeResults) {
		for (const result of claudeResults) {
			boxContents.push(buildClaudeUsageLines(result, flags));
		}
	}
	if (factoryResults) {
		for (const { account, usage } of factoryResults) {
			boxContents.push(buildFactoryUsageLines(account, usage, flags));
		}
	}
	if (grokResults) {
		for (const { account, usage } of grokResults) {
			boxContents.push(buildGrokUsageLines(account, usage, flags));
		}
	}
	if (syntheticResults) {
		for (const { account, usage } of syntheticResults) {
			boxContents.push(buildSyntheticUsageLines(account, usage, flags));
		}
	}
	if (antigravityResults) {
		for (const { account, usage } of antigravityResults) {
			boxContents.push(buildAntigravityUsageLines(account, usage, flags));
		}
	}
	if (openCodeGoResults) {
		for (const { account, usage } of openCodeGoResults) {
			boxContents.push(buildOpenCodeGoUsageLines(account, usage, flags));
		}
	}

	if (flags.compact) {
		for (const lines of boxContents) {
			console.log(lines.join("\n"));
		}
		return;
	}

	const boxWidth = sharedBoxMinWidth(boxContents);
	for (const lines of boxContents) {
		console.log(drawQuotaBox(lines, boxWidth).join("\n"));
	}
}

function buildProxxAccountUsageLines(account, flags = {}) {
	const lines = [];
	const planDisplay = account.planType ? ` (${account.planType})` : "";
	const emailDisplay = formatEmailDisplay(account.email, flags);
	const header = `Proxx${emailDisplay}${planDisplay}`;
	const label = account.displayName ?? account.accountId ?? "unknown";

	if (flags.compact) {
		const parts = [];
		if (account.status === "error") {
			parts.push(header, colorize(`error: ${account.error ?? "Unknown error"}`, RED));
			return [parts.join(" | ")];
		}

		const fiveHour = account.fiveHour;
		if (fiveHour && fiveHour.remainingPercent !== null && fiveHour.remainingPercent !== undefined) {
			const remaining = fiveHour.remainingPercent;
			const reset = fiveHour.resetAfterSeconds ? formatResetTime(fiveHour.resetAfterSeconds, "compact") : "";
			parts.push(colorize(`5h ${String(Math.round(remaining)).padStart(3)}%${reset ? ` ${reset}` : ""}`,
				remaining <= 20 ? RED : remaining <= 60 ? YELLOW : GREEN));
		}

		const weekly = account.weekly;
		if (weekly && weekly.remainingPercent !== null && weekly.remainingPercent !== undefined) {
			const remaining = weekly.remainingPercent;
			const reset = weekly.resetAfterSeconds ? formatResetTime(weekly.resetAfterSeconds, "compact") : "";
			parts.push(colorize(`7d ${String(Math.round(remaining)).padStart(3)}%${reset ? ` ${reset}` : ""}`,
				remaining <= 20 ? RED : remaining <= 60 ? YELLOW : GREEN));
		}

		if (account.rateLimit?.allowed === false) {
			parts.push(colorize("rate-limited", RED));
		}
		parts.push(header);
		return [parts.join(" | ")];
	}

	lines.push(header);
	lines.push("");

	if (account.status === "error") {
		lines.push(`Error: ${account.error ?? "Unknown error"}`);
		return lines;
	}

	// 5h limit
	const fiveHour = account.fiveHour;
	if (fiveHour && fiveHour.remainingPercent !== null && fiveHour.remainingPercent !== undefined) {
		const remaining = fiveHour.remainingPercent;
		const reset = fiveHour.resetAfterSeconds ? formatResetTime(fiveHour.resetAfterSeconds, "inline") : "";
		lines.push(formatQuotaBarLine("5h limit", remaining, reset));
	}

	// Weekly limit
	const weekly = account.weekly;
	if (weekly && weekly.remainingPercent !== null && weekly.remainingPercent !== undefined) {
		const remaining = weekly.remainingPercent;
		const reset = weekly.resetAfterSeconds ? formatResetTime(weekly.resetAfterSeconds, "inline") : "";
		lines.push(formatQuotaBarLine("Weekly limit", remaining, reset));
	}

	// Rate limit info
	const rateLimit = account.rateLimit;
	if (rateLimit && rateLimit.allowed === false) {
		lines.push(colorize("  Rate limited", RED));
	}

	lines.push(`  Account: ${label}`);
	if (account.chatgptAccountId) {
		lines.push(`  Workspace: ${account.chatgptAccountId}`);
	}

	return lines;
}

export async function handleProxx(args, flags) {
	const subcommand = args[0];
	const subArgs = args.slice(1);
	if (!subcommand || subcommand === "quota") {
		// Respect --local flag: skip proxx (remote) accounts when local mode is set
		const localMode = flags.local ?? !flags.native;
		if (localMode) {
			if (flags.json) {
				console.log(JSON.stringify({ accounts: [], local: true, note: "Proxx accounts are remote and excluded in --local mode" }, null, 2));
			} else {
				console.log("No proxx accounts shown (remote accounts excluded in --local mode).");
			}
			return;
		}
		await handleProxxQuota(subcommand === "quota" ? subArgs : args, flags);
		return;
	}
	if (subcommand === "help") {
		printHelpProxx();
		return;
	}
	console.error(colorize(`Unknown proxx command: ${subcommand}`, RED));
	printHelpProxx();
	process.exit(1);
}

export async function handleProxxQuota(args, flags) {
	// Resolve config from flags or env
	const baseUrl = flags.proxxBaseUrl
		?? process.env.PROXX_BASE_URL
		?? process.env.PROXX_URL
		?? "http://localhost:8789";
	const authToken = flags.proxxToken
		?? process.env.PROXX_AUTH_TOKEN
		?? undefined;
	const accountId = args[0] ?? undefined;

	const result = await fetchProxxOpenAiQuota({ baseUrl, authToken, accountId });

	if (!result.success) {
		if (flags.json) {
			console.log(JSON.stringify({ success: false, error: result.error, status: result.status }, null, 2));
		} else {
			console.error(colorize(`Error: ${result.error}`, RED));
			console.error(`\nServer: ${baseUrl}`);
			if (!authToken) {
				console.error("Hint: set PROXX_AUTH_TOKEN or pass --token <token>");
			}
		}
		process.exit(1);
	}

	const accounts = Array.isArray(result.data?.accounts) ? result.data.accounts : [];

	if (!accounts.length) {
		if (flags.json) {
			console.log(JSON.stringify({ success: true, accounts: [] }, null, 2));
		} else {
			console.log("No OpenAI accounts found on the proxx server.");
			console.log(`Server: ${baseUrl}`);
		}
		return;
	}

	if (flags.json) {
		console.log(JSON.stringify(result.data, null, 2));
		return;
	}

	for (const account of accounts) {
		const lines = buildProxxAccountUsageLines(account, flags);
		if (flags.compact) {
			console.log(lines.join("\n"));
		} else {
			const boxLines = drawQuotaBox(lines);
			console.log(boxLines.join("\n"));
		}
	}
}
