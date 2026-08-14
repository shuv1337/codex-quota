import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	QuotaLoadError,
	buildAllowedHosts,
	buildQuotaSnapshot,
	createQuotaLoader,
	createShuvquotaServer,
	executeQuotaCli,
	getMimeType,
	isAllowedHost,
	maskEmail,
	parseShuvquotaPort,
	resolveStaticFile,
	sanitizeDisplayText,
} from "./shuvquota.js";
import { riskFor } from "./web/quota-risk.js";

const FIXED_NOW = new Date("2026-07-16T12:00:00.000Z");

function completeRawPayload() {
	return {
		codex: [{
			label: "work<script>",
			email: "user@example.com",
			accountId: "acct-secret",
			planType: "pro",
			source: "/home/private/auth.json",
			accessToken: "access-secret",
			usage: {
				rate_limit: {
					primary_window: {
						used_percent: 120,
						reset_at: 1784217600,
						limit_window_seconds: 18000,
					},
					secondary_window: {
						remaining_percent: 65,
						reset_after_seconds: 3600,
						limit_window_seconds: 604800,
					},
				},
				additional_rate_limits: [{
					limit_name: "code_review",
					rate_limit: {
						primary_window: {
							used_percent: 44,
							limit_window_seconds: 86400,
						},
					},
				}],
				rate_limit_reset_credits: {
					available_count: 2,
					refresh_token: "never-return-this",
					credits: [
						{ id: "credit-secret", expires_at: "2026-08-01T00:00:00Z" },
						{ id: "credit-secret-2", expires_at: "2026-07-28T00:00:00Z" },
					],
				},
			},
		}],
		claude: [{
			success: true,
			label: "max",
			subscriptionType: "claude_max",
			source: "/home/private/.credentials.json",
			account: { email: "claude@example.net", id: "raw-id" },
			usage: {
				five_hour: {
					utilization: 0.5,
					resets_at: "2026-07-16T14:00:00Z",
				},
				seven_day: { remaining_percent: 80 },
				limits: [{
					kind: "weekly_scoped",
					group: "weekly",
					percent: 95,
					scope: { model: { display_name: "Fable" }, id: "scope-secret" },
				}],
			},
		}],
		factory: [{
			label: "factory",
			email: "factory@example.org",
			accountId: "factory-secret",
			org: "private-org",
			source: "/private/factory.json",
			usage: {
				percent: -12,
				used: 25,
				limit: 100,
				billingPeriod: { start: "2026-07-01", end: "2026-07-31" },
				data: [{ raw: "large-provider-payload" }],
			},
		}],
		grok: [{
			label: "grok",
			email: "grok@example.dev",
			accountId: "grok-secret",
			teamId: "team-secret",
			tier: 3,
			refreshed: true,
			source: "/private/grok.json",
			usage: {
				creditUsagePercent: 32,
				period: {
					start: "2026-07-10T00:00:00Z",
					end: "2026-07-17T00:00:00Z",
				},
				products: [
					{ product: "Api", usagePercent: 12 },
					{ product: "GrokBuild", usagePercent: 101 },
				],
				prepaidBalance: 12345,
			},
		}],
		synthetic: [{
			label: "synthetic<script>",
			source: "/private/synthetic.db",
			apiKey: "sk-synthetic-secret",
			usage: {
				subscription: { percentRemaining: 75, renewsAt: "2026-08-07T00:00:00Z" },
				searchHourly: { percentRemaining: 80, renewsAt: "2026-08-06T08:00:00Z" },
				weeklyTokenLimit: {
					percentRemaining: 74.15,
					remainingCredits: "$17.79",
					maxCredits: "$24.00",
					nextRegenAt: "2026-08-06T10:00:00Z",
				},
				rollingFiveHourLimit: {
					percentRemaining: 81.6,
					nextTickAt: "2026-08-06T07:25:00Z",
				},
			},
		}],
		antigravity: [{
			label: "antigravity<script>",
			email: "agy@example.com",
			projectId: "canvas-secret",
			paidTier: "g1-pro-tier",
			source: "/private/opencode.db",
			access: "ya29.secret",
			refresh: "1//secret",
			usage: {
				groups: [
					{
						id: "gemini",
						displayName: "Gemini Models",
						buckets: [
							{
								bucketId: "gemini-weekly",
								displayName: "Weekly Limit Remaining",
								window: "weekly",
								resetTime: "2026-08-20T21:12:04Z",
								remainingFraction: 0.82,
							},
							{
								bucketId: "gemini-5h",
								displayName: "Five Hour Limit Remaining",
								window: "5h",
								resetTime: "2026-08-15T01:30:19Z",
								remainingFraction: 0.004,
							},
						],
					},
				],
			},
		}],
		"opencode-go": [{
			label: "dashboard<script>",
			source: "/private/opencode-go/auth.json",
			authCookie: "opencode-auth-cookie-secret",
			workspaceId: "opencode-workspace-secret",
			rawHtml: "<html>opencode-raw-html-secret</html>",
			usage: {
				source: "dashboard",
				rollingUsage: {
					usagePercent: 25,
					remainingPercent: 75,
					resetInSec: 1800,
					resetAt: null,
				},
				weeklyUsage: {
					usagePercent: 60,
					remainingPercent: 40,
					resetAt: "2026-07-20T00:00:00Z",
				},
				monthlyUsage: {
					usagePercent: 10,
					remainingPercent: 90,
					resetAt: "2026-08-01T00:00:00Z",
				},
				unknownDashboardField: "opencode-unknown-secret",
			},
		}],
		divergence: {
			codex: { diverged: true, cliAccountId: "do-not-return" },
			claude: { diverged: false, stores: ["/private/store"] },
		},
	};
}

