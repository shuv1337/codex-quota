/**
 * Tests for Synthetic quota support.
 * Run with: bun test synthetic.test.js
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	SYNTHETIC_QUOTAS_URL,
	SYNTHETIC_TIMEOUT_MS,
	normalizeSyntheticAccount,
	loadSyntheticAccountsFromEnv,
	loadSyntheticAccountsFromIntegrationDb,
	loadAllSyntheticAccounts,
	normalizeSyntheticQuotas,
	fetchSyntheticUsage,
	buildSyntheticUsageLines,
	printHelp,
	printHelpSynthetic,
} from "./codex-quota.js";

const QUOTAS = {
	subscription: { limit: 500, requests: 125, renewsAt: "2026-08-07T00:00:00Z" },
	search: {
		hourly: { limit: 250, requests: 50, renewsAt: "2026-08-06T08:00:00Z" },
	},
	freeToolCalls: { limit: 0, requests: 0, renewsAt: "2026-08-07T00:00:00Z" },
	weeklyTokenLimit: {
		percentRemaining: 74.15,
		maxCredits: "$24.00",
		remainingCredits: "$17.79",
		nextRegenAt: "2026-08-06T10:00:00Z",
		nextRegenCredits: "$0.48",
	},
	rollingFiveHourLimit: {
		remaining: 408,
		max: 500,
		nextTickAt: "2026-08-06T07:25:00Z",
		tickPercent: 0.05,
		limited: false,
	},
};

describe("Synthetic constants", () => {
	test("uses the v2 quota endpoint and a positive timeout", () => {
		expect(SYNTHETIC_QUOTAS_URL).toBe("https://api.synthetic.new/v2/quotas");
		expect(SYNTHETIC_TIMEOUT_MS).toBeGreaterThan(0);
	});
});

describe("Synthetic account discovery", () => {
	const dbPath = join(tmpdir(), `codex-quota-synthetic-${process.pid}.db`);
	let originalApiKey;
	let originalAccounts;
	let originalLabel;

	beforeEach(() => {
		originalApiKey = process.env.SYNTHETIC_API_KEY;
		originalAccounts = process.env.SYNTHETIC_ACCOUNTS;
		originalLabel = process.env.SYNTHETIC_LABEL;
		delete process.env.SYNTHETIC_API_KEY;
		delete process.env.SYNTHETIC_ACCOUNTS;
		delete process.env.SYNTHETIC_LABEL;
		writeFileSync(dbPath, "placeholder");
	});

	afterEach(() => {
		if (originalApiKey === undefined) delete process.env.SYNTHETIC_API_KEY;
		else process.env.SYNTHETIC_API_KEY = originalApiKey;
		if (originalAccounts === undefined) delete process.env.SYNTHETIC_ACCOUNTS;
		else process.env.SYNTHETIC_ACCOUNTS = originalAccounts;
		if (originalLabel === undefined) delete process.env.SYNTHETIC_LABEL;
		else process.env.SYNTHETIC_LABEL = originalLabel;
		rmSync(dbPath, { force: true });
	});

	test("normalizes database JSON without exposing extra fields", () => {
		expect(normalizeSyntheticAccount('{"type":"key","key":"sk-test"}', {
			label: "default",
			source: "/tmp/db",
		})).toEqual({
			label: "default",
			apiKey: "sk-test",
			source: "/tmp/db",
			credentialId: null,
		});
	});

	test("loads single and multi-account environment formats", () => {
		process.env.SYNTHETIC_API_KEY = "single-key";
		process.env.SYNTHETIC_LABEL = "main";
		process.env.SYNTHETIC_ACCOUNTS = JSON.stringify([
			{ label: "work", apiKey: "work-key" },
		]);
		const accounts = loadSyntheticAccountsFromEnv();
		expect(accounts.map(account => account.label)).toEqual(["main", "work"]);
	});

	test("loads integration credentials through the injectable SQLite seam", async () => {
		let closed = false;
		class FakeDatabase {
			prepare() {
				return {
					all: () => [{ id: "cred-1", label: "default", value: '{"key":"db-key"}' }],
				};
			}
			close() {
				closed = true;
			}
		}
		const accounts = await loadSyntheticAccountsFromIntegrationDb(dbPath, {
			DatabaseSync: FakeDatabase,
		});
		expect(accounts[0]).toMatchObject({ label: "default", apiKey: "db-key" });
		expect(closed).toBe(true);
	});

	test("deduplicates the same key with environment precedence", async () => {
		process.env.SYNTHETIC_API_KEY = "same-key";
		class FakeDatabase {
			prepare() {
				return { all: () => [{ id: "1", label: "db", value: '{"key":"same-key"}' }] };
			}
			close() {}
		}
		const accounts = await loadAllSyntheticAccounts({ dbPath, DatabaseSync: FakeDatabase });
		expect(accounts).toHaveLength(1);
		expect(accounts[0].source).toBe("env:SYNTHETIC_API_KEY");
	});
});

describe("Synthetic quota API", () => {
	test("normalizes all supported quota windows", () => {
		const usage = normalizeSyntheticQuotas(QUOTAS);
		expect(usage.subscription.percentRemaining).toBe(75);
		expect(usage.searchHourly.percentRemaining).toBe(80);
		expect(usage.rollingFiveHourLimit.percentRemaining).toBeCloseTo(81.6);
		expect(usage.weeklyTokenLimit.remainingCredits).toBe("$17.79");
		expect(usage.freeToolCalls).toBeNull();
	});

	test("fetches with bearer authorization and returns no credential", async () => {
		let request;
		const result = await fetchSyntheticUsage({ apiKey: "secret-key" }, {
			fetchFn: async (url, options) => {
				request = { url, options };
				return { ok: true, status: 200, json: async () => QUOTAS };
			},
		});
		expect(request.url).toBe(SYNTHETIC_QUOTAS_URL);
		expect(request.options.headers.Authorization).toBe("Bearer secret-key");
		expect(JSON.stringify(result)).not.toContain("secret-key");
		expect(result.success).toBe(true);
	});

	test("maps authentication failures", async () => {
		const result = await fetchSyntheticUsage({ apiKey: "bad" }, {
			fetchFn: async () => ({ ok: false, status: 401 }),
		});
		expect(result).toEqual({
			success: false,
			error: "Synthetic API key is invalid",
			status: 401,
		});
	});
});

describe("Synthetic display and help", () => {
	test("renders quota windows and omits zero-limit tool calls", () => {
		const lines = buildSyntheticUsageLines(
			{ label: "default", source: "/tmp/integration.db" },
			{ success: true, usage: normalizeSyntheticQuotas(QUOTAS) },
			{ noColor: true },
		);
		const text = lines.join("\n");
		expect(text).toContain("Synthetic (default)");
		expect(text).toContain("5h tokens:");
		expect(text).toContain("Weekly credits:");
		expect(text).toContain("Requests:");
		expect(text).toContain("Search hourly:");
		expect(text).not.toContain("Free tool");
		expect(text).not.toContain("apiKey");
	});

	test("main and provider help include Synthetic", () => {
		const output = [];
		const originalLog = console.log;
		console.log = value => output.push(value);
		try {
			printHelp();
			printHelpSynthetic();
		} finally {
			console.log = originalLog;
		}
		expect(output.join("\n")).toContain("synthetic");
		expect(output.join("\n")).toContain("SYNTHETIC_API_KEY");
	});
});
