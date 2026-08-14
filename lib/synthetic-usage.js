/**
 * Synthetic quota fetch and normalization.
 * Depends on: lib/constants.js
 */

import { SYNTHETIC_QUOTAS_URL, SYNTHETIC_TIMEOUT_MS } from "./constants.js";

function finiteNumber(value) {
	if (value === null || value === undefined || value === "") return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function normalizeRequestWindow(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const limit = finiteNumber(value.limit);
	const requests = finiteNumber(value.requests);
	if (limit === null || requests === null) return null;
	const remaining = Math.max(0, limit - requests);
	return {
		limit,
		requests,
		remaining,
		percentRemaining: limit > 0 ? Math.max(0, Math.min(100, remaining / limit * 100)) : null,
		renewsAt: typeof value.renewsAt === "string" ? value.renewsAt : null,
	};
}

/**
 * Normalize a Synthetic /v2/quotas response.
 * @param {unknown} raw
 * @returns {object | null}
 */
export function normalizeSyntheticQuotas(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const subscription = normalizeRequestWindow(raw.subscription);
	const searchHourly = normalizeRequestWindow(raw.search?.hourly);
	const freeToolCalls = normalizeRequestWindow(raw.freeToolCalls);

	const weeklyRaw = raw.weeklyTokenLimit;
	const weeklyTokenLimit = weeklyRaw && typeof weeklyRaw === "object" ? {
		percentRemaining: finiteNumber(weeklyRaw.percentRemaining),
		maxCredits: typeof weeklyRaw.maxCredits === "string" ? weeklyRaw.maxCredits : null,
		remainingCredits: typeof weeklyRaw.remainingCredits === "string"
			? weeklyRaw.remainingCredits : null,
		nextRegenAt: typeof weeklyRaw.nextRegenAt === "string" ? weeklyRaw.nextRegenAt : null,
		nextRegenCredits: typeof weeklyRaw.nextRegenCredits === "string"
			? weeklyRaw.nextRegenCredits : null,
	} : null;

	const rollingRaw = raw.rollingFiveHourLimit;
	let rollingFiveHourLimit = null;
	if (rollingRaw && typeof rollingRaw === "object") {
		const remaining = finiteNumber(rollingRaw.remaining);
		const max = finiteNumber(rollingRaw.max);
		if (remaining !== null && max !== null) {
			rollingFiveHourLimit = {
				remaining,
				max,
				percentRemaining: max > 0
					? Math.max(0, Math.min(100, remaining / max * 100)) : null,
				nextTickAt: typeof rollingRaw.nextTickAt === "string" ? rollingRaw.nextTickAt : null,
				tickPercent: finiteNumber(rollingRaw.tickPercent),
				limited: typeof rollingRaw.limited === "boolean" ? rollingRaw.limited : null,
			};
		}
	}

	if (!subscription && !searchHourly && !weeklyTokenLimit && !rollingFiveHourLimit) return null;
	return {
		subscription,
		searchHourly,
		freeToolCalls: freeToolCalls?.limit > 0 ? freeToolCalls : null,
		weeklyTokenLimit,
		rollingFiveHourLimit,
	};
}

/**
 * Fetch quota for a Synthetic API key.
 * @param {object} account
 * @param {{ fetchFn?: typeof fetch, timeoutMs?: number, url?: string }} [options]
 * @returns {Promise<{ success: boolean, usage?: object, error?: string, status?: number }>}
 */
export async function fetchSyntheticUsage(account, options = {}) {
	if (!account?.apiKey) return { success: false, error: "No Synthetic API key available" };
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		options.timeoutMs ?? SYNTHETIC_TIMEOUT_MS,
	);
	try {
		const response = await (options.fetchFn ?? fetch)(options.url ?? SYNTHETIC_QUOTAS_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${account.apiKey}`,
				accept: "application/json",
			},
			signal: controller.signal,
		});
		if (response.status === 401 || response.status === 403) {
			return { success: false, error: "Synthetic API key is invalid", status: response.status };
		}
		if (!response.ok) {
			return { success: false, error: `HTTP ${response.status}`, status: response.status };
		}
		let body;
		try {
			body = await response.json();
		} catch {
			return { success: false, error: "Invalid JSON response" };
		}
		const usage = normalizeSyntheticQuotas(body);
		return usage
			? { success: true, usage }
			: { success: false, error: "Synthetic quota unavailable" };
	} catch (error) {
		const message = error?.name === "AbortError"
			? "Request timed out"
			: error?.message ?? String(error);
		return { success: false, error: message };
	} finally {
		clearTimeout(timeout);
	}
}
