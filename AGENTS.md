# AGENTS.md - Coding Agent Guidelines

Guidelines for AI coding agents working in this repository.

## Project Overview

`codex-quota` is a zero-dependency Node.js CLI for managing multiple OpenAI Codex, Claude, Factory.ai, SuperGrok (xAI OAuth), Synthetic, and Google AI Pro / Antigravity credentials. Provides account management (add, switch, remove, list, sync) and quota checking using only Node.js built-in modules.

## Tech Stack

- **Runtime**: Node.js >= 18 (uses native fetch, crypto)
- **Package Manager**: Bun (preferred) or npm
- **Module System**: ESM (`"type": "module"`)
- **Test Framework**: Bun's built-in test runner
- **Dependencies**: None - uses Node.js built-ins only

## Build/Run Commands

```bash
# Run the CLI
node codex-quota.js
bun run start

# Run all tests
bun test

# Run a single test file
bun test codex-quota.test.js

# Run tests matching a pattern
bun test --grep "isValidAccount"
bun test --grep "JWT"

# Watch mode for tests
bun test --watch

# Install globally (for development)
bun link

# Preflight checks (before publish)
bun run preflight

# Dry-run pack (verify npm package contents)
bun run release:pack
```

## Project Structure

```
codex-quota/
├── codex-quota.js            # Entry point: main(), CLI routing, barrel re-exports
├── codex-quota.test.js       # Main test suite (imports via barrel re-exports)
├── grok.test.js              # SuperGrok / Grok OAuth quota tests
├── synthetic.test.js         # Synthetic API quota tests
├── lib/
│   ├── constants.js          # All config constants and path definitions
│   ├── color.js              # Terminal color output helpers
│   ├── jwt.js                # JWT decode, profile/account extraction
│   ├── fs.js                 # Atomic file write, symlink-aware write
│   ├── paths.js              # Auth file path resolution (opencode, codex-cli, pi)
│   ├── container.js          # Multi-account JSON container read/write/map
│   ├── token-match.js        # Generic OAuth token matching, normalizing, updating
│   ├── codex-accounts.js     # Codex account loading, dedup, active-label
│   ├── claude-accounts.js    # Claude account loading, session/OAuth resolution
│   ├── codex-tokens.js       # OpenAI token refresh and multi-store persistence
│   ├── claude-tokens.js      # Claude token refresh and multi-store persistence
│   ├── factory-crypto.js     # AES-256-GCM encryption/decryption for Factory auth.v2 files
│   ├── factory-accounts.js   # Factory account loading, dedup, active-label
│   ├── factory-tokens.js     # Factory token refresh and multi-store persistence
│   ├── factory-usage.js      # Factory Analytics API fetch and billing period calculation
│   ├── grok-accounts.js      # SuperGrok/xAI OAuth account loading from pi/OpenCode/Hermes
│   ├── grok-tokens.js        # SuperGrok token refresh with fan-out multi-store writeback
│   ├── grok-usage.js         # SuperGrok weekly credits billing fetch (cli-chat-proxy)
│   ├── synthetic-accounts.js # Synthetic key loading from env and integration SQLite
│   ├── synthetic-usage.js    # Synthetic quota normalization and fetch
│   ├── antigravity-accounts.js # Google AI Pro / Antigravity OAuth loading
│   ├── antigravity-tokens.js # In-memory Google OAuth refresh (no store writeback)
│   ├── antigravity-usage.js  # Cloud Code retrieveUserQuotaSummary fetch
│   ├── codex-usage.js        # Codex usage API fetch
│   ├── claude-usage.js       # Claude usage API fetch (session + OAuth)
│   ├── display.js            # Bars, boxes, usage lines, help text, shortenPath
│   ├── prompts.js            # Interactive prompt helpers (confirm/input)
│   ├── oauth.js              # OpenAI OAuth PKCE flow (shared utilities)
│   ├── claude-oauth.js       # Claude OAuth browser flow
│   ├── sync.js               # Divergence detection, reverse-sync, fresher-store
│   └── handlers.js           # Subcommand handlers (add, switch, sync, list, etc.)
├── scripts/
│   └── preflight.js          # Publish preflight checks
├── package.json
├── README.md
└── LICENSE
```

## Module Architecture

### Dependency Graph (no circular dependencies)

