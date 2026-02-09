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
} from "./constants.js";
import { GREEN, RED, YELLOW, colorize } from "./color.js";
import { getPackageVersion } from "./color.js";
import {
	shortenPath,
	drawBox,
	buildAccountUsageLines,
	buildClaudeUsageLines,
	formatExpiryStatus,
	printHelp,
	printHelpCodex,
	printHelpClaude,
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
	clearCodexQuotaLabelForRemovedAccount,
	maybeImportClaudeOauthStores,
	getActiveClaudeAccountFromStore,
	handleCodexSync,
	handleClaudeSync,
} from "./sync.js";

// Handlers extracted from codex-quota.js
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
				codex_quota_label: label,
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
			codex_quota_label: label,
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
	const codexDivergence = flags.local ? null : detectCodexDivergence({ allowMigration: false });
	const activeLabel = codexDivergence?.activeLabel ?? null;
	const accounts = loadAllAccounts(activeLabel, { local: flags.local });
	
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
				local: flags.local ?? false,
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
 * @param {{ json: boolean, local?: boolean }} flags - Parsed flags
 */
export async function handleClaudeList(flags) {
	if (!flags.local) {
		const importResult = await maybeImportClaudeOauthStores({ json: flags.json });
		if (importResult.warnings.length && !flags.json) {
			for (const warning of importResult.warnings) {
				console.error(colorize(`Warning: ${warning}`, YELLOW));
			}
		}
	}
	const divergence = flags.local ? null : detectClaudeDivergence();
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
				local: flags.local ?? false,
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
	let codexQuotaLabelCleared = false;
	let codexQuotaClearError = null;
	
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
			const cleared = clearCodexQuotaLabelForRemovedAccount(account);
			codexQuotaLabelCleared = cleared.updated;
		} catch (err) {
			codexQuotaClearError = err?.message ?? String(err);
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
			if (codexQuotaLabelCleared) {
				output.codexQuotaLabelCleared = true;
			}
			if (codexQuotaClearError) {
				output.codexQuotaLabelError = codexQuotaClearError;
			}
			console.log(JSON.stringify(output, null, 2));
			return;
		}

		if (activeLabelClearError) {
			console.error(colorize(`Warning: Failed to clear activeLabel: ${activeLabelClearError}`, YELLOW));
		}
		if (codexQuotaClearError) {
			console.error(colorize(`Warning: Failed to clear codex_quota_label: ${codexQuotaClearError}`, YELLOW));
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
 * @param {{ json: boolean, local?: boolean }} flags - Parsed flags
 * @param {"all" | "codex" | "claude"} scope - Which accounts to show
 */
export async function handleQuota(args, flags, scope = "all") {
	const labelFilter = args[0];
	const localMode = Boolean(flags.local);
	
	// Determine which account types to show:
	// - scope "all": show both (default)
	// - scope "codex": show only Codex
	// - scope "claude": show only Claude
	const showCodex = scope === "all" || scope === "codex";
	const showClaude = scope === "all" || scope === "claude";
	
	const codexDivergence = showCodex && !localMode ? detectCodexDivergence({ allowMigration: false }) : null;
	const codexActiveLabel = codexDivergence?.activeLabel ?? null;
	const allAccounts = showCodex ? loadAllAccounts(codexActiveLabel, { local: localMode }) : [];
	const hasOpenAiAccounts = allAccounts.length > 0;
	const claudeDivergence = showClaude && !localMode ? detectClaudeDivergence() : null;

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
		// Always output both fields when showing both, or just the relevant one
		if (showCodex && showClaude) {
			const payload = {
				codex: openaiOutputWithDivergence,
				claude: claudeOutputWithDivergence,
			};
			payload.divergence = {
				codex: codexDivergenceInfo,
				claude: claudeDivergenceInfo,
			};
			console.log(JSON.stringify(payload, null, 2));
		} else if (showClaude) {
			console.log(JSON.stringify(claudeOutputWithDivergence, null, 2));
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

