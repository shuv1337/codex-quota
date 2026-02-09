/**
 * Generic OAuth token matching, normalizing, and updating.
 * Zero internal dependencies — pure logic module.
 */

/**
 * Unified OAuth token matcher — replaces both isOpenAiOauthTokenMatch and isClaudeOauthTokenMatch.
 * @param {{ storedAccess?: string | null, storedRefresh?: string | null, previousAccess?: string | null, previousRefresh?: string | null, label?: string | null, storedLabel?: string | null }} params
 * @returns {boolean}
 */
export function isOauthTokenMatch({
	storedAccess,
	storedRefresh,
	previousAccess,
	previousRefresh,
	label,
	storedLabel,
}) {
	if (previousRefresh && storedRefresh && storedRefresh === previousRefresh) return true;
	if (previousAccess && storedAccess && storedAccess === previousAccess) return true;
	if (!storedAccess && !storedRefresh && label && storedLabel && label === storedLabel) return true;
	return false;
}

/**
 * OpenAI token field map: canonical key → candidate keys in order of preference.
 */
export const OPENAI_TOKEN_FIELDS = {
	access: ["access", "access_token"],
	refresh: ["refresh", "refresh_token"],
	expires: ["expires", "expires_at"],
	accountId: ["accountId", "account_id"],
	idToken: ["idToken", "id_token"],
};

/**
 * Claude token field map: canonical key → candidate keys in order of preference.
 */
export const CLAUDE_TOKEN_FIELDS = {
	access: ["oauthToken", "oauth_token", "accessToken", "access_token", "access"],
	refresh: ["oauthRefreshToken", "oauth_refresh_token", "refreshToken", "refresh_token", "refresh"],
	scopes: ["oauthScopes", "oauth_scopes", "scopes"],
	expires: ["oauthExpiresAt", "oauth_expires_at", "expiresAt", "expires_at", "expires"],
};

/**
 * Normalize an entry's tokens using a field map — returns canonical field values.
 * @param {Record<string, unknown>} entry
 * @param {Record<string, string[]>} fieldMap
 * @returns {Record<string, unknown>}
 */
export function normalizeEntryTokens(entry, fieldMap) {
	const result = {};
	for (const [canonical, candidates] of Object.entries(fieldMap)) {
		let value = null;
		for (const key of candidates) {
			if (entry?.[key] != null) {
				value = entry[key];
				break;
			}
		}
		result[canonical] = value;
	}
	return result;
}

/**
 * Resolve which key to use for writing back into an entry.
 * Returns the first candidate key that already exists in the entry, or the first candidate as default.
 * @param {Record<string, unknown>} entry
 * @param {string[]} candidates
 * @returns {string}
 */
export function resolveKey(entry, candidates) {
	for (const key of candidates) {
		if (key in entry) return key;
	}
	return candidates[0];
}

/**
 * Update an entry's tokens using a field map and an account object with canonical keys.
 * @param {Record<string, unknown>} entry
 * @param {Record<string, unknown>} account - Object with canonical field names as keys
 * @param {Record<string, string[]>} fieldMap
 * @returns {Record<string, unknown>}
 */
export function updateEntryTokens(entry, account, fieldMap) {
	for (const [canonical, candidates] of Object.entries(fieldMap)) {
		if (canonical in account) {
			const key = resolveKey(entry, candidates);
			entry[key] = account[canonical];
		}
	}
	return entry;
}