```
codex-quota.js (entry)
  ├── lib/constants.js          (leaf — Node.js built-ins only)
  ├── lib/color.js              ← constants
  ├── lib/jwt.js                ← constants
  ├── lib/fs.js                 (leaf — Node.js built-ins only)
  ├── lib/paths.js              ← constants
  ├── lib/prompts.js            (leaf — Node.js built-ins only)
  ├── lib/token-match.js        (leaf — zero internal deps, pure logic)
  ├── lib/container.js          ← fs, constants
  ├── lib/codex-accounts.js     ← constants, jwt, container, paths
  ├── lib/claude-accounts.js    ← constants, container, paths
  ├── lib/codex-tokens.js       ← constants, paths, jwt, token-match, container, fs
  ├── lib/claude-tokens.js      ← constants, paths, token-match, container, fs
  ├── lib/codex-usage.js        ← constants
  ├── lib/factory-crypto.js     ← constants, fs
  ├── lib/factory-accounts.js   ← constants, jwt, container, factory-crypto
  ├── lib/factory-tokens.js     ← constants, jwt, token-match, container, factory-crypto
  ├── lib/factory-usage.js      ← constants
  ├── lib/grok-accounts.js      ← constants, jwt, paths, token-match
  ├── lib/grok-tokens.js        ← constants, jwt, fs, grok-accounts
  ├── lib/grok-usage.js         ← constants
  ├── lib/synthetic-accounts.js ← constants
  ├── lib/synthetic-usage.js    ← constants
  ├── lib/antigravity-accounts.js ← constants, token-match
  ├── lib/antigravity-tokens.js ← constants
  ├── lib/antigravity-usage.js  ← constants
  ├── lib/claude-usage.js       ← constants, paths, claude-accounts, claude-tokens
  ├── lib/display.js            ← constants, color, jwt, claude-usage (for normalizeClaudeOrgId)
  ├── lib/oauth.js              ← constants, jwt
  ├── lib/claude-oauth.js       ← constants, oauth, claude-tokens, prompts
  ├── lib/sync.js               ← constants, paths, jwt, codex-accounts, claude-accounts,
  │                                codex-tokens, claude-tokens, token-match, container,
  │                                display, color, prompts, fs
  └── lib/handlers.js           ← (imports from most modules above)
```

### Entry Point Pattern

`codex-quota.js` is a thin shell (~260 lines):
1. Imports from `lib/` modules
2. `main()` function — CLI arg parsing + routing to handlers
3. `isMain` guard — only runs `main()` when executed directly
4. **Barrel re-exports** — re-exports every symbol from `lib/` so that test imports and external consumers continue to work via `import { ... } from "./codex-quota.js"`

### Where to Add New Code

| What | Where |
|------|-------|
| New constant | `lib/constants.js` |
| New Codex account loader | `lib/codex-accounts.js` |
| New Claude account loader | `lib/claude-accounts.js` |
| New Factory account loader | `lib/factory-accounts.js` |
| Factory auth.v2 crypto | `lib/factory-crypto.js` |
| New display/formatting | `lib/display.js` |
| New CLI subcommand handler | `lib/handlers.js` (+ register in `handleCodex`/`handleClaude`/`handleFactory`) |
| New OAuth flow logic | `lib/oauth.js` or `lib/claude-oauth.js` |
| Token persistence changes | `lib/codex-tokens.js`, `lib/claude-tokens.js`, `lib/factory-tokens.js`, or `lib/grok-tokens.js` |
| New Grok/SuperGrok loader | `lib/grok-accounts.js` |
| Grok billing fetch | `lib/grok-usage.js` |
| New Antigravity loader | `lib/antigravity-accounts.js` |
| Antigravity Cloud Code quota | `lib/antigravity-usage.js` |
| Sync/divergence logic | `lib/sync.js` |
| **New export for tests** | Add to the relevant `lib/*.js` module AND add a barrel re-export in `codex-quota.js` |

### Token Match Generics

`lib/token-match.js` provides unified helpers that replace the old duplicated OpenAI/Claude token-match patterns:

- `isOauthTokenMatch(params)` — single function replaces both `isOpenAiOauthTokenMatch` and `isClaudeOauthTokenMatch`
- `normalizeEntryTokens(entry, fieldMap)` — generic field normalizer using `OPENAI_TOKEN_FIELDS`, `CLAUDE_TOKEN_FIELDS`, `FACTORY_TOKEN_FIELDS`, or `XAI_TOKEN_FIELDS`
- `updateEntryTokens(entry, account, fieldMap)` — generic field updater
- `resolveKey(entry, candidates)` — picks the first existing key from candidates

When adding a new provider, define a new field map constant and reuse these generics.

### Important: package.json `files` Array

The `"files"` array **must** include `"lib/"` for the npm package to work. The preflight script (`scripts/preflight.js`) enforces this. If you add new top-level directories that need publishing, add them to both `files` and the preflight `REQUIRED_FILES` list.

## Code Style Guidelines

### Formatting

- **Indentation**: Tabs (not spaces)
- **Quotes**: Double quotes for strings
- **Semicolons**: Always use semicolons
- **Line length**: ~100 chars max
- **Trailing newline**: Always end files with a newline

### Naming Conventions

- **Constants**: `UPPER_SNAKE_CASE` (e.g., `TOKEN_URL`, `OAUTH_TIMEOUT_MS`)
- **Functions/variables**: `camelCase` (e.g., `extractAccountId`, `activeAccountsPath`)
- **Booleans**: Use prefixes `is`, `has`, `should` (e.g., `noColorFlag`, `isMain`)

### Section Dividers

Separate major sections with ASCII art (used in `codex-quota.js` entry point and larger modules):
```javascript
// ─────────────────────────────────────────────────────────────────────────────
// Section Name
// ─────────────────────────────────────────────────────────────────────────────
```