describe("buildQuotaSnapshot", () => {
	test("normalizes the shuvquota provider shapes into the browser DTO", () => {
		const snapshot = buildQuotaSnapshot(completeRawPayload(), FIXED_NOW);

		expect(snapshot.schemaVersion).toBe(1);
		expect(snapshot.generatedAt).toBe("2026-07-16T12:00:00.000Z");
		expect(snapshot.providers.map(provider => provider.id)).toEqual([
			"codex",
			"claude",
			"grok",
			"synthetic",
			"antigravity",
			"opencode-go",
		]);
		expect(snapshot.summary).toEqual({ providerCount: 6, accountCount: 6, attention: 4 });
		expect(snapshot.divergence).toEqual({ codex: true, claude: false });

		const codex = snapshot.providers[0].accounts[0];
		expect(codex.label).toBe("workscript");
		expect(codex.email).toBe("u***@example.com");
		expect(codex.plan).toBe("Pro");
		expect(codex.status).toBe("attention");
		expect(codex.windows).toHaveLength(3);
		expect(codex.windows[0]).toEqual({
			id: "session",
			label: "Session",
			usedPercent: 100,
			remainingPercent: 0,
			resetAt: "2026-07-16T16:00:00.000Z",
			windowSeconds: 18000,
		});
		expect(codex.windows[1].resetAt).toBe("2026-07-16T13:00:00.000Z");
		expect(codex.windows[2].label).toBe("Code Review");
		expect(codex.bankedResets).toEqual({
			availableCount: 2,
			expirations: ["2026-07-28T00:00:00.000Z", "2026-08-01T00:00:00.000Z"],
		});

		const claude = snapshot.providers[1].accounts[0];
		expect(claude.email).toBe("c***@example.net");
		expect(claude.plan).toBe("Max");
		expect(claude.windows.find(window => window.id === "session").usedPercent).toBe(50);
		expect(claude.windows.find(window => window.id === "fable-weekly").remainingPercent).toBe(5);
		expect(claude.status).toBe("attention");

		const grok = snapshot.providers[2].accounts[0];
		expect(grok.plan).toBe("SuperGrok");
		expect(grok.windows.map(window => window.usedPercent)).toEqual([32, 12, 100]);
		expect(grok.status).toBe("attention");

		const synthetic = snapshot.providers[3].accounts[0];
		expect(synthetic.label).toBe("syntheticscript");
		expect(synthetic.plan).toBe("Synthetic");
		expect(synthetic.status).toBe("ok");
		expect(synthetic.windows.map(window => window.id)).toEqual(["5h", "weekly", "requests", "search"]);
		expect(synthetic.windows[0].remainingPercent).toBe(81.6);

		const antigravity = snapshot.providers[4].accounts[0];
		expect(antigravity.label).toBe("antigravityscript");
		expect(antigravity.email).toBe("a***@example.com");
		expect(antigravity.plan).toBe("Google AI Pro");
		expect(antigravity.status).toBe("attention");
		expect(antigravity.windows[0].label).toBe("Weekly");
		expect(antigravity.windows[1]).toMatchObject({
			label: "5h",
			remainingPercent: 0.4,
			windowSeconds: 18000,
		});

		const opencodeGoProvider = snapshot.providers[5];
		expect(opencodeGoProvider).toMatchObject({ id: "opencode-go", name: "OpenCode Go" });
		const opencodeGo = opencodeGoProvider.accounts[0];
		expect(opencodeGo.label).toBe("dashboardscript");
		expect(opencodeGo.plan).toBe("Go");
		expect(opencodeGo.status).toBe("ok");
		expect(opencodeGo.windows).toEqual([
			{
				id: "rolling",
				label: "5h",
				usedPercent: 25,
				remainingPercent: 75,
				resetAt: "2026-07-16T12:30:00.000Z",
				windowSeconds: 18000,
			},
			{
				id: "weekly",
				label: "Weekly",
				usedPercent: 60,
				remainingPercent: 40,
				resetAt: "2026-07-20T00:00:00.000Z",
				windowSeconds: 604800,
			},
			{
				id: "monthly",
				label: "Monthly",
				usedPercent: 10,
				remainingPercent: 90,
				resetAt: "2026-08-01T00:00:00.000Z",
				windowSeconds: null,
			},
		]);
	});

	test("excludes Factory data even when the combined CLI payload contains it", () => {
		const snapshot = buildQuotaSnapshot({
			factory: [{
				label: "must-not-render",
				accountId: "factory-secret",
			}],
		}, FIXED_NOW);

		expect(snapshot.providers.map(provider => provider.id)).toEqual([
			"codex",
			"claude",
			"grok",
			"synthetic",
			"antigravity",
			"opencode-go",
		]);
		expect(snapshot.summary).toEqual({ providerCount: 6, accountCount: 0 });
		expect(JSON.stringify(snapshot)).not.toContain("factory-secret");
		expect(JSON.stringify(snapshot)).not.toContain("must-not-render");
	});

	test("drops paths, raw IDs, tokens, detailed usage, refresh data, and raw divergence", () => {
		const serialized = JSON.stringify(buildQuotaSnapshot(completeRawPayload(), FIXED_NOW));
		for (const secret of [
			"acct-secret",
			"access-secret",
			"never-return-this",
			"credit-secret",
			"/home/private",
			"/private/",
			"factory-secret",
			"grok-secret",
			"team-secret",
			"scope-secret",
			"do-not-return",
			"large-provider-payload",
			"prepaidBalance",
			"refreshed",
			"authCookie",
			"opencode-auth-cookie-secret",
			"workspaceId",
			"opencode-workspace-secret",
			"rawHtml",
			"opencode-raw-html-secret",
			"opencode-unknown-secret",
			"/private/opencode-go/auth.json",
			"canvas-secret",
			"ya29.secret",
			"1//secret",
			"/private/opencode.db",
			"sk-synthetic-secret",
			"/private/synthetic.db",
		]) {
			expect(serialized).not.toContain(secret);
		}
		expect(serialized).not.toContain("user@example.com");
		expect(serialized).not.toContain("claude@example.net");
	});

	test("preserves partial accounts while categorizing provider errors safely", () => {
		const snapshot = buildQuotaSnapshot({
			codex: [{
				label: "expired",
				email: "person@example.com",
				usage: { error: "HTTP 401 token sk-secret at /home/shuv/auth.json" },
			}],
			claude: [{
				success: true,
				label: "partial",
				usage: { five_hour: { utilization: 10 } },
				errors: { account: "a raw backend exception with secrets" },
			}],
		}, FIXED_NOW);

		expect(snapshot.providers[0].accounts[0].status).toBe("error");
		expect(snapshot.providers[0].error).toBe("Authentication required");
		expect(snapshot.providers[1].accounts[0].status).toBe("ok");
		expect(snapshot.providers[1].error).toBe("Some quota data is unavailable");
		const serialized = JSON.stringify(snapshot);
		expect(serialized).not.toContain("sk-secret");
		expect(serialized).not.toContain("/home/shuv");
		expect(serialized).not.toContain("backend exception");
	});

	test("categorizes OpenCode Go dashboard errors without exposing scrape credentials", () => {
		const snapshot = buildQuotaSnapshot({
			"opencode-go": [{
				label: "go",
				source: "/private/opencode-go-error-source",
				authCookie: "error-auth-cookie-secret",
				workspaceId: "error-workspace-secret",
				rawHtml: "error-raw-html-secret",
				error: "HTTP 403 authCookie=error-auth-cookie-secret workspace=error-workspace-secret",
			}],
		}, FIXED_NOW);

		const provider = snapshot.providers.find(item => item.id === "opencode-go");
		expect(provider.error).toBe("Authentication required");
		expect(provider.accounts[0]).toMatchObject({
			label: "go",
			plan: "Go",
			status: "error",
			windows: [],
		});
		const serialized = JSON.stringify(snapshot);
		for (const secret of [
			"error-auth-cookie-secret",
			"error-workspace-secret",
			"error-raw-html-secret",
			"/private/opencode-go-error-source",
		]) {
			expect(serialized).not.toContain(secret);
		}
	});

	test("handles a global CLI error without reflecting it", () => {
		const snapshot = buildQuotaSnapshot({
			success: false,
			error: "catastrophic failure: refresh_token=secret /private/file",
		}, FIXED_NOW);
		expect(snapshot.providers.every(provider => provider.error === "Authentication required")).toBe(true);
		expect(JSON.stringify(snapshot)).not.toContain("refresh_token");
	});

	test("accepts bare-boolean combined divergence fields", () => {
		const snapshot = buildQuotaSnapshot({
			codex: [],
			claude: [],
			divergence: { codex: true, claude: false },
		}, FIXED_NOW);
		expect(snapshot.divergence).toEqual({ codex: true, claude: false });
		expect(snapshot.providers[2].name).toBe("SuperGrok");
		expect(snapshot.providers[3].name).toBe("Synthetic");
		expect(snapshot.providers[4].name).toBe("Antigravity");
		expect(snapshot.providers[5].name).toBe("OpenCode Go");
	});
});

