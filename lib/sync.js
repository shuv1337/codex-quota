/**
 * Divergence detection, reverse-sync, fresher-store resolution.
 * Also includes handleCodexSync and handleClaudeSync since they're tightly
 * coupled with the divergence/sync logic.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	MULTI_ACCOUNT_PATHS,
	CLAUDE_CREDENTIALS_PATH,
	CLAUDE_MULTI_ACCOUNT_PATHS,
	PRIMARY_CMD,
} from "./constants.js";
import { getOpencodeAuthPath, getCodexCliAuthPath, getPiAuthPath } from "./paths.js";
import { extractAccountId, extractProfile } from "./jwt.js";
import {
	isValidAccount,
	findAccountByLabel,
	loadAllAccountsNoDedup,
	readCodexActiveStoreContainer,
	getCodexActiveLabelInfo,
} from "./codex-accounts.js";
import {
	normalizeClaudeAccount,
	isValidClaudeAccount,
	loadClaudeAccounts,
	findClaudeAccountByLabel,
	getClaudeLabels,
	readClaudeActiveStoreContainer,
	getClaudeActiveLabelInfo,
	findClaudeSessionKey,
	loadClaudeAccountsFromFile,
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
	refreshClaudeToken,
	normalizeClaudeOauthEntryTokens,
	updateClaudeOauthEntry,
} from "./claude-tokens.js";
import { isOauthTokenMatch, normalizeEntryTokens, OPENAI_TOKEN_FIELDS } from "./token-match.js";
import { readMultiAccountContainer, writeMultiAccountContainer, mapContainerAccounts } from "./container.js";
import { writeFileAtomic } from "./fs.js";
import { shortenPath, drawBox, formatExpiryStatus } from "./display.js";
import { GREEN, YELLOW, RED, colorize } from "./color.js";
import { promptConfirm, promptInput } from "./prompts.js";

// Internal helper
function normalizeOpenAiOauthEntryTokens(entry) {
	return normalizeEntryTokens(entry, OPENAI_TOKEN_FIELDS);
}

export function readCodexCliAuth() {
	const path = getCodexCliAuthPath();
	if (!existsSync(path)) {
		return {
			path,
			exists: false,
			parsed: null,
			tokens: null,
			accountId: null,
			trackedLabel: null,
		};
	}

	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		const tokens = parsed?.tokens && typeof parsed.tokens === "object" && !Array.isArray(parsed.tokens)
			? parsed.tokens
			: null;
		const accountId = resolveCodexCliAccountId(tokens);
		const trackedLabel = typeof parsed?.codex_quota_label === "string" ? parsed.codex_quota_label : null;
		return {
			path,
			exists: true,
			parsed,
			tokens,
			accountId,
			trackedLabel,
		};
	} catch (err) {
		return {
			path,
			exists: true,
			parsed: null,
			tokens: null,
			accountId: null,
			trackedLabel: null,
			error: err?.message ?? String(err),
		};
	}
}

/**
 * Resolve a Codex CLI accountId from the tokens object.
 * Prefers tokens.account_id and falls back to decoding the access token.
 * @param {Record<string, unknown> | null} tokens
 * @returns {string | null}
 */
export function resolveCodexCliAccountId(tokens) {
	if (!tokens) return null;
	const direct = tokens.account_id ?? tokens.accountId ?? null;
	if (typeof direct === "string" && direct) {
		return direct;
	}
	const accessToken = tokens.access_token ?? tokens.accessToken ?? null;
	if (typeof accessToken === "string" && accessToken) {
		return extractAccountId(accessToken);
	}
	return null;
}

/**
 * Normalize a Codex account entry from a multi-account file.
 * @param {unknown} entry - Raw account entry
 * @param {string} source - Source path
 * @returns {{ label: string, accountId: string, access: string, refresh: string, expires?: number, idToken?: string, source: string } | null}
 */
export function normalizeCodexAccountEntry(entry, source) {
	if (!entry || typeof entry !== "object") return null;
	const label = entry.label ?? null;
	const accountId = entry.accountId ?? entry.account_id ?? null;
	const access = entry.access ?? entry.access_token ?? null;
	const refresh = entry.refresh ?? entry.refresh_token ?? null;
	const expires = entry.expires ?? entry.expires_at ?? null;
	const idToken = entry.idToken ?? entry.id_token ?? null;
	const normalized = {
		...entry,
		label,
		accountId,
		access,
		refresh,
		expires,
		idToken,
		source,
	};
	return isValidAccount(normalized) ? normalized : null;
}

/**
 * Find a Codex account by label using no-dedup file-only resolution.
 * This avoids email-based deduplication dropping valid labels.
 * @param {string} label
 * @returns {{ label: string, accountId: string, access: string, refresh: string, expires?: number, idToken?: string, source: string } | null}
 */
export function findCodexAccountByLabelInFiles(label) {
	for (const path of MULTI_ACCOUNT_PATHS) {
		if (!existsSync(path)) continue;
		const container = readMultiAccountContainer(path);
		if (container.rootType === "invalid") continue;
		for (const entry of container.accounts) {
			const normalized = normalizeCodexAccountEntry(entry, path);
			if (normalized?.label === label) {
				return normalized;
			}
		}
	}
	return null;
}

/**
 * Find a Codex account by accountId using file-only resolution.
 * @param {string | null} accountId
 * @returns {{ label: string, accountId: string, source: string } | null}
 */
export function findCodexAccountByAccountIdInFiles(accountId) {
	if (!accountId) return null;
	for (const path of MULTI_ACCOUNT_PATHS) {
		if (!existsSync(path)) continue;
		const container = readMultiAccountContainer(path);
		if (container.rootType === "invalid") continue;
		for (const entry of container.accounts) {
			if (!entry || typeof entry !== "object") continue;
			const entryAccountId = entry.accountId ?? entry.account_id ?? null;
			if (entryAccountId === accountId && typeof entry.label === "string") {
				return { label: entry.label, accountId, source: path };
			}
		}
	}
	return null;
}

/**
 * Check whether we have any Codex multi-account file available.
 * @returns {boolean}
 */
