/**
 * Codex usage API fetch.
 * Depends on: lib/constants.js
 */

import { USAGE_URL } from "./constants.js";

export async function fetchUsage(account) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15000);

	try {
		const res = await fetch(USAGE_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${account.access}`,
				accept: "application/json",
				"chatgpt-account-id": account.accountId,
				originator: "codex_cli_rs",
			},
			signal: controller.signal,
		});
		if (!res.ok) {
			return { error: `HTTP ${res.status}` };
		}
		return await res.json();
	} catch (e) {
		return { error: e.message };
	} finally {
		clearTimeout(timeout);
	}
}
