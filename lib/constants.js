/**
 * All configuration constants for codex-quota.
 * Zero internal dependencies — only uses Node.js built-ins.
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// OAuth config (matches OpenAI Codex CLI)
export const TOKEN_URL = "https://auth.openai.com/oauth/token";
export const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const REDIRECT_URI = "http://localhost:1455/auth/callback";
export const SCOPE = "openid profile email offline_access";
export const OAUTH_TIMEOUT_MS = 120000; // 2 minutes
export const OPENAI_OAUTH_REFRESH_BUFFER_MS = 60 * 1000;
export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const RESET_CREDITS_URL =
	"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
export const PROXX_DEFAULT_BASE_URL = "http://localhost:8789";
export const JWT_CLAIM = "https://api.openai.com/auth";
export const JWT_PROFILE = "https://api.openai.com/profile";
export const CLAUDE_CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
export const CLAUDE_MULTI_ACCOUNT_PATHS = [
	join(homedir(), ".claude-accounts.json"),
];
export const CLAUDE_API_BASE = "https://claude.ai/api";
export const CLAUDE_ORIGIN = "https://claude.ai";
export const CLAUDE_ORGS_URL = `${CLAUDE_API_BASE}/organizations`;
export const CLAUDE_ACCOUNT_URL = `${CLAUDE_API_BASE}/account`;
export const CLAUDE_TIMEOUT_MS = 15000;
export const CLAUDE_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Claude OAuth API configuration (new official endpoint)
export const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_OAUTH_VERSION = "2023-06-01";
export const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
export const CLAUDE_OAUTH_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Claude OAuth browser flow configuration
export const CLAUDE_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const CLAUDE_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
export const CLAUDE_OAUTH_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_OAUTH_SCOPES = "org:create_api_key user:profile user:inference";

// CLI command names
export const PRIMARY_CMD = "codex-quota";
export const PACKAGE_JSON_PATH = fileURLToPath(new URL("../package.json", import.meta.url));

export const MULTI_ACCOUNT_PATHS = [
	join(homedir(), ".codex-accounts.json"),
	join(homedir(), ".opencode", "openai-codex-auth-accounts.json"),
];

export const CODEX_CLI_AUTH_PATH = join(homedir(), ".codex", "auth.json");
export const PI_AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
export const DEFAULT_XDG_DATA_HOME = join(homedir(), ".local", "share");
export const MULTI_ACCOUNT_SCHEMA_VERSION = 1;

// Factory.ai configuration
export const FACTORY_API_BASE = "https://api.factory.ai";
export const FACTORY_USAGE_URL = `${FACTORY_API_BASE}/api/v1/analytics/tokens`;
export const FACTORY_TIMEOUT_MS = 15000;
export const FACTORY_MULTI_ACCOUNT_PATH = join(homedir(), ".factory-accounts.json");
export const FACTORY_AUTH_FILE_PATH = join(homedir(), ".factory", "auth.v2.file");
export const FACTORY_AUTH_KEY_PATH = join(homedir(), ".factory", "auth.v2.key");
export const FACTORY_OAUTH_REFRESH_BUFFER_MS = 60 * 1000;
export const FACTORY_PLAN_TIERS = {
	pro: 20_000_000,
	max: 200_000_000,
};

// xAI SuperGrok / Grok OAuth configuration
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const XAI_OAUTH_USERINFO_URL = "https://auth.x.ai/oauth2/userinfo";
export const XAI_OAUTH_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
export const XAI_OAUTH_REFRESH_BUFFER_MS = 5 * 60 * 1000;
export const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
export const GROK_TIMEOUT_MS = 15000;
export const GROK_PI_AUTH_PATHS = [
	join(homedir(), ".shuvpi", "agent", "auth.json"),
	join(homedir(), ".pi", "agent", "auth.json"),
	join(homedir(), ".shuvhelm", "pi-agent", "auth.json"),
];
export const GROK_HERMES_AUTH_PATH = join(homedir(), ".hermes", "auth.json");
export const GROK_OPENCODE_AUTH_PATH = join(
	process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
	"opencode",
	"auth.json",
);
export const GROK_PLAN_OVERRIDE_PATH = join(homedir(), ".grok-plan-override.json");

// Synthetic quota configuration
export const SYNTHETIC_QUOTAS_URL = "https://api.synthetic.new/v2/quotas";
export const SYNTHETIC_TIMEOUT_MS = 15000;
export const SYNTHETIC_INTEGRATION_DB_PATH = join(
	process.env.XDG_DATA_HOME || DEFAULT_XDG_DATA_HOME,
	"opencode",
	"opencode-integration-v2.db",
);

// Google AI Pro / Antigravity Cloud Code quota
export const ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const ANTIGRAVITY_CLOUD_CODE_URL = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_TIMEOUT_MS = 15000;
export const ANTIGRAVITY_OAUTH_REFRESH_BUFFER_MS = 5 * 60 * 1000;
export const ANTIGRAVITY_METHOD_ID = "google-ai-pro";
export const ANTIGRAVITY_CLI_VERSION = "1.1.13";
export const ANTIGRAVITY_CLI_CL = "964361259";
export const ANTIGRAVITY_USER_AGENT =
	`antigravity/cli/${ANTIGRAVITY_CLI_VERSION} (aidev_client; os_type=linux; arch=amd64; cl=${ANTIGRAVITY_CLI_CL}; auth_method=consumer)`;
export const ANTIGRAVITY_V1_ACCOUNTS_PATH = join(
	process.env.XDG_DATA_HOME || DEFAULT_XDG_DATA_HOME,
	"opencode",
	"antigravity-accounts.json",
);
export const ANTIGRAVITY_INTEGRATION_DB_PATHS = [
	join(process.env.XDG_DATA_HOME || DEFAULT_XDG_DATA_HOME, "opencode", "opencode.db"),
	join(process.env.XDG_DATA_HOME || DEFAULT_XDG_DATA_HOME, "opencode", "opencode-local.db"),
];

// OpenCode Go dashboard configuration
export const OPENCODE_GO_DASHBOARD_BASE_URL = "https://opencode.ai";
export const OPENCODE_GO_TIMEOUT_MS = 15000;
