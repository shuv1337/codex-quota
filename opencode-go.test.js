/**
 * Tests for authenticated OpenCode Go dashboard usage.
 * Run with: bun test opencode-go.test.js
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";

import {
	resolveOpenCodeGoDashboardConfig,
	getOpenCodeGoSearchLocations,
	parseOpenCodeGoResetSeconds,
	parseOpenCodeGoDashboardHtml,
	fetchOpenCodeGoUsage,
	buildOpenCodeGoUsageLines,
	buildOpenCodeGoJsonOutput,
	OPENCODE_GO_DASHBOARD_BASE_URL,
	OPENCODE_GO_TIMEOUT_MS,
} from "./shuvquota.js";

const NOW_MS = Date.parse("2026-07-21T12:00:00.000Z");
const SENTINEL_COOKIE = "SENTINEL_COOKIE_MUST_NEVER_LEAK";

function usageItem(label, usagePercent, resetText) {
	return `<div class="usage" data-slot="usage-item">
		<div data-slot="usage-header">
			<span data-slot="usage-label">${label}</span>
			<span data-slot="usage-value"><!--$-->${usagePercent}<!--/-->%</span>
		</div>
		<div data-slot="progress">
			<div data-slot="progress-bar" style="width: ${usagePercent}%;"></div>
		</div>
		<span data-slot="reset-time"><!--$-->Resets in<!--/--> <!--$-->${resetText}<!--/--></span>
	</div>`;
}

function dashboardHtml() {
	return `<!doctype html><html><body>
		${usageItem("Rolling Usage", "0", "5 hours 0 minutes")}
		${usageItem("Weekly Usage", "12.5", "2 days 3 hours 4 minutes 5 seconds")}
		<div data-slot="usage-item">
			<span data-slot="usage-label">Monthly Usage</span>
			<span data-slot="usage-value"><!--$-->100.25<!--/-->%</span>
			<span data-slot="reset-time"><!--$-->Resets now<!--/--></span>
		</div>
	</body></html>`;
}

function responseContainsSecret(result) {
	return JSON.stringify(result).includes(SENTINEL_COOKIE);
}

describe("resolveOpenCodeGoDashboardConfig", () => {
	test("returns none when neither required variable is set", () => {
		expect(resolveOpenCodeGoDashboardConfig({})).toEqual({ state: "none" });
		expect(resolveOpenCodeGoDashboardConfig({ OPENCODE_GO_LABEL: "personal" }))
			.toEqual({ state: "none" });
	});

	test("reports the missing cookie without reflecting the workspace ID", () => {
		const result = resolveOpenCodeGoDashboardConfig({
			OPENCODE_GO_WORKSPACE_ID: SENTINEL_COOKIE,
		});
		expect(result.state).toBe("incomplete");
		expect(result.missing).toEqual(["OPENCODE_GO_AUTH_COOKIE"]);
		expect(result.error).toContain("OPENCODE_GO_AUTH_COOKIE");
		expect(result.error).not.toContain(SENTINEL_COOKIE);
	});

	test("reports the missing workspace without reflecting the cookie", () => {
		const result = resolveOpenCodeGoDashboardConfig({
			OPENCODE_GO_AUTH_COOKIE: SENTINEL_COOKIE,
		});
		expect(result.state).toBe("incomplete");
		expect(result.missing).toEqual(["OPENCODE_GO_WORKSPACE_ID"]);
		expect(result.error).toContain("OPENCODE_GO_WORKSPACE_ID");
		expect(result.error).not.toContain(SENTINEL_COOKIE);
	});

	test("treats blank required variables as missing", () => {
		const result = resolveOpenCodeGoDashboardConfig({
			OPENCODE_GO_WORKSPACE_ID: "  ",
			OPENCODE_GO_AUTH_COOKIE: SENTINEL_COOKIE,
		});
		expect(result.state).toBe("incomplete");
		expect(result.missing).toEqual(["OPENCODE_GO_WORKSPACE_ID"]);
	});

	test("returns a configured account with the default label", () => {
		expect(resolveOpenCodeGoDashboardConfig({
			OPENCODE_GO_WORKSPACE_ID: " wrk_123 ",
			OPENCODE_GO_AUTH_COOKIE: " cookie-value ",
		})).toEqual({
			state: "configured",
			account: {
				label: "go",
				workspaceId: "wrk_123",
				authCookie: "cookie-value",
				source: "env:OPENCODE_GO_*",
			},
		});
	});

	test("uses a nonblank configured label", () => {
		const result = resolveOpenCodeGoDashboardConfig({
			OPENCODE_GO_WORKSPACE_ID: "wrk_123",
			OPENCODE_GO_AUTH_COOKIE: "cookie-value",
			OPENCODE_GO_LABEL: " personal ",
		});
		expect(result.account.label).toBe("personal");
	});
});

describe("getOpenCodeGoSearchLocations", () => {
	test("lists both required environment variables", () => {
		const locations = getOpenCodeGoSearchLocations();
		expect(locations.some(location => location.includes("~/.shuvquota.env"))).toBe(true);
		expect(locations).toContain("OPENCODE_GO_WORKSPACE_ID env var");
		expect(locations).toContain("OPENCODE_GO_AUTH_COOKIE env var");
	});
});

describe("OpenCode Go public constants", () => {
	test("uses the production dashboard with a bounded timeout", () => {
		expect(OPENCODE_GO_DASHBOARD_BASE_URL).toBe("https://opencode.ai");
		expect(OPENCODE_GO_TIMEOUT_MS).toBe(15000);
	});
});

describe("parseOpenCodeGoResetSeconds", () => {
	test("adds days, hours, minutes, and seconds", () => {
		expect(parseOpenCodeGoResetSeconds(
			"Resets in 1 day 2 hours 3 minutes 4 seconds",
		)).toBe(93784);
	});

	test("supports decimals, singular units, and abbreviations", () => {
		expect(parseOpenCodeGoResetSeconds("Resets in 1.5 hours 0.5 minutes")).toBe(5430);
		expect(parseOpenCodeGoResetSeconds("1 d 2 hrs 3 mins 4 secs")).toBe(93784);
	});

	test("recognizes reset-now variants", () => {
		expect(parseOpenCodeGoResetSeconds("Resets now")).toBe(0);
		expect(parseOpenCodeGoResetSeconds("Reset right now")).toBe(0);
		expect(parseOpenCodeGoResetSeconds("reset-now")).toBe(0);
		expect(parseOpenCodeGoResetSeconds("now")).toBe(0);
	});

	test("strips hydration comments and tags", () => {
		expect(parseOpenCodeGoResetSeconds(
			"<span><!--$-->Resets in<!--/--> <!--$-->5 hours 2 minutes<!--/--></span>",
		)).toBe(18120);
	});

	test("clamps negative totals and rejects unknown text", () => {
		expect(parseOpenCodeGoResetSeconds("Resets in -2 hours")).toBe(0);
		expect(parseOpenCodeGoResetSeconds("Sometime next week")).toBeNull();
		expect(parseOpenCodeGoResetSeconds(null)).toBeNull();
	});
});

describe("parseOpenCodeGoDashboardHtml", () => {
	test("parses the current live SSR data-slot format", () => {
		const result = parseOpenCodeGoDashboardHtml(dashboardHtml(), { nowMs: NOW_MS });
		expect(result).toEqual({
			source: "dashboard",
			rollingUsage: {
				usagePercent: 0,
				remainingPercent: 100,
				resetInSec: 18000,
				resetAt: "2026-07-21T17:00:00.000Z",
			},
			weeklyUsage: {
				usagePercent: 12.5,
				remainingPercent: 87.5,
				resetInSec: 183845,
				resetAt: "2026-07-23T15:04:05.000Z",
			},
			monthlyUsage: {
				usagePercent: 100.25,
				remainingPercent: 0,
				resetInSec: 0,
				resetAt: "2026-07-21T12:00:00.000Z",
			},
		});
	});

	test("accepts one known window and clamps remaining percent to 100", () => {
		const html = usageItem("Rolling Usage", "-5.5", "30 seconds");
		const result = parseOpenCodeGoDashboardHtml(html, { nowMs: NOW_MS });
		expect(result).toEqual({
			source: "dashboard",
			rollingUsage: {
				usagePercent: -5.5,
				remainingPercent: 100,
				resetInSec: 30,
				resetAt: "2026-07-21T12:00:30.000Z",
			},
		});
	});

	test("allows slot attributes and tags in different forms", () => {
		const html = `<article data-slot='usage-item'>
			<strong class="label" data-slot='usage-label'>Weekly&nbsp;Usage</strong>
			<output data-slot=usage-value><b>42.75</b>%</output>
			<time data-slot='reset-time'>Resets in .5 hours</time>
		</article>`;
		const result = parseOpenCodeGoDashboardHtml(html, { nowMs: NOW_MS });
		expect(result.weeklyUsage.usagePercent).toBe(42.75);
		expect(result.weeklyUsage.remainingPercent).toBe(57.25);
		expect(result.weeklyUsage.resetInSec).toBe(1800);
	});

	test("uses SolidJS hydration objects as a fallback in either property order", () => {
		const html = `<script>window.data = {
			rollingUsage: { resetInSec: 90, usagePercent: 12.25 },
			weeklyUsage: { usagePercent: 40, resetInSec: 120 },
			monthlyUsage: { resetInSec: -5, usagePercent: 130 }
		};</script>`;
		const result = parseOpenCodeGoDashboardHtml(html, { nowMs: NOW_MS });
		expect(result.rollingUsage.usagePercent).toBe(12.25);
		expect(result.rollingUsage.resetInSec).toBe(90);
		expect(result.weeklyUsage).toMatchObject({
			usagePercent: 40,
			remainingPercent: 60,
			resetInSec: 120,
		});
		expect(result.monthlyUsage).toMatchObject({
			usagePercent: 130,
			remainingPercent: 0,
			resetInSec: 0,
		});
	});

	test("parses HTML-encoded hydration JSON", () => {
		const html = `<script>{&quot;rollingUsage&quot;:{
			&quot;usagePercent&quot;:&quot;25.5&quot;,
			&quot;resetInSec&quot;:&quot;60&quot;
		}}</script>`;
		const result = parseOpenCodeGoDashboardHtml(html, { nowMs: NOW_MS });
		expect(result.rollingUsage).toEqual({
			usagePercent: 25.5,
			remainingPercent: 74.5,
			resetInSec: 60,
			resetAt: "2026-07-21T12:01:00.000Z",
		});
	});

	test("prefers rendered data-slot values over hydration fallback data", () => {
		const html = `<script>{
			rollingUsage: { usagePercent: 99, resetInSec: 1 }
		}</script>${usageItem("Rolling Usage", "10", "2 minutes")}`;
		const result = parseOpenCodeGoDashboardHtml(html, { nowMs: NOW_MS });
		expect(result.rollingUsage).toMatchObject({
			usagePercent: 10,
			remainingPercent: 90,
			resetInSec: 120,
		});
	});

	test("requires at least one complete known usage window", () => {
		expect(parseOpenCodeGoDashboardHtml("<html>Sign in</html>", { nowMs: NOW_MS }))
			.toBeNull();
		expect(parseOpenCodeGoDashboardHtml(
			usageItem("Daily Usage", "20", "1 hour"),
			{ nowMs: NOW_MS },
		)).toBeNull();
		expect(parseOpenCodeGoDashboardHtml(
			usageItem("Weekly Usage", "not-a-number", "1 hour"),
			{ nowMs: NOW_MS },
		)).toBeNull();
	});
});

describe("fetchOpenCodeGoUsage", () => {
	test("fetches the encoded dashboard path with browser headers and parses usage", async () => {
		let requestUrl;
		let requestOptions;
		const result = await fetchOpenCodeGoUsage({
			workspaceId: "wrk/a b?secret",
			authCookie: SENTINEL_COOKIE,
		}, {
			nowMs: NOW_MS,
			fetchFn: async (url, options) => {
				requestUrl = url;
				requestOptions = options;
				return new Response(dashboardHtml(), { status: 200 });
			},
		});

		expect(requestUrl).toBe(
			"https://opencode.ai/workspace/wrk%2Fa%20b%3Fsecret/go",
		);
		expect(requestOptions.method).toBe("GET");
		expect(requestOptions.headers.Accept).toBe("text/html");
		expect(requestOptions.headers["User-Agent"]).toContain("Mozilla/5.0");
		expect(requestOptions.headers.Cookie).toBe(`auth=${SENTINEL_COOKIE}`);
		expect(requestOptions.signal).toBeInstanceOf(AbortSignal);
		expect(result.success).toBe(true);
		expect(result.usage.source).toBe("dashboard");
		expect(responseContainsSecret(result)).toBe(false);
	});

	test("supports an injected base URL without duplicating its trailing slash", async () => {
		let requestUrl;
		const result = await fetchOpenCodeGoUsage({
			workspaceId: "wrk_123",
			authCookie: SENTINEL_COOKIE,
		}, {
			baseUrl: "https://dashboard.example.test///",
			nowMs: NOW_MS,
			fetchFn: async (url) => {
				requestUrl = url;
				return new Response(usageItem("Rolling Usage", "1", "1 second"));
			},
		});
		expect(result.success).toBe(true);
		expect(requestUrl).toBe("https://dashboard.example.test/workspace/wrk_123/go");
	});

	for (const status of [401, 403]) {
		test(`returns safe sign-in guidance for HTTP ${status}`, async () => {
			const result = await fetchOpenCodeGoUsage({
				workspaceId: "workspace-secret",
				authCookie: SENTINEL_COOKIE,
			}, {
				fetchFn: async () => new Response(SENTINEL_COOKIE, { status }),
			});
			expect(result).toMatchObject({ success: false, status });
			expect(result.error).toContain("sign-in required");
			expect(result.error).toContain("OPENCODE_GO_AUTH_COOKIE");
			expect(responseContainsSecret(result)).toBe(false);
			expect(JSON.stringify(result)).not.toContain("workspace-secret");
		});
	}

	test("returns only safe status information for other non-2xx responses", async () => {
		let bodyRead = false;
		const result = await fetchOpenCodeGoUsage({
			workspaceId: "workspace-secret",
			authCookie: SENTINEL_COOKIE,
		}, {
			fetchFn: async () => ({
				ok: false,
				status: 503,
				text: async () => {
					bodyRead = true;
					return SENTINEL_COOKIE;
				},
			}),
		});
		expect(result).toEqual({
			success: false,
			error: "OpenCode Go dashboard returned HTTP 503",
			status: 503,
		});
		expect(bodyRead).toBe(false);
	});

	test("gives safe cookie-refresh guidance for a 200 login page", async () => {
		const result = await fetchOpenCodeGoUsage({
			workspaceId: "workspace-secret",
			authCookie: SENTINEL_COOKIE,
		}, {
			fetchFn: async () => new Response(
				`<html><form>Sign in ${SENTINEL_COOKIE}</form></html>`,
				{ status: 200 },
			),
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain("refresh OPENCODE_GO_AUTH_COOKIE");
		expect(responseContainsSecret(result)).toBe(false);
		expect(JSON.stringify(result)).not.toContain("workspace-secret");
	});

	test("does not reflect exception messages", async () => {
		const result = await fetchOpenCodeGoUsage({
			workspaceId: "workspace-secret",
			authCookie: SENTINEL_COOKIE,
		}, {
			fetchFn: async () => {
				throw new Error(`network failure ${SENTINEL_COOKIE}`);
			},
		});
		expect(result).toEqual({
			success: false,
			error: "OpenCode Go dashboard request failed",
		});
		expect(responseContainsSecret(result)).toBe(false);
	});

	test("times out an injected fetch even when it ignores abort", async () => {
		let requestSignal;
		const result = await fetchOpenCodeGoUsage({
			workspaceId: "workspace-secret",
			authCookie: SENTINEL_COOKIE,
		}, {
			timeoutMs: 5,
			fetchFn: async (_url, options) => {
				requestSignal = options.signal;
				return new Promise(() => {});
			},
		});
		expect(result).toEqual({
			success: false,
			error: "OpenCode Go dashboard request timed out",
		});
		expect(requestSignal.aborted).toBe(true);
		expect(responseContainsSecret(result)).toBe(false);
	});

	test("applies the timeout while reading a successful response body", async () => {
		const result = await fetchOpenCodeGoUsage({
			workspaceId: "workspace-secret",
			authCookie: SENTINEL_COOKIE,
		}, {
			timeoutMs: 5,
			fetchFn: async () => ({
				ok: true,
				status: 200,
				text: async () => new Promise(() => {}),
			}),
		});
		expect(result).toEqual({
			success: false,
			error: "OpenCode Go dashboard request timed out",
		});
		expect(responseContainsSecret(result)).toBe(false);
	});

	test("does not expose available account fields when configuration is incomplete", async () => {
		const result = await fetchOpenCodeGoUsage({
			workspaceId: SENTINEL_COOKIE,
		});
		expect(result).toEqual({
			success: false,
			error: "OpenCode Go dashboard configuration is incomplete",
		});
		expect(responseContainsSecret(result)).toBe(false);
	});
});

describe("OpenCode Go display and CLI routing", () => {
	test("sanitizes standalone and combined JSON at the handler boundary", () => {
		const output = buildOpenCodeGoJsonOutput([{
			account: {
				label: "go",
				workspaceId: "workspace-secret",
				authCookie: SENTINEL_COOKIE,
				source: "/private/credential/path",
			},
			usage: {
				success: true,
				usage: {
					source: SENTINEL_COOKIE,
					rawHtml: SENTINEL_COOKIE,
					rollingUsage: {
						usagePercent: 12.5,
						remainingPercent: 87.5,
						resetInSec: 60,
						resetAt: "2026-07-21T12:01:00.000Z",
						authCookie: SENTINEL_COOKIE,
					},
				},
			},
		}]);

		expect(output).toEqual([{
			label: "go",
			usage: {
				source: "dashboard",
				rollingUsage: {
					usagePercent: 12.5,
					remainingPercent: 87.5,
					resetInSec: 60,
					resetAt: "2026-07-21T12:01:00.000Z",
				},
			},
			error: undefined,
			source: "dashboard",
		}]);
		expect(JSON.stringify(output)).not.toContain(SENTINEL_COOKIE);
		expect(JSON.stringify(output)).not.toContain("workspace-secret");
		expect(JSON.stringify(output)).not.toContain("credential/path");
	});

	test("does not reflect unknown provider errors through JSON output", () => {
		const output = buildOpenCodeGoJsonOutput([{
			account: { label: "go", authCookie: SENTINEL_COOKIE },
			usage: { success: false, error: `network ${SENTINEL_COOKIE}` },
		}]);
		expect(output).toEqual([{
			label: "go",
			usage: null,
			error: "OpenCode Go usage unavailable",
			source: "dashboard",
		}]);
		expect(JSON.stringify(output)).not.toContain(SENTINEL_COOKIE);
	});

	test("renders all three dashboard windows in regular and compact output", () => {
		const usage = parseOpenCodeGoDashboardHtml(dashboardHtml(), { nowMs: NOW_MS });
		const payload = { success: true, usage };
		const regular = buildOpenCodeGoUsageLines({ label: "go" }, payload, {});
		const compact = buildOpenCodeGoUsageLines({ label: "go" }, payload, { compact: true });

		expect(regular[0]).toBe("OpenCode Go (go)");
		expect(regular.join("\n")).toContain("5h limit:");
		expect(regular.join("\n")).toContain("Weekly limit:");
		expect(regular.join("\n")).toContain("Monthly limit:");
		expect(regular.join("\n")).toContain("Source: OpenCode dashboard");
		expect(compact).toHaveLength(1);
		expect(compact[0]).toContain("5h");
		expect(compact[0]).toContain("week");
		expect(compact[0]).toContain("month");
		expect(compact[0]).toContain("OpenCode Go (go)");
	});

	test("does not reflect account credentials in display errors", () => {
		const lines = buildOpenCodeGoUsageLines({
			label: "go",
			workspaceId: "workspace-secret",
			authCookie: SENTINEL_COOKIE,
		}, {
			success: false,
			error: "OpenCode Go dashboard request failed",
		}, {});
		const output = lines.join("\n");
		expect(output).toContain("dashboard request failed");
		expect(output).not.toContain("workspace-secret");
		expect(output).not.toContain(SENTINEL_COOKIE);
	});

	for (const args of [["opencode-go", "--help"], ["opencode-go", "quota", "--help"]]) {
		test(`routes ${args.join(" ")} to OpenCode Go help without configuration`, () => {
			const env = { ...process.env };
			env.OPENCODE_GO_WORKSPACE_ID = "";
			env.OPENCODE_GO_AUTH_COOKIE = "";
			env.OPENCODE_GO_LABEL = "";
			const result = spawnSync(process.execPath, ["shuvquota.js", ...args, "--no-color"], {
				cwd: process.cwd(),
				env,
				encoding: "utf8",
			});
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toContain("shuvquota opencode-go");
			expect(result.stdout).not.toContain(SENTINEL_COOKIE);
		});
	}
});
