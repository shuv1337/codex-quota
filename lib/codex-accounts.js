/**
 * Codex account loading, dedup, active-label resolution.
 * Depends on: lib/constants.js, lib/jwt.js, lib/container.js, lib/paths.js
 */

import { existsSync, readFileSync } from "node:fs";
import { MULTI_ACCOUNT_PATHS } from "./constants.js";
import { extractAccountId, extractProfile } from "./jwt.js";
import { readMultiAccountContainer } from "./container.js";
import { getCodexCliAuthPath } from "./paths.js";

/**
 * Load accounts from CODEX_ACCOUNTS environment variable
 * @returns {Array<{label: string, accountId: string, access: string, refresh: string, expires?: number, source: string}>}
 */
export function loadAccountsFromEnv() {
	const envAccounts = process.env.CODEX_ACCOUNTS;
	if (!envAccounts) return [];

	try {
		const parsed = JSON.parse(envAccounts);
		const accounts = Array.isArray(parsed) ? parsed : parsed?.accounts ?? [];
		return accounts
			.filter(isValidAccount)
			.map(a => ({ ...a, source: "env" }));
	} catch {
		console.error("Warning: CODEX_ACCOUNTS env var is not valid JSON");
		return [];
	}
}

/**
 * Load accounts from a multi-account JSON file
 * @param {string} filePath - Path to the JSON file
 * @returns {Array<{label: string, accountId: string, access: string, refresh: string, expires?: number, source: string}>}
 */
export function loadAccountsFromFile(filePath) {
	const container = readMultiAccountContainer(filePath);
	if (!container.exists) return [];
	return container.accounts
		.filter(isValidAccount)
		.map(a => ({ ...a, source: filePath }));
}

/**
 * Load account from Codex CLI auth.json (single account format)
 * Returns array with single account for consistency with other loaders
 * @returns {Array<{label: string, accountId: string, access: string, refresh: string, expires?: number, source: string}>}
 */
export function loadAccountFromCodexCli() {
	const codexAuthPath = getCodexCliAuthPath();
	if (!existsSync(codexAuthPath)) return [];

	try {
		const raw = readFileSync(codexAuthPath, "utf-8");
		const parsed = JSON.parse(raw);
		const tokens = parsed?.tokens;

		if (!tokens?.access_token || !tokens?.refresh_token) {
			return [];
		}

		const accountId = typeof tokens.account_id === "string" && tokens.account_id
			? tokens.account_id
			: extractAccountId(tokens.access_token);
		if (!accountId) {
			return [];
		}

		return [{
			label: "codex-cli",
			accountId,
			access: tokens.access_token,
			refresh: tokens.refresh_token,
			expires: tokens.expires_at ? tokens.expires_at * 1000 : Date.now() - 1000,
			source: codexAuthPath,
		}];
	} catch {
		return [];
	}
}

export function isValidAccount(a) {
	return a?.label && a?.accountId && a?.access && a?.refresh;
}

/**
 * Deduplicate accounts by email (from JWT token), keeping the first occurrence.
 * Optionally prefer a specific label so the active account remains visible.
 * @param {Array<{access: string, label?: string}>} accounts
 * @param {{ preferredLabel?: string | null }} [options]
 * @returns {Array<{access: string, label?: string}>}
 */
export function deduplicateAccountsByEmail(accounts, options = {}) {
	const preferredLabel = options.preferredLabel ?? null;
	let preferredEmail = null;
	if (preferredLabel) {
		const preferredAccount = accounts.find(account => account.label === preferredLabel);
		if (preferredAccount?.access) {
			preferredEmail = extractProfile(preferredAccount.access)?.email ?? null;
		}
	}

	const seen = new Set();
	return accounts.filter(account => {
		if (!account.access) return true;
		const profile = extractProfile(account.access);
		const email = profile?.email;
		if (!email) return true;
		if (preferredEmail && email === preferredEmail) {
			return account.label === preferredLabel;
		}
		if (seen.has(email)) return false;
		seen.add(email);
		return true;
	});
}

/**
 * Resolve the multi-account file that stores activeLabel for Codex.
 * @returns {string}
 */
export function resolveCodexActiveStorePath() {
	for (const path of MULTI_ACCOUNT_PATHS) {
		if (existsSync(path)) return path;
	}
	return MULTI_ACCOUNT_PATHS[0];
}

/**
 * Read the active-label store container for Codex.
 * @returns {{ path: string, container: ReturnType<typeof readMultiAccountContainer> }}
 */
export function readCodexActiveStoreContainer() {
	const path = resolveCodexActiveStorePath();
	const container = readMultiAccountContainer(path);
	return { path, container };
}

/**
 * Get the activeLabel stored for Codex (if any).
 * @returns {{ activeLabel: string | null, path: string, schemaVersion: number }}
 */
export function getCodexActiveLabelInfo() {
	const { path, container } = readCodexActiveStoreContainer();
	return {
		activeLabel: container.activeLabel ?? null,
		path,
		schemaVersion: container.schemaVersion ?? 0,
	};
}

/**
 * Load ALL accounts from ALL sources without deduplication by email.
 * @param {{ local?: boolean }} [options] - When local=true, skip harness auth files
 * @returns {Array<{label: string, accountId: string, access: string, refresh: string, expires?: number, source: string}>}
 */
export function loadAllAccountsNoDedup(options = {}) {
	const all = [];
	all.push(...loadAccountsFromEnv());
	for (const path of MULTI_ACCOUNT_PATHS) {
		all.push(...loadAccountsFromFile(path));
	}
	if (all.length === 0 && !options.local) {
		all.push(...loadAccountFromCodexCli());
	}
	return all;
}

/**
 * Load ALL accounts from ALL sources (env, file paths, codex-cli)
 * Deduplicates by email to prevent showing same user twice
 * @param {string | null} [preferredLabel]
 * @param {{ local?: boolean }} [options]
 * @returns {Array<{label: string, accountId: string, access: string, refresh: string, expires?: number, source: string}>}
 */
export function loadAllAccounts(preferredLabel = null, options = {}) {
	const all = loadAllAccountsNoDedup(options);
	return deduplicateAccountsByEmail(all, { preferredLabel });
}

/**
 * Find an account by label from all sources
 * @param {string} label
 * @returns {{label: string, accountId: string, access: string, refresh: string, expires?: number, source: string} | null}
 */
export function findAccountByLabel(label) {
	const accounts = loadAllAccountsNoDedup();
	return accounts.find(a => a.label === label) ?? null;
}

/**
 * Get all labels from all account sources
 * @returns {string[]}
 */
export function getAllLabels() {
	const accounts = loadAllAccountsNoDedup();
	return [...new Set(accounts.map(a => a.label))];
}