describe("display sanitization", () => {
	test("masks valid email and omits malformed identity values", () => {
		expect(maskEmail("  Person@Example.COM ")).toBe("P***@example.com");
		expect(maskEmail("not-an-email")).toBeNull();
		expect(maskEmail("token@localhost")).toBeNull();
	});

	test("removes controls and markup from short display strings", () => {
		expect(sanitizeDisplayText(" hello\n<script>& world ")).toBe("hello script world");
	});
});

describe("quota runway risk", () => {
	test("labels zero remaining quota as exhausted", () => {
		expect(riskFor({ status: "attention" }, { remainingPercent: 0 })).toEqual({
			id: "exhausted",
			label: "Exhausted",
			copy: "No quota remaining",
		});
	});

	test("keeps non-zero low quota in the tight state", () => {
		expect(riskFor({ status: "attention" }, { remainingPercent: 0.1 })).toEqual({
			id: "tight",
			label: "Tight",
			copy: "Likely to exhaust",
		});
	});

	test("does not mistake missing quota for exhausted quota", () => {
		expect(riskFor({ status: "ok" }, { remainingPercent: null })).toEqual({
			id: "unknown",
			label: "Not reported",
			copy: "No current runway",
		});
	});
});

describe("quota process execution", () => {
	test("uses execFile with exact arguments, no shell, timeout, and a bounded buffer", async () => {
		let invocation;
		const output = await executeQuotaCli({
			cliPath: "/repo/codex-quota.js",
			timeoutMs: 1234,
			execFileFn(command, args, options, callback) {
				invocation = { command, args, options };
				callback(null, "{}\n", "ignored stderr");
			},
		});
		expect(output).toBe("{}");
		expect(invocation.command).toBe(process.execPath);
		expect(invocation.args).toEqual([
			"/repo/codex-quota.js",
			"--json",
			"--no-color",
			"--local",
			"--no-factory",
		]);
		expect(invocation.options.shell).toBe(false);
		expect(invocation.options.timeout).toBe(1234);
		expect(invocation.options.maxBuffer).toBe(2 * 1024 * 1024);
	});

	test("converts a killed child into a non-reflective timeout error", async () => {
		const failure = executeQuotaCli({
			execFileFn(_command, _args, _options, callback) {
				const error = Object.assign(new Error("raw secret timeout output"), {
					killed: true,
					signal: "SIGTERM",
				});
				callback(error, "sensitive stdout", "sensitive stderr");
			},
		});
		await expect(failure).rejects.toMatchObject({
			code: "CLI_TIMEOUT",
			safeMessage: "Quota request timed out",
		});
	});

	test("accepts valid JSON status output from a non-zero CLI", async () => {
		const output = await executeQuotaCli({
			execFileFn(_command, _args, _options, callback) {
				callback(Object.assign(new Error("exit 1"), { code: 1 }), '{"error":"No accounts found"}', "");
			},
		});
		expect(output).toContain("No accounts found");
	});
});

