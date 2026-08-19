/**
 * SuperGrok / Grok billing usage fetch (weekly credits).
 * Depends on: lib/constants.js
 */

import {
	GROK_BILLING_URL,
	GROK_TIMEOUT_MS,
	XAI_OAUTH_USERINFO_URL,
} from "./constants.js";

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function numberValue(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	if (value && typeof value === "object" && "val" in value) {
		return numberValue(/** @type {{ val?: unknown }} */ (value).val);
	}
	return undefined;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function stringValue(value) {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
function objectValue(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? /** @type {Record<string, unknown>} */ (value)
		: undefined;
}

/**
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown> | undefined} currentPeriod
 * @returns {boolean}
 */
function hasConfirmedZeroUsagePeriod(config, currentPeriod) {
	return currentPeriod?.type === "USAGE_PERIOD_TYPE_WEEKLY"
		&& Date.parse(String(currentPeriod.start)) === Date.parse(String(config.billingPeriodStart))
		&& Date.parse(String(currentPeriod.end)) === Date.parse(String(config.billingPeriodEnd));
}

/**
 * Normalize cli-chat-proxy billing?format=credits payload.
 * @param {unknown} raw
 * @returns {{
 * 	creditUsagePercent: number | null,
 * 	period: { type: string | null, start: string | null, end: string | null },
 * 	products: Array<{ product: string, usagePercent: number }>,
 * 	prepaidBalance: number | null,
 * 	onDemandCap: number | null,
 * 	onDemandUsed: number | null,
 * 	isUnifiedBillingUser: boolean | null,
 * } | null}
 */
export function normalizeGrokCreditsBilling(raw) {
	const root = objectValue(raw);
	const config = objectValue(root?.config);
	if (!config) return null;

	const currentPeriod = objectValue(config.currentPeriod);
	const products = [];
	const productUsage = Array.isArray(config.productUsage) ? config.productUsage : [];
	for (const entry of productUsage) {
		const item = objectValue(entry);
		const product = stringValue(item?.product);
		const usagePercent = numberValue(item?.usagePercent);
		if (!product || usagePercent === undefined) continue;
		products.push({ product, usagePercent });
	}

	const creditUsagePercent = numberValue(config.creditUsagePercent)
		?? (hasConfirmedZeroUsagePeriod(config, currentPeriod) ? 0 : undefined);
	const prepaidBalance = numberValue(config.prepaidBalance);
	const onDemandCap = numberValue(config.onDemandCap);
	const onDemandUsed = numberValue(config.onDemandUsed);

	return {
		creditUsagePercent: creditUsagePercent ?? null,
		period: {
			type: stringValue(currentPeriod?.type)
				?? stringValue(config.periodType)
				?? null,
			start: stringValue(currentPeriod?.start)
				?? stringValue(config.billingPeriodStart)
				?? null,
			end: stringValue(currentPeriod?.end)
				?? stringValue(config.billingPeriodEnd)
				?? null,
		},
		products,
		prepaidBalance: prepaidBalance ?? null,
		onDemandCap: onDemandCap ?? null,
		onDemandUsed: onDemandUsed ?? null,
		isUnifiedBillingUser: typeof config.isUnifiedBillingUser === "boolean"
			? config.isUnifiedBillingUser
			: null,
	};
}

/**
 * Fetch SuperGrok weekly credits usage.
 * @param {object} account - Grok account with accessToken
 * @param {{ fetchFn?: typeof fetch, timeoutMs?: number, url?: string }} [options]
 * @returns {Promise<{ success: boolean, usage?: object, error?: string, status?: number }>}
 */
export async function fetchGrokUsage(account, options = {}) {
	const accessToken = account?.accessToken ?? account?.access_token ?? null;
	if (!accessToken) {
		return { success: false, error: "No authentication token available" };
	}

	const fetchFn = options.fetchFn ?? fetch;
	const url = options.url ?? GROK_BILLING_URL;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? GROK_TIMEOUT_MS);

	try {
		const res = await fetchFn(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				accept: "application/json",
			},
			signal: controller.signal,
		});

		if (res.status === 401 || res.status === 403) {
			return { success: false, error: "Grok sign-in required", status: res.status };
		}
		if (!res.ok) {
			let detail = "";
			try {
				detail = (await res.text()).trim();
			} catch {
				// ignore
			}
			return {
				success: false,
				error: detail
					? `HTTP ${res.status}: ${detail.slice(0, 200)}`
					: `HTTP ${res.status}`,
				status: res.status,
			};
		}

		let body;
		try {
			body = await res.json();
		} catch {
			return { success: false, error: "Invalid JSON response" };
		}

		const usage = normalizeGrokCreditsBilling(body);
		if (!usage) {
			return { success: false, error: "Grok quota unavailable" };
		}

		return { success: true, usage };
	} catch (e) {
		const message = e?.name === "AbortError" ? "Request timed out" : (e?.message ?? String(e));
		return { success: false, error: message };
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Optionally enrich account with email from OIDC userinfo.
 * Failures are ignored — quota still works without email.
 * @param {object} account
 * @param {{ fetchFn?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<object>}
 */
export async function enrichGrokAccountFromUserinfo(account, options = {}) {
	if (account?.email) return account;
	const accessToken = account?.accessToken ?? account?.access_token ?? null;
	if (!accessToken) return account;

	const fetchFn = options.fetchFn ?? fetch;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? GROK_TIMEOUT_MS);

	try {
		const res = await fetchFn(XAI_OAUTH_USERINFO_URL, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				accept: "application/json",
			},
			signal: controller.signal,
		});
		if (!res.ok) return account;
		const body = await res.json();
		if (typeof body?.email === "string" && body.email) {
			account.email = body.email;
		}
		if (!account.accountId && typeof body?.sub === "string") {
			account.accountId = body.sub;
		}
	} catch {
		// ignore
	} finally {
		clearTimeout(timeout);
	}
	return account;
}