export function hasCodexMultiAccountStore() {
	return MULTI_ACCOUNT_PATHS.some(path => existsSync(path));
}

/**
 * Update Codex activeLabel in the source-of-truth container.
 * Active label is stored only in the first existing multi-account file.
 * If no multi-account file exists, creates one at the default path.
 * @param {string | null} activeLabel
 * @returns {{ updated: boolean, path: string | null, created?: boolean }}
 */
export function setCodexActiveLabel(activeLabel) {
	const created = !hasCodexMultiAccountStore();
	const { path, container } = readCodexActiveStoreContainer();
	writeMultiAccountContainer(path, container, container.accounts, { activeLabel }, { mode: 0o600 });
	return { updated: true, path, created };
}

/**
 * Update Claude activeLabel in the source-of-truth container.
 * @param {string | null} activeLabel
 * @returns {{ updated: boolean, path: string | null, skipped?: boolean }}
 */
export function setClaudeActiveLabel(activeLabel) {
	if (!CLAUDE_MULTI_ACCOUNT_PATHS.some(path => existsSync(path))) {
		return { updated: false, path: null, skipped: true };
	}
	const { path, container } = readClaudeActiveStoreContainer();
	writeMultiAccountContainer(path, container, container.accounts, { activeLabel }, { mode: 0o600 });
	return { updated: true, path };
}

/**
 * Clear codex_quota_label when it matches the removed account and accountId guard passes.
 * @param {{ label: string, accountId: string }} account
 * @returns {{ updated: boolean, path: string | null, skipped?: boolean, reason?: string }}
 */
export function clearCodexQuotaLabelForRemovedAccount(account) {
	const cliAuth = readCodexCliAuth();
	if (!cliAuth.exists || !cliAuth.parsed) {
		return { updated: false, path: null, skipped: true, reason: "auth-missing" };
	}
	if (!cliAuth.trackedLabel || cliAuth.trackedLabel !== account.label) {
		return { updated: false, path: cliAuth.path, skipped: true, reason: "label-mismatch" };
	}
	if (!cliAuth.accountId || cliAuth.accountId !== account.accountId) {
		return { updated: false, path: cliAuth.path, skipped: true, reason: "account-id-mismatch" };
	}
	const updatedPayload = { ...cliAuth.parsed };
	delete updatedPayload.codex_quota_label;
	writeFileAtomic(cliAuth.path, JSON.stringify(updatedPayload, null, 2) + "\n", { mode: 0o600 });
	return { updated: true, path: cliAuth.path };
}

/**
 * Guarded migration: promote codex_quota_label to activeLabel when accountId matches.
 * @param {{ path: string, container: ReturnType<typeof readMultiAccountContainer> }} activeStore
 * @param {ReturnType<typeof readCodexCliAuth>} cliAuth
 * @returns {{ migrated: boolean, activeLabel: string | null }}
 */
export function maybeMigrateCodexQuotaLabelToActiveLabel(activeStore, cliAuth) {
	const currentActiveLabel = activeStore.container.activeLabel ?? null;
	if (currentActiveLabel) {
		return { migrated: false, activeLabel: currentActiveLabel };
	}
	const trackedLabel = cliAuth.trackedLabel ?? null;
	const cliAccountId = cliAuth.accountId ?? null;
	if (!trackedLabel || !cliAccountId) {
		return { migrated: false, activeLabel: null };
	}
	// Search all sources (env, files, codex-cli auth) not just multi-account files
	const trackedAccount = findAccountByLabel(trackedLabel);
	if (!trackedAccount) {
		return { migrated: false, activeLabel: null };
	}
	if (trackedAccount.accountId !== cliAccountId) {
		return { migrated: false, activeLabel: null };
	}
	writeMultiAccountContainer(
		activeStore.path,
		activeStore.container,
		activeStore.container.accounts,
		{ activeLabel: trackedLabel },
		{ mode: 0o600 },
	);
	return { migrated: true, activeLabel: trackedLabel };
}

/**
 * Detect whether Codex CLI auth diverged from activeLabel.
 * @param {{ allowMigration?: boolean }} [options]
 * @returns {{
 * 	activeLabel: string | null,
 * 	activeAccount: ReturnType<typeof findCodexAccountByLabelInFiles> | null,
 * 	activeStorePath: string,
 * 	cliAccountId: string | null,
 * 	cliLabel: string | null,
 * 	diverged: boolean,
 * 	migrated: boolean,
 * }}
 */
export function detectCodexDivergence(options = {}) {
	const allowMigration = options.allowMigration !== false;
	const activeStore = readCodexActiveStoreContainer();
	const cliAuth = readCodexCliAuth();
	const migration = allowMigration
		? maybeMigrateCodexQuotaLabelToActiveLabel(activeStore, cliAuth)
		: { migrated: false, activeLabel: activeStore.container.activeLabel ?? null };
	if (!allowMigration && !migration.activeLabel) {
		const trackedLabel = cliAuth.trackedLabel ?? null;
		const cliAccountId = cliAuth.accountId ?? null;
		if (trackedLabel && cliAccountId) {
			// Search all sources (env, files, codex-cli auth) not just multi-account files
			const trackedAccount = findAccountByLabel(trackedLabel);
			if (trackedAccount && trackedAccount.accountId === cliAccountId) {
				migration.activeLabel = trackedLabel;
			}
		}
	}
	const activeLabel = migration.activeLabel ?? activeStore.container.activeLabel ?? null;
	// Search all sources (env, files, codex-cli auth) not just multi-account files
	const activeAccount = activeLabel ? findAccountByLabel(activeLabel) : null;
	const activeAccountId = activeAccount?.accountId ?? null;
	const cliAccountId = cliAuth.accountId ?? null;
	const cliMatch = findCodexAccountByAccountIdInFiles(cliAccountId);
	const cliLabel = cliMatch?.label ?? null;
	const diverged = Boolean(activeAccountId && cliAccountId && activeAccountId !== cliAccountId);
	return {
		activeLabel,
		activeAccount,
		activeStorePath: activeStore.path,
		cliAccountId,
		cliLabel,
		diverged,
		migrated: migration.migrated,
	};
}