### Imports

Always use Node.js built-in modules with `node:` prefix:
```javascript
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
```

For internal imports, use relative paths from `lib/`:
```javascript
import { MULTI_ACCOUNT_PATHS } from "./constants.js";
import { writeFileAtomic } from "./fs.js";
```

### JSDoc Comments

Document exported functions with JSDoc:
```javascript
/**
 * Load accounts from a multi-account JSON file
 * @param {string} filePath - Path to the JSON file
 * @returns {Array<{label: string, accountId: string, ...}>}
 */
```

### Error Handling

- Use try/catch for file operations and JSON parsing
- Return null or empty arrays on failure (fail silently for optional data)
- Only log errors when actionable by user
- Use `console.error()` for warnings, `console.log()` for output

```javascript
try {
	return JSON.parse(readFileSync(filePath, "utf-8"));
} catch {
	return []; // Invalid JSON - silently return empty array
}
```

### Async/Await Patterns

- Use AbortController for fetch timeouts
- Clean up resources in finally blocks

```javascript
async function fetchUsage(account) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15000);
	try {
		const res = await fetch(URL, { signal: controller.signal });
		return await res.json();
	} catch (e) {
		return { error: e.message };
	} finally {
		clearTimeout(timeout);
	}
}
```

### Modern JavaScript Features

Use ES2020+ features:
- Nullish coalescing: `input ?? defaultValue`
- Optional chaining: `payload?.[JWT_PROFILE]?.email`
- Array/object spread: `all.push(...items)`, `{ ...account, source }`

## Testing Guidelines

### Test Structure

```javascript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";

describe("functionName", () => {
	test("describes what it returns/does for input", () => {
		expect(result).toBe(expected);
	});
});
```

### Test Imports

Tests import from `./codex-quota.js` (the barrel re-exports), not directly from `lib/`:
```javascript
import {
	loadAccountsFromEnv,
	loadAccountsFromFile,
	decodeJWT,
	extractAccountId,
	// ...
} from "./codex-quota.js";
```

This means any new export must be added in two places:
1. The `lib/*.js` module where the function lives
2. The barrel re-export block at the bottom of `codex-quota.js`

### Test Naming

- Descriptive names: `"returns empty array for non-existent file"`
- Group related tests with `describe` blocks
- Test edge cases: null, undefined, invalid input, empty arrays

### Environment Cleanup

Always restore environment state:
```javascript
let originalEnv;
beforeEach(() => { originalEnv = process.env.CODEX_ACCOUNTS; });
afterEach(() => {
	if (originalEnv === undefined) delete process.env.CODEX_ACCOUNTS;
	else process.env.CODEX_ACCOUNTS = originalEnv;
});
```

### Test Counts

As of latest: **686 tests** across the repository test files. All tests must pass before any commit.

### SuperGrok / Grok OAuth notes

- Namespace: `cq grok` / `cq grok quota` (also included in default `cq` / `cq quota`).
- Phase A is **quota-only**: no add/switch/remove; reads live tokens from pi/shuvpi/shuvhelm (`xai` and `xai-oauth`), OpenCode (`xai`), Hermes pool/provider, and optional `GROK_ACCOUNTS` env.
- Billing endpoint: `https://cli-chat-proxy.grok.com/v1/billing?format=credits` (weekly credits + Api/GrokBuild product split).
- **Refresh fan-out hard rule**: xAI rotates refresh tokens. On refresh, write the new access+refresh to every store that held the *same previous refresh token*. Never refresh into an isolated store only — that bricks other agents.
- Diverged refresh sessions (same user, different refresh) are left alone.

### Synthetic notes

- Namespace: `cq synthetic` / `cq synthetic quota` (also included in default quota output).
- Credentials are read from `SYNTHETIC_API_KEY`, `SYNTHETIC_ACCOUNTS`, or the shuvcode integration-v2 SQLite database.
- The SQLite reader dynamically imports `node:sqlite`; Node versions without it skip that optional source.
- Quota endpoint: `https://api.synthetic.new/v2/quotas` (rolling 5-hour, weekly credits, subscription requests, and hourly search).

### Google AI Pro / Antigravity notes

- Namespace: `cq antigravity` / `cq antigravity quota` (also included in default `cq` / `cq quota`).
- Quota-only: no add/switch/remove. Reads `ANTIGRAVITY_REFRESH` / `ANTIGRAVITY_ACCOUNTS`, `~/.local/share/opencode/antigravity-accounts.json`, and shuvcode `google` OAuth (`methodID=google-ai-pro`) from `opencode.db` / `opencode-local.db`.
- Quota endpoint: `POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` with `{ project }`. Gemini 5h + weekly, plus unused Claude/GPT buckets.
- **No refresh writeback.** Google does not rotate this refresh token. Refresh stays in memory so we do not race shuvcode's stored credential.
- OAuth client id/secret are not in-tree. Set `ANTIGRAVITY_CLIENT_ID` and `ANTIGRAVITY_CLIENT_SECRET` in `~/.codex-quota.env`.
