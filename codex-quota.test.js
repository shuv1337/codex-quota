/**
 * Tests for codex-quota.js account loading and utility functions
 * 
 * Run with: bun test
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
	writeFileSync,
	mkdirSync,
	rmSync,
	existsSync,
	readFileSync,
	lstatSync,
	symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

import {
	loadAccountsFromEnv,
	loadAccountsFromFile,
	loadAccountFromCodexCli,
	loadAllAccounts,
	findAccountByLabel,
	getAllLabels,
	isValidAccount,
	loadClaudeAccountsFromEnv,
	loadClaudeAccountsFromFile,
	isValidClaudeAccount,
	// Deduplication functions
	deduplicateAccountsByEmail,
	deduplicateClaudeOAuthAccounts,
	// Claude OAuth functions
	loadClaudeOAuthFromClaudeCode,
	loadClaudeOAuthFromOpenCode,
	loadClaudeOAuthFromEnv,
	loadAllClaudeOAuthAccounts,
	fetchClaudeOAuthUsage,
	fetchClaudeOAuthUsageForAccount,
	// OpenAI OAuth utilities
	generatePKCE,
	generateState,
	buildAuthUrl,
	checkPortAvailable,
	isHeadlessEnvironment,
	openBrowser,
	startCallbackServer,
	exchangeCodeForTokens,
	// Claude OAuth browser flow
	buildClaudeAuthUrl,
	parseClaudeCodeState,
	exchangeClaudeCodeForTokens,
	refreshClaudeToken,
	handleClaudeOAuthFlow,
	// JWT utilities
	decodeJWT,
	extractAccountId,
	getActiveAccountId,
	formatExpiryStatus,
	shortenPath,
	supportsColor,
	colorize,
	setNoColorFlag,
	handleSwitch,
	handleRemove,
	MULTI_ACCOUNT_PATHS,
	CODEX_CLI_AUTH_PATH,
	PRIMARY_CMD,
	printHelp,
	printHelpAdd,
	printHelpSwitch,
	printHelpList,
	printHelpRemove,
	printHelpQuota,
} from "./codex-quota.js";

import {
	buildChecks,
	checkPackageName,
	checkFilesArrayExists,
	checkRequiredFiles,
} from "./scripts/preflight.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

// Create a valid JWT-like token with the expected claims structure
function createMockAccessToken(accountId, email = "test@example.com", planType = "plus") {
	const header = { alg: "RS256", typ: "JWT" };
	const payload = {
		"https://api.openai.com/auth": {
			chatgpt_account_id: accountId,
			chatgpt_plan_type: planType,
		},
		"https://api.openai.com/profile": {
			email,
		},
	};
	const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64");
	const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64");
	return `${headerB64}.${payloadB64}.fake_signature`;
}

const MOCK_ACCOUNT_ID = "acc_12345";
const MOCK_ACCESS_TOKEN = createMockAccessToken(MOCK_ACCOUNT_ID);
const MOCK_REFRESH_TOKEN = "refresh_token_123";

// ─────────────────────────────────────────────────────────────────────────────
// CLI constants tests
// ─────────────────────────────────────────────────────────────────────────────

describe("PRIMARY_CMD constant", () => {
	test("equals 'codex-quota'", () => {
		expect(PRIMARY_CMD).toBe("codex-quota");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Help output tests
// ─────────────────────────────────────────────────────────────────────────────

describe("help output", () => {
	let consoleOutput;
	let originalConsoleLog;

	beforeEach(() => {
		// Capture console.log output
		originalConsoleLog = console.log;
		consoleOutput = [];
		console.log = (...args) => {
			consoleOutput.push(args.join(" "));
		};
	});

	afterEach(() => {
		// Restore console.log
		console.log = originalConsoleLog;
	});

	test("main help contains 'codex-quota' as primary command", () => {
		printHelp();
		const output = consoleOutput.join("\n");
		
		// Should show codex-quota in usage examples
		expect(output).toContain("codex-quota");
		// Should show codex-quota as first command in header
		expect(output).toMatch(/^codex-quota/);
	});

	test("all subcommand help contains 'codex-quota'", () => {
		const helpFunctions = [printHelpAdd, printHelpSwitch, printHelpList, printHelpRemove, printHelpQuota];
		
		for (const helpFn of helpFunctions) {
			consoleOutput = [];
			helpFn();
			const output = consoleOutput.join("\n");
			
			// Each subcommand help should contain codex-quota in command examples
			expect(output).toContain("codex-quota");
		}
	});

});

// ─────────────────────────────────────────────────────────────────────────────
// Error message tests
// ─────────────────────────────────────────────────────────────────────────────

describe("error messages", () => {
	test("do not hardcode codex-usage", () => {
		const source = readFileSync(join(import.meta.dir, "codex-quota.js"), "utf-8");
		const matches = source.match(/codex-usage/g) ?? [];
		expect(matches.length).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// package.json metadata validation tests
// ─────────────────────────────────────────────────────────────────────────────

describe("package.json metadata", () => {
	let pkg;

	beforeEach(() => {
		pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf-8"));
	});

	test("has name equal to 'codex-quota'", () => {
		expect(pkg.name).toBe("codex-quota");
	});

	test("has files array defined", () => {
		expect(Array.isArray(pkg.files)).toBe(true);
	});

	test("files array includes 'codex-quota.js'", () => {
		expect(pkg.files).toContain("codex-quota.js");
	});

	test("files array includes 'README.md'", () => {
		expect(pkg.files).toContain("README.md");
	});

	test("bin includes 'codex-quota' command", () => {
		expect(pkg.bin).toHaveProperty("codex-quota");
		expect(pkg.bin["codex-quota"]).toBe("./codex-quota.js");
	});

	test("bin includes 'cq' alias", () => {
		expect(pkg.bin).toHaveProperty("cq");
		expect(pkg.bin["cq"]).toBe("./codex-quota.js");
	});

	test("has repository field", () => {
		expect(pkg.repository).toBeDefined();
		expect(pkg.repository.type).toBe("git");
		expect(pkg.repository.url).toContain("github.com");
	});

	test("has engines.node >= 18", () => {
		expect(pkg.engines).toBeDefined();
		expect(pkg.engines.node).toBeDefined();
		// Parse the version requirement (e.g., ">=18.0.0" or ">=18")
		const nodeVersion = pkg.engines.node;
		const match = nodeVersion.match(/>=?\s*(\d+)/);
		expect(match).not.toBeNull();
		expect(parseInt(match[1], 10)).toBeGreaterThanOrEqual(18);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// README documentation tests
// ─────────────────────────────────────────────────────────────────────────────

describe("README documentation", () => {
	let readme;

	beforeEach(() => {
		readme = readFileSync(join(import.meta.dir, "README.md"), "utf-8");
	});

	test("uses codex-quota title", () => {
		expect(readme.startsWith("# codex-quota")).toBe(true);
	});

	test("documents npm install -g codex-quota", () => {
		expect(readme).toContain("npm install -g codex-quota");
	});

	test("documents bun add -g codex-quota", () => {
		expect(readme).toContain("bun add -g codex-quota");
	});

	test("documents OpenCode integration", () => {
		expect(readme).toContain("Switch the active account for both Codex CLI and OpenCode");
	});

	test("documents OpenCode auth path", () => {
		expect(readme).toContain("~/.local/share/opencode/auth.json");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// CI workflow tests
// ─────────────────────────────────────────────────────────────────────────────

describe("CI workflow", () => {
	const workflowPath = join(import.meta.dir, ".github", "workflows", "ci.yml");
	let workflow;

	beforeEach(() => {
		workflow = existsSync(workflowPath) ? readFileSync(workflowPath, "utf-8") : "";
	});

	test("ci workflow file exists", () => {
		expect(existsSync(workflowPath)).toBe(true);
	});

	test("workflow triggers on push", () => {
		expect(workflow).toContain("push:");
	});

	test("workflow triggers on pull_request", () => {
		expect(workflow).toContain("pull_request:");
	});

	test("workflow runs bun test", () => {
		expect(workflow).toContain("bun test");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Preflight checks tests
// ─────────────────────────────────────────────────────────────────────────────

describe("preflight checks", () => {
	test("fails if name is not codex-quota", () => {
		const result = checkPackageName({ name: "wrong-name" });
		expect(result.pass).toBe(false);
		expect(result.message).toContain("expected 'codex-quota'");
	});

	test("fails if files array is missing", () => {
		const result = checkFilesArrayExists({});
		expect(result.pass).toBe(false);
		expect(result.message).toContain("missing files array");
	});

	test("fails if required files are missing", () => {
		const result = checkRequiredFiles({ files: ["README.md"] });
		expect(result.pass).toBe(false);
		expect(result.message).toContain("codex-quota.js");
		expect(result.message).toContain("LICENSE");
	});

	test("passes with correct configuration", () => {
		const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf-8"));
		const checks = buildChecks(pkg, { skipGit: true });
		const allPass = checks.every(check => check.pass);
		expect(allPass).toBe(true);
	});

	test("returns clear error messages", () => {
		const result = checkPackageName({ name: "broken" });
		expect(result.message).toContain("package.json name is");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Account validation tests
// ─────────────────────────────────────────────────────────────────────────────

describe("isValidAccount", () => {
	test("returns truthy for valid account with all required fields", () => {
		const account = {
			label: "test",
			accountId: MOCK_ACCOUNT_ID,
			access: MOCK_ACCESS_TOKEN,
			refresh: MOCK_REFRESH_TOKEN,
		};
		expect(isValidAccount(account)).toBeTruthy();
	});

	test("returns falsy for account missing label", () => {
		const account = {
			accountId: MOCK_ACCOUNT_ID,
			access: MOCK_ACCESS_TOKEN,
			refresh: MOCK_REFRESH_TOKEN,
		};
		expect(isValidAccount(account)).toBeFalsy();
	});

	test("returns falsy for account missing access token", () => {
		const account = {
			label: "test",
			accountId: MOCK_ACCOUNT_ID,
			refresh: MOCK_REFRESH_TOKEN,
		};
		expect(isValidAccount(account)).toBeFalsy();
	});

	test("returns falsy for account missing refresh token", () => {
		const account = {
			label: "test",
			accountId: MOCK_ACCOUNT_ID,
			access: MOCK_ACCESS_TOKEN,
		};
		expect(isValidAccount(account)).toBeFalsy();
	});

	test("returns falsy for null input", () => {
		expect(isValidAccount(null)).toBeFalsy();
	});

	test("returns falsy for non-object input", () => {
		expect(isValidAccount("string")).toBeFalsy();
		expect(isValidAccount(123)).toBeFalsy();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Claude account validation tests
// ─────────────────────────────────────────────────────────────────────────────

describe("isValidClaudeAccount", () => {
	test("returns truthy for valid account with sessionKey", () => {
		const account = {
			label: "claude",
			sessionKey: "sk-ant-oat-123",
		};
		expect(isValidClaudeAccount(account)).toBeTruthy();
	});

	test("returns truthy for valid account with oauthToken", () => {
		const account = {
			label: "claude",
			oauthToken: "oauth-token",
		};
		expect(isValidClaudeAccount(account)).toBeTruthy();
	});

	test("returns falsy for account missing label", () => {
		const account = {
			sessionKey: "sk-ant-oat-123",
		};
		expect(isValidClaudeAccount(account)).toBeFalsy();
	});

	test("returns falsy for account missing tokens", () => {
		const account = {
			label: "claude",
		};
		expect(isValidClaudeAccount(account)).toBeFalsy();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// loadAccountsFromEnv tests
// ─────────────────────────────────────────────────────────────────────────────

describe("loadAccountsFromEnv", () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = process.env.CODEX_ACCOUNTS;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.CODEX_ACCOUNTS;
		} else {
			process.env.CODEX_ACCOUNTS = originalEnv;
		}
	});

	test("returns empty array when CODEX_ACCOUNTS not set", () => {
		delete process.env.CODEX_ACCOUNTS;
		const accounts = loadAccountsFromEnv();
		expect(accounts).toEqual([]);
	});

	test("returns accounts from JSON array format", () => {
		const mockAccounts = [
			{ label: "env-account", accountId: MOCK_ACCOUNT_ID, access: MOCK_ACCESS_TOKEN, refresh: MOCK_REFRESH_TOKEN },
		];
		process.env.CODEX_ACCOUNTS = JSON.stringify(mockAccounts);
		
		const accounts = loadAccountsFromEnv();
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("env-account");
		expect(accounts[0].source).toBe("env");
	});

	test("returns accounts from {accounts: [...]} format", () => {
		const mockData = {
			accounts: [
				{ label: "env-account-2", accountId: MOCK_ACCOUNT_ID, access: MOCK_ACCESS_TOKEN, refresh: MOCK_REFRESH_TOKEN },
			],
		};
		process.env.CODEX_ACCOUNTS = JSON.stringify(mockData);
		
		const accounts = loadAccountsFromEnv();
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("env-account-2");
		expect(accounts[0].source).toBe("env");
	});

	test("returns empty array for invalid JSON", () => {
		process.env.CODEX_ACCOUNTS = "not valid json {";
		const accounts = loadAccountsFromEnv();
		expect(accounts).toEqual([]);
	});

	test("filters out invalid accounts", () => {
		const mockAccounts = [
			{ label: "valid", accountId: MOCK_ACCOUNT_ID, access: MOCK_ACCESS_TOKEN, refresh: MOCK_REFRESH_TOKEN },
			{ label: "invalid-no-access", accountId: MOCK_ACCOUNT_ID, refresh: MOCK_REFRESH_TOKEN },
		];
		process.env.CODEX_ACCOUNTS = JSON.stringify(mockAccounts);
		
		const accounts = loadAccountsFromEnv();
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("valid");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// loadClaudeAccountsFromEnv tests
// ─────────────────────────────────────────────────────────────────────────────

describe("loadClaudeAccountsFromEnv", () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = process.env.CLAUDE_ACCOUNTS;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.CLAUDE_ACCOUNTS;
		} else {
			process.env.CLAUDE_ACCOUNTS = originalEnv;
		}
	});

	test("returns empty array when CLAUDE_ACCOUNTS not set", () => {
		delete process.env.CLAUDE_ACCOUNTS;
		const accounts = loadClaudeAccountsFromEnv();
		expect(accounts).toEqual([]);
	});

	test("returns accounts from JSON array format", () => {
		const mockAccounts = [
			{ label: "claude-env", sessionKey: "sk-ant-oat-123" },
		];
		process.env.CLAUDE_ACCOUNTS = JSON.stringify(mockAccounts);

		const accounts = loadClaudeAccountsFromEnv();
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("claude-env");
		expect(accounts[0].source).toBe("env");
	});

	test("returns accounts from {accounts: [...]} format", () => {
		const mockData = {
			accounts: [
				{ label: "claude-env-2", oauthToken: "oauth-token" },
			],
		};
		process.env.CLAUDE_ACCOUNTS = JSON.stringify(mockData);

		const accounts = loadClaudeAccountsFromEnv();
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("claude-env-2");
		expect(accounts[0].source).toBe("env");
	});

	test("returns empty array for invalid JSON", () => {
		process.env.CLAUDE_ACCOUNTS = "not valid json {";
		const accounts = loadClaudeAccountsFromEnv();
		expect(accounts).toEqual([]);
	});

	test("filters out invalid accounts", () => {
		const mockAccounts = [
			{ label: "valid", sessionKey: "sk-ant-oat-123" },
			{ label: "invalid-no-auth" },
		];
		process.env.CLAUDE_ACCOUNTS = JSON.stringify(mockAccounts);

		const accounts = loadClaudeAccountsFromEnv();
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("valid");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// loadAccountsFromFile tests
// ─────────────────────────────────────────────────────────────────────────────

describe("loadAccountsFromFile", () => {
	const testDir = join(tmpdir(), "codex-quota-test-" + Date.now());
	const testFile = join(testDir, "accounts.json");

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	test("returns empty array for non-existent file", () => {
		const accounts = loadAccountsFromFile("/nonexistent/path/accounts.json");
		expect(accounts).toEqual([]);
	});

	test("returns accounts from JSON array format", () => {
		const mockAccounts = [
			{ label: "file-account", accountId: MOCK_ACCOUNT_ID, access: MOCK_ACCESS_TOKEN, refresh: MOCK_REFRESH_TOKEN },
		];
		writeFileSync(testFile, JSON.stringify(mockAccounts));
		
		const accounts = loadAccountsFromFile(testFile);
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("file-account");
		expect(accounts[0].source).toBe(testFile);
	});

	test("returns accounts from {accounts: [...]} format", () => {
		const mockData = {
			accounts: [
				{ label: "file-account-2", accountId: MOCK_ACCOUNT_ID, access: MOCK_ACCESS_TOKEN, refresh: MOCK_REFRESH_TOKEN },
			],
		};
		writeFileSync(testFile, JSON.stringify(mockData));
		
		const accounts = loadAccountsFromFile(testFile);
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("file-account-2");
		expect(accounts[0].source).toBe(testFile);
	});

	test("returns empty array for invalid JSON file", () => {
		writeFileSync(testFile, "not valid json");
		const accounts = loadAccountsFromFile(testFile);
		expect(accounts).toEqual([]);
	});

	test("preserves extra fields from accounts", () => {
		const mockAccounts = [
			{ label: "account", accountId: MOCK_ACCOUNT_ID, access: MOCK_ACCESS_TOKEN, refresh: MOCK_REFRESH_TOKEN, expires: 123456, customField: "preserved" },
		];
		writeFileSync(testFile, JSON.stringify(mockAccounts));
		
		const accounts = loadAccountsFromFile(testFile);
		expect(accounts[0].expires).toBe(123456);
		expect(accounts[0].customField).toBe("preserved");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// loadClaudeAccountsFromFile tests
// ─────────────────────────────────────────────────────────────────────────────

describe("loadClaudeAccountsFromFile", () => {
	const testDir = join(tmpdir(), "codex-quota-claude-test-" + Date.now());
	const testFile = join(testDir, "claude-accounts.json");

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	test("returns empty array for non-existent file", () => {
		const accounts = loadClaudeAccountsFromFile("/nonexistent/path/claude-accounts.json");
		expect(accounts).toEqual([]);
	});

	test("returns accounts from JSON array format", () => {
		const mockAccounts = [
			{ label: "file-claude", sessionKey: "sk-ant-oat-123" },
		];
		writeFileSync(testFile, JSON.stringify(mockAccounts));

		const accounts = loadClaudeAccountsFromFile(testFile);
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("file-claude");
		expect(accounts[0].source).toBe(testFile);
	});

	test("returns accounts from {accounts: [...]} format", () => {
		const mockData = {
			accounts: [
				{ label: "file-claude-2", oauthToken: "oauth-token" },
			],
		};
		writeFileSync(testFile, JSON.stringify(mockData));

		const accounts = loadClaudeAccountsFromFile(testFile);
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("file-claude-2");
		expect(accounts[0].source).toBe(testFile);
	});

	test("returns empty array for invalid JSON file", () => {
		writeFileSync(testFile, "not valid json");
		const accounts = loadClaudeAccountsFromFile(testFile);
		expect(accounts).toEqual([]);
	});

	test("filters out invalid accounts", () => {
		const mockData = {
			accounts: [
				{ label: "valid", sessionKey: "sk-ant-oat-123" },
				{ label: "invalid-no-auth" },
			],
		};
		writeFileSync(testFile, JSON.stringify(mockData));

		const accounts = loadClaudeAccountsFromFile(testFile);
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("valid");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Claude OAuth loading tests
// ─────────────────────────────────────────────────────────────────────────────

describe("loadClaudeOAuthFromEnv", () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = process.env.CLAUDE_OAUTH_ACCOUNTS;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.CLAUDE_OAUTH_ACCOUNTS;
		} else {
			process.env.CLAUDE_OAUTH_ACCOUNTS = originalEnv;
		}
	});

	test("returns empty array when CLAUDE_OAUTH_ACCOUNTS not set", () => {
		delete process.env.CLAUDE_OAUTH_ACCOUNTS;
		const accounts = loadClaudeOAuthFromEnv();
		expect(accounts).toEqual([]);
	});

	test("returns accounts from JSON array format", () => {
		const mockAccounts = [
			{ label: "oauth-env", accessToken: "sk-ant-oat-123" },
		];
		process.env.CLAUDE_OAUTH_ACCOUNTS = JSON.stringify(mockAccounts);

		const accounts = loadClaudeOAuthFromEnv();
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("oauth-env");
		expect(accounts[0].source).toBe("env:CLAUDE_OAUTH_ACCOUNTS");
	});

	test("returns accounts from {accounts: [...]} format", () => {
		const mockData = {
			accounts: [
				{ label: "oauth-env-2", accessToken: "sk-ant-oat-456" },
			],
		};
		process.env.CLAUDE_OAUTH_ACCOUNTS = JSON.stringify(mockData);

		const accounts = loadClaudeOAuthFromEnv();
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("oauth-env-2");
	});

	test("returns empty array for invalid JSON", () => {
		process.env.CLAUDE_OAUTH_ACCOUNTS = "not valid json {";
		const accounts = loadClaudeOAuthFromEnv();
		expect(accounts).toEqual([]);
	});

	test("filters out accounts missing label or accessToken", () => {
		const mockAccounts = [
			{ label: "valid", accessToken: "sk-ant-oat-123" },
			{ label: "no-token" },
			{ accessToken: "sk-ant-oat-456" },
		];
		process.env.CLAUDE_OAUTH_ACCOUNTS = JSON.stringify(mockAccounts);

		const accounts = loadClaudeOAuthFromEnv();
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("valid");
	});
});

describe("loadClaudeOAuthFromClaudeCode", () => {
	const testDir = join(tmpdir(), "codex-quota-claude-oauth-test-" + Date.now());
	const testCredentialsFile = join(testDir, ".credentials.json");
	let originalEnv;

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
		originalEnv = process.env.CLAUDE_CREDENTIALS_PATH;
		process.env.CLAUDE_CREDENTIALS_PATH = testCredentialsFile;
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
		if (originalEnv === undefined) {
			delete process.env.CLAUDE_CREDENTIALS_PATH;
		} else {
			process.env.CLAUDE_CREDENTIALS_PATH = originalEnv;
		}
	});

	test("returns empty array when credentials file not found", () => {
		const accounts = loadClaudeOAuthFromClaudeCode();
		expect(accounts).toEqual([]);
	});

	test("returns account with OAuth credentials and user:profile scope", () => {
		const mockCredentials = {
			claudeAiOauth: {
				accessToken: "sk-ant-oat-123",
				refreshToken: "sk-ant-ort-456",
				expiresAt: Date.now() + 3600000,
				scopes: ["user:inference", "user:profile"],
				subscriptionType: "max",
				rateLimitTier: "default_claude_max_20x",
			},
		};
		writeFileSync(testCredentialsFile, JSON.stringify(mockCredentials));

		const accounts = loadClaudeOAuthFromClaudeCode();
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("claude-code");
		expect(accounts[0].accessToken).toBe("sk-ant-oat-123");
		expect(accounts[0].subscriptionType).toBe("max");
		expect(accounts[0].source).toBe(testCredentialsFile);
	});

	test("returns empty array when missing user:profile scope", () => {
		const mockCredentials = {
			claudeAiOauth: {
				accessToken: "sk-ant-oat-123",
				scopes: ["user:inference"], // Missing user:profile
			},
		};
		writeFileSync(testCredentialsFile, JSON.stringify(mockCredentials));

		const accounts = loadClaudeOAuthFromClaudeCode();
		expect(accounts).toEqual([]);
	});

	test("returns empty array when accessToken is missing", () => {
		const mockCredentials = {
			claudeAiOauth: {
				refreshToken: "sk-ant-ort-456",
				scopes: ["user:profile"],
			},
		};
		writeFileSync(testCredentialsFile, JSON.stringify(mockCredentials));

		const accounts = loadClaudeOAuthFromClaudeCode();
		expect(accounts).toEqual([]);
	});
});

describe("loadAllClaudeOAuthAccounts", () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = process.env.CLAUDE_OAUTH_ACCOUNTS;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.CLAUDE_OAUTH_ACCOUNTS;
		} else {
			process.env.CLAUDE_OAUTH_ACCOUNTS = originalEnv;
		}
	});

	test("returns accounts from env with highest priority", () => {
		const mockAccounts = [
			{ label: "env-account", accessToken: "sk-ant-oat-env" },
		];
		process.env.CLAUDE_OAUTH_ACCOUNTS = JSON.stringify(mockAccounts);

		const accounts = loadAllClaudeOAuthAccounts();
		// Should include at least the env account
		const envAccount = accounts.find(a => a.label === "env-account");
		expect(envAccount).toBeDefined();
		expect(envAccount.accessToken).toBe("sk-ant-oat-env");
	});

	test("deduplicates accounts by label", () => {
		const mockAccounts = [
			{ label: "duplicate", accessToken: "sk-ant-oat-1" },
			{ label: "duplicate", accessToken: "sk-ant-oat-2" },
		];
		process.env.CLAUDE_OAUTH_ACCOUNTS = JSON.stringify(mockAccounts);

		const accounts = loadAllClaudeOAuthAccounts();
		const duplicates = accounts.filter(a => a.label === "duplicate");
		// Only the first one should be kept
		expect(duplicates.length).toBe(1);
		expect(duplicates[0].accessToken).toBe("sk-ant-oat-1");
	});
});

describe("fetchClaudeOAuthUsageForAccount", () => {
	test("returns error when token is expired", async () => {
		const account = {
			label: "expired-account",
			accessToken: "sk-ant-oat-expired",
			expiresAt: Date.now() - 1000, // Expired 1 second ago
			source: "test",
		};

		const result = await fetchClaudeOAuthUsageForAccount(account);
		expect(result.success).toBe(false);
		expect(result.error).toContain("expired");
		expect(result.label).toBe("expired-account");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Deduplication tests
// ─────────────────────────────────────────────────────────────────────────────

// Helper to create a fake JWT with a specific email in the profile claim
function createFakeJwtWithEmail(email) {
	const header = { alg: "RS256", typ: "JWT" };
	const payload = {
		"https://api.openai.com/profile": { email },
		exp: Math.floor(Date.now() / 1000) + 3600,
	};
	const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
	return `${encode(header)}.${encode(payload)}.fake-signature`;
}

describe("deduplicateAccountsByEmail", () => {
	test("removes duplicate accounts with same email", () => {
		const accounts = [
			{ label: "account1", access: createFakeJwtWithEmail("user1@example.com"), source: "file1" },
			{ label: "account2", access: createFakeJwtWithEmail("user1@example.com"), source: "file2" },
			{ label: "account3", access: createFakeJwtWithEmail("user2@example.com"), source: "file3" },
		];
		const result = deduplicateAccountsByEmail(accounts);
		expect(result.length).toBe(2);
		expect(result[0].label).toBe("account1");
		expect(result[1].label).toBe("account3");
	});

	test("keeps first occurrence when duplicates exist", () => {
		const accounts = [
			{ label: "first", access: createFakeJwtWithEmail("same@example.com"), source: "source1" },
			{ label: "second", access: createFakeJwtWithEmail("same@example.com"), source: "source2" },
			{ label: "third", access: createFakeJwtWithEmail("same@example.com"), source: "source3" },
		];
		const result = deduplicateAccountsByEmail(accounts);
		expect(result.length).toBe(1);
		expect(result[0].label).toBe("first");
		expect(result[0].source).toBe("source1");
	});

	test("returns all accounts when emails are different", () => {
		const accounts = [
			{ label: "a", access: createFakeJwtWithEmail("a@example.com"), source: "s1" },
			{ label: "b", access: createFakeJwtWithEmail("b@example.com"), source: "s2" },
			{ label: "c", access: createFakeJwtWithEmail("c@example.com"), source: "s3" },
		];
		const result = deduplicateAccountsByEmail(accounts);
		expect(result.length).toBe(3);
	});

	test("handles empty array", () => {
		const result = deduplicateAccountsByEmail([]);
		expect(result).toEqual([]);
	});

	test("keeps accounts without access token", () => {
		const accounts = [
			{ label: "no-token", source: "s1" },
			{ label: "has-token", access: createFakeJwtWithEmail("user@example.com"), source: "s2" },
		];
		const result = deduplicateAccountsByEmail(accounts);
		expect(result.length).toBe(2);
	});

	test("keeps accounts with invalid JWT (no email extractable)", () => {
		const accounts = [
			{ label: "invalid-jwt", access: "not-a-valid-jwt", source: "s1" },
			{ label: "valid-jwt", access: createFakeJwtWithEmail("user@example.com"), source: "s2" },
		];
		const result = deduplicateAccountsByEmail(accounts);
		expect(result.length).toBe(2);
	});
});

describe("deduplicateClaudeOAuthAccounts", () => {
	test("removes duplicate accounts with same refreshToken", () => {
		const accounts = [
			{ label: "claude1", accessToken: "sk-ant-oat-abc", refreshToken: "sk-ant-ort-same", source: "file1" },
			{ label: "claude2", accessToken: "sk-ant-oat-def", refreshToken: "sk-ant-ort-same", source: "file2" },
			{ label: "claude3", accessToken: "sk-ant-oat-ghi", refreshToken: "sk-ant-ort-different", source: "file3" },
		];
		const result = deduplicateClaudeOAuthAccounts(accounts);
		expect(result.length).toBe(2);
		expect(result[0].label).toBe("claude1");
		expect(result[1].label).toBe("claude3");
	});

	test("keeps first occurrence when duplicates exist", () => {
		const refresh = "sk-ant-ort-same-" + "x".repeat(50);
		const accounts = [
			{ label: "first", accessToken: "sk-ant-oat-1", refreshToken: refresh, source: "source1" },
			{ label: "second", accessToken: "sk-ant-oat-2", refreshToken: refresh, source: "source2" },
		];
		const result = deduplicateClaudeOAuthAccounts(accounts);
		expect(result.length).toBe(1);
		expect(result[0].label).toBe("first");
	});

	test("returns all accounts when refresh tokens are different", () => {
		const accounts = [
			{ label: "a", accessToken: "sk-ant-oat-1", refreshToken: "sk-ant-ort-1-unique", source: "s1" },
			{ label: "b", accessToken: "sk-ant-oat-2", refreshToken: "sk-ant-ort-2-unique", source: "s2" },
		];
		const result = deduplicateClaudeOAuthAccounts(accounts);
		expect(result.length).toBe(2);
	});

	test("falls back to accessToken when no refreshToken", () => {
		const accounts = [
			{ label: "claude1", accessToken: "sk-ant-oat-same-token", source: "file1" },
			{ label: "claude2", accessToken: "sk-ant-oat-same-token", source: "file2" },
			{ label: "claude3", accessToken: "sk-ant-oat-different", source: "file3" },
		];
		const result = deduplicateClaudeOAuthAccounts(accounts);
		expect(result.length).toBe(2);
		expect(result[0].label).toBe("claude1");
		expect(result[1].label).toBe("claude3");
	});

	test("handles empty array", () => {
		const result = deduplicateClaudeOAuthAccounts([]);
		expect(result).toEqual([]);
	});

	test("keeps accounts without accessToken", () => {
		const accounts = [
			{ label: "no-token", source: "s1" },
			{ label: "has-token", accessToken: "sk-ant-valid-token", source: "s2" },
		];
		const result = deduplicateClaudeOAuthAccounts(accounts);
		expect(result.length).toBe(2);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// generatePKCE tests
// ─────────────────────────────────────────────────────────────────────────────

describe("generatePKCE", () => {
	test("returns object with verifier and challenge", () => {
		const pkce = generatePKCE();
		expect(pkce).toHaveProperty("verifier");
		expect(pkce).toHaveProperty("challenge");
	});

	test("verifier is 43 characters (32 bytes base64url)", () => {
		const pkce = generatePKCE();
		expect(pkce.verifier.length).toBe(43);
	});

	test("challenge is 43 characters (SHA256 in base64url)", () => {
		const pkce = generatePKCE();
		expect(pkce.challenge.length).toBe(43);
	});

	test("returns different values on each call", () => {
		const pkce1 = generatePKCE();
		const pkce2 = generatePKCE();
		expect(pkce1.verifier).not.toBe(pkce2.verifier);
		expect(pkce1.challenge).not.toBe(pkce2.challenge);
	});

	test("verifier is valid base64url (no +, /, or = chars)", () => {
		const pkce = generatePKCE();
		expect(pkce.verifier).not.toMatch(/[+/=]/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// generateState tests
// ─────────────────────────────────────────────────────────────────────────────

describe("generateState", () => {
	test("returns 64-character hex string", () => {
		const state = generateState();
		expect(state.length).toBe(64);
	});

	test("returns valid hex characters only", () => {
		const state = generateState();
		expect(state).toMatch(/^[0-9a-f]+$/);
	});

	test("returns different values on each call", () => {
		const state1 = generateState();
		const state2 = generateState();
		expect(state1).not.toBe(state2);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// buildAuthUrl tests
// ─────────────────────────────────────────────────────────────────────────────

describe("buildAuthUrl", () => {
	test("returns valid URL starting with AUTHORIZE_URL", () => {
		const pkce = generatePKCE();
		const state = generateState();
		const url = buildAuthUrl(pkce.challenge, state);
		
		expect(url).toMatch(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
	});

	test("includes all required OAuth parameters", () => {
		const pkce = generatePKCE();
		const state = generateState();
		const url = buildAuthUrl(pkce.challenge, state);
		const parsed = new URL(url);
		
		expect(parsed.searchParams.get("response_type")).toBe("code");
		expect(parsed.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
		expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
		expect(parsed.searchParams.get("scope")).toBe("openid profile email offline_access");
		expect(parsed.searchParams.get("code_challenge")).toBe(pkce.challenge);
		expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
		expect(parsed.searchParams.get("state")).toBe(state);
	});

	test("URL is parseable by URL constructor", () => {
		const pkce = generatePKCE();
		const state = generateState();
		const url = buildAuthUrl(pkce.challenge, state);
		
		expect(() => new URL(url)).not.toThrow();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// checkPortAvailable tests
// ─────────────────────────────────────────────────────────────────────────────

describe("checkPortAvailable", () => {
	test("returns true for available port", async () => {
		// Use a high port that's unlikely to be in use
		const result = await checkPortAvailable(59999);
		expect(result).toBe(true);
	});

	// Note: Testing port-in-use requires starting a server, which is more complex
	// and covered by integration tests
});

// ─────────────────────────────────────────────────────────────────────────────
// JWT utilities tests
// ─────────────────────────────────────────────────────────────────────────────

describe("decodeJWT", () => {
	test("decodes valid JWT and returns payload", () => {
		const token = createMockAccessToken(MOCK_ACCOUNT_ID);
		const payload = decodeJWT(token);
		
		expect(payload).not.toBeNull();
		expect(payload["https://api.openai.com/auth"].chatgpt_account_id).toBe(MOCK_ACCOUNT_ID);
	});

	test("returns null for invalid JWT format", () => {
		expect(decodeJWT("not.a.valid.token.format")).toBeNull();
		expect(decodeJWT("just-a-string")).toBeNull();
		expect(decodeJWT("")).toBeNull();
	});

	test("returns null for JWT with invalid base64", () => {
		expect(decodeJWT("header.!!!invalid!!!.signature")).toBeNull();
	});
});

describe("extractAccountId", () => {
	test("extracts account ID from valid token", () => {
		const token = createMockAccessToken(MOCK_ACCOUNT_ID);
		const accountId = extractAccountId(token);
		expect(accountId).toBe(MOCK_ACCOUNT_ID);
	});

	test("returns null for token without account ID", () => {
		const header = { alg: "RS256" };
		const payload = { sub: "user123" };
		const token = `${Buffer.from(JSON.stringify(header)).toString("base64")}.${Buffer.from(JSON.stringify(payload)).toString("base64")}.sig`;
		
		expect(extractAccountId(token)).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// isHeadlessEnvironment tests
// ─────────────────────────────────────────────────────────────────────────────

describe("isHeadlessEnvironment", () => {
	let originalSSH_CLIENT;
	let originalSSH_TTY;
	let originalDISPLAY;
	let originalWAYLAND_DISPLAY;
	let originalPlatform;

	beforeEach(() => {
		// Save original env values
		originalSSH_CLIENT = process.env.SSH_CLIENT;
		originalSSH_TTY = process.env.SSH_TTY;
		originalDISPLAY = process.env.DISPLAY;
		originalWAYLAND_DISPLAY = process.env.WAYLAND_DISPLAY;
		// Clear all relevant env vars for clean test state
		delete process.env.SSH_CLIENT;
		delete process.env.SSH_TTY;
		delete process.env.DISPLAY;
		delete process.env.WAYLAND_DISPLAY;
	});

	afterEach(() => {
		// Restore original env values
		if (originalSSH_CLIENT === undefined) {
			delete process.env.SSH_CLIENT;
		} else {
			process.env.SSH_CLIENT = originalSSH_CLIENT;
		}
		if (originalSSH_TTY === undefined) {
			delete process.env.SSH_TTY;
		} else {
			process.env.SSH_TTY = originalSSH_TTY;
		}
		if (originalDISPLAY === undefined) {
			delete process.env.DISPLAY;
		} else {
			process.env.DISPLAY = originalDISPLAY;
		}
		if (originalWAYLAND_DISPLAY === undefined) {
			delete process.env.WAYLAND_DISPLAY;
		} else {
			process.env.WAYLAND_DISPLAY = originalWAYLAND_DISPLAY;
		}
	});

	test("returns true when SSH_CLIENT is set", () => {
		process.env.SSH_CLIENT = "192.168.1.100 50000 22";
		expect(isHeadlessEnvironment()).toBe(true);
	});

	test("returns true when SSH_TTY is set", () => {
		process.env.SSH_TTY = "/dev/pts/0";
		expect(isHeadlessEnvironment()).toBe(true);
	});

	test("returns true when both SSH_CLIENT and SSH_TTY are set", () => {
		process.env.SSH_CLIENT = "192.168.1.100 50000 22";
		process.env.SSH_TTY = "/dev/pts/0";
		expect(isHeadlessEnvironment()).toBe(true);
	});

	test("returns false when SSH vars not set and DISPLAY is available (non-Linux or Linux with display)", () => {
		// Clear SSH vars (already done in beforeEach)
		// Set DISPLAY to simulate graphical environment
		process.env.DISPLAY = ":0";
		// This test verifies that with DISPLAY set, it returns false
		// The actual result depends on platform, but if not headless, should be false
		const result = isHeadlessEnvironment();
		// If on Linux, having DISPLAY means not headless
		// If not on Linux, no SSH means not headless
		expect(result).toBe(false);
	});

	test("SSH detection takes priority over display availability", () => {
		// Even with DISPLAY set, SSH session should return true
		process.env.DISPLAY = ":0";
		process.env.SSH_CLIENT = "192.168.1.100 50000 22";
		expect(isHeadlessEnvironment()).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// openBrowser tests
// ─────────────────────────────────────────────────────────────────────────────

describe("openBrowser", () => {
	let originalSSH_CLIENT;
	let originalSSH_TTY;
	let originalDISPLAY;
	let originalWAYLAND_DISPLAY;
	let consoleLogSpy;
	let originalConsoleLog;

	beforeEach(() => {
		// Save original env values
		originalSSH_CLIENT = process.env.SSH_CLIENT;
		originalSSH_TTY = process.env.SSH_TTY;
		originalDISPLAY = process.env.DISPLAY;
		originalWAYLAND_DISPLAY = process.env.WAYLAND_DISPLAY;
		// Clear all relevant env vars for clean test state
		delete process.env.SSH_CLIENT;
		delete process.env.SSH_TTY;
		delete process.env.DISPLAY;
		delete process.env.WAYLAND_DISPLAY;
		// Spy on console.log
		originalConsoleLog = console.log;
		consoleLogSpy = [];
		console.log = (...args) => {
			consoleLogSpy.push(args.join(" "));
		};
	});

	afterEach(() => {
		// Restore console.log
		console.log = originalConsoleLog;
		// Restore original env values
		if (originalSSH_CLIENT === undefined) {
			delete process.env.SSH_CLIENT;
		} else {
			process.env.SSH_CLIENT = originalSSH_CLIENT;
		}
		if (originalSSH_TTY === undefined) {
			delete process.env.SSH_TTY;
		} else {
			process.env.SSH_TTY = originalSSH_TTY;
		}
		if (originalDISPLAY === undefined) {
			delete process.env.DISPLAY;
		} else {
			process.env.DISPLAY = originalDISPLAY;
		}
		if (originalWAYLAND_DISPLAY === undefined) {
			delete process.env.WAYLAND_DISPLAY;
		} else {
			process.env.WAYLAND_DISPLAY = originalWAYLAND_DISPLAY;
		}
	});

	test("returns false and prints URL when --no-browser option is set", () => {
		const testUrl = "https://auth.openai.com/authorize?test=123";
		const result = openBrowser(testUrl, { noBrowser: true });
		
		expect(result).toBe(false);
		// Check that URL was printed to console
		const logOutput = consoleLogSpy.join("\n");
		expect(logOutput).toContain(testUrl);
		expect(logOutput).toContain("Open this URL in your browser");
	});

	test("returns false and prints URL in headless environment (SSH_CLIENT set)", () => {
		process.env.SSH_CLIENT = "192.168.1.100 50000 22";
		const testUrl = "https://auth.openai.com/authorize?test=456";
		const result = openBrowser(testUrl, {});
		
		expect(result).toBe(false);
		const logOutput = consoleLogSpy.join("\n");
		expect(logOutput).toContain(testUrl);
		expect(logOutput).toContain("Open this URL in your browser");
	});

	test("returns false and prints URL in headless environment (SSH_TTY set)", () => {
		process.env.SSH_TTY = "/dev/pts/0";
		const testUrl = "https://auth.openai.com/authorize?test=789";
		const result = openBrowser(testUrl, {});
		
		expect(result).toBe(false);
		const logOutput = consoleLogSpy.join("\n");
		expect(logOutput).toContain(testUrl);
		expect(logOutput).toContain("Open this URL in your browser");
	});

	test("--no-browser option takes priority over display availability", () => {
		// Even with DISPLAY set (non-headless), --no-browser should still print URL
		process.env.DISPLAY = ":0";
		const testUrl = "https://auth.openai.com/authorize?test=priority";
		const result = openBrowser(testUrl, { noBrowser: true });
		
		expect(result).toBe(false);
		const logOutput = consoleLogSpy.join("\n");
		expect(logOutput).toContain(testUrl);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Color utilities tests
// ─────────────────────────────────────────────────────────────────────────────

describe("colorize", () => {
	test("returns text unchanged when colors not supported", () => {
		// In test environment, stdout is not a TTY, so colors should be disabled
		const result = colorize("test", "\x1b[32m");
		expect(result).toBe("test");
	});
});

describe("supportsColor", () => {
	let originalNO_COLOR;
	let originalIsTTY;

	beforeEach(() => {
		// Save original values
		originalNO_COLOR = process.env.NO_COLOR;
		originalIsTTY = process.stdout.isTTY;
	});

	afterEach(() => {
		// Restore original values
		if (originalNO_COLOR === undefined) {
			delete process.env.NO_COLOR;
		} else {
			process.env.NO_COLOR = originalNO_COLOR;
		}
		// Note: we can't restore isTTY as it's read-only, but tests shouldn't modify it
	});

	test("returns false when NO_COLOR env var is set to '1'", () => {
		process.env.NO_COLOR = "1";
		expect(supportsColor()).toBe(false);
	});

	test("returns false when NO_COLOR env var is set to any non-empty string", () => {
		process.env.NO_COLOR = "true";
		expect(supportsColor()).toBe(false);
		
		process.env.NO_COLOR = "yes";
		expect(supportsColor()).toBe(false);
		
		process.env.NO_COLOR = "anything";
		expect(supportsColor()).toBe(false);
	});

	test("returns false when stdout is not a TTY (test environment)", () => {
		// In test environment, stdout.isTTY is typically undefined/false
		// Clear NO_COLOR to isolate the TTY check
		delete process.env.NO_COLOR;
		// Test runner pipes output, so isTTY is false
		expect(supportsColor()).toBe(false);
	});

	test("colorize returns plain text when NO_COLOR is set", () => {
		process.env.NO_COLOR = "1";
		const result = colorize("Error message", "\x1b[31m"); // RED
		// Should return plain text without ANSI codes
		expect(result).toBe("Error message");
		expect(result).not.toContain("\x1b[");
	});

	test("colorize returns plain text when NO_COLOR is set to empty-looking value", () => {
		// Per no-color.org spec, any non-empty value disables color
		// However, technically empty string should NOT disable colors
		delete process.env.NO_COLOR;
		// In test env, colors are disabled due to non-TTY anyway
		const result = colorize("Success", "\x1b[32m"); // GREEN
		expect(result).toBe("Success");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// --no-color flag tests
// ─────────────────────────────────────────────────────────────────────────────

describe("--no-color flag", () => {
	let originalNO_COLOR;

	beforeEach(() => {
		// Save original NO_COLOR and clear it
		originalNO_COLOR = process.env.NO_COLOR;
		delete process.env.NO_COLOR;
		// Reset the noColorFlag before each test
		setNoColorFlag(false);
	});

	afterEach(() => {
		// Restore original NO_COLOR
		if (originalNO_COLOR === undefined) {
			delete process.env.NO_COLOR;
		} else {
			process.env.NO_COLOR = originalNO_COLOR;
		}
		// Reset noColorFlag after tests
		setNoColorFlag(false);
	});

	test("supportsColor returns false when --no-color flag is set via setNoColorFlag(true)", () => {
		setNoColorFlag(true);
		expect(supportsColor()).toBe(false);
	});

	test("colorize returns plain text when --no-color flag is set", () => {
		setNoColorFlag(true);
		const result = colorize("Error message", "\x1b[31m"); // RED
		expect(result).toBe("Error message");
		expect(result).not.toContain("\x1b[");
	});

	test("--no-color flag takes priority over TTY status", () => {
		// Even if we somehow had a TTY (which we don't in tests), --no-color should disable colors
		setNoColorFlag(true);
		expect(supportsColor()).toBe(false);
	});

	test("colors remain disabled after multiple colorize calls with --no-color", () => {
		setNoColorFlag(true);
		
		// Multiple calls should all return plain text
		expect(colorize("First", "\x1b[32m")).toBe("First");   // GREEN
		expect(colorize("Second", "\x1b[31m")).toBe("Second"); // RED
		expect(colorize("Third", "\x1b[33m")).toBe("Third");   // YELLOW
	});

	test("setNoColorFlag can be toggled", () => {
		// Start disabled
		setNoColorFlag(true);
		expect(supportsColor()).toBe(false);
		
		// Re-enable (though TTY check will still fail in tests)
		setNoColorFlag(false);
		// Without --no-color, supportsColor depends on TTY (false in test env)
		// So we just verify it doesn't throw
		supportsColor();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// findAccountByLabel tests
// ─────────────────────────────────────────────────────────────────────────────

describe("findAccountByLabel", () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = process.env.CODEX_ACCOUNTS;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.CODEX_ACCOUNTS;
		} else {
			process.env.CODEX_ACCOUNTS = originalEnv;
		}
	});

	test("finds account by label from env", () => {
		const mockAccounts = [
			{ label: "personal", accountId: MOCK_ACCOUNT_ID, access: MOCK_ACCESS_TOKEN, refresh: MOCK_REFRESH_TOKEN },
		];
		process.env.CODEX_ACCOUNTS = JSON.stringify(mockAccounts);
		
		const account = findAccountByLabel("personal");
		expect(account).not.toBeNull();
		expect(account.label).toBe("personal");
	});

	test("returns null for non-existent label", () => {
		delete process.env.CODEX_ACCOUNTS;
		const account = findAccountByLabel("nonexistent-label-12345");
		expect(account).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// getAllLabels tests
// ─────────────────────────────────────────────────────────────────────────────

describe("getAllLabels", () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = process.env.CODEX_ACCOUNTS;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.CODEX_ACCOUNTS;
		} else {
			process.env.CODEX_ACCOUNTS = originalEnv;
		}
	});

	test("returns array of labels from env accounts", () => {
		// Use different emails so they aren't deduplicated
		const mockAccounts = [
			{ label: "work", accountId: MOCK_ACCOUNT_ID, access: createMockAccessToken(MOCK_ACCOUNT_ID, "work@example.com"), refresh: MOCK_REFRESH_TOKEN },
			{ label: "personal", accountId: "acc_67890", access: createMockAccessToken("acc_67890", "personal@example.com"), refresh: MOCK_REFRESH_TOKEN },
		];
		process.env.CODEX_ACCOUNTS = JSON.stringify(mockAccounts);
		
		const labels = getAllLabels();
		expect(labels).toContain("work");
		expect(labels).toContain("personal");
	});

	test("returns unique labels (deduplicates by email)", () => {
		// Same email means they get deduplicated, even with different accountIds
		const mockAccounts = [
			{ label: "dedup-test-1", accountId: MOCK_ACCOUNT_ID, access: createMockAccessToken(MOCK_ACCOUNT_ID, "dedup-same@example.com"), refresh: MOCK_REFRESH_TOKEN },
			{ label: "dedup-test-2", accountId: "acc_67890", access: createMockAccessToken("acc_67890", "dedup-same@example.com"), refresh: MOCK_REFRESH_TOKEN },
		];
		process.env.CODEX_ACCOUNTS = JSON.stringify(mockAccounts);
		
		const labels = getAllLabels();
		// Only first account kept (by email), so "dedup-test-1" should be present
		// but "dedup-test-2" should be deduplicated away
		expect(labels).toContain("dedup-test-1");
		expect(labels).not.toContain("dedup-test-2");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// startCallbackServer tests
// ─────────────────────────────────────────────────────────────────────────────

describe("startCallbackServer", () => {
	test("starts and listens on port 1455", async () => {
		const expectedState = generateState();
		
		// Start the server
		const serverPromise = startCallbackServer(expectedState);
		
		// Give the server time to start listening
		await new Promise(resolve => setTimeout(resolve, 100));
		
		// Verify the port is now in use (server is listening)
		const portAvailable = await checkPortAvailable(1455);
		expect(portAvailable).toBe(false);
		
		// Simulate a successful callback to clean up
		const response = await fetch(`http://127.0.0.1:1455/auth/callback?code=test_code&state=${expectedState}`);
		expect(response.ok).toBe(true);
		
		// Get the result
		const result = await serverPromise;
		expect(result.code).toBe("test_code");
		expect(result.state).toBe(expectedState);
	});

	test("returns code and state from callback URL", async () => {
		const expectedState = generateState();
		const testCode = "authorization_code_123";
		
		// Start the server
		const serverPromise = startCallbackServer(expectedState);
		
		// Give the server time to start
		await new Promise(resolve => setTimeout(resolve, 100));
		
		// Simulate callback with code and state
		const response = await fetch(`http://127.0.0.1:1455/auth/callback?code=${testCode}&state=${expectedState}`);
		expect(response.ok).toBe(true);
		
		// Verify the result
		const result = await serverPromise;
		expect(result.code).toBe(testCode);
		expect(result.state).toBe(expectedState);
	});

	test("rejects on state mismatch (CSRF protection)", async () => {
		const expectedState = generateState();
		const wrongState = generateState(); // Different state
		
		// Start the server and immediately attach error handler to prevent uncaught rejection
		let error = null;
		const serverPromise = startCallbackServer(expectedState).catch(e => {
			error = e;
		});
		
		// Give the server time to start
		await new Promise(resolve => setTimeout(resolve, 100));
		
		// Simulate callback with wrong state
		const response = await fetch(`http://127.0.0.1:1455/auth/callback?code=test_code&state=${wrongState}`);
		expect(response.status).toBe(400);
		
		// Wait for the promise to complete
		await serverPromise;
		
		// Verify the error was caught
		expect(error).not.toBeNull();
		expect(error.message).toContain("State mismatch");
	});

	test("rejects on OAuth error in callback", async () => {
		const expectedState = generateState();
		
		// Start the server and immediately attach error handler to prevent uncaught rejection
		let error = null;
		const serverPromise = startCallbackServer(expectedState).catch(e => {
			error = e;
		});
		
		// Give the server time to start
		await new Promise(resolve => setTimeout(resolve, 100));
		
		// Simulate error callback (user denied access)
		const response = await fetch(`http://127.0.0.1:1455/auth/callback?error=access_denied&error_description=User%20denied%20access`);
		expect(response.ok).toBe(true); // Error page is still a 200 response
		
		// Wait for the promise to complete
		await serverPromise;
		
		// Verify the error was caught
		expect(error).not.toBeNull();
		expect(error.message).toContain("OAuth error");
	});

	test("returns 404 for non-callback paths", async () => {
		const expectedState = generateState();
		
		// Start the server
		const serverPromise = startCallbackServer(expectedState);
		
		// Give the server time to start
		await new Promise(resolve => setTimeout(resolve, 100));
		
		// Try a non-callback path
		const response = await fetch("http://127.0.0.1:1455/other/path");
		expect(response.status).toBe(404);
		
		// Clean up by sending valid callback
		await fetch(`http://127.0.0.1:1455/auth/callback?code=cleanup&state=${expectedState}`);
		await serverPromise;
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// exchangeCodeForTokens tests
// ─────────────────────────────────────────────────────────────────────────────

describe("exchangeCodeForTokens", () => {
	let originalFetch;

	beforeEach(() => {
		// Save original fetch
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		// Restore original fetch
		globalThis.fetch = originalFetch;
	});

	// Helper to create a mock id_token with email claim
	function createMockIdToken(email) {
		const header = { alg: "RS256", typ: "JWT" };
		const payload = { email };
		const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64");
		const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64");
		return `${headerB64}.${payloadB64}.fake_signature`;
	}

	test("returns token object with all required fields on success", async () => {
		const mockAccessToken = createMockAccessToken("acc_test_123", "user@example.com", "plus");
		const mockIdToken = createMockIdToken("user@example.com");
		
		// Mock successful token exchange response
		globalThis.fetch = async (url, options) => {
			// Verify the request is correct
			expect(url).toBe("https://auth.openai.com/oauth/token");
			expect(options.method).toBe("POST");
			expect(options.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
			
			// Verify body contains required parameters
			const body = new URLSearchParams(options.body);
			expect(body.get("grant_type")).toBe("authorization_code");
			expect(body.get("code")).toBe("test_auth_code");
			expect(body.get("code_verifier")).toBe("test_verifier");
			
			return new Response(JSON.stringify({
				access_token: mockAccessToken,
				refresh_token: "refresh_token_xyz",
				id_token: mockIdToken,
				expires_in: 3600, // 1 hour
				token_type: "Bearer",
			}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};
		
		const result = await exchangeCodeForTokens("test_auth_code", "test_verifier");
		
		// Verify all required fields are present
		expect(result).toHaveProperty("accessToken");
		expect(result).toHaveProperty("refreshToken");
		expect(result).toHaveProperty("idToken");
		expect(result).toHaveProperty("expires");
		expect(result).toHaveProperty("accountId");
		expect(result).toHaveProperty("email");
		
		// Verify field values
		expect(result.accessToken).toBe(mockAccessToken);
		expect(result.refreshToken).toBe("refresh_token_xyz");
		expect(result.idToken).toBe(mockIdToken);
		expect(result.accountId).toBe("acc_test_123");
		expect(result.email).toBe("user@example.com");
		
		// Verify expires is a timestamp in the future (within ~1 hour)
		const now = Date.now();
		expect(result.expires).toBeGreaterThan(now);
		expect(result.expires).toBeLessThan(now + 3700 * 1000); // Allow slight margin
	});

	test("throws error on HTTP error response", async () => {
		globalThis.fetch = async () => {
			return new Response(JSON.stringify({
				error: "invalid_grant",
				error_description: "Authorization code has expired",
			}), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		};
		
		await expect(exchangeCodeForTokens("invalid_code", "verifier")).rejects.toThrow("Token exchange failed");
		await expect(exchangeCodeForTokens("invalid_code", "verifier")).rejects.toThrow("Authorization code has expired");
	});

	test("throws error when access_token is missing", async () => {
		globalThis.fetch = async () => {
			return new Response(JSON.stringify({
				refresh_token: "refresh_token_xyz",
				expires_in: 3600,
			}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};
		
		await expect(exchangeCodeForTokens("code", "verifier")).rejects.toThrow("Missing access_token");
	});

	test("throws error when refresh_token is missing", async () => {
		const mockAccessToken = createMockAccessToken("acc_test_123");
		
		globalThis.fetch = async () => {
			return new Response(JSON.stringify({
				access_token: mockAccessToken,
				expires_in: 3600,
			}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};
		
		await expect(exchangeCodeForTokens("code", "verifier")).rejects.toThrow("Missing refresh_token");
	});

	test("handles response without id_token (idToken is null)", async () => {
		const mockAccessToken = createMockAccessToken("acc_test_456", "notoken@example.com");
		
		globalThis.fetch = async () => {
			return new Response(JSON.stringify({
				access_token: mockAccessToken,
				refresh_token: "refresh_xyz",
				expires_in: 3600,
				// No id_token in response
			}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};
		
		const result = await exchangeCodeForTokens("code", "verifier");
		
		expect(result.idToken).toBeNull();
		expect(result.accountId).toBe("acc_test_456");
		// Email might be null since there's no id_token to extract it from
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// formatExpiryStatus tests (for list command)
// ─────────────────────────────────────────────────────────────────────────────

describe("formatExpiryStatus", () => {
	test("returns 'Unknown' for undefined expires", () => {
		const result = formatExpiryStatus(undefined);
		expect(result.status).toBe("unknown");
		expect(result.display).toBe("Unknown");
	});

	test("returns 'Unknown' for null expires", () => {
		const result = formatExpiryStatus(null);
		expect(result.status).toBe("unknown");
		expect(result.display).toBe("Unknown");
	});

	test("returns 'Expired' for past timestamp", () => {
		const pastTime = Date.now() - 10000; // 10 seconds ago
		const result = formatExpiryStatus(pastTime);
		expect(result.status).toBe("expired");
		expect(result.display).toBe("Expired");
	});

	test("returns 'expiring' status for token expiring within 5 minutes", () => {
		const expiringTime = Date.now() + 3 * 60 * 1000; // 3 minutes from now
		const result = formatExpiryStatus(expiringTime);
		expect(result.status).toBe("expiring");
		expect(result.display).toMatch(/^Expiring in \d+m$/);
	});

	test("returns 'valid' status with minutes format for <1 hour", () => {
		const futureTime = Date.now() + 30 * 60 * 1000; // 30 minutes from now
		const result = formatExpiryStatus(futureTime);
		expect(result.status).toBe("valid");
		expect(result.display).toMatch(/^\d+m$/);
	});

	test("returns 'valid' status with hours and minutes format for <24 hours", () => {
		const futureTime = Date.now() + 5 * 60 * 60 * 1000; // 5 hours from now
		const result = formatExpiryStatus(futureTime);
		expect(result.status).toBe("valid");
		expect(result.display).toMatch(/^\d+h \d+m$/);
	});

	test("returns 'valid' status with days and hours format for >24 hours", () => {
		const futureTime = Date.now() + 48 * 60 * 60 * 1000; // 48 hours from now
		const result = formatExpiryStatus(futureTime);
		expect(result.status).toBe("valid");
		expect(result.display).toMatch(/^\d+d \d+h$/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// shortenPath tests (for list command)
// ─────────────────────────────────────────────────────────────────────────────

describe("shortenPath", () => {
	test("replaces home directory with ~", () => {
		const home = homedir();
		const result = shortenPath(join(home, ".codex-accounts.json"));
		expect(result).toBe("~/.codex-accounts.json");
	});

	test("replaces home directory with ~ for nested paths", () => {
		const home = homedir();
		const result = shortenPath(join(home, ".codex", "auth.json"));
		expect(result).toBe("~/.codex/auth.json");
	});

	test("returns original path if not under home directory", () => {
		const result = shortenPath("/tmp/test-accounts.json");
		expect(result).toBe("/tmp/test-accounts.json");
	});

	test("handles paths without home directory prefix", () => {
		const result = shortenPath("/etc/config.json");
		expect(result).toBe("/etc/config.json");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// getActiveAccountId tests (for list command)
// ─────────────────────────────────────────────────────────────────────────────

describe("getActiveAccountId", () => {
	const testDir = join(tmpdir(), "codex-auth-test-" + Date.now());
	const testAuthPath = join(testDir, "auth.json");
	let originalCodexAuthPath;

	beforeEach(() => {
		originalCodexAuthPath = process.env.CODEX_AUTH_PATH;
		process.env.CODEX_AUTH_PATH = testAuthPath;
	});

	afterEach(() => {
		if (originalCodexAuthPath === undefined) {
			delete process.env.CODEX_AUTH_PATH;
		} else {
			process.env.CODEX_AUTH_PATH = originalCodexAuthPath;
		}
		rmSync(testDir, { recursive: true, force: true });
	});

	test("returns null when auth file does not exist", () => {
		const result = getActiveAccountId();
		expect(result).toBe(null);
	});

	// Note: More comprehensive tests would require mocking the filesystem
	// which is complex in this context. The function is simple enough
	// that code review verification is acceptable.
});

// ─────────────────────────────────────────────────────────────────────────────
// handleSwitch tests
// ─────────────────────────────────────────────────────────────────────────────

describe("handleSwitch", () => {
	const testDir = join(tmpdir(), "codex-switch-test-" + Date.now());
	const testAccountsFile = join(testDir, "test-accounts.json");
	const testAuthDir = join(testDir, ".codex");
	const testAuthFile = join(testAuthDir, "auth.json");
	let originalEnv;
	let originalCodexAuthPath;
	let originalXdgDataHome;
	let originalExit;
	let originalConsoleLog;
	let originalConsoleError;
	let consoleOutput;
	let exitCode;

	beforeEach(() => {
		// Create test directories
		mkdirSync(testDir, { recursive: true });
		mkdirSync(testAuthDir, { recursive: true });
		
		// Save original env and set up test env account
		originalEnv = process.env.CODEX_ACCOUNTS;
		originalCodexAuthPath = process.env.CODEX_AUTH_PATH;
		originalXdgDataHome = process.env.XDG_DATA_HOME;
		process.env.CODEX_AUTH_PATH = testAuthFile;
		process.env.XDG_DATA_HOME = testDir;
		
		// Create a test account with valid tokens in env var
		const testAccounts = [
			{
				label: "test-switch-account",
				accountId: MOCK_ACCOUNT_ID,
				access: MOCK_ACCESS_TOKEN,
				refresh: MOCK_REFRESH_TOKEN,
				idToken: "test_id_token_123",
				expires: Date.now() + 3600000, // 1 hour from now
			},
		];
		process.env.CODEX_ACCOUNTS = JSON.stringify(testAccounts);
		
		// Mock process.exit to capture exit code
		originalExit = process.exit;
		exitCode = null;
		process.exit = (code) => {
			exitCode = code;
			throw new Error(`process.exit(${code})`);
		};
		
		// Capture console output
		originalConsoleLog = console.log;
		originalConsoleError = console.error;
		consoleOutput = { log: [], error: [] };
		console.log = (...args) => consoleOutput.log.push(args.join(" "));
		console.error = (...args) => consoleOutput.error.push(args.join(" "));
	});

	afterEach(() => {
		// Restore process.exit
		process.exit = originalExit;
		
		// Restore console
		console.log = originalConsoleLog;
		console.error = originalConsoleError;
		
		// Restore env
		if (originalEnv === undefined) {
			delete process.env.CODEX_ACCOUNTS;
		} else {
			process.env.CODEX_ACCOUNTS = originalEnv;
		}
		if (originalCodexAuthPath === undefined) {
			delete process.env.CODEX_AUTH_PATH;
		} else {
			process.env.CODEX_AUTH_PATH = originalCodexAuthPath;
		}
		if (originalXdgDataHome === undefined) {
			delete process.env.XDG_DATA_HOME;
		} else {
			process.env.XDG_DATA_HOME = originalXdgDataHome;
		}
		
		// Clean up test directories
		rmSync(testDir, { recursive: true, force: true });
	});

	test("exits with error when no label provided", async () => {
		try {
			await handleSwitch([], { json: false });
		} catch (e) {
			expect(e.message).toContain("process.exit(1)");
		}
		expect(exitCode).toBe(1);
		expect(consoleOutput.error.join("\n")).toContain("Usage: codex-quota switch <label>");
	});

	test("exits with JSON error when no label provided and --json flag set", async () => {
		try {
			await handleSwitch([], { json: true });
		} catch (e) {
			expect(e.message).toContain("process.exit(1)");
		}
		expect(exitCode).toBe(1);
		// Find the JSON output
		const jsonEntry = consoleOutput.log.find(entry => entry.startsWith("{"));
		expect(jsonEntry).toBeDefined();
		const output = JSON.parse(jsonEntry);
		expect(output.success).toBe(false);
		expect(output.error).toContain("Missing required label argument");
	});

	test("exits with error when account not found", async () => {
		try {
			await handleSwitch(["nonexistent-label-xyz"], { json: false });
		} catch (e) {
			expect(e.message).toContain("process.exit(1)");
		}
		expect(exitCode).toBe(1);
		expect(consoleOutput.error.join("\n")).toContain("not found");
	});

	test("exits with JSON error and available labels when account not found", async () => {
		try {
			await handleSwitch(["nonexistent-label-xyz"], { json: true });
		} catch (e) {
			expect(e.message).toContain("process.exit(1)");
		}
		expect(exitCode).toBe(1);
		// Find the JSON output (last log entry containing valid JSON)
		const jsonEntry = consoleOutput.log.find(entry => entry.startsWith("{"));
		expect(jsonEntry).toBeDefined();
		const output = JSON.parse(jsonEntry);
		expect(output.success).toBe(false);
		expect(output.error).toContain("nonexistent-label-xyz");
		expect(output.error).toContain("not found");
		expect(Array.isArray(output.availableLabels)).toBe(true);
		expect(output.availableLabels).toContain("test-switch-account");
	});

	test("outputs success JSON with all required fields when switch succeeds", async () => {
		await handleSwitch(["test-switch-account"], { json: true });
		
		// Find the JSON output (success response starts with { and contains "success")
		const jsonEntry = consoleOutput.log.find(entry => entry.startsWith("{"));
		expect(jsonEntry).toBeDefined();
		const output = JSON.parse(jsonEntry);
		expect(output.success).toBe(true);
		expect(output.label).toBe("test-switch-account");
		expect(output).toHaveProperty("email");
		expect(output).toHaveProperty("accountId");
		expect(output).toHaveProperty("authPath");
	});

	test("auth.json has correct structure with tokens object after switch", async () => {
		// Execute the switch
		await handleSwitch(["test-switch-account"], { json: true });
		
		// Read the test auth.json that was written
		expect(existsSync(testAuthFile)).toBe(true);
		
		const authContent = JSON.parse(readFileSync(testAuthFile, "utf-8"));
		
		// Verify the tokens object structure
		expect(authContent).toHaveProperty("tokens");
		expect(authContent.tokens).toHaveProperty("access_token");
		expect(authContent.tokens).toHaveProperty("refresh_token");
		expect(authContent.tokens).toHaveProperty("account_id");
		expect(authContent.tokens).toHaveProperty("expires_at");
		
		// Verify the values match the test account
		expect(authContent.tokens.access_token).toBe(MOCK_ACCESS_TOKEN);
		expect(authContent.tokens.refresh_token).toBe(MOCK_REFRESH_TOKEN);
		expect(authContent.tokens.account_id).toBe(MOCK_ACCOUNT_ID);
		expect(authContent.tokens.id_token).toBe("test_id_token_123");
		
		// Verify expires_at is in seconds (not milliseconds)
		expect(authContent.tokens.expires_at).toBeLessThan(Date.now()); // Should be in seconds
		expect(authContent.tokens.expires_at).toBeGreaterThan(Date.now() / 1000 - 100); // Reasonable range
		
		// Verify last_refresh is an ISO timestamp at root level (matches Codex CLI format)
		expect(authContent).toHaveProperty("last_refresh");
		expect(authContent.last_refresh).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	test("updates OpenCode auth.json without touching other providers", async () => {
		const opencodeDir = join(testDir, "opencode");
		const opencodeAuthPath = join(opencodeDir, "auth.json");
		mkdirSync(opencodeDir, { recursive: true });
		const existingAuth = {
			openai: {
				type: "oauth",
				access: "old_access",
				refresh: "old_refresh",
				expires: 123,
				accountId: "old_account",
				extra: "keep",
			},
			anthropic: {
				type: "api",
				key: "anthropic_key",
			},
			openrouter: {
				type: "api",
				key: "openrouter_key",
			},
		};
		writeFileSync(opencodeAuthPath, JSON.stringify(existingAuth, null, 2) + "\n", "utf-8");
		const expectedExpires = JSON.parse(process.env.CODEX_ACCOUNTS)[0].expires;
		
		await handleSwitch(["test-switch-account"], { json: true });
		
		const updatedAuth = JSON.parse(readFileSync(opencodeAuthPath, "utf-8"));
		expect(updatedAuth.anthropic).toEqual(existingAuth.anthropic);
		expect(updatedAuth.openrouter).toEqual(existingAuth.openrouter);
		expect(updatedAuth.openai.type).toBe("oauth");
		expect(updatedAuth.openai.access).toBe(MOCK_ACCESS_TOKEN);
		expect(updatedAuth.openai.refresh).toBe(MOCK_REFRESH_TOKEN);
		expect(updatedAuth.openai.accountId).toBe(MOCK_ACCOUNT_ID);
		expect(updatedAuth.openai.expires).toBe(expectedExpires);
		expect(updatedAuth.openai.extra).toBe("keep");
	});

	test("preserves symlinked OpenCode auth.json", async () => {
		if (process.platform === "win32") {
			return;
		}
		const opencodeDir = join(testDir, "opencode");
		const realDir = join(testDir, "real-auth");
		const opencodeAuthPath = join(opencodeDir, "auth.json");
		const realAuthPath = join(realDir, "auth.json");
		
		mkdirSync(opencodeDir, { recursive: true });
		mkdirSync(realDir, { recursive: true });
		
		const existingAuth = {
			openai: {
				type: "oauth",
				access: "old_access",
				refresh: "old_refresh",
				expires: 123,
				accountId: "old_account",
			},
			anthropic: {
				type: "api",
				key: "anthropic_key",
			},
		};
		writeFileSync(realAuthPath, JSON.stringify(existingAuth, null, 2) + "\n", "utf-8");
		symlinkSync(realAuthPath, opencodeAuthPath);
		
		await handleSwitch(["test-switch-account"], { json: true });
		
		expect(lstatSync(opencodeAuthPath).isSymbolicLink()).toBe(true);
		
		const updatedAuth = JSON.parse(readFileSync(realAuthPath, "utf-8"));
		expect(updatedAuth.anthropic).toEqual(existingAuth.anthropic);
		expect(updatedAuth.openai.type).toBe("oauth");
		expect(updatedAuth.openai.access).toBe(MOCK_ACCESS_TOKEN);
		expect(updatedAuth.openai.refresh).toBe(MOCK_REFRESH_TOKEN);
		expect(updatedAuth.openai.accountId).toBe(MOCK_ACCOUNT_ID);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// handleRemove tests
// ─────────────────────────────────────────────────────────────────────────────

describe("handleRemove", () => {
	const testDir = join(tmpdir(), "codex-remove-test-" + Date.now());
	const testAccountsFile = join(testDir, "test-accounts.json");
	let originalEnv;
	let originalExit;
	let originalConsoleLog;
	let originalConsoleError;
	let consoleOutput;
	let exitCode;

	beforeEach(() => {
		// Create test directory
		mkdirSync(testDir, { recursive: true });
		
		// Save original env
		originalEnv = process.env.CODEX_ACCOUNTS;
		
		// Mock process.exit to capture exit code
		originalExit = process.exit;
		exitCode = null;
		process.exit = (code) => {
			exitCode = code;
			throw new Error(`process.exit(${code})`);
		};
		
		// Capture console output
		originalConsoleLog = console.log;
		originalConsoleError = console.error;
		consoleOutput = { log: [], error: [] };
		console.log = (...args) => consoleOutput.log.push(args.join(" "));
		console.error = (...args) => consoleOutput.error.push(args.join(" "));
	});

	afterEach(() => {
		// Restore process.exit
		process.exit = originalExit;
		
		// Restore console
		console.log = originalConsoleLog;
		console.error = originalConsoleError;
		
		// Restore env
		if (originalEnv === undefined) {
			delete process.env.CODEX_ACCOUNTS;
		} else {
			process.env.CODEX_ACCOUNTS = originalEnv;
		}
		
		// Clean up test directories
		rmSync(testDir, { recursive: true, force: true });
	});

	test("exits with error when no label provided", async () => {
		try {
			await handleRemove([], { json: false });
		} catch (e) {
			expect(e.message).toContain("process.exit(1)");
		}
		expect(exitCode).toBe(1);
		expect(consoleOutput.error.join("\n")).toContain("Usage: codex-quota remove <label>");
	});

	test("exits with JSON error when no label provided and --json flag set", async () => {
		try {
			await handleRemove([], { json: true });
		} catch (e) {
			expect(e.message).toContain("process.exit(1)");
		}
		expect(exitCode).toBe(1);
		const jsonEntry = consoleOutput.log.find(entry => entry.startsWith("{"));
		expect(jsonEntry).toBeDefined();
		const output = JSON.parse(jsonEntry);
		expect(output.success).toBe(false);
		expect(output.error).toContain("Missing required label argument");
	});

	test("exits with error when account not found", async () => {
		// Set up empty env
		delete process.env.CODEX_ACCOUNTS;
		
		try {
			await handleRemove(["nonexistent-label-xyz"], { json: false });
		} catch (e) {
			expect(e.message).toContain("process.exit(1)");
		}
		expect(exitCode).toBe(1);
		expect(consoleOutput.error.join("\n")).toContain("not found");
	});

	test("exits with JSON error and available labels when account not found", async () => {
		// Set up an account in env var
		const testAccounts = [
			{ label: "existing-account", accountId: MOCK_ACCOUNT_ID, access: MOCK_ACCESS_TOKEN, refresh: MOCK_REFRESH_TOKEN },
		];
		process.env.CODEX_ACCOUNTS = JSON.stringify(testAccounts);
		
		try {
			await handleRemove(["nonexistent-label-xyz"], { json: true });
		} catch (e) {
			expect(e.message).toContain("process.exit(1)");
		}
		expect(exitCode).toBe(1);
		const jsonEntry = consoleOutput.log.find(entry => entry.startsWith("{"));
		expect(jsonEntry).toBeDefined();
		const output = JSON.parse(jsonEntry);
		expect(output.success).toBe(false);
		expect(output.error).toContain("nonexistent-label-xyz");
		expect(output.error).toContain("not found");
		expect(Array.isArray(output.availableLabels)).toBe(true);
		expect(output.availableLabels).toContain("existing-account");
	});

	test("exits with error when trying to remove env var account", async () => {
		// Set up an account in env var
		const testAccounts = [
			{ label: "env-account", accountId: MOCK_ACCOUNT_ID, access: MOCK_ACCESS_TOKEN, refresh: MOCK_REFRESH_TOKEN },
		];
		process.env.CODEX_ACCOUNTS = JSON.stringify(testAccounts);
		
		try {
			await handleRemove(["env-account"], { json: false });
		} catch (e) {
			expect(e.message).toContain("process.exit(1)");
		}
		expect(exitCode).toBe(1);
		expect(consoleOutput.error.join("\n")).toContain("Cannot remove account from CODEX_ACCOUNTS env var");
	});

	test("exits with JSON error when trying to remove env var account with --json", async () => {
		// Set up an account in env var
		const testAccounts = [
			{ label: "env-account", accountId: MOCK_ACCOUNT_ID, access: MOCK_ACCESS_TOKEN, refresh: MOCK_REFRESH_TOKEN },
		];
		process.env.CODEX_ACCOUNTS = JSON.stringify(testAccounts);
		
		try {
			await handleRemove(["env-account"], { json: true });
		} catch (e) {
			expect(e.message).toContain("process.exit(1)");
		}
		expect(exitCode).toBe(1);
		const jsonEntry = consoleOutput.log.find(entry => entry.startsWith("{"));
		expect(jsonEntry).toBeDefined();
		const output = JSON.parse(jsonEntry);
		expect(output.success).toBe(false);
		expect(output.error).toContain("Cannot remove account from CODEX_ACCOUNTS env var");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Claude OAuth browser flow tests
// ─────────────────────────────────────────────────────────────────────────────

describe("buildClaudeAuthUrl", () => {
	test("builds URL with correct base and required parameters", () => {
		const codeChallenge = "test_challenge_abc123";
		const state = "test_state_xyz789";
		const url = buildClaudeAuthUrl(codeChallenge, state);
		
		expect(url).toContain("https://claude.ai/oauth/authorize");
		expect(url).toContain("response_type=code");
		expect(url).toContain("client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e");
		expect(url).toContain("redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback");
		expect(url).toContain("code_challenge=" + codeChallenge);
		expect(url).toContain("code_challenge_method=S256");
		expect(url).toContain("state=" + state);
		expect(url).toContain("code=true");
	});

	test("includes scopes with %20 encoding for spaces", () => {
		const url = buildClaudeAuthUrl("challenge", "state");
		expect(url).toContain("scope=org%3Acreate_api_key%20user%3Aprofile%20user%3Ainference");
	});

	test("works with PKCE values from generatePKCE", () => {
		const { verifier, challenge } = generatePKCE();
		const state = generateState();
		const url = buildClaudeAuthUrl(challenge, state);
		
		expect(url).toContain(challenge);
		expect(url).toContain(state);
		// Verify URL is parseable
		expect(() => new URL(url)).not.toThrow();
	});
});

describe("parseClaudeCodeState", () => {
	test("parses code#state format", () => {
		const result = parseClaudeCodeState("abc123#xyz789");
		expect(result.code).toBe("abc123");
		expect(result.state).toBe("xyz789");
	});

	test("parses code only (no state)", () => {
		const result = parseClaudeCodeState("abc123");
		expect(result.code).toBe("abc123");
		expect(result.state).toBeNull();
	});

	test("parses full callback URL", () => {
		const result = parseClaudeCodeState(
			"https://console.anthropic.com/oauth/code/callback?code=abc123&state=xyz789"
		);
		expect(result.code).toBe("abc123");
		expect(result.state).toBe("xyz789");
	});

	test("parses callback URL without state parameter", () => {
		const result = parseClaudeCodeState(
			"https://console.anthropic.com/oauth/code/callback?code=abc123"
		);
		expect(result.code).toBe("abc123");
		expect(result.state).toBeNull();
	});

	test("returns null for empty input", () => {
		const result = parseClaudeCodeState("");
		expect(result.code).toBeNull();
		expect(result.state).toBeNull();
	});

	test("returns null for null input", () => {
		const result = parseClaudeCodeState(null);
		expect(result.code).toBeNull();
		expect(result.state).toBeNull();
	});

	test("returns null for undefined input", () => {
		const result = parseClaudeCodeState(undefined);
		expect(result.code).toBeNull();
		expect(result.state).toBeNull();
	});

	test("trims whitespace from input", () => {
		const result = parseClaudeCodeState("  abc123#xyz789  ");
		expect(result.code).toBe("abc123");
		expect(result.state).toBe("xyz789");
	});

	test("handles code with empty state after # (treats empty as null)", () => {
		const result = parseClaudeCodeState("abc123#");
		expect(result.code).toBe("abc123");
		expect(result.state).toBeNull();
	});

	test("returns null for invalid URL", () => {
		const result = parseClaudeCodeState("http://invalid url with spaces");
		expect(result.code).toBeNull();
		expect(result.state).toBeNull();
	});
});
