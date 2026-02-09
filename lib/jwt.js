/**
 * JWT decode and profile/account extraction.
 * Depends only on lib/constants.js.
 */

import { JWT_CLAIM, JWT_PROFILE } from "./constants.js";

export function decodeJWT(token) {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = Buffer.from(parts[1], "base64").toString("utf-8");
		return JSON.parse(payload);
	} catch {
		return null;
	}
}

export function extractAccountId(accessToken) {
	const payload = decodeJWT(accessToken);
	return payload?.[JWT_CLAIM]?.chatgpt_account_id ?? null;
}

export function extractProfile(accessToken) {
	const payload = decodeJWT(accessToken);
	const auth = payload?.[JWT_CLAIM] ?? {};
	const profile = payload?.[JWT_PROFILE] ?? {};
	return {
		email: profile.email ?? null,
		planType: auth.chatgpt_plan_type ?? null,
		userId: auth.chatgpt_user_id ?? null,
	};
}