describe("quota loader", () => {
	test("single-flights concurrent scans and serves the short success cache", async () => {
		let calls = 0;
		let release;
		const pending = new Promise(resolvePromise => {
			release = resolvePromise;
		});
		const clock = { value: 1000 };
		const loader = createQuotaLoader({
			execute: async () => {
				calls += 1;
				await pending;
				return completeRawPayload();
			},
			now: () => new Date(clock.value),
			cacheMs: 5000,
		});
		const first = loader.getSnapshot();
		const second = loader.getSnapshot();
		expect(calls).toBe(1);
		release();
		const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
		expect(firstSnapshot).toBe(secondSnapshot);
		expect(firstSnapshot.scanDurationMs).toBe(0);
		expect(await loader.getSnapshot()).toBe(firstSnapshot);
		expect(calls).toBe(1);
	});

	test("rejects invalid JSON and cools down failures without re-running", async () => {
		let calls = 0;
		const loader = createQuotaLoader({
			execute: async () => {
				calls += 1;
				return "not json and includes secret-token";
			},
			failureCooldownMs: 10_000,
		});
		await expect(loader.getSnapshot()).rejects.toMatchObject({
			code: "INVALID_JSON",
			safeMessage: "Quota data unavailable",
		});
		await expect(loader.getSnapshot()).rejects.toBeInstanceOf(QuotaLoadError);
		expect(calls).toBe(1);
	});
});

