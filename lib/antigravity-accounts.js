/**
 * Google AI Pro / Antigravity account loading.
 * Depends on: lib/constants.js, lib/token-match.js
 *
 * Quota-only: reads live tokens from env, shuvcode SQLite, and the V1
 * antigravity-accounts.json file. No managed add/switch/remove.
 */

import { existsSync, readFileSync } from "node:fs";
import {
	ANTIGRAVITY_INTEGRATION_DB_PATHS,
	ANTIGRAVITY_METHOD_ID,
	ANTIGRAVITY_V1_ACCOUNTS_PATH,
} from "./constants.js";
import { ANTIGRAVITY_TOKEN_FIELDS, normalizeEntryTokens } from "./token-match.js";

/**
 * @param {unknown} value
 * @returns {number | null}
 */
export function resolveAntigravityExpiresAt(value) {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value < 1e12 ? value * 1000 : value;
	}
	if (typeof value === "string" && value.trim()) {
		const asNum = Number(value);
		if (Number.isFinite(asNum) && asNum > 0) {
			return asNum < 1e12 ? asNum * 1000 : asNum;
		}
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return null;
}

/**
 * Split a V1 `refresh|projectId` compound token.
 * @param {string} value
 * @returns {{ refresh: string, projectId?: string }}
 */