/**
 * Find the active Claude account in the source-of-truth file.
 * @returns {{ activeLabel: string | null, account: ReturnType<typeof normalizeClaudeAccount> | null, path: string }}
 */
export function getActiveClaudeAccountFromStore() {
	const { path, container } = readClaudeActiveStoreContainer();
	const activeLabel = container.activeLabel ?? null;
	if (!activeLabel) {
		return { activeLabel: null, account: null, path };
	}
	if (container.rootType === "invalid") {
		return { activeLabel, account: null, path };
	}
	for (const entry of container.accounts) {
		if (!entry || typeof entry !== "object") continue;
		if (entry.label !== activeLabel) continue;
		const normalized = normalizeClaudeAccount(entry, path);
		if (normalized && isValidClaudeAccount(normalized)) {
			return { activeLabel, account: normalized, path };
		}
	}
	return { activeLabel, account: null, path };
}

/**
 * Read Claude OAuth tokens from Claude Code credentials.
 * @returns {{ name: string, path: string, exists: boolean, tokens: ReturnType<typeof normalizeClaudeOauthEntryTokens> | null }}
 */
export function readClaudeCodeOauthStore() {
	const path = process.env.CLAUDE_CREDENTIALS_PATH || CLAUDE_CREDENTIALS_PATH;
	if (!existsSync(path)) {
		return { name: "claude-code", path, exists: false, tokens: null };
	}
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		const oauth = parsed?.claudeAiOauth ?? parsed?.claude_ai_oauth ?? {};
		return { name: "claude-code", path, exists: true, tokens: normalizeClaudeOauthEntryTokens(oauth) };
	} catch {
		return { name: "claude-code", path, exists: true, tokens: null };
	}
}

/**
 * Read Claude OAuth tokens from OpenCode auth.json.
 * @returns {{ name: string, path: string, exists: boolean, tokens: ReturnType<typeof normalizeClaudeOauthEntryTokens> | null }}
 */
export function readOpencodeClaudeOauthStore() {
	const path = getOpencodeAuthPath();
	if (!existsSync(path)) {
		return { name: "opencode", path, exists: false, tokens: null };
	}
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		return { name: "opencode", path, exists: true, tokens: normalizeClaudeOauthEntryTokens(parsed?.anthropic ?? {}) };
	} catch {
		return { name: "opencode", path, exists: true, tokens: null };
	}
}

/**
 * Read Claude OAuth tokens from pi auth.json.
 * @returns {{ name: string, path: string, exists: boolean, tokens: ReturnType<typeof normalizeClaudeOauthEntryTokens> | null }}
 */
export function readPiClaudeOauthStore() {
	const path = getPiAuthPath();
	if (!existsSync(path)) {
		return { name: "pi", path, exists: false, tokens: null };
	}
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		return { name: "pi", path, exists: true, tokens: normalizeClaudeOauthEntryTokens(parsed?.anthropic ?? {}) };
	} catch {
		return { name: "pi", path, exists: true, tokens: null };
	}
}

/**
 * Compare Claude OAuth tokens, preferring refresh-token matching.
 * @param {{ oauthToken?: string | null, oauthRefreshToken?: string | null }} activeAccount
 * @param {ReturnType<typeof normalizeClaudeOauthEntryTokens> | null} storeTokens
 * @returns {{ considered: boolean, matches: boolean | null, method: "refresh" | "access" | null }}
 */
export function compareClaudeOauthTokens(activeAccount, storeTokens) {
	if (!storeTokens) {
		return { considered: false, matches: null, method: null };
	}
	const activeRefresh = activeAccount.oauthRefreshToken ?? null;
	const storeRefresh = storeTokens.refresh ?? null;
	if (activeRefresh && storeRefresh) {
		return {
			considered: true,
			matches: activeRefresh === storeRefresh,
			method: "refresh",
		};
	}
	const activeAccess = activeAccount.oauthToken ?? null;
	const storeAccess = storeTokens.access ?? null;
	if (activeAccess && storeAccess) {
		return {
			considered: true,
			matches: activeAccess === storeAccess,
			method: "access",
		};
	}
	return { considered: false, matches: null, method: null };
}

/**
 * Detect whether Claude CLI auth stores diverged from activeLabel.
 * Uses token matching and degrades gracefully when OAuth tokens are absent.
 * @returns {{
 * 	activeLabel: string | null,
 * 	activeAccount: ReturnType<typeof normalizeClaudeAccount> | null,
 * 	activeStorePath: string,
 * 	diverged: boolean,
 * 	skipped: boolean,
 * 	skipReason: string | null,
 * 	stores: Array<{ name: string, path: string, exists: boolean, considered: boolean, matches: boolean | null, method: string | null }>,
 * }}
 */
export function detectClaudeDivergence() {
	const active = getActiveClaudeAccountFromStore();
	const activeLabel = active.activeLabel ?? null;
	const activeAccount = active.account ?? null;
	if (!activeLabel) {
		return {
			activeLabel: null,
			activeAccount: null,
			activeStorePath: active.path,
			diverged: false,
			skipped: true,
			skipReason: "no-active-label",
			stores: [],
		};
	}
	if (!activeAccount) {
		return {
			activeLabel,
			activeAccount: null,
			activeStorePath: active.path,
			diverged: false,
			skipped: true,
			skipReason: "active-account-missing",
			stores: [],
		};
	}
	if (!activeAccount.oauthToken) {
		return {
			activeLabel,
			activeAccount,
			activeStorePath: active.path,
			diverged: false,
			skipped: true,
			skipReason: "active-account-not-oauth",
			stores: [],
		};
	}

	const stores = [
		readClaudeCodeOauthStore(),
		readOpencodeClaudeOauthStore(),
		readPiClaudeOauthStore(),
	].map(store => {
		const comparison = compareClaudeOauthTokens(activeAccount, store.tokens);
		return {
			name: store.name,
			path: store.path,
			exists: store.exists,
			considered: comparison.considered,
			matches: comparison.matches,
			method: comparison.method,
		};
	});
	const diverged = stores.some(store => store.considered && store.matches === false);
	return {
		activeLabel,
		activeAccount,
		activeStorePath: active.path,
		diverged,
		skipped: false,
		skipReason: null,
		stores,
	};
}

