/**
 * Google AI Pro / Antigravity Cloud Code quota fetch.
 * Depends on: lib/constants.js
 */

import {
	ANTIGRAVITY_CLOUD_CODE_URL,
	ANTIGRAVITY_TIMEOUT_MS,
	ANTIGRAVITY_USER_AGENT,
} from "./constants.js";

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function record(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function finiteNumber(value) {
	if (value === null || value === undefined || value === "") return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function stringField(value) {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Normalize retrieveUserQuotaSummary into Gemini and Claude/GPT buckets.
 * @param {unknown} raw
 * @returns {{
 * 	paidTier: string | null,
 * 	groups: Array<{
 * 		id: string,
 * 		displayName: string,
 * 		buckets: Array<{
 * 			bucketId: string,
 * 			displayName: string,
 * 			window: string | null,
 * 			resetTime: string | null,
 * 			remainingFraction: number,
 * 			percentRemaining: number,
 * 			description: string | null,
 * 		}>,
 * 	}>,
 * } | null}
 */
export function normalizeAntigravityQuota(raw) {
	const root = record(raw);
	if (!root || !Array.isArray(root.groups)) return null;
	const groups = [];
	for (const [index, rawGroup] of root.groups.entries()) {
		const group = record(rawGroup);
		if (!group || !Array.isArray(group.buckets)) continue;
		const buckets = [];
		for (const rawBucket of group.buckets) {
			const bucket = record(rawBucket);
			if (!bucket) continue;
			const remainingFraction = finiteNumber(bucket.remainingFraction ?? bucket.remaining_fraction);
			if (remainingFraction === null) continue;
			const percentRemaining = Math.max(0, Math.min(100, remainingFraction * 100));
			buckets.push({
				bucketId: stringField(bucket.bucketId) ?? stringField(bucket.bucket_id) ?? `bucket-${buckets.length}`,
				displayName: stringField(bucket.displayName) ?? stringField(bucket.display_name) ?? "Limit",
				window: stringField(bucket.window),
				resetTime: stringField(bucket.resetTime) ?? stringField(bucket.reset_time),
				remainingFraction,
				percentRemaining,
				description: stringField(bucket.description),
			});
		}
		if (!buckets.length) continue;
		groups.push({
			id: stringField(group.id) ?? slugGroup(group.displayName, index),
			displayName: stringField(group.displayName) ?? stringField(group.display_name) ?? "Models",
			buckets,
		});
	}
	if (!groups.length) return null;
	return {
		paidTier: stringField(root.paidTier) ?? stringField(root.paid_tier),
		groups,
	};
}

/**
 * @param {unknown} displayName
 * @param {number} index
 * @returns {string}
 */
function slugGroup(displayName, index) {
	const text = typeof displayName === "string" ? displayName.toLowerCase() : "";
	if (text.includes("gemini")) return "gemini";
	if (text.includes("claude") || text.includes("gpt")) return "3p";
	return `group-${index}`;
}

/**
 * @param {string} access
 * @param {string} path
 * @param {unknown} body
 * @param {{ fetchFn?: typeof fetch, timeoutMs?: number, baseUrl?: string }} options
 * @returns {Promise<{ ok: true, body: unknown } | { ok: false, error: string, status?: number }>}
 */
async function cloudCode(access, path, body, options = {}) {
	const fetchFn = options.fetchFn ?? fetch;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? ANTIGRAVITY_TIMEOUT_MS);
	try {
		const response = await fetchFn(`${options.baseUrl ?? ANTIGRAVITY_CLOUD_CODE_URL}${path}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${access}`,
				"Content-Type": "application/json",
				"User-Agent": ANTIGRAVITY_USER_AGENT,
				Accept: "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (response.status === 401 || response.status === 403) {
			return { ok: false, error: "Google AI Pro sign-in required", status: response.status };
		}
		if (!response.ok) {
			let detail = "";
			try {
				detail = (await response.text()).trim();
			} catch {
				// ignore
			}
			return {
				ok: false,
				error: detail
					? `HTTP ${response.status}: ${detail.slice(0, 200)}`
					: `HTTP ${response.status}`,
				status: response.status,
			};
		}
		try {
			return { ok: true, body: await response.json() };
		} catch {
			return { ok: false, error: "Invalid JSON response" };
		}
	} catch (error) {
		const message = error?.name === "AbortError"
			? "Request timed out"
			: error?.message ?? String(error);
		return { ok: false, error: message };
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Resolve a Cloud Code project id when the stored credential omitted one.
 * @param {string} access
 * @param {{ fetchFn?: typeof fetch, timeoutMs?: number, baseUrl?: string }} [options]
 * @returns {Promise<string | null>}
 */
export async function loadAntigravityProjectId(access, options = {}) {
	const result = await cloudCode(access, "/v1internal:loadCodeAssist", {
		metadata: { ideType: "ANTIGRAVITY" },
	}, options);
	if (!result.ok) return null;
	const data = record(result.body);
	if (!data) return null;
	const project = data.cloudaicompanionProject;
	const projectRecord = record(project);
	return stringField(project)
		?? stringField(projectRecord?.id)
		?? stringField(projectRecord?.name);
}

/**
 * Fetch Google AI Pro quota for one account.
 * @param {object} account
 * @param {{ fetchFn?: typeof fetch, timeoutMs?: number, baseUrl?: string }} [options]
 * @returns {Promise<{ success: boolean, usage?: object, error?: string, status?: number }>}
 */
export async function fetchAntigravityUsage(account, options = {}) {
	const access = account?.access;
	if (!access) return { success: false, error: "No authentication token available" };

	let projectId = account.projectId;
	if (!projectId) {
		projectId = await loadAntigravityProjectId(access, options);
		if (projectId) account.projectId = projectId;
	}
	if (!projectId) return { success: false, error: "Google AI Pro is missing a Cloud Code project id" };

	const result = await cloudCode(access, "/v1internal:retrieveUserQuotaSummary", {
		project: projectId,
	}, options);
	if (!result.ok) {
		return { success: false, error: result.error, status: result.status };
	}
	const usage = normalizeAntigravityQuota(result.body);
	return usage
		? { success: true, usage }
		: { success: false, error: "Antigravity quota unavailable" };
}