export function splitAntigravityRefresh(value) {
	const index = value.indexOf("|");
	if (index <= 0) return { refresh: value };
	return { refresh: value.slice(0, index), projectId: value.slice(index + 1) || undefined };
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function record(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value;
}

/**
 * @param {unknown} raw
 * @returns {unknown}
 */
function parseMaybeJson(raw) {
	if (typeof raw !== "string") return raw;
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

/**
 * Normalize a Google AI Pro / Antigravity credential.
 * @param {unknown} raw
 * @param {{ label?: string, source?: string, credentialId?: string }} [metadata]
 * @returns {object | null}
 */
export function normalizeAntigravityAccount(raw, metadata = {}) {
	const parsed = parseMaybeJson(raw);
	const value = record(parsed);
	if (!value) return null;
	if (value.type && value.type !== "oauth") return null;
	if (value.methodID && value.methodID !== ANTIGRAVITY_METHOD_ID) return null;

	const tokens = normalizeEntryTokens(value, ANTIGRAVITY_TOKEN_FIELDS);
	const refreshRaw = typeof tokens.refresh === "string" ? tokens.refresh.trim() : "";
	if (!refreshRaw && typeof tokens.access !== "string") return null;
	const split = refreshRaw ? splitAntigravityRefresh(refreshRaw) : { refresh: "" };
	const metadataRecord = record(value.metadata) ?? {};
	const projectId =
		(typeof tokens.projectId === "string" && tokens.projectId) ||
		(typeof metadataRecord.projectId === "string" && metadataRecord.projectId) ||
		(typeof metadataRecord.project_id === "string" && metadataRecord.project_id) ||
		split.projectId ||
		null;
	const email =
		(typeof tokens.email === "string" && tokens.email) ||
		(typeof metadataRecord.email === "string" && metadataRecord.email) ||
		null;
	const paidTier =
		(typeof tokens.paidTier === "string" && tokens.paidTier) ||
		(typeof metadataRecord.paidTier === "string" && metadataRecord.paidTier) ||
		null;
	const label = metadata.label
		?? (typeof value.label === "string" && value.label.trim() ? value.label.trim() : null)
		?? email
		?? "antigravity";
	const access = typeof tokens.access === "string" && tokens.access.trim()
		? tokens.access.trim()
		: null;
	const refresh = split.refresh || null;
	if (!access && !refresh) return null;

	return {
		label,
		access,
		refresh,
		expires: resolveAntigravityExpiresAt(tokens.expires),
		projectId,
		email,
		paidTier,
		source: metadata.source ?? "env",
		credentialId: metadata.credentialId ?? null,
	};
}

/**
 * Load Antigravity accounts from ANTIGRAVITY_* environment variables.
 * @returns {object[]}
 */
export function loadAntigravityAccountsFromEnv() {
	const accounts = [];
	if (process.env.ANTIGRAVITY_REFRESH || process.env.ANTIGRAVITY_ACCESS) {
		const account = normalizeAntigravityAccount({
			refresh: process.env.ANTIGRAVITY_REFRESH,
			access: process.env.ANTIGRAVITY_ACCESS,
			expires: process.env.ANTIGRAVITY_EXPIRES,
			projectId: process.env.ANTIGRAVITY_PROJECT,
			email: process.env.ANTIGRAVITY_EMAIL,
			paidTier: process.env.ANTIGRAVITY_PAID_TIER,
		}, {
			label: process.env.ANTIGRAVITY_LABEL || "antigravity",
			source: "env:ANTIGRAVITY_REFRESH",
		});
		if (account) accounts.push(account);
	}

	if (process.env.ANTIGRAVITY_ACCOUNTS) {
		try {
			const parsed = JSON.parse(process.env.ANTIGRAVITY_ACCOUNTS);
			const entries = Array.isArray(parsed) ? parsed : parsed?.accounts ?? [];
			for (const [index, entry] of entries.entries()) {
				const account = normalizeAntigravityAccount(entry, {
					label: record(entry)?.label ?? `antigravity-${index + 1}`,
					source: "env:ANTIGRAVITY_ACCOUNTS",
				});
				if (account) accounts.push(account);
			}
		} catch {
			console.error("Warning: ANTIGRAVITY_ACCOUNTS env var is not valid JSON");
		}
	}
	return accounts;
}

/**
 * Load Antigravity accounts from a V1 antigravity-accounts.json file.
 * @param {string} [filePath]
 * @returns {object[]}
 */
export function loadAntigravityAccountsFromV1File(
	filePath = process.env.ANTIGRAVITY_V1_ACCOUNTS_PATH || ANTIGRAVITY_V1_ACCOUNTS_PATH,
) {
	if (!filePath || !existsSync(filePath)) return [];
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
		const entries = Array.isArray(parsed) ? parsed : parsed?.accounts ?? [];
		const activeIndex = typeof parsed?.activeIndex === "number" && parsed.activeIndex >= 0
			? parsed.activeIndex
			: 0;
		const ordered = [...entries];
		if (ordered[activeIndex]) {
			const [active] = ordered.splice(activeIndex, 1);
			ordered.unshift(active);
		}
		return ordered.flatMap((entry, index) => {
			const account = normalizeAntigravityAccount(entry, {
				label: record(entry)?.label ?? record(entry)?.email ?? `antigravity-${index + 1}`,
				source: filePath,
			});
			return account ? [account] : [];
		});
	} catch {
		return [];
	}
}

/**
 * Load Google AI Pro credentials from a shuvcode/OpenCode SQLite database.
 * Node versions without node:sqlite return an empty list.
 * @param {string} [filePath]
 * @param {{ DatabaseSync?: Function }} [options]
 * @returns {Promise<object[]>}
 */
export async function loadAntigravityAccountsFromIntegrationDb(filePath, options = {}) {
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
		`).all("google");
		return rows.flatMap(row => {
			const account = normalizeAntigravityAccount(row.value, {
				label: row.label || "antigravity",
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
 * Database paths searched for Google AI Pro credentials.
 * @returns {string[]}
 */
export function getAntigravityIntegrationDbPaths() {
	if (process.env.ANTIGRAVITY_INTEGRATION_DB_PATH) {
		return [process.env.ANTIGRAVITY_INTEGRATION_DB_PATH];
	}
	return ANTIGRAVITY_INTEGRATION_DB_PATHS;
}

/**
 * Load and deduplicate Antigravity accounts. Environment entries take precedence.
 * @param {{ includeEnv?: boolean, dbPaths?: string[], v1Path?: string, DatabaseSync?: Function }} [options]
 * @returns {Promise<object[]>}
 */
export async function loadAllAntigravityAccounts(options = {}) {
	const accounts = options.includeEnv === false ? [] : loadAntigravityAccountsFromEnv();
	accounts.push(...loadAntigravityAccountsFromV1File(
		options.v1Path ?? process.env.ANTIGRAVITY_V1_ACCOUNTS_PATH ?? ANTIGRAVITY_V1_ACCOUNTS_PATH,
	));
	const dbPaths = options.dbPaths ?? getAntigravityIntegrationDbPaths();
	for (const dbPath of dbPaths) {
		accounts.push(...await loadAntigravityAccountsFromIntegrationDb(dbPath, {
			DatabaseSync: options.DatabaseSync,
		}));
	}
	const byRefresh = new Map();
	for (const account of accounts) {
		const key = account.refresh || account.access;
		if (!byRefresh.has(key)) byRefresh.set(key, account);
	}
	const selected = [];
	for (const account of byRefresh.values()) {
		const index = selected.findIndex(existing => sameAntigravityIdentity(existing, account));
		if (index < 0) {
			selected.push(account);
			continue;
		}
		if (!selected[index].access && account.access) selected[index] = account;
	}
	return selected;
}

/**
 * @param {object} left
 * @param {object} right
 * @returns {boolean}
 */
function sameAntigravityIdentity(left, right) {
	if (left.email && right.email && left.email === right.email) return true;
	if (left.projectId && right.projectId && left.projectId === right.projectId) return true;
	return false;
}

/**
 * @param {object[]} [accounts]
 * @returns {string[]}
 */
export function getAllAntigravityLabels(accounts) {
	return (accounts ?? []).map(account => account.label);
}

/**
 * Locations searched for Antigravity credentials.
 * @returns {string[]}
 */
export function getAntigravitySearchLocations() {
	return [
		"ANTIGRAVITY_REFRESH env var",
		"ANTIGRAVITY_ACCOUNTS env var",
		process.env.ANTIGRAVITY_V1_ACCOUNTS_PATH || ANTIGRAVITY_V1_ACCOUNTS_PATH,
		...getAntigravityIntegrationDbPaths(),
	];
}