export function isLikelyValidClaudeOauthTokens(tokens) {
	if (!tokens?.access) return false;
	if (typeof tokens.expires === "number" && tokens.expires <= Date.now()) return false;
	return true;
}

export function isClaudeOauthTokenEquivalent(storeTokens, account) {
	if (!storeTokens || !account) return false;
	const storeRefresh = storeTokens.refresh ?? null;
	const storeAccess = storeTokens.access ?? null;
	const accountRefresh = account.oauthRefreshToken ?? null;
	const accountAccess = account.oauthToken ?? null;
	if (storeRefresh && accountRefresh) return storeRefresh === accountRefresh;
	if (storeAccess && accountAccess) return storeAccess === accountAccess;
	return false;
}

/**
 * Find Claude OAuth tokens in OpenCode/pi that are not present in managed accounts.
 * @param {Array<ReturnType<typeof normalizeClaudeAccount>>} managedAccounts
 * @returns {Array<{ name: string, path: string, tokens: ReturnType<typeof normalizeClaudeOauthEntryTokens> }>}
 */
export function findUntrackedClaudeOauthStores(managedAccounts) {
	const trackedAccounts = Array.isArray(managedAccounts) ? managedAccounts : [];
	const stores = [
		readOpencodeClaudeOauthStore(),
		readPiClaudeOauthStore(),
	];
	const untracked = [];

	for (const store of stores) {
		if (!store.exists || !store.tokens) continue;
		if (!isLikelyValidClaudeOauthTokens(store.tokens)) continue;
		const matches = trackedAccounts.some(account => isClaudeOauthTokenEquivalent(store.tokens, account));
		if (!matches) {
			untracked.push({
				name: store.name,
				path: store.path,
				tokens: store.tokens,
			});
		}
	}

	return untracked;
}

export async function maybeImportClaudeOauthStores(options = {}) {
	const json = Boolean(options.json);
	const result = {
		updated: false,
		warnings: [],
	};
	if (json) return result;
	if (!process.stdin.isTTY || !process.stdout.isTTY) return result;

	const { path: targetPath, container } = readClaudeActiveStoreContainer();
	if (container.rootType === "invalid") {
		result.warnings.push(`Invalid Claude accounts file at ${targetPath}`);
		return result;
	}
	if (container.rootType === "missing") {
		container.accounts = [];
	}

	let managedAccounts = container.accounts
		.map(entry => normalizeClaudeAccount(entry, targetPath))
		.filter(account => account && isValidClaudeAccount(account));
	const existingLabels = new Set(managedAccounts.map(account => account.label));
	const untrackedStores = findUntrackedClaudeOauthStores(managedAccounts);

	if (!untrackedStores.length) return result;

	for (const store of untrackedStores) {
		console.error(
			`Detected Claude OAuth token in ${store.name} (${shortenPath(store.path)}) `
				+ `not saved in ${shortenPath(targetPath)}.`
		);

		if (!managedAccounts.length) {
			console.error("No managed Claude accounts found to merge into.");
		}
		console.error("Choose how to record it:");
		console.error("  [1] Add as new account");
		console.error("  [2] Merge into existing account");
		console.error("  [3] Skip\n");
		const choice = (await promptInput("Enter choice (1, 2, or 3): ")).trim();

		if (choice === "2" && managedAccounts.length) {
			console.error(`Existing labels: ${managedAccounts.map(a => a.label).join(", ")}`);
			const mergeLabel = (await promptInput("Merge into label: ")).trim();
			if (!mergeLabel || !existingLabels.has(mergeLabel)) {
				console.error(colorize(`Skipping: label "${mergeLabel}" not found.`, YELLOW));
				continue;
			}
			const mapped = mapContainerAccounts(container, (entry) => {
				if (!entry || typeof entry !== "object") return entry;
				if (entry.label !== mergeLabel) return entry;
				return updateClaudeOauthEntry({ ...entry }, {
					accessToken: store.tokens.access,
					refreshToken: store.tokens.refresh,
					expiresAt: store.tokens.expires,
					scopes: store.tokens.scopes,
				});
			});
			if (mapped.updated) {
				container.accounts = mapped.accounts;
				result.updated = true;
				managedAccounts = container.accounts
					.map(entry => normalizeClaudeAccount(entry, targetPath))
					.filter(account => account && isValidClaudeAccount(account));
				console.error(colorize(`Merged OAuth token into "${mergeLabel}".`, GREEN));
			} else {
				console.error(colorize(`No changes applied to "${mergeLabel}".`, YELLOW));
			}
			continue;
		}

		if (choice === "1" || (choice === "2" && !managedAccounts.length)) {
			const label = (await promptInput("New label: ")).trim();
			if (!label) {
				console.error(colorize("Skipping: label is required.", YELLOW));
				continue;
			}
			if (!/^[a-zA-Z0-9_-]+$/.test(label)) {
				console.error(colorize(`Skipping: invalid label "${label}".`, YELLOW));
				continue;
			}
			if (existingLabels.has(label)) {
				console.error(colorize(`Skipping: label "${label}" already exists.`, YELLOW));
				continue;
			}
			const newAccount = {
				label,
				sessionKey: null,
				oauthToken: store.tokens.access,
				oauthRefreshToken: store.tokens.refresh ?? null,
				oauthExpiresAt: store.tokens.expires ?? null,
				oauthScopes: store.tokens.scopes ?? null,
				cfClearance: null,
				orgId: null,
			};
			container.accounts.push(newAccount);
			managedAccounts.push(normalizeClaudeAccount(newAccount, targetPath));
			existingLabels.add(label);
			result.updated = true;
			console.error(colorize(`Added Claude account "${label}".`, GREEN));
			continue;
		}

		console.error("Skipping import.");
	}

	if (result.updated) {
		writeMultiAccountContainer(targetPath, container, container.accounts, {}, { mode: 0o600 });
	}

	return result;
}

