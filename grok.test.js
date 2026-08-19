/**
 * Tests for SuperGrok / Grok OAuth quota (Phase A)
 * Run with: bun test grok.test.js
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
	writeFileSync,
	mkdirSync,
	rmSync,
	readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	XAI_OAUTH_CLIENT_ID,
	XAI_OAUTH_TOKEN_URL,
	GROK_BILLING_URL,
	GROK_TIMEOUT_MS,
	XAI_OAUTH_REFRESH_BUFFER_MS,
	XAI_TOKEN_FIELDS,
	extractGrokProfile,
	resolveGrokExpiresAt,
	isValidGrokAccount,
	loadGrokAccountsFromPiAuth,
	loadGrokAccountsFromOpencodeAuth,
	loadGrokAccountsFromHermesAuth,
	loadGrokAccountsFromEnv,
	mergeGrokAccountCandidates,
	loadAllGrokAccounts,
	isGrokTokenExpiring,
	refreshGrokToken,
	sourceMatchesRotatedTokens,
	persistGrokTokens,
	ensureFreshGrokToken,
	normalizeGrokCreditsBilling,
	fetchGrokUsage,
	buildGrokUsageLines,
	formatGrokPeriodReset,
	printHelp,
	printHelpGrok,
	printHelpGrokQuota,
	visibleLength,
	measureLinesWidth,
	sharedBoxMinWidth,
	drawBox,
	drawQuotaBox,
	QUOTA_BOX_MAX_WIDTH,
	formatQuotaBarLine,
	QUOTA_LABEL_WIDTH,
} from "./shuvquota.js";

function makeGrokJwt(claims = {}) {
	const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({
		iss: "https://auth.x.ai",
		sub: "user-sub-1",
		principal_id: "user-sub-1",
		tier: 5,
		team_id: "team-1",
		exp: Math.floor(Date.now() / 1000) + 3600,
		iat: Math.floor(Date.now() / 1000),
		...claims,
	})).toString("base64url");
	return `${header}.${payload}.sig`;
}

describe("Grok constants", () => {
	test("XAI_OAUTH_CLIENT_ID matches SuperGrok public client", () => {
		expect(XAI_OAUTH_CLIENT_ID).toBe("b1a00492-073a-47ea-816f-4c329264a828");
	});

	test("GROK_BILLING_URL uses credits format on cli-chat-proxy", () => {
		expect(GROK_BILLING_URL).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
	});

	test("XAI_OAUTH_TOKEN_URL is auth.x.ai", () => {
		expect(XAI_OAUTH_TOKEN_URL).toBe("https://auth.x.ai/oauth2/token");
	});

	test("refresh buffer and timeout are positive numbers", () => {
		expect(XAI_OAUTH_REFRESH_BUFFER_MS).toBe(5 * 60 * 1000);
		expect(GROK_TIMEOUT_MS).toBe(15000);
	});

	test("XAI_TOKEN_FIELDS covers pi and hermes key styles", () => {
		expect(XAI_TOKEN_FIELDS.access).toContain("access");
		expect(XAI_TOKEN_FIELDS.access).toContain("access_token");
		expect(XAI_TOKEN_FIELDS.refresh).toContain("refresh");
		expect(XAI_TOKEN_FIELDS.refresh).toContain("refresh_token");
	});
});

describe("extractGrokProfile", () => {
	test("reads sub, team, and tier from JWT", () => {
		const token = makeGrokJwt({ sub: "abc", principal_id: "abc", tier: 5, team_id: "t1" });
		const profile = extractGrokProfile(token);
		expect(profile.accountId).toBe("abc");
		expect(profile.teamId).toBe("t1");
		expect(profile.tier).toBe(5);
	});

	test("returns nulls for invalid token", () => {
		expect(extractGrokProfile("not-a-jwt")).toEqual({
			accountId: null,
			teamId: null,
			tier: null,
			email: null,
		});
	});
});

describe("resolveGrokExpiresAt", () => {
	test("uses explicit ms expiry", () => {
		const ms = Date.now() + 10_000;
		expect(resolveGrokExpiresAt(ms, null)).toBe(ms);
	});

	test("converts second-scale numbers to ms", () => {
		expect(resolveGrokExpiresAt(1_700_000_000, null)).toBe(1_700_000_000_000);
	});

	test("falls back to JWT exp", () => {
		const expSec = Math.floor(Date.now() / 1000) + 120;
		const token = makeGrokJwt({ exp: expSec });
		expect(resolveGrokExpiresAt(null, token)).toBe(expSec * 1000);
	});
});

describe("isValidGrokAccount", () => {
	test("requires accountId and a token", () => {
		expect(isValidGrokAccount({ accountId: "a", accessToken: "t" })).toBe(true);
		expect(isValidGrokAccount({ accountId: "a", refreshToken: "r" })).toBe(true);
		expect(isValidGrokAccount({ accountId: "a" })).toBe(false);
		expect(isValidGrokAccount(null)).toBe(false);
	});
});

describe("normalizeGrokCreditsBilling", () => {
	test("normalizes weekly credits payload", () => {
		const usage = normalizeGrokCreditsBilling({
			config: {
				currentPeriod: {
					type: "USAGE_PERIOD_TYPE_WEEKLY",
					start: "2026-07-08T00:00:00Z",
					end: "2026-07-15T00:00:00Z",
				},
				creditUsagePercent: 32,
				productUsage: [
					{ product: "Api", usagePercent: 19 },
					{ product: "GrokBuild", usagePercent: 13 },
				],
				prepaidBalance: { val: 2000 },
				onDemandCap: { val: 0 },
				onDemandUsed: { val: 0 },
				isUnifiedBillingUser: true,
			},
		});
		expect(usage.creditUsagePercent).toBe(32);
		expect(usage.products).toEqual([
			{ product: "Api", usagePercent: 19 },
			{ product: "GrokBuild", usagePercent: 13 },
		]);
		expect(usage.prepaidBalance).toBe(2000);
		expect(usage.period.type).toBe("USAGE_PERIOD_TYPE_WEEKLY");
		expect(usage.period.end).toBe("2026-07-15T00:00:00Z");
	});

	test("returns null without config", () => {
		expect(normalizeGrokCreditsBilling({})).toBeNull();
		expect(normalizeGrokCreditsBilling(null)).toBeNull();
	});

	test("treats an omitted proto3 percent as zero for a confirmed weekly period", () => {
		const usage = normalizeGrokCreditsBilling({
			config: {
				currentPeriod: {
					type: "USAGE_PERIOD_TYPE_WEEKLY",
					start: "2026-08-19T02:30:16.863135+00:00",
					end: "2026-08-26T02:30:16.863135+00:00",
				},
				billingPeriodStart: "2026-08-19T02:30:16.863135+00:00",
				billingPeriodEnd: "2026-08-26T02:30:16.863135+00:00",
				isUnifiedBillingUser: true,
			},
		});

		expect(usage.creditUsagePercent).toBe(0);
		expect(usage.products).toEqual([]);
	});

	test("keeps an omitted percent unknown when period bounds do not match", () => {
		const usage = normalizeGrokCreditsBilling({
			config: {
				currentPeriod: {
					type: "USAGE_PERIOD_TYPE_WEEKLY",
					start: "2026-08-19T02:30:16.863135+00:00",
					end: "2026-08-26T02:30:16.863135+00:00",
				},
				billingPeriodStart: "2026-08-01T00:00:00Z",
				billingPeriodEnd: "2026-09-01T00:00:00Z",
			},
		});

		expect(usage.creditUsagePercent).toBeNull();
	});
});

describe("loadGrokAccountsFromPiAuth", () => {
	const dir = join(tmpdir(), `shuvquota-grok-pi-${Date.now()}`);
	const authPath = join(dir, "auth.json");

	beforeEach(() => {
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("loads xai-oauth entry", () => {
		const access = makeGrokJwt({ sub: "pi-user" });
		writeFileSync(authPath, JSON.stringify({
			"xai-oauth": {
				type: "oauth",
				access,
				refresh: "refresh-pi",
				expires: Date.now() + 60_000,
				token_endpoint: XAI_OAUTH_TOKEN_URL,
			},
		}));
		const accounts = loadGrokAccountsFromPiAuth(authPath);
		expect(accounts).toHaveLength(1);
		expect(accounts[0].accountId).toBe("pi-user");
		expect(accounts[0].refreshToken).toBe("refresh-pi");
		expect(accounts[0].sources[0].kind).toBe("pi-auth");
		expect(accounts[0].sources[0].providerKey).toBe("xai-oauth");
	});

	test("loads xai entry used by current shuvpi sessions", () => {
		const access = makeGrokJwt({ sub: "pi-xai-user" });
		writeFileSync(authPath, JSON.stringify({
			xai: {
				type: "oauth",
				access,
				refresh: "refresh-xai",
				expires: Date.now() + 60_000,
			},
		}));
		const accounts = loadGrokAccountsFromPiAuth(authPath);
		expect(accounts).toHaveLength(1);
		expect(accounts[0].accountId).toBe("pi-xai-user");
		expect(accounts[0].refreshToken).toBe("refresh-xai");
		expect(accounts[0].sources[0].providerKey).toBe("xai");
	});

	test("loads both xai and xai-oauth when present", () => {
		const staleAccess = makeGrokJwt({ sub: "same-user", exp: Math.floor(Date.now() / 1000) - 3600 });
		const freshAccess = makeGrokJwt({ sub: "same-user", exp: Math.floor(Date.now() / 1000) + 7200 });
		const staleExp = Date.now() - 60_000;
		const freshExp = Date.now() + 120_000;
		writeFileSync(authPath, JSON.stringify({
			"xai-oauth": {
				type: "oauth",
				access: staleAccess,
				refresh: "stale-refresh",
				expires: staleExp,
			},
			xai: {
				type: "oauth",
				access: freshAccess,
				refresh: "fresh-refresh",
				expires: freshExp,
			},
		}));
		const accounts = loadGrokAccountsFromPiAuth(authPath);
		expect(accounts).toHaveLength(2);
		const keys = accounts.map(a => a.sources[0].providerKey).sort();
		expect(keys).toEqual(["xai", "xai-oauth"]);

		// loadAll path merges by accountId and keeps the fresher session
		const merged = loadAllGrokAccounts({
			piAuthPaths: [authPath],
			opencodeAuthPath: join(dir, "missing-opencode.json"),
			hermesAuthPath: join(dir, "missing-hermes.json"),
			includeEnv: false,
		});
		expect(merged).toHaveLength(1);
		expect(merged[0].refreshToken).toBe("fresh-refresh");
		expect(merged[0].expiresAt).toBe(freshExp);
		expect(merged[0].sources).toHaveLength(2);
	});

	test("returns empty for missing file", () => {
		expect(loadGrokAccountsFromPiAuth(join(dir, "missing.json"))).toEqual([]);
	});
});

describe("loadGrokAccountsFromOpencodeAuth", () => {
	const dir = join(tmpdir(), `shuvquota-grok-oc-${Date.now()}`);
	const authPath = join(dir, "auth.json");

	beforeEach(() => {
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("loads xai entry", () => {
		const access = makeGrokJwt({ sub: "oc-user" });
		writeFileSync(authPath, JSON.stringify({
			xai: { type: "oauth", access, refresh: "refresh-oc", expires: Date.now() + 60_000 },
		}));
		const accounts = loadGrokAccountsFromOpencodeAuth(authPath);
		expect(accounts).toHaveLength(1);
		expect(accounts[0].accountId).toBe("oc-user");
		expect(accounts[0].sources[0].kind).toBe("opencode-auth");
	});
});

describe("loadGrokAccountsFromHermesAuth", () => {
	const dir = join(tmpdir(), `shuvquota-grok-hermes-${Date.now()}`);
	const authPath = join(dir, "auth.json");

	beforeEach(() => {
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("loads pool and provider tokens", () => {
		const access = makeGrokJwt({ sub: "hermes-user" });
		writeFileSync(authPath, JSON.stringify({
			credential_pool: {
				"xai-oauth": [{
					label: "device_code",
					access_token: access,
					refresh_token: "refresh-hermes",
				}],
			},
			providers: {
				"xai-oauth": {
					tokens: {
						access_token: access,
						refresh_token: "refresh-hermes",
						expires_in: 21600,
					},
				},
			},
		}));
		const accounts = loadGrokAccountsFromHermesAuth(authPath);
		expect(accounts.length).toBeGreaterThanOrEqual(1);
		expect(accounts.every(a => a.accountId === "hermes-user")).toBe(true);
	});
});

describe("loadGrokAccountsFromEnv", () => {
	let original;

	beforeEach(() => {
		original = process.env.GROK_ACCOUNTS;
	});

	afterEach(() => {
		if (original === undefined) delete process.env.GROK_ACCOUNTS;
		else process.env.GROK_ACCOUNTS = original;
	});

	test("loads array from env", () => {
		const access = makeGrokJwt({ sub: "env-user" });
		process.env.GROK_ACCOUNTS = JSON.stringify([{
			label: "personal",
			access,
			refresh: "refresh-env",
			expires: Date.now() + 60_000,
		}]);
		const accounts = loadGrokAccountsFromEnv();
		expect(accounts).toHaveLength(1);
		expect(accounts[0].label).toBe("personal");
		expect(accounts[0].accountId).toBe("env-user");
		expect(accounts[0].source).toBe("env");
	});
});

describe("mergeGrokAccountCandidates", () => {
	test("unions sources and keeps fresher tokens", () => {
		const older = {
			label: "grok",
			accountId: "u1",
			accessToken: "old-access",
			refreshToken: "old-refresh",
			expiresAt: 100,
			source: "/a",
			sources: [{ kind: "pi-auth", path: "/a", previousAccess: "old-access", previousRefresh: "old-refresh" }],
		};
		const newer = {
			label: "grok",
			accountId: "u1",
			accessToken: "new-access",
			refreshToken: "new-refresh",
			expiresAt: 200,
			source: "/b",
			sources: [{ kind: "opencode-auth", path: "/b", previousAccess: "new-access", previousRefresh: "new-refresh" }],
		};
		const merged = mergeGrokAccountCandidates(older, newer);
		expect(merged.accessToken).toBe("new-access");
		expect(merged.sources).toHaveLength(2);
	});
});

describe("loadAllGrokAccounts", () => {
	const dir = join(tmpdir(), `shuvquota-grok-all-${Date.now()}`);
	const piPath = join(dir, "pi-auth.json");
	const ocPath = join(dir, "oc-auth.json");

	beforeEach(() => {
		mkdirSync(dir, { recursive: true });
		delete process.env.GROK_ACCOUNTS;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		delete process.env.GROK_ACCOUNTS;
	});

	test("dedupes same sub across stores", () => {
		const access = makeGrokJwt({ sub: "shared-user" });
		const expires = Date.now() + 120_000;
		writeFileSync(piPath, JSON.stringify({
			"xai-oauth": { type: "oauth", access, refresh: "same-refresh", expires },
		}));
		writeFileSync(ocPath, JSON.stringify({
			xai: { type: "oauth", access, refresh: "same-refresh", expires },
		}));

		const accounts = loadAllGrokAccounts({
			piAuthPaths: [piPath],
			opencodeAuthPath: ocPath,
			hermesAuthPath: join(dir, "missing-hermes.json"),
			includeEnv: false,
		});
		expect(accounts).toHaveLength(1);
		expect(accounts[0].accountId).toBe("shared-user");
		expect(accounts[0].sources.length).toBe(2);
	});
});

describe("sourceMatchesRotatedTokens", () => {
	test("matches on refresh when both sides have one; access is fallback only", () => {
		expect(sourceMatchesRotatedTokens(
			{ previousRefresh: "r1", previousAccess: "a1" },
			{ previousRefresh: "r1", previousAccess: "a9" },
		)).toBe(true);
		// Diverged refresh must not match even if access is shared
		expect(sourceMatchesRotatedTokens(
			{ previousRefresh: "r9", previousAccess: "a1" },
			{ previousRefresh: "r1", previousAccess: "a1" },
		)).toBe(false);
		expect(sourceMatchesRotatedTokens(
			{ previousRefresh: "r9", previousAccess: "a9" },
			{ previousRefresh: "r1", previousAccess: "a1" },
		)).toBe(false);
		// Access fallback when refresh is missing on a side
		expect(sourceMatchesRotatedTokens(
			{ previousRefresh: null, previousAccess: "a1" },
			{ previousRefresh: "r1", previousAccess: "a1" },
		)).toBe(true);
	});
});

describe("persistGrokTokens fan-out", () => {
	const dir = join(tmpdir(), `shuvquota-grok-persist-${Date.now()}`);
	const piPath = join(dir, "pi.json");
	const ocPath = join(dir, "oc.json");
	const hermesPath = join(dir, "hermes.json");

	beforeEach(() => {
		mkdirSync(dir, { recursive: true });
		const access = makeGrokJwt({ sub: "persist-user" });
		writeFileSync(piPath, JSON.stringify({
			"xai-oauth": { type: "oauth", access, refresh: "old-refresh", expires: 1 },
			other: { keep: true },
		}, null, 2));
		writeFileSync(ocPath, JSON.stringify({
			xai: { type: "oauth", access, refresh: "old-refresh", expires: 1 },
			openai: { type: "oauth", access: "keep-me" },
		}, null, 2));
		writeFileSync(hermesPath, JSON.stringify({
			credential_pool: {
				"xai-oauth": [{
					label: "device_code",
					access_token: access,
					refresh_token: "old-refresh",
				}],
			},
			providers: {
				"xai-oauth": {
					tokens: {
						access_token: access,
						refresh_token: "old-refresh",
						expires_in: 100,
					},
				},
			},
		}, null, 2));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("writes rotated tokens to every matching store and preserves siblings", () => {
		const oldAccess = JSON.parse(readFileSync(piPath, "utf-8"))["xai-oauth"].access;
		const account = {
			accountId: "persist-user",
			sources: [
				{ kind: "pi-auth", path: piPath, providerKey: "xai-oauth", previousAccess: oldAccess, previousRefresh: "old-refresh" },
				{ kind: "opencode-auth", path: ocPath, providerKey: "xai", previousAccess: oldAccess, previousRefresh: "old-refresh" },
				{ kind: "hermes-pool", path: hermesPath, previousAccess: oldAccess, previousRefresh: "old-refresh" },
				{ kind: "hermes-provider", path: hermesPath, previousAccess: oldAccess, previousRefresh: "old-refresh" },
			],
		};
		const tokens = {
			accessToken: makeGrokJwt({ sub: "persist-user", exp: Math.floor(Date.now() / 1000) + 7200 }),
			refreshToken: "new-refresh",
			expiresAt: Date.now() + 7_200_000,
			expiresIn: 7200,
		};
		const result = persistGrokTokens(account, tokens, {
			previousAccess: oldAccess,
			previousRefresh: "old-refresh",
		});
		expect(result.errors).toEqual([]);
		expect(result.updatedPaths.sort()).toEqual([hermesPath, ocPath, piPath].sort());

		const pi = JSON.parse(readFileSync(piPath, "utf-8"));
		expect(pi["xai-oauth"].refresh).toBe("new-refresh");
		expect(pi["xai-oauth"].access).toBe(tokens.accessToken);
		expect(pi.other.keep).toBe(true);

		const oc = JSON.parse(readFileSync(ocPath, "utf-8"));
		expect(oc.xai.refresh).toBe("new-refresh");
		expect(oc.openai.access).toBe("keep-me");

		const hermes = JSON.parse(readFileSync(hermesPath, "utf-8"));
		expect(hermes.credential_pool["xai-oauth"][0].refresh_token).toBe("new-refresh");
		expect(hermes.providers["xai-oauth"].tokens.refresh_token).toBe("new-refresh");
	});

	test("does not overwrite a store with a different refresh token", () => {
		const diverged = JSON.parse(readFileSync(ocPath, "utf-8"));
		diverged.xai.refresh = "other-session-refresh";
		writeFileSync(ocPath, JSON.stringify(diverged, null, 2));

		const oldAccess = JSON.parse(readFileSync(piPath, "utf-8"))["xai-oauth"].access;
		const account = {
			sources: [
				{ kind: "pi-auth", path: piPath, providerKey: "xai-oauth", previousAccess: oldAccess, previousRefresh: "old-refresh" },
				{ kind: "opencode-auth", path: ocPath, providerKey: "xai", previousAccess: oldAccess, previousRefresh: "other-session-refresh" },
			],
		};
		const tokens = {
			accessToken: "brand-new-access",
			refreshToken: "brand-new-refresh",
			expiresAt: Date.now() + 1000,
		};
		const result = persistGrokTokens(account, tokens, {
			previousAccess: oldAccess,
			previousRefresh: "old-refresh",
		});
		expect(result.updatedPaths).toEqual([piPath]);
		const oc = JSON.parse(readFileSync(ocPath, "utf-8"));
		expect(oc.xai.refresh).toBe("other-session-refresh");
	});
});

describe("isGrokTokenExpiring and ensureFreshGrokToken", () => {
	const dir = join(tmpdir(), `shuvquota-grok-fresh-${Date.now()}`);
	const piPath = join(dir, "pi.json");

	beforeEach(() => {
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("isGrokTokenExpiring respects buffer", () => {
		const soon = Date.now() + 1000;
		expect(isGrokTokenExpiring("x", soon, 5000)).toBe(true);
		const later = Date.now() + 60_000;
		expect(isGrokTokenExpiring("x", later, 5000)).toBe(false);
	});

	test("skips refresh when access is still fresh", async () => {
		const access = makeGrokJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
		const account = {
			accessToken: access,
			refreshToken: "r",
			expiresAt: Date.now() + 3_600_000,
			sources: [],
		};
		const result = await ensureFreshGrokToken(account, {
			fetchFn: async () => {
				throw new Error("should not refresh");
			},
		});
		expect(result.ok).toBe(true);
		expect(result.refreshed).toBe(false);
	});

	test("refreshes and fans out when expiring", async () => {
		const oldAccess = makeGrokJwt({ sub: "fresh-user", exp: Math.floor(Date.now() / 1000) - 10 });
		writeFileSync(piPath, JSON.stringify({
			"xai-oauth": { type: "oauth", access: oldAccess, refresh: "old-refresh", expires: Date.now() - 1000 },
		}, null, 2));
		const newAccess = makeGrokJwt({ sub: "fresh-user", exp: Math.floor(Date.now() / 1000) + 3600 });
		const account = {
			accountId: "fresh-user",
			accessToken: oldAccess,
			refreshToken: "old-refresh",
			expiresAt: Date.now() - 1000,
			sources: [{
				kind: "pi-auth",
				path: piPath,
				providerKey: "xai-oauth",
				previousAccess: oldAccess,
				previousRefresh: "old-refresh",
			}],
		};
		const result = await ensureFreshGrokToken(account, {
			bufferMs: 60_000,
			fetchFn: async () => ({
				ok: true,
				async text() {
					return JSON.stringify({
						access_token: newAccess,
						refresh_token: "rotated-refresh",
						expires_in: 21600,
					});
				},
			}),
		});
		expect(result.ok).toBe(true);
		expect(result.refreshed).toBe(true);
		expect(account.refreshToken).toBe("rotated-refresh");
		expect(account.accessToken).toBe(newAccess);
		const written = JSON.parse(readFileSync(piPath, "utf-8"));
		expect(written["xai-oauth"].refresh).toBe("rotated-refresh");
		expect(written["xai-oauth"].access).toBe(newAccess);
	});
});

describe("refreshGrokToken", () => {
	test("posts refresh_token grant", async () => {
		let seenBody = "";
		const result = await refreshGrokToken("r-token", {
			fetchFn: async (_url, init) => {
				seenBody = String(init.body);
				return {
					ok: true,
					async text() {
						return JSON.stringify({
							access_token: "a",
							refresh_token: "r2",
							expires_in: 100,
						});
					},
				};
			},
		});
		expect(result.access_token).toBe("a");
		expect(result.refresh_token).toBe("r2");
		expect(seenBody).toContain("grant_type=refresh_token");
		expect(seenBody).toContain(XAI_OAUTH_CLIENT_ID);
	});

	test("returns error on HTTP failure", async () => {
		const result = await refreshGrokToken("r", {
			fetchFn: async () => ({
				ok: false,
				status: 400,
				async text() { return "bad"; },
			}),
		});
		expect(result.error).toContain("HTTP 400");
	});
});

describe("fetchGrokUsage", () => {
	test("returns normalized credits usage", async () => {
		const result = await fetchGrokUsage({ accessToken: "t" }, {
			fetchFn: async () => ({
				ok: true,
				status: 200,
				async json() {
					return {
						config: {
							creditUsagePercent: 10,
							productUsage: [{ product: "Api", usagePercent: 10 }],
							prepaidBalance: { val: 5 },
							billingPeriodStart: "s",
							billingPeriodEnd: "e",
						},
					};
				},
			}),
		});
		expect(result.success).toBe(true);
		expect(result.usage.creditUsagePercent).toBe(10);
		expect(result.usage.prepaidBalance).toBe(5);
	});

	test("maps 401 to sign-in required", async () => {
		const result = await fetchGrokUsage({ accessToken: "t" }, {
			fetchFn: async () => ({
				ok: false,
				status: 401,
				async text() { return ""; },
			}),
		});
		expect(result.success).toBe(false);
		expect(result.error).toBe("Grok sign-in required");
	});
});

describe("buildGrokUsageLines", () => {
	test("renders compact Codex/Claude-style limit lines", () => {
		const periodEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
		const lines = buildGrokUsageLines(
			{ label: "personal", email: "a@b.com", tier: 5, source: "/tmp/auth.json" },
			{
				success: true,
				usage: {
					creditUsagePercent: 32,
					products: [
						{ product: "Api", usagePercent: 19 },
						{ product: "GrokBuild", usagePercent: 13 },
					],
					prepaidBalance: 2000,
					period: {
						type: "USAGE_PERIOD_TYPE_WEEKLY",
						start: "2026-07-08T02:30:16.863135+00:00",
						end: periodEnd,
					},
				},
			},
			{ noColor: true },
		);
		const text = lines.join("\n");
		expect(text).toContain("Grok");
		expect(text).toContain("a***@b.com");
		expect(text).not.toContain("<a@b.com>");
		expect(text).toContain("Credits:");
		expect(text).toContain("68% left"); // 100-32
		expect(text).toContain("Api:");
		expect(text).toContain("GrokBuild:");
		expect(text).toContain("Prepaid:");
		expect(text).toContain("resets");
		// No raw ISO period dump or "% used" noise
		expect(text).not.toContain("USAGE_PERIOD_TYPE_WEEKLY");
		expect(text).not.toContain("% used");
		expect(text).not.toContain("2026-07-08T02:30:16");
	});

	test("renders error payload", () => {
		const lines = buildGrokUsageLines(
			{ label: "grok" },
			{ success: false, error: "boom" },
			{},
		);
		expect(lines.join("\n")).toContain("boom");
	});

	test("formatGrokPeriodReset uses relative reset phrasing", () => {
		const end = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
		const text = formatGrokPeriodReset(end, "inline");
		expect(text).toContain("resets");
	});
});

describe("Grok help output", () => {
	let consoleOutput;
	let originalConsoleLog;

	beforeEach(() => {
		originalConsoleLog = console.log;
		consoleOutput = [];
		console.log = (...args) => {
			consoleOutput.push(args.join(" "));
		};
	});

	afterEach(() => {
		console.log = originalConsoleLog;
	});

	test("printHelpGrok mentions SuperGrok and fan-out", () => {
		printHelpGrok();
		const output = consoleOutput.join("\n");
		expect(output).toContain("shuvquota");
		expect(output).toContain("SuperGrok");
		expect(output).toContain("refresh");
	});

	test("printHelpGrokQuota lists sources", () => {
		printHelpGrokQuota();
		const output = consoleOutput.join("\n");
		expect(output).toContain("GROK_ACCOUNTS");
		expect(output).toContain("Hermes");
	});

	test("main help includes grok namespace", () => {
		printHelp();
		const output = consoleOutput.join("\n");
		expect(output).toContain("grok");
	});
});

describe("uniform box width", () => {
	test("visibleLength ignores ANSI color codes", () => {
		expect(visibleLength("hello")).toBe(5);
		expect(visibleLength("\u001b[32mhello\u001b[0m")).toBe(5);
	});

	test("sharedBoxMinWidth uses the widest content set", () => {
		const short = ["hi"];
		const long = ["this is a much longer line of content"];
		expect(sharedBoxMinWidth([short, long], 10)).toBe(measureLinesWidth(long));
		expect(sharedBoxMinWidth([short], 70)).toBe(70);
	});

	test("drawBox with shared minWidth produces equal outer widths", () => {
		const a = ["Codex short"];
		const b = ["Claude (work)", "Weekly limit: something longer here for width"];
		const c = ["Grok mid"];
		const width = sharedBoxMinWidth([a, b, c]);
		const boxes = [a, b, c].map(lines => drawBox(lines, width));
		const outer = boxes.map(box => visibleLength(box[0]));
		expect(outer[0]).toBe(outer[1]);
		expect(outer[1]).toBe(outer[2]);
		for (const box of boxes) {
			for (const row of box) {
				expect(visibleLength(row)).toBe(outer[0]);
			}
		}
	});

	test("drawBox wraps content inside a narrow terminal width", () => {
		const lines = [
			"Codex (prolite) <s***@shuv.dev> (pro)",
			"",
			formatQuotaBarLine("Weekly limit", 100, "(resets 21:18 on 22 Jul)"),
			"  Source: ~/.codex-accounts.json",
		];
		const box = drawBox(lines, sharedBoxMinWidth([lines]), 50);

		expect(box.every(line => visibleLength(line) === 50)).toBe(true);
		expect(box.join("\n")).toContain("│ Weekly limit: [████████████████████] 100% left │");
		expect(box.join("\n")).toContain("│               (resets 21:18 on 22 Jul)");
	});

	test("drawBox keeps reset metadata together when a bar consumes the first row", () => {
		const line = formatQuotaBarLine("Weekly limit", 100, "(resets 21:18 on 22 Jul)");
		const box = drawBox([line], 70, 40);

		expect(box.every(row => visibleLength(row) === 40)).toBe(true);
		expect(box.join("\n")).toContain("│               100% left");
		expect(box.join("\n")).toContain("│   (resets 21:18 on 22 Jul)");
		expect(box.join("\n")).not.toContain("100% left (resets");
	});

	test("drawBox preserves ANSI styling when wrapped", () => {
		const line = "\u001b[32mAdded an account with a deliberately long label\u001b[0m";
		const box = drawBox([line], 10, 28);

		expect(box.length).toBeGreaterThan(3);
		expect(box.every(row => visibleLength(row) === 28)).toBe(true);
		expect(box.slice(1, -1).every(row => row.includes("\u001b[32m"))).toBe(true);
		expect(box.slice(1, -1).every(row => row.includes("\u001b[0m"))).toBe(true);
	});

	test("drawQuotaBox prefers a narrow card even when the terminal is wider", () => {
		const line = formatQuotaBarLine("Weekly limit", 100, "(resets 21:18 on 22 Jul)");
		const box = drawQuotaBox([line]);

		expect(QUOTA_BOX_MAX_WIDTH).toBe(50);
		expect(box.every(row => visibleLength(row) === QUOTA_BOX_MAX_WIDTH)).toBe(true);
		expect(box.join("\n")).toContain("(resets 21:18 on 22 Jul)");
	});
});

describe("quota bar alignment", () => {
	test("bars share one start column across labels", () => {
		const lines = [
			formatQuotaBarLine("5h limit", 100),
			formatQuotaBarLine("Weekly limit", 80, "(resets 10:59 on 19 Jul)"),
			formatQuotaBarLine("Fable weekly", 63, "(resets 10:59 on 19 Jul)"),
			formatQuotaBarLine("Credits", 67, "(resets 19:30)"),
			formatQuotaBarLine("Api", 78),
			formatQuotaBarLine("GrokBuild", 87),
			formatQuotaBarLine("Sonnet weekly", 50),
		];
		const idxs = lines.map(l => l.indexOf("["));
		expect(new Set(idxs).size).toBe(1);
		expect(idxs[0]).toBe(QUOTA_LABEL_WIDTH);
	});
});
