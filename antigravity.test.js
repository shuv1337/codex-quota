/**
 * Tests for Google AI Pro / Antigravity quota support.
 * Run with: bun test antigravity.test.js
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	ANTIGRAVITY_CLOUD_CODE_URL,
	ANTIGRAVITY_METHOD_ID,
	ANTIGRAVITY_TOKEN_URL,
	ANTIGRAVITY_TIMEOUT_MS,
	ANTIGRAVITY_USER_AGENT,
	normalizeAntigravityAccount,
	splitAntigravityRefresh,
	loadAntigravityAccountsFromEnv,
	loadAntigravityAccountsFromV1File,
	loadAntigravityAccountsFromIntegrationDb,
	loadAllAntigravityAccounts,
	normalizeAntigravityQuota,
	fetchAntigravityUsage,
	isAntigravityTokenExpiring,
	refreshAntigravityToken,
	ensureFreshAntigravityToken,
	buildAntigravityUsageLines,
	printHelp,
	printHelpAntigravity,
} from "./shuvquota.js";

const QUOTA = {
	groups: [
		{
			displayName: "Gemini Models",
			buckets: [
				{
					bucketId: "gemini-weekly",
					displayName: "Weekly Limit Remaining",
					window: "weekly",
					resetTime: "2026-08-20T21:12:04Z",
					remainingFraction: 0.8171796,
				},
				{
					bucketId: "gemini-5h",
					displayName: "Five Hour Limit Remaining",
					window: "5h",
					resetTime: "2026-08-15T01:30:19Z",
					remainingFraction: 0.0040261,
				},
			],
		},
		{
			displayName: "Claude and GPT models",
			buckets: [
				{
					bucketId: "3p-weekly",
					displayName: "Weekly Limit Remaining",
					window: "weekly",
					resetTime: "2026-08-21T22:06:03Z",
					remainingFraction: 1,
				},
				{
					bucketId: "3p-5h",
					displayName: "Five Hour Limit Remaining",
					window: "5h",
					resetTime: "2026-08-15T03:06:03Z",
					remainingFraction: 1,
				},
			],
		},
	],
};

describe("Antigravity constants", () => {
	test("uses Cloud Code and a positive timeout", () => {
		expect(ANTIGRAVITY_CLOUD_CODE_URL).toBe("https://daily-cloudcode-pa.googleapis.com");
		expect(ANTIGRAVITY_TOKEN_URL).toBe("https://oauth2.googleapis.com/token");
		expect(ANTIGRAVITY_METHOD_ID).toBe("google-ai-pro");
		expect(ANTIGRAVITY_TIMEOUT_MS).toBeGreaterThan(0);
		expect(ANTIGRAVITY_USER_AGENT).toContain("antigravity/cli/");
	});
});

describe("Antigravity account discovery", () => {
	const dbPath = join(tmpdir(), `shuvquota-antigravity-${process.pid}.db`);
	const v1Path = join(tmpdir(), `shuvquota-antigravity-${process.pid}.json`);
	let originalRefresh;
	let originalAccounts;
	let originalLabel;

	beforeEach(() => {
		originalRefresh = process.env.ANTIGRAVITY_REFRESH;
		originalAccounts = process.env.ANTIGRAVITY_ACCOUNTS;
		originalLabel = process.env.ANTIGRAVITY_LABEL;
		delete process.env.ANTIGRAVITY_REFRESH;
		delete process.env.ANTIGRAVITY_ACCESS;
		delete process.env.ANTIGRAVITY_ACCOUNTS;
		delete process.env.ANTIGRAVITY_LABEL;
		delete process.env.ANTIGRAVITY_PROJECT;
		writeFileSync(dbPath, "placeholder");
	});

	afterEach(() => {
		if (originalRefresh === undefined) delete process.env.ANTIGRAVITY_REFRESH;
		else process.env.ANTIGRAVITY_REFRESH = originalRefresh;
		if (originalAccounts === undefined) delete process.env.ANTIGRAVITY_ACCOUNTS;
		else process.env.ANTIGRAVITY_ACCOUNTS = originalAccounts;
		if (originalLabel === undefined) delete process.env.ANTIGRAVITY_LABEL;
		else process.env.ANTIGRAVITY_LABEL = originalLabel;
		delete process.env.ANTIGRAVITY_ACCESS;
		delete process.env.ANTIGRAVITY_PROJECT;
		rmSync(dbPath, { force: true });
		rmSync(v1Path, { force: true });
	});

	test("splits a V1 compound refresh token", () => {
		expect(splitAntigravityRefresh("1//abc|canvas-wallaby-dvmxc")).toEqual({
			refresh: "1//abc",
			projectId: "canvas-wallaby-dvmxc",
		});
	});

	test("normalizes a shuvcode google-ai-pro credential", () => {
		expect(normalizeAntigravityAccount({
			type: "oauth",
			methodID: "google-ai-pro",
			access: "ya29.a",
			refresh: "1//abc",
			expires: 1_786_748_153_121,
			metadata: {
				email: "user@gmail.com",
				projectId: "canvas-wallaby-dvmxc",
				paidTier: "g1-pro-tier",
			},
		}, {
			label: "user@gmail.com",
			source: "/tmp/opencode.db",
		})).toMatchObject({
			label: "user@gmail.com",
			access: "ya29.a",
			refresh: "1//abc",
			projectId: "canvas-wallaby-dvmxc",
			email: "user@gmail.com",
			paidTier: "g1-pro-tier",
			source: "/tmp/opencode.db",
		});
	});

	test("ignores Google API-key credentials", () => {
		expect(normalizeAntigravityAccount({ type: "key", key: "AIza" })).toBeNull();
	});

	test("loads environment and V1 accounts", () => {
		process.env.ANTIGRAVITY_REFRESH = "1//env";
		process.env.ANTIGRAVITY_PROJECT = "env-project";
		process.env.ANTIGRAVITY_LABEL = "env";
		writeFileSync(v1Path, JSON.stringify({
			activeIndex: 0,
			accounts: [{ refreshToken: "1//v1|v1-project", email: "v1@gmail.com" }],
		}));
		expect(loadAntigravityAccountsFromEnv()[0]).toMatchObject({
			label: "env",
			refresh: "1//env",
			projectId: "env-project",
		});
		expect(loadAntigravityAccountsFromV1File(v1Path)[0]).toMatchObject({
			refresh: "1//v1",
			projectId: "v1-project",
			email: "v1@gmail.com",
		});
	});

	test("loads integration credentials through the injectable SQLite seam", async () => {
		let closed = false;
		class FakeDatabase {
			prepare() {
				return {
					all: () => [{
						id: "cred-1",
						label: "user@gmail.com",
						value: JSON.stringify({
							type: "oauth",
							methodID: "google-ai-pro",
							refresh: "1//db",
							access: "ya29.db",
							metadata: { projectId: "db-project" },
						}),
					}],
				};
			}
			close() {
				closed = true;
			}
		}
		const accounts = await loadAntigravityAccountsFromIntegrationDb(dbPath, {
			DatabaseSync: FakeDatabase,
		});
		expect(accounts[0]).toMatchObject({
			label: "user@gmail.com",
			refresh: "1//db",
			projectId: "db-project",
		});
		expect(closed).toBe(true);
	});

	test("prefers a live shuvcode credential over a stale V1 refresh for the same project", async () => {
		writeFileSync(v1Path, JSON.stringify({
			accounts: [{ refreshToken: "1//stale|canvas-wallaby-dvmxc" }],
		}));
		class FakeDatabase {
			prepare() {
				return {
					all: () => [{
						id: "1",
						label: "user@gmail.com",
						value: JSON.stringify({
							type: "oauth",
							methodID: "google-ai-pro",
							access: "ya29.live",
							refresh: "1//live",
							metadata: { email: "user@gmail.com", projectId: "canvas-wallaby-dvmxc" },
						}),
					}],
				};
			}
			close() {}
		}
		const accounts = await loadAllAntigravityAccounts({
			dbPaths: [dbPath],
			v1Path,
			DatabaseSync: FakeDatabase,
		});
		expect(accounts).toHaveLength(1);
		expect(accounts[0].access).toBe("ya29.live");
	});

	test("deduplicates the same refresh with environment precedence", async () => {
		process.env.ANTIGRAVITY_REFRESH = "1//same";
		class FakeDatabase {
			prepare() {
				return {
					all: () => [{
						id: "1",
						label: "db",
						value: JSON.stringify({
							type: "oauth",
							methodID: "google-ai-pro",
							refresh: "1//same",
						}),
					}],
				};
			}
			close() {}
		}
		const accounts = await loadAllAntigravityAccounts({
			dbPaths: [dbPath],
			v1Path: join(tmpdir(), "missing-antigravity.json"),
			DatabaseSync: FakeDatabase,
		});
		expect(accounts).toHaveLength(1);
		expect(accounts[0].source).toBe("env:ANTIGRAVITY_REFRESH");
	});
});

describe("Antigravity quota API", () => {
	test("normalizes Gemini and 3P buckets", () => {
		const usage = normalizeAntigravityQuota(QUOTA);
		expect(usage.groups).toHaveLength(2);
		expect(usage.groups[0].id).toBe("gemini");
		expect(usage.groups[0].buckets[1].percentRemaining).toBeCloseTo(0.40261);
		expect(usage.groups[1].id).toBe("3p");
		expect(usage.groups[1].buckets[0].percentRemaining).toBe(100);
	});

	test("fetches with bearer auth and project body", async () => {
		let request;
		const result = await fetchAntigravityUsage({
			access: "ya29.secret",
			projectId: "canvas-wallaby-dvmxc",
		}, {
			fetchFn: async (url, options) => {
				request = { url, options };
				return { ok: true, status: 200, json: async () => QUOTA };
			},
		});
		expect(request.url).toBe(`${ANTIGRAVITY_CLOUD_CODE_URL}/v1internal:retrieveUserQuotaSummary`);
		expect(request.options.headers.Authorization).toBe("Bearer ya29.secret");
		expect(JSON.parse(request.options.body)).toEqual({ project: "canvas-wallaby-dvmxc" });
		expect(result.success).toBe(true);
		expect(result.usage.groups[0].buckets[0].bucketId).toBe("gemini-weekly");
	});

	test("loads a missing project id before fetching quota", async () => {
		const urls = [];
		const result = await fetchAntigravityUsage({ access: "ya29.secret" }, {
			fetchFn: async (url) => {
				urls.push(url);
				if (url.endsWith("loadCodeAssist")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({ cloudaicompanionProject: "loaded-project" }),
					};
				}
				return { ok: true, status: 200, json: async () => QUOTA };
			},
		});
		expect(urls[0]).toContain("loadCodeAssist");
		expect(result.success).toBe(true);
	});

	test("returns auth errors without leaking tokens", async () => {
		const result = await fetchAntigravityUsage({
			access: "ya29.secret",
			projectId: "proj",
		}, {
			fetchFn: async () => ({ ok: false, status: 401, text: async () => "nope" }),
		});
		expect(result).toEqual({
			success: false,
			error: "Google AI Pro sign-in required",
			status: 401,
		});
	});
});

describe("Antigravity token refresh", () => {
	let originalClientId;
	let originalClientSecret;

	beforeEach(() => {
		originalClientId = process.env.ANTIGRAVITY_CLIENT_ID;
		originalClientSecret = process.env.ANTIGRAVITY_CLIENT_SECRET;
		process.env.ANTIGRAVITY_CLIENT_ID = "test-client-id";
		process.env.ANTIGRAVITY_CLIENT_SECRET = "test-client-secret";
	});

	afterEach(() => {
		if (originalClientId === undefined) delete process.env.ANTIGRAVITY_CLIENT_ID;
		else process.env.ANTIGRAVITY_CLIENT_ID = originalClientId;
		if (originalClientSecret === undefined) delete process.env.ANTIGRAVITY_CLIENT_SECRET;
		else process.env.ANTIGRAVITY_CLIENT_SECRET = originalClientSecret;
	});

	test("treats missing expiry as expiring", () => {
		expect(isAntigravityTokenExpiring("ya29.a", Date.now() + 60_000)).toBe(true);
		expect(isAntigravityTokenExpiring("ya29.a", Date.now() + 10 * 60_000)).toBe(false);
	});

	test("refreshes in memory and keeps the current refresh token", async () => {
		const account = {
			access: "old",
			refresh: "1//same",
			expires: Date.now() - 1000,
		};
		const result = await ensureFreshAntigravityToken(account, {
			fetchFn: async (url, options) => {
				expect(url).toBe(ANTIGRAVITY_TOKEN_URL);
				expect(options.body.get("refresh_token")).toBe("1//same");
				return {
					ok: true,
					text: async () => JSON.stringify({ access_token: "ya29.new", expires_in: 3600 }),
				};
			},
		});
		expect(result).toEqual({ ok: true, refreshed: true });
		expect(account.access).toBe("ya29.new");
		expect(account.refresh).toBe("1//same");
	});

	test("requires a configured OAuth client", async () => {
		delete process.env.ANTIGRAVITY_CLIENT_ID;
		delete process.env.ANTIGRAVITY_CLIENT_SECRET;
		const result = await refreshAntigravityToken("1//x", {
			fetchFn: async () => {
				throw new Error("should not fetch");
			},
		});
		expect(result.error).toContain("ANTIGRAVITY_CLIENT_ID");
	});

	test("refreshGrok-style HTTP errors stay status-prefixed", async () => {
		const result = await refreshAntigravityToken("1//x", {
			fetchFn: async () => ({
				ok: false,
				status: 400,
				text: async () => '{"error":"invalid_grant"}',
			}),
		});
		expect(result.error).toContain("HTTP 400");
	});
});

describe("Antigravity display", () => {
	test("printHelp mentions the namespace", () => {
		const lines = [];
		const original = console.log;
		console.log = (value) => lines.push(String(value));
		printHelp();
		printHelpAntigravity();
		console.log = original;
		const text = lines.join("\n");
		expect(text).toContain("antigravity");
		expect(text).toContain("Google AI Pro");
	});

	test("renders Gemini 5h and weekly remaining", () => {
		const lines = buildAntigravityUsageLines({
			label: "user@gmail.com",
			paidTier: "g1-pro-tier",
			source: "/tmp/opencode.db",
		}, { success: true, usage: normalizeAntigravityQuota(QUOTA) });
		expect(lines[0]).toContain("Antigravity");
		expect(lines[0]).toContain("Google AI Pro");
		expect(lines.some(line => line.includes("Gemini 5h"))).toBe(true);
		expect(lines.some(line => line.includes("Gemini weekly"))).toBe(true);
	});
});
