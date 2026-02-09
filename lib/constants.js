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