export function readOpencodeOpenAiOauthStore() {
	const path = getOpencodeAuthPath();
	if (!existsSync(path)) {
		return { name: "opencode", path, exists: false, tokens: null };
	}
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		const openai = parsed?.openai ?? {};
		return { name: "opencode", path, exists: true, tokens: normalizeOpenAiOauthEntryTokens(openai) };
	} catch {
		return { name: "opencode", path, exists: true, tokens: null };
	}
}

/**
 * Read OpenAI OAuth tokens from pi auth.json (openai-codex section).
 * @returns {{ name: string, path: string, exists: boolean, tokens: ReturnType<typeof normalizeOpenAiOauthEntryTokens> | null }}
 */
export function readPiOpenAiOauthStore() {
	const path = getPiAuthPath();
	if (!existsSync(path)) {
		return { name: "pi", path, exists: false, tokens: null };
	}
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		const codex = parsed?.["openai-codex"] ?? {};
		return { name: "pi", path, exists: true, tokens: normalizeOpenAiOauthEntryTokens(codex) };
	} catch {
		return { name: "pi", path, exists: true, tokens: null };
	}
}

/**
 * Read OpenAI OAuth tokens from Codex CLI auth.json.
 * @returns {{ name: string, path: string, exists: boolean, tokens: ReturnType<typeof normalizeOpenAiOauthEntryTokens> | null }}
 */
export function readCodexCliOpenAiOauthStore() {
	const cliAuth = readCodexCliAuth();
	if (!cliAuth.exists || !cliAuth.tokens) {
		return { name: "codex-cli", path: cliAuth.path, exists: cliAuth.exists, tokens: null };
	}
	// Codex CLI uses access_token/refresh_token/expires_at (seconds) format
	const tokens = {
		access: cliAuth.tokens.access_token ?? null,
		refresh: cliAuth.tokens.refresh_token ?? null,
		// Convert seconds to ms for consistency
		expires: cliAuth.tokens.expires_at ? cliAuth.tokens.expires_at * 1000 : null,
		accountId: cliAuth.tokens.account_id ?? cliAuth.tokens.accountId ?? null,
		idToken: cliAuth.tokens.id_token ?? null,
	};
	return { name: "codex-cli", path: cliAuth.path, exists: true, tokens };
}

/**
 * Find the CLI store with the freshest OpenAI OAuth token for the active account.
 * Matches by refresh token; returns the store with the newest expires (or newest access if expires unavailable).
 * @param {{ refresh: string, expires?: number, access?: string, accountId?: string }} activeAccount
 * @returns {{ fresher: boolean, store: { name: string, path: string, tokens: { access: string, refresh: string, expires: number | null, accountId: string | null, idToken: string | null } } | null }}
 */
export function findFresherOpenAiOAuthStore(activeAccount) {
	const activeRefresh = activeAccount.refresh ?? null;
	const activeExpires = activeAccount.expires ?? 0;
	const activeAccess = activeAccount.access ?? null;

	if (!activeRefresh) {
		return { fresher: false, store: null };
	}

	const stores = [
		readOpencodeOpenAiOauthStore(),
		readPiOpenAiOauthStore(),
		readCodexCliOpenAiOauthStore(),
	];

	let fresherStore = null;
	let fresherExpires = activeExpires;
	let fresherAccess = activeAccess;

	for (const store of stores) {
		if (!store.exists || !store.tokens) continue;
		const storeRefresh = store.tokens.refresh ?? null;
		const storeExpires = store.tokens.expires ?? 0;
		const storeAccess = store.tokens.access ?? null;

		// Must match refresh token
		if (storeRefresh !== activeRefresh) continue;

		// Compare by expires first (if both have it)
		if (storeExpires && fresherExpires) {
			if (storeExpires > fresherExpires) {
				fresherStore = store;
				fresherExpires = storeExpires;
				fresherAccess = storeAccess;
			}
		} else if (storeExpires && !fresherExpires) {
			// Store has expires, active doesn't - store is fresher
			fresherStore = store;
			fresherExpires = storeExpires;
			fresherAccess = storeAccess;
		} else if (storeAccess && storeAccess !== fresherAccess) {
			// Neither has expires - fall back to access token difference
			// Can't determine which is fresher without expires, but if different, prefer store
			// (This is a heuristic: if access tokens differ, assume CLI was refreshed)
			fresherStore = store;
			fresherAccess = storeAccess;
		}
	}

	if (!fresherStore) {
		return { fresher: false, store: null };
	}

	return {
		fresher: true,
		store: {
			name: fresherStore.name,
			path: fresherStore.path,
			tokens: fresherStore.tokens,
		},
	};
}

/**
 * Find the CLI store with the freshest Claude OAuth token for the active account.
 * Matches by refresh token; returns the store with the newest expires (or newest access if expires unavailable).
 * @param {{ oauthRefreshToken?: string | null, oauthExpiresAt?: number | null, oauthToken?: string | null }} activeAccount
 * @returns {{ fresher: boolean, store: { name: string, path: string, tokens: { access: string, refresh: string, expires: number | null, scopes: string[] | null } } | null }}
 */
export function findFresherClaudeOAuthStore(activeAccount) {
	const activeRefresh = activeAccount.oauthRefreshToken ?? null;
	const activeExpires = activeAccount.oauthExpiresAt ?? 0;
	const activeAccess = activeAccount.oauthToken ?? null;

	if (!activeRefresh) {
		return { fresher: false, store: null };
	}

	const stores = [
		readClaudeCodeOauthStore(),
		readOpencodeClaudeOauthStore(),
		readPiClaudeOauthStore(),
	];

	let fresherStore = null;
	let fresherExpires = activeExpires;
	let fresherAccess = activeAccess;

	for (const store of stores) {
		if (!store.exists || !store.tokens) continue;
		const storeRefresh = store.tokens.refresh ?? null;
		const storeExpires = store.tokens.expires ?? 0;
		const storeAccess = store.tokens.access ?? null;

		// Must match refresh token
		if (storeRefresh !== activeRefresh) continue;

		// Compare by expires first (if both have it)
		if (storeExpires && fresherExpires) {
			if (storeExpires > fresherExpires) {
				fresherStore = store;
				fresherExpires = storeExpires;
				fresherAccess = storeAccess;
			}
		} else if (storeExpires && !fresherExpires) {
			// Store has expires, active doesn't - store is fresher
			fresherStore = store;
			fresherExpires = storeExpires;
			fresherAccess = storeAccess;
		} else if (storeAccess && storeAccess !== fresherAccess) {
			// Neither has expires - fall back to access token difference
			fresherStore = store;
			fresherAccess = storeAccess;
		}
	}

	if (!fresherStore) {
		return { fresher: false, store: null };
	}

	return {
		fresher: true,
		store: {
			name: fresherStore.name,
			path: fresherStore.path,
			tokens: fresherStore.tokens,
		},
	};
}