describe("host and entry point configuration", () => {
	test("allows configured names port-insensitively alongside localhost defaults", () => {
		const allowed = buildAllowedHosts("shuvdev.tail586a6d.ts.net, quota.internal:8443", "127.0.0.1");
		expect(isAllowedHost("shuvdev.tail586a6d.ts.net:4789", allowed)).toBe(true);
		expect(isAllowedHost("quota.internal:443", allowed)).toBe(true);
		expect(isAllowedHost("localhost:9999", allowed)).toBe(true);
		expect(isAllowedHost("attacker.example", allowed)).toBe(false);
		expect(isAllowedHost("shuvdev.tail586a6d.ts.net@attacker.example", allowed)).toBe(false);
	});

	test("validates the server port", () => {
		expect(parseShuvquotaPort(undefined)).toBe(4789);
		expect(parseShuvquotaPort("8443")).toBe(8443);
		expect(() => parseShuvquotaPort("0")).toThrow();
		expect(() => parseShuvquotaPort("not-a-port")).toThrow();
	});
});

describe("static file resolution and MIME", () => {
	let root;
	let outside;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "shuvquota-static-"));
		outside = `${root}-outside.txt`;
		writeFileSync(join(root, "index.html"), "<!doctype html><title>shuvquota</title>");
		writeFileSync(join(root, "app.js"), "export const app = true;\n");
		writeFileSync(join(root, "site.webmanifest"), "{}\n");
		writeFileSync(outside, "private\n");
		symlinkSync(outside, join(root, "escape.txt"));
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { force: true });
	});

	test("resolves ordinary files but rejects encoded traversal and symlink escape", async () => {
		expect(await resolveStaticFile("/", root)).toBe(join(root, "index.html"));
		expect(await resolveStaticFile("/app.js?v=1", root)).toBe(join(root, "app.js"));
		expect(await resolveStaticFile("/%2e%2e/secret.txt", root)).toBeNull();
		expect(await resolveStaticFile("/..%2Fsecret.txt", root)).toBeNull();
		expect(await resolveStaticFile("/escape.txt", root)).toBeNull();
	});

	test("returns explicit PWA and asset MIME types", () => {
		expect(getMimeType("index.html")).toBe("text/html; charset=utf-8");
		expect(getMimeType("app.js")).toBe("text/javascript; charset=utf-8");
		expect(getMimeType("site.webmanifest")).toBe("application/manifest+json; charset=utf-8");
		expect(getMimeType("icon.png")).toBe("image/png");
		expect(getMimeType("unknown.bin")).toBe("application/octet-stream");
	});

	test("ships a complete default app shell", async () => {
		for (const path of [
			"/",
			"/app.js",
			"/styles.css",
			"/manifest.webmanifest",
			"/sw.js",
			"/icons/devil-phone.svg",
			"/icons/providers/opencode-go.svg",
			"/icons/providers/synthetic.svg",
			"/icons/providers/antigravity.svg",
		]) {
			expect(await resolveStaticFile(path)).not.toBeNull();
		}
	});
});

