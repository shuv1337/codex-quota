/**
 * Synthetic API key discovery from environment variables and shuvcode's integration database.
 * Depends on: lib/constants.js
 */

import { existsSync } from "node:fs";
import { SYNTHETIC_INTEGRATION_DB_PATH } from "./constants.js";

/**
 * Normalize a Synthetic credential into an account record.
 * @param {unknown} raw
 * @param {{ label?: string, source?: string, credentialId?: string }} [metadata]
 * @returns {object | null}
 */
export function normalizeSyntheticAccount(raw, metadata = {}) {
	let value = raw;
	if (typeof raw === "string") {
		try {
			value = JSON.parse(raw);
		} catch {
			value = { key: raw };
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const apiKey = value.apiKey ?? value.api_key ?? value.key ?? value.token;
	if (typeof apiKey !== "string" || !apiKey.trim()) return null;
	const label = metadata.label ?? value.label ?? "synthetic";
	return {
		label: typeof label === "string" && label.trim() ? label.trim() : "synthetic",
		apiKey: apiKey.trim(),
		source: metadata.source ?? "env",
		credentialId: metadata.credentialId ?? null,
	};
}

/**
 * Load Synthetic accounts from SYNTHETIC_API_KEY and SYNTHETIC_ACCOUNTS.
 * @returns {object[]}
 */
export function loadSyntheticAccountsFromEnv() {
	const accounts = [];
	if (process.env.SYNTHETIC_API_KEY) {
		const account = normalizeSyntheticAccount(process.env.SYNTHETIC_API_KEY, {
			label: process.env.SYNTHETIC_LABEL || "synthetic",
			source: "env:SYNTHETIC_API_KEY",
		});
		if (account) accounts.push(account);
	}

	if (process.env.SYNTHETIC_ACCOUNTS) {
		try {
			const parsed = JSON.parse(process.env.SYNTHETIC_ACCOUNTS);
			const entries = Array.isArray(parsed) ? parsed : parsed?.accounts ?? [];
			for (const [index, entry] of entries.entries()) {
				const account = normalizeSyntheticAccount(entry, {
					label: entry?.label ?? `synthetic-${index + 1}`,
					source: "env:SYNTHETIC_ACCOUNTS",
				});
				if (account) accounts.push(account);
			}
		} catch {
			console.error("Warning: SYNTHETIC_ACCOUNTS env var is not valid JSON");
		}
	}
	return accounts;
}

/**
 * Load Synthetic credentials from shuvcode's integration-v2 SQLite database.
 * Node versions without node:sqlite return an empty list so the Node 18 CLI remains usable.
 * @param {string} [filePath]
 * @param {{ DatabaseSync?: Function }} [options]
 * @returns {Promise<object[]>}
 */
export async function loadSyntheticAccountsFromIntegrationDb(
	filePath = process.env.SYNTHETIC_INTEGRATION_DB_PATH || SYNTHETIC_INTEGRATION_DB_PATH,
	options = {},
) {
	if (!filePath || !existsSync(filePath)) return [];
	let DatabaseSync = options.DatabaseSync;
	if (!DatabaseSync) {
		try {
			({ DatabaseSync } = await import("node:sqlite"));
		} catch {
			return [];
		}
	}

	let database;
	try {
		database = new DatabaseSync(filePath, { readOnly: true });
		const rows = database.prepare(`
			SELECT id, label, value
			FROM credential
			WHERE integration_id = ?
			ORDER BY active DESC NULLS LAST, time_updated DESC
		`).all("synthetic");
		return rows.flatMap(row => {
			const account = normalizeSyntheticAccount(row.value, {
				label: row.label || "synthetic",
				source: filePath,
				credentialId: row.id,
			});
			return account ? [account] : [];
		});
	} catch {
		return [];
	} finally {
		try {
			database?.close();
		} catch {
			// Ignore close failures on an optional credential source.
		}
	}
}

/**
 * Load and deduplicate all Synthetic accounts. Environment entries take precedence.
 * @param {{ includeEnv?: boolean, dbPath?: string, DatabaseSync?: Function }} [options]
 * @returns {Promise<object[]>}
 */
export async function loadAllSyntheticAccounts(options = {}) {
	const accounts = options.includeEnv === false ? [] : loadSyntheticAccountsFromEnv();
	accounts.push(...await loadSyntheticAccountsFromIntegrationDb(
		options.dbPath ?? process.env.SYNTHETIC_INTEGRATION_DB_PATH ?? SYNTHETIC_INTEGRATION_DB_PATH,
		{ DatabaseSync: options.DatabaseSync },
	));
	const byKey = new Map();
	for (const account of accounts) {
		if (!byKey.has(account.apiKey)) byKey.set(account.apiKey, account);
	}
	return [...byKey.values()];
}

/**
 * Locations searched for Synthetic credentials.
 * @returns {string[]}
 */
export function getSyntheticSearchLocations() {
	return [
		"SYNTHETIC_API_KEY env var",
		"SYNTHETIC_ACCOUNTS env var",
		process.env.SYNTHETIC_INTEGRATION_DB_PATH || SYNTHETIC_INTEGRATION_DB_PATH,
	];
}