/**
 * Find a consistent Claude OAuth store to recover from when refresh fails.
 * Returns null when CLI stores disagree on token identity.
 * @returns {{ store: { name: string, path: string, tokens: { access: string, refresh: string | null, expires: number | null, scopes: string[] | null } } | null, reason: string | null }}
 */
export function findClaudeOAuthRecoveryStore() {
	const stores = [
		readClaudeCodeOauthStore(),
		readOpencodeClaudeOauthStore(),
		readPiClaudeOauthStore(),
	];
	const candidates = stores.filter(store => store.exists && store.tokens && (store.tokens.access || store.tokens.refresh));
	if (!candidates.length) {
		return { store: null, reason: "no-stores" };
	}
	const fingerprints = new Set();
	for (const store of candidates) {
		const token = store.tokens.refresh ?? store.tokens.access ?? null;
		if (token) fingerprints.add(token);
	}
	if (fingerprints.size > 1) {
		return { store: null, reason: "ambiguous" };
	}
	let bestStore = null;
	let bestExpires = 0;
	for (const store of candidates) {
		const expires = typeof store.tokens.expires === "number" ? store.tokens.expires : 0;
		if (!bestStore || expires > bestExpires) {
			bestStore = store;
			bestExpires = expires;
		}
	}
	if (!bestStore) {
		return { store: null, reason: "no-stores" };
	}
	return {
		store: {
			name: bestStore.name,
			path: bestStore.path,
			tokens: bestStore.tokens,
		},
		reason: null,
	};
}

/**
 * Get the currently active account_id from ~/.codex/auth.json
 * @returns {string | null} Active account ID or null if not found
 */
export function getActiveAccountId() {
	return readCodexCliAuth().accountId ?? null;
}

/**
 * Get detailed info about the currently active account from ~/.codex/auth.json
 * Includes tracked label if set by codex-quota switch command
 * @returns {{ accountId: string | null, trackedLabel: string | null, source: "codex-quota" | "native" | null }}
 */
export function getActiveAccountInfo() {
	const info = readCodexCliAuth();
	if (!info.exists || !info.accountId) {
		return { accountId: null, trackedLabel: info.trackedLabel ?? null, source: null };
	}
	const source = info.trackedLabel ? "codex-quota" : "native";
	return { accountId: info.accountId, trackedLabel: info.trackedLabel ?? null, source };
}

// formatExpiryStatus and shortenPath are imported from ./display.js

/**
 * Handle sync subcommand - bi-directional sync for activeLabel account
 */