function rawRequest(port, path, options = {}) {
	return new Promise((resolvePromise, rejectPromise) => {
		const req = request({
			host: "127.0.0.1",
			port,
			path,
			method: options.method ?? "GET",
			headers: {
				Host: options.host ?? `127.0.0.1:${port}`,
				...options.headers,
			},
		}, response => {
			const chunks = [];
			response.on("data", chunk => chunks.push(chunk));
			response.on("end", () => resolvePromise({
				status: response.statusCode,
				headers: response.headers,
				body: Buffer.concat(chunks).toString("utf8"),
			}));
		});
		req.once("error", rejectPromise);
		req.end();
	});
}

describe("shuvquota HTTP server", () => {
	let root;
	let server;
	let port;
	let quotaCalls;

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "shuvquota-http-"));
		writeFileSync(join(root, "index.html"), "<!doctype html><title>shuvquota</title>");
		writeFileSync(join(root, "app.js"), "export const app = true;\n");
		writeFileSync(join(root, "site.webmanifest"), "{}\n");
		quotaCalls = 0;
		server = createShuvquotaServer({
			webRoot: root,
			allowedHosts: "shuvdev.tail586a6d.ts.net",
			quotaLoader: async () => {
				quotaCalls += 1;
				return buildQuotaSnapshot(completeRawPayload(), FIXED_NOW);
			},
		});
		await new Promise(resolvePromise => server.listen(0, "127.0.0.1", resolvePromise));
		port = server.address().port;
	});

	afterAll(async () => {
		await new Promise(resolvePromise => server.close(resolvePromise));
		rmSync(root, { recursive: true, force: true });
	});

	test("serves health with API privacy and strong security headers", async () => {
		const response = await rawRequest(port, "/api/health");
		expect(response.status).toBe(200);
		expect(JSON.parse(response.body)).toEqual({ status: "ok", service: "shuvquota", schemaVersion: 1 });
		expect(response.headers["cache-control"]).toContain("private");
		expect(response.headers["cache-control"]).toContain("no-store");
		expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
		expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
		expect(response.headers["x-content-type-options"]).toBe("nosniff");
		expect(response.headers["referrer-policy"]).toBe("no-referrer");
		expect(response.headers["permissions-policy"]).toContain("camera=()");
		expect(response.headers["access-control-allow-origin"]).toBeUndefined();
	});

	test("serves only the normalized quota snapshot with no-store", async () => {
		const response = await rawRequest(port, "/api/quota");
		const payload = JSON.parse(response.body);
		expect(response.status).toBe(200);
		expect(response.headers["cache-control"]).toContain("no-store");
		expect(payload.schemaVersion).toBe(1);
		expect(payload.providers).toHaveLength(6);
		expect(response.body).not.toContain("acct-secret");
		expect(quotaCalls).toBe(1);
	});

	test("supports HEAD without returning a response body", async () => {
		const api = await rawRequest(port, "/api/health", { method: "HEAD" });
		expect(api.status).toBe(200);
		expect(api.body).toBe("");
		expect(Number(api.headers["content-length"])).toBeGreaterThan(0);
		const statik = await rawRequest(port, "/app.js", { method: "HEAD" });
		expect(statik.status).toBe(200);
		expect(statik.body).toBe("");
		expect(statik.headers["content-type"]).toBe("text/javascript; charset=utf-8");
	});

	test("serves static PWA assets with correct MIME and no CORS", async () => {
		const index = await rawRequest(port, "/");
		expect(index.status).toBe(200);
		expect(index.headers["content-type"]).toBe("text/html; charset=utf-8");
		expect(index.headers["cache-control"]).toBe("no-cache");
		expect(index.headers["access-control-allow-origin"]).toBeUndefined();
		const manifest = await rawRequest(port, "/site.webmanifest");
		expect(manifest.headers["content-type"]).toBe("application/manifest+json; charset=utf-8");
	});

	test("rejects unsafe Host, cross-site Fetch Metadata, traversal, and methods", async () => {
		const host = await rawRequest(port, "/", { host: "attacker.example:4789" });
		expect(host.status).toBe(421);
		const tailscale = await rawRequest(port, "/api/health", {
			host: "shuvdev.tail586a6d.ts.net:8443",
		});
		expect(tailscale.status).toBe(200);
		const crossSite = await rawRequest(port, "/api/quota", {
			headers: { "Sec-Fetch-Site": "cross-site" },
		});
		expect(crossSite.status).toBe(403);
		expect(quotaCalls).toBe(1);
		const traversal = await rawRequest(port, "/..%2Foutside.txt");
		expect(traversal.status).toBe(404);
		const post = await rawRequest(port, "/api/quota", { method: "POST" });
		expect(post.status).toBe(405);
		expect(post.headers.allow).toBe("GET, HEAD");
		expect(quotaCalls).toBe(1);
	});
});

describe("quota API failures", () => {
	test("returns a conforming, private 503 DTO without raw child errors", async () => {
		const root = mkdtempSync(join(tmpdir(), "shuvquota-failure-"));
		writeFileSync(join(root, "index.html"), "ok\n");
		const server = createShuvquotaServer({
			webRoot: root,
			quotaLoader: async () => {
				throw new Error("access token secret from /home/private/auth.json");
			},
			now: () => FIXED_NOW,
		});
		await new Promise(resolvePromise => server.listen(0, "127.0.0.1", resolvePromise));
		const port = server.address().port;
		try {
			const response = await rawRequest(port, "/api/quota");
			const payload = JSON.parse(response.body);
			expect(response.status).toBe(503);
			expect(response.headers["cache-control"]).toContain("no-store");
			expect(payload.schemaVersion).toBe(1);
			expect(payload.providers.every(provider => provider.error === "Quota data unavailable")).toBe(true);
			expect(response.body).not.toContain("access token");
			expect(response.body).not.toContain("/home/private");
		} finally {
			await new Promise(resolvePromise => server.close(resolvePromise));
			rmSync(root, { recursive: true, force: true });
		}
	});
});
