/**
 * Grok / SuperGrok account loading from live auth stores.
 * Depends on: lib/constants.js, lib/jwt.js
 *
 * Phase A: read-only discovery of existing xAI OAuth tokens owned by other tools.
 * No managed multi-account container yet.
 */

import { existsSync, readFileSync } from "node:fs";
import {
	GROK_PI_AUTH_PATHS,
	GROK_HERMES_AUTH_PATH,
	GROK_OPENCODE_AUTH_PATH,
	GROK_PLAN_OVERRIDE_PATH,
} from "./constants.js";
import { decodeJWT } from "./jwt.js";
import { getOpencodeAuthPath } from "./paths.js";
import { normalizeEntryTokens, XAI_TOKEN_FIELDS } from "./token-match.js";

/**
 * Load optional manual SuperGrok plan override for web/CLI display.
 * @param {string} [filePath]
 * @returns {string | null}
 */
export function loadGrokPlanOverride(filePath = GROK_PLAN_OVERRIDE_PATH) {
	if (!existsSync(filePath)) return null;
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
		const value = parsed?.planOverride ?? parsed?.plan ?? parsed?.planType;
		return typeof value === "string" && value.trim() ? value.trim() : null;
	} catch {
		return null;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract SuperGrok profile claims from an access JWT.
 * @param {string | null | undefined} accessToken
 * @returns {{ accountId: string | null, teamId: string | null, tier: number | null, email: string | null }}
 */
export function extractGrokProfile(accessToken) {
	const payload = decodeJWT(accessToken);
	if (!payload) {
		return { accountId: null, teamId: null, tier: null, email: null };
	}

	const accountId =
		(typeof payload.sub === "string" && payload.sub) ||
		(typeof payload.principal_id === "string" && payload.principal_id) ||
		null;
	const teamId =
		(typeof payload.team_id === "string" && payload.team_id) ||
		(typeof payload.teamId === "string" && payload.teamId) ||
		null;
	const tier = typeof payload.tier === "number" && Number.isFinite(payload.tier)
		? payload.tier
		: null;
	const email = typeof payload.email === "string" && payload.email
		? payload.email
		: null;

	return { accountId, teamId, tier, email };
}

/**
 * Resolve absolute expiry (ms) from explicit expires field or JWT exp claim.
 * @param {unknown} expiresValue
 * @param {string | null | undefined} accessToken
 * @returns {number | null}
 */
export function resolveGrokExpiresAt(expiresValue, accessToken) {
	if (typeof expiresValue === "number" && Number.isFinite(expiresValue) && expiresValue > 0) {
		// Heuristic: values < 1e12 are likely seconds
		return expiresValue < 1e12 ? expiresValue * 1000 : expiresValue;
	}
	if (typeof expiresValue === "string" && expiresValue.trim()) {
		const asNum = Number(expiresValue);
		if (Number.isFinite(asNum) && asNum > 0) {
			return asNum < 1e12 ? asNum * 1000 : asNum;
		}
		const parsed = Date.parse(expiresValue);
		if (!Number.isNaN(parsed)) return parsed;
	}

	const payload = decodeJWT(accessToken);
	if (payload?.exp && typeof payload.exp === "number") {
		return payload.exp * 1000;
	}
	return null;
}

/**
 * @param {object} account
 * @returns {boolean}
 */
export function isValidGrokAccount(account) {
	return Boolean(
		account &&
		typeof account === "object" &&
		account.accountId &&
		(account.accessToken || account.refreshToken),
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Source readers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} filePath
 * @returns {object | null}
 */
function readJsonObject(filePath) {
	if (!existsSync(filePath)) return null;
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Build a candidate account from raw token fields + source metadata.
 * @param {object} raw
 * @param {{ kind: string, path: string, label?: string, providerKey?: string }} source
 * @returns {object | null}
 */
export function candidateFromRawTokens(raw, source) {
	if (!raw || typeof raw !== "object") return null;
	const tokens = normalizeEntryTokens(raw, XAI_TOKEN_FIELDS);
	const accessToken = typeof tokens.access === "string" ? tokens.access : null;
	const refreshToken = typeof tokens.refresh === "string" ? tokens.refresh : null;
	if (!accessToken && !refreshToken) return null;

	const profile = extractGrokProfile(accessToken);
	const accountId =
		(typeof tokens.accountId === "string" && tokens.accountId) ||
		profile.accountId;
	if (!accountId) return null;

	const expiresAt = resolveGrokExpiresAt(tokens.expires, accessToken);
	const label = source.label
		|| profile.email
		|| (typeof raw.label === "string" && raw.label)
		|| "grok";

	return {
		label,
		accountId,
		email: profile.email,
		teamId: profile.teamId,
		tier: profile.tier,
		accessToken,
		refreshToken,
		expiresAt,
		tokenEndpoint:
			(typeof raw.token_endpoint === "string" && raw.token_endpoint) ||
			(typeof raw.tokenEndpoint === "string" && raw.tokenEndpoint) ||
			null,
		source: source.path,
		sources: [{
			kind: source.kind,
			path: source.path,
			providerKey: source.providerKey ?? null,
			label: source.label ?? null,
			previousAccess: accessToken,
			previousRefresh: refreshToken,
		}],
	};
}

/** Provider keys used by pi/shuvpi/shuvhelm auth.json for SuperGrok OAuth. */
export const GROK_PI_PROVIDER_KEYS = ["xai", "xai-oauth"];

/**
 * Load accounts from a pi-style auth.json (`xai` and/or `xai-oauth` entries).
 * shuvpi currently stores the active SuperGrok session under `xai`; older
 * flows and Hermes-originated logins often used `xai-oauth`. Both are read so
 * a stale key does not hide a working one (merge prefers fresher expiresAt).
 * @param {string} filePath
 * @param {string | string[]} [providerKey] - single key, list of keys, or omit for both
 * @returns {object[]}
 */
export function loadGrokAccountsFromPiAuth(filePath, providerKey) {
	const data = readJsonObject(filePath);
	if (!data) return [];

	const keys = Array.isArray(providerKey)
		? providerKey
		: (typeof providerKey === "string" && providerKey
			? [providerKey]
			: GROK_PI_PROVIDER_KEYS);

	const out = [];
	for (const key of keys) {
		const entry = data[key];
		const candidate = candidateFromRawTokens(entry, {
			kind: "pi-auth",
			path: filePath,
			providerKey: key,
			label: "grok",
		});
		if (candidate) out.push(candidate);
	}
	return out;
}

/**
 * Load accounts from OpenCode auth.json (`xai` provider entry).
 * @param {string} filePath
 * @returns {object[]}
 */
export function loadGrokAccountsFromOpencodeAuth(filePath) {
	const data = readJsonObject(filePath);
	if (!data) return [];
	const entry = data.xai ?? data["xai-oauth"];
	const providerKey = data.xai ? "xai" : (data["xai-oauth"] ? "xai-oauth" : "xai");
	const candidate = candidateFromRawTokens(entry, {
		kind: "opencode-auth",
		path: filePath,
		providerKey,
		label: "grok",
	});
	return candidate ? [candidate] : [];
}

/**
 * Load accounts from Hermes auth.json (credential pool + providers.xai-oauth).
 * @param {string} filePath
 * @returns {object[]}
 */
export function loadGrokAccountsFromHermesAuth(filePath) {
	const data = readJsonObject(filePath);
	if (!data) return [];

	const out = [];

	const pool = data.credential_pool?.["xai-oauth"];
	if (Array.isArray(pool)) {
		for (const entry of pool) {
			const label = typeof entry?.label === "string" && entry.label
				? entry.label
				: "grok";
			const candidate = candidateFromRawTokens(entry, {
				kind: "hermes-pool",
				path: filePath,
				providerKey: "xai-oauth",
				label,
			});
			if (candidate) out.push(candidate);
		}
	}

	const providerTokens = data.providers?.["xai-oauth"]?.tokens;
	if (providerTokens && typeof providerTokens === "object") {
		const candidate = candidateFromRawTokens(providerTokens, {
			kind: "hermes-provider",
			path: filePath,
			providerKey: "xai-oauth",
			label: "grok",
		});
		if (candidate) out.push(candidate);
	}

	return out;
}

/**
 * Load Grok accounts from GROK_ACCOUNTS env var (JSON array or { accounts: [] }).
 * @returns {object[]}
 */
export function loadGrokAccountsFromEnv() {
	const raw = process.env.GROK_ACCOUNTS;
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		const accounts = Array.isArray(parsed) ? parsed : parsed?.accounts ?? [];
		return accounts
			.map((entry, index) => {
				const candidate = candidateFromRawTokens(entry, {
					kind: "env",
					path: "env:GROK_ACCOUNTS",
					label: typeof entry?.label === "string" ? entry.label : `grok-${index + 1}`,
				});
				return candidate ? { ...candidate, source: "env" } : null;
			})
			.filter(Boolean);
	} catch {
		console.error("Warning: GROK_ACCOUNTS env var is not valid JSON");
		return [];
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Combine + dedupe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge two account candidates that share an accountId.
 * Keeps freshest tokens; unions source locations for fan-out refresh.
 * @param {object} primary
 * @param {object} incoming
 * @returns {object}
 */
export function mergeGrokAccountCandidates(primary, incoming) {
	const primaryExp = primary.expiresAt ?? 0;
	const incomingExp = incoming.expiresAt ?? 0;
	const preferIncoming = incomingExp > primaryExp
		|| (!primary.accessToken && incoming.accessToken)
		|| (!primary.refreshToken && incoming.refreshToken);

	const base = preferIncoming
		? {
			...primary,
			...incoming,
			label: primary.label || incoming.label,
			email: primary.email || incoming.email,
			teamId: primary.teamId || incoming.teamId,
			tier: primary.tier ?? incoming.tier ?? null,
			source: incoming.source,
		}
		: {
			...primary,
			email: primary.email || incoming.email,
			teamId: primary.teamId || incoming.teamId,
			tier: primary.tier ?? incoming.tier ?? null,
		};

	const sources = [...(primary.sources ?? [])];
	for (const src of incoming.sources ?? []) {
		const exists = sources.some(s =>
			s.kind === src.kind
			&& s.path === src.path
			&& (s.previousRefresh ?? null) === (src.previousRefresh ?? null)
			&& (s.previousAccess ?? null) === (src.previousAccess ?? null)
			&& (s.label ?? null) === (src.label ?? null)
		);
		if (!exists) sources.push(src);
	}
	base.sources = sources;
	return base;
}

/**
 * Load all SuperGrok OAuth accounts from known live stores.
 * Deduplicates by accountId (JWT sub), merging source locations.
 * @param {{
 * 	piAuthPaths?: string[],
 * 	opencodeAuthPath?: string,
 * 	hermesAuthPath?: string,
 * 	includeEnv?: boolean,
 * }} [options]
 * @returns {object[]}
 */
export function loadAllGrokAccounts(options = {}) {
	const piAuthPaths = options.piAuthPaths ?? GROK_PI_AUTH_PATHS;
	const opencodeAuthPath = options.opencodeAuthPath ?? getOpencodeAuthPath() ?? GROK_OPENCODE_AUTH_PATH;
	const hermesAuthPath = options.hermesAuthPath ?? GROK_HERMES_AUTH_PATH;
	const includeEnv = options.includeEnv ?? true;

	const all = [];
	if (includeEnv) {
		all.push(...loadGrokAccountsFromEnv());
	}
	for (const path of piAuthPaths) {
		all.push(...loadGrokAccountsFromPiAuth(path));
	}
	all.push(...loadGrokAccountsFromOpencodeAuth(opencodeAuthPath));
	all.push(...loadGrokAccountsFromHermesAuth(hermesAuthPath));

	const byId = new Map();
	for (const account of all) {
		if (!isValidGrokAccount(account)) continue;
		const existing = byId.get(account.accountId);
		if (!existing) {
			byId.set(account.accountId, account);
		} else {
			byId.set(account.accountId, mergeGrokAccountCandidates(existing, account));
		}
	}
	const planOverride = loadGrokPlanOverride();
	return [...byId.values()].map((account) => (
		planOverride && !account.planOverride
			? { ...account, planOverride }
			: account
	));
}

/**
 * @param {Array<object>} accounts
 * @param {string} label
 * @returns {object | null}
 */
export function findGrokAccountByLabel(accounts, label) {
	if (!Array.isArray(accounts) || !label) return null;
	return accounts.find(a => a.label === label) ?? null;
}

/**
 * @param {Array<object>} accounts
 * @returns {string[]}
 */
export function getAllGrokLabels(accounts) {
	if (!Array.isArray(accounts)) return [];
	return [...new Set(accounts.map(a => a.label).filter(Boolean))];
}

/**
 * Paths searched for Grok accounts (for error messages).
 * @returns {string[]}
 */
export function getGrokSearchLocations() {
	return [
		"GROK_ACCOUNTS env var",
		...GROK_PI_AUTH_PATHS,
		getOpencodeAuthPath() ?? GROK_OPENCODE_AUTH_PATH,
		GROK_HERMES_AUTH_PATH,
	];
}