export async function handleCodexSync(args, flags) {
	const dryRun = Boolean(flags.dryRun);
	try {
		const divergence = detectCodexDivergence({ allowMigration: !dryRun });
		const activeLabel = divergence.activeLabel ?? null;
		if (!activeLabel) {
			const message = "No activeLabel set. Run 'codex-quota codex switch <label>' first.";
			if (flags.json) {
				console.log(JSON.stringify({ success: false, error: message }, null, 2));
			} else {
				console.error(colorize(`Error: ${message}`, RED));
			}
			process.exit(1);
		}

		let account = divergence.activeAccount ?? findCodexAccountByLabelInFiles(activeLabel);
		if (!account) {
			const message = `Active label "${activeLabel}" could not be resolved in multi-account files.`;
			if (flags.json) {
				console.log(JSON.stringify({ success: false, error: message, activeLabel }, null, 2));
			} else {
				console.error(colorize(`Error: ${message}`, RED));
			}
			process.exit(1);
		}

		const pulledPaths = [];
		const warnings = [];

		// Reverse-sync: check if any CLI store has a fresher token
		const fresherResult = findFresherOpenAiOAuthStore(account);
		if (fresherResult.fresher && fresherResult.store) {
			const fresherStore = fresherResult.store;
			const fresherTokens = fresherStore.tokens;
			if (!dryRun) {
				// Update the account entry in the multi-account file with the fresher token
				const previousTokens = {
					previousAccessToken: account.access,
					previousRefreshToken: account.refresh,
				};
				const updatedAccount = {
					label: account.label,
					access: fresherTokens.access,
					refresh: fresherTokens.refresh,
					expires: fresherTokens.expires,
					accountId: fresherTokens.accountId ?? account.accountId,
					idToken: fresherTokens.idToken ?? account.idToken,
					source: account.source,
				};
				const persistResult = persistOpenAiOAuthTokens(updatedAccount, previousTokens);
				if (persistResult.updatedPaths.length > 0) {
					pulledPaths.push(fresherStore.path);
					// Update the account reference with the fresher tokens for forward push
					account = { ...account, ...updatedAccount };
				}
				if (persistResult.errors.length > 0) {
					warnings.push(...persistResult.errors);
				}
			} else {
				pulledPaths.push(fresherStore.path);
			}
		}

		if (!dryRun) {
			const refreshAccounts = loadAllAccountsNoDedup();
			const tokenOk = await ensureFreshToken(account, refreshAccounts);
			if (!tokenOk) {
				const message = `Failed to refresh token for "${activeLabel}". Re-authentication may be required.`;
				if (flags.json) {
					console.log(JSON.stringify({ success: false, error: message, activeLabel }, null, 2));
				} else {
					console.error(colorize(`Error: ${message}`, RED));
				}
				process.exit(1);
			}
		}

		const profile = extractProfile(account.access);
		const email = profile.email ?? null;
		const updatedPaths = [];
		const skippedPaths = [];

		const codexAuthPath = getCodexCliAuthPath();
		if (dryRun) {
			updatedPaths.push(codexAuthPath);
		} else {
			let existingAuth = {};
			if (existsSync(codexAuthPath)) {
				try {
					const raw = readFileSync(codexAuthPath, "utf-8");
					const parsed = JSON.parse(raw);
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
						existingAuth = parsed;
					}
				} catch {
					existingAuth = {};
				}
			}
			const existingTokens = existingAuth.tokens && typeof existingAuth.tokens === "object" && !Array.isArray(existingAuth.tokens)
				? existingAuth.tokens
				: {};
			const expiresAt = Math.floor(((account.expires ?? (Date.now() - 1000)) / 1000));
			const updatedTokens = {
				...existingTokens,
				access_token: account.access,
				refresh_token: account.refresh,
				account_id: account.accountId,
				expires_at: expiresAt,
			};
			if (account.idToken) {
				updatedTokens.id_token = account.idToken;
			} else if ("id_token" in updatedTokens) {
				delete updatedTokens.id_token;
			}
			const updatedAuth = {
				...existingAuth,
				tokens: updatedTokens,
				last_refresh: new Date().toISOString(),
				codex_quota_label: activeLabel,
			};
			writeFileAtomic(codexAuthPath, JSON.stringify(updatedAuth, null, 2) + "\n", { mode: 0o600 });
			updatedPaths.push(codexAuthPath);
		}

		const opencodePath = getOpencodeAuthPath();
		if (existsSync(opencodePath)) {
			if (dryRun) {
				updatedPaths.push(opencodePath);
			} else {
				const result = updateOpencodeAuth(account);
				if (result.updated) {
					updatedPaths.push(result.path);
				} else if (result.error) {
					warnings.push(result.error);
				}
			}
		} else {
			skippedPaths.push(opencodePath);
		}

		const piPath = getPiAuthPath();
		if (existsSync(piPath)) {
			if (dryRun) {
				updatedPaths.push(piPath);
			} else {
				const result = updatePiAuth(account);
				if (result.updated) {
					updatedPaths.push(result.path);
				} else if (result.error) {
					warnings.push(result.error);
				}
			}
		} else {
			skippedPaths.push(piPath);
		}

		if (flags.json) {
			console.log(JSON.stringify({
				success: true,
				dryRun,
				activeLabel,
				email,
				accountId: account.accountId,
				pulled: pulledPaths,
				updated: updatedPaths,
				skipped: skippedPaths,
				warnings,
			}, null, 2));
			return;
		}

		const emailDisplay = email ? ` <${email}>` : "";
		const lines = [
			`Syncing active account: ${activeLabel}${emailDisplay}`,
			"",
		];
		if (dryRun) {
			lines.push("Dry run: no files were written.");
			lines.push("");
		}
		if (pulledPaths.length) {
			lines.push("Pulled fresher token from:");
			for (const path of pulledPaths) {
				lines.push(`  ${shortenPath(path)}`);
			}
			lines.push("");
		}
		lines.push("Updated:");
		if (updatedPaths.length) {
			for (const path of updatedPaths) {
				lines.push(`  ${shortenPath(path)}`);
			}
		} else {
			lines.push("  (none)");
		}
		lines.push("");
		lines.push("Skipped (not found):");
		if (skippedPaths.length) {
			for (const path of skippedPaths) {
				lines.push(`  ${shortenPath(path)}`);
			}
		} else {
			lines.push("  (none)");
		}
		const boxLines = drawBox(lines);
		console.log(boxLines.join("\n"));
		for (const warning of warnings) {
			console.error(colorize(`Warning: ${warning}`, YELLOW));
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

export async function handleClaudeSync(args, flags) {
	const dryRun = Boolean(flags.dryRun);
	try {
		const active = getActiveClaudeAccountFromStore();
		const activeLabel = active.activeLabel ?? null;
		if (!activeLabel) {
			const message = "No activeLabel set. Run 'codex-quota claude switch <label>' first.";
			if (flags.json) {
				console.log(JSON.stringify({ success: false, error: message }, null, 2));
			} else {
				console.error(colorize(`Error: ${message}`, RED));
			}
			process.exit(1);
		}
		let account = active.account;
		if (!account) {
			const message = `Active label "${activeLabel}" could not be resolved in ~/.claude-accounts.json.`;
			if (flags.json) {
				console.log(JSON.stringify({ success: false, error: message, activeLabel }, null, 2));
			} else {
				console.error(colorize(`Error: ${message}`, RED));
			}
			process.exit(1);
		}
		if (!account.oauthToken) {
			const warning = "Active Claude account has no OAuth tokens; nothing to sync.";
			if (flags.json) {
				console.log(JSON.stringify({
					success: true,
					dryRun,
					activeLabel,
					pulled: [],
					updated: [],
					skipped: [],
					warnings: [warning],
				}, null, 2));
			} else {
				console.error(warning);
			}
			return;
		}

		const pulledPaths = [];
		const warnings = [];

		// Reverse-sync: check if any CLI store has a fresher token
		const fresherResult = findFresherClaudeOAuthStore(account);
		if (fresherResult.fresher && fresherResult.store) {
			const fresherStore = fresherResult.store;
			const fresherTokens = fresherStore.tokens;
			if (!dryRun) {
				// Update the account entry in the multi-account file with the fresher token
				const previousTokens = {
					previousAccessToken: account.oauthToken,
					previousRefreshToken: account.oauthRefreshToken,
				};
				const updatedAccount = {
					label: account.label,
					accessToken: fresherTokens.access,
					refreshToken: fresherTokens.refresh,
					expiresAt: fresherTokens.expires,
					scopes: fresherTokens.scopes ?? account.oauthScopes,
					source: account.source,
				};
				const persistResult = persistClaudeOAuthTokens(updatedAccount, previousTokens);
				if (persistResult.updatedPaths.length > 0) {
					pulledPaths.push(fresherStore.path);
					// Update the account reference with the fresher tokens for forward push
					account = {
						...account,
						oauthToken: fresherTokens.access,
						oauthRefreshToken: fresherTokens.refresh,
						oauthExpiresAt: fresherTokens.expires,
						oauthScopes: fresherTokens.scopes ?? account.oauthScopes,
					};
				}
				if (persistResult.errors.length > 0) {
					warnings.push(...persistResult.errors);
				}
			} else {
				pulledPaths.push(fresherStore.path);
			}
		}

		if (!dryRun) {
			let tokenOk = await ensureFreshClaudeOAuthToken(account);
			if (!tokenOk) {
				const recovery = findClaudeOAuthRecoveryStore();
				const recoveryStore = recovery.store;
				const recoveryTokens = recoveryStore?.tokens ?? null;
				const activeExpires = account.oauthExpiresAt ?? 0;
				const recoveryExpires = recoveryTokens?.expires ?? 0;
				const recoveryIsNewer = Boolean(recoveryExpires && (!activeExpires || recoveryExpires > activeExpires));
				const recoveryHasAccess = Boolean(recoveryTokens?.access);
				let recovered = false;

				if (recoveryStore && recoveryTokens && recoveryHasAccess && (recoveryIsNewer || !activeExpires)) {
					const previousTokens = {
						previousAccessToken: account.oauthToken,
						previousRefreshToken: account.oauthRefreshToken,
					};
					const updatedAccount = {
						label: account.label,
						accessToken: recoveryTokens.access,
						refreshToken: recoveryTokens.refresh,
						expiresAt: recoveryTokens.expires,
						scopes: recoveryTokens.scopes ?? account.oauthScopes,
						source: account.source,
					};
					const persistResult = persistClaudeOAuthTokens(updatedAccount, previousTokens);
					if (persistResult.updatedPaths.length > 0) {
						pulledPaths.push(recoveryStore.path);
						account = {
							...account,
							oauthToken: recoveryTokens.access,
							oauthRefreshToken: recoveryTokens.refresh,
							oauthExpiresAt: recoveryTokens.expires,
							oauthScopes: recoveryTokens.scopes ?? account.oauthScopes,
						};
						recovered = true;
					}
					if (persistResult.errors.length > 0) {
						warnings.push(...persistResult.errors);
					}
					if (recovered) {
						warnings.push(
							`Claude OAuth refresh failed; recovered tokens from ${shortenPath(recoveryStore.path)}.`
						);
					}
				}

				tokenOk = recovered;
				if (!tokenOk) {
					let detail = "";
					if (recovery.reason === "ambiguous") {
						detail = " CLI auth stores disagree; refusing to overwrite.";
					} else if (recovery.reason === "no-stores") {
						detail = " No valid CLI auth stores found.";
					}
					const message = `Failed to refresh Claude OAuth token for "${activeLabel}".${detail}`;
					if (flags.json) {
						console.log(JSON.stringify({ success: false, error: message, activeLabel }, null, 2));
					} else {
						console.error(colorize(`Error: ${message}`, RED));
					}
					process.exit(1);
				}
			}
		}

		const updatedPaths = [];
		const skippedPaths = [];

		const credentialsPath = process.env.CLAUDE_CREDENTIALS_PATH || CLAUDE_CREDENTIALS_PATH;
		if (dryRun) {
			updatedPaths.push(credentialsPath);
		} else {
			const credentialsUpdate = updateClaudeCredentials(account);
			if (credentialsUpdate.error) {
				if (flags.json) {
					console.log(JSON.stringify({ success: false, error: credentialsUpdate.error }, null, 2));
				} else {
					console.error(colorize(`Error: ${credentialsUpdate.error}`, RED));
				}
				process.exit(1);
			}
			updatedPaths.push(credentialsUpdate.path);
		}

		const opencodePath = getOpencodeAuthPath();
		if (existsSync(opencodePath)) {
			if (dryRun) {
				updatedPaths.push(opencodePath);
			} else {
				const result = updateOpencodeClaudeAuth(account);
				if (result.updated) {
					updatedPaths.push(result.path);
				} else if (result.error) {
					warnings.push(result.error);
				}
			}
		} else {
			skippedPaths.push(opencodePath);
		}

		const piPath = getPiAuthPath();
		if (existsSync(piPath)) {
			if (dryRun) {
				updatedPaths.push(piPath);
			} else {
				const result = updatePiClaudeAuth(account);
				if (result.updated) {
					updatedPaths.push(result.path);
				} else if (result.error) {
					warnings.push(result.error);
				}
			}
		} else {
			skippedPaths.push(piPath);
		}

		if (flags.json) {
			console.log(JSON.stringify({
				success: true,
				dryRun,
				activeLabel,
				pulled: pulledPaths,
				updated: updatedPaths,
				skipped: skippedPaths,
				warnings,
			}, null, 2));
			return;
		}

		const lines = [
			`Syncing active account: ${activeLabel}`,
			"",
		];
		if (dryRun) {
			lines.push("Dry run: no files were written.");
			lines.push("");
		}
		if (pulledPaths.length) {
			lines.push("Pulled fresher token from:");
			for (const path of pulledPaths) {
				lines.push(`  ${shortenPath(path)}`);
			}
			lines.push("");
		}
		lines.push("Updated:");
		if (updatedPaths.length) {
			for (const path of updatedPaths) {
				lines.push(`  ${shortenPath(path)}`);
			}
		} else {
			lines.push("  (none)");
		}
		lines.push("");
		lines.push("Skipped (not found):");
		if (skippedPaths.length) {
			for (const path of skippedPaths) {
				lines.push(`  ${shortenPath(path)}`);
			}
		} else {
			lines.push("  (none)");
		}
		console.log(drawBox(lines).join("\n"));
		for (const warning of warnings) {
			console.error(colorize(`Warning: ${warning}`, YELLOW));
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
 * Handle Claude add subcommand - add a Claude credential interactively
 * Supports two authentication methods:
 *   - OAuth browser flow (--oauth): Opens browser for authentication
 *   - Manual entry (--manual): Paste sessionKey/token directly
 * @param {string[]} args - Non-flag arguments (optional label)
 * @param {{ json: boolean, noBrowser: boolean, oauth: boolean, manual: boolean }} flags - Parsed flags
 */
