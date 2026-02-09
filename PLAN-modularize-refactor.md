# PLAN: Modularize & Deduplicate codex-quota

## Summary

Break the monolithic 8K-line `codex-quota.js` into focused ESM modules under `lib/`, unify duplicated OpenAI/Claude token persistence patterns into shared generics, and eliminate dead code. The test file stays as a single file but re-points its imports at the new modules. The `codex-quota.js` entry point becomes a thin shell: imports, `main()`, CLI routing, and a barrel re-export for backward compatibility.

**Zero new dependencies.** All modules use Node.js built-ins only.

## Constraints

- `package.json` `"bin"` still points at `./codex-quota.js` — it remains the entry point
- `package.json` `"files"` must be updated to include `lib/`
- All 203 existing tests must pass after each phase
- Published npm package must still work as a global CLI (`cq`, `codex-quota`)
- Each phase ends with a green test run and a commit

---

## Phase 0 — Mechanical prep and guardrails

- [x] Create `lib/` directory and add a short module index checklist in this plan (module name → exported symbols)
- [x] Add a temporary smoke script/command checklist for every phase:
  - `node codex-quota.js --version`
  - `node codex-quota.js --help`
  - `node codex-quota.js codex quota --local`
  - `node codex-quota.js claude quota --local`
- [x] Confirm current export surface from `codex-quota.js` is captured (so barrel re-export parity is verifiable later)
- [x] Commit: `chore: prep modularization guardrails and smoke checklist`

---

## Phase 1 — Extract leaf modules (no cross-dependencies)

These modules have zero internal imports — they only use Node.js built-ins. Extract them first to establish the foundation.

### 1.1 — `lib/color.js`

- [x] Create `lib/color.js`
- [x] Move from `codex-quota.js` (lines 92–159):
  - Constants: `GREEN`, `RED`, `YELLOW`, `RESET`
  - Mutable: `noColorFlag` — keep as module-level `let`, export getter/setter
  - Functions: `setNoColorFlag`, `supportsColor`, `colorize`, `outputJson`, `getPackageVersion`
- [x] `getPackageVersion` path safety: if `PACKAGE_JSON_PATH` moves to `lib/constants.js`, define it relative to the module with `new URL("../package.json", import.meta.url)` (not `dirname(import.meta.url)` from the old file)
- [x] Exports: `{ GREEN, RED, YELLOW, RESET, setNoColorFlag, supportsColor, colorize, outputJson, getPackageVersion }`
- [x] Verify: `bun test` green

### 1.2 — `lib/constants.js`

- [x] Create `lib/constants.js`
- [x] Move all top-level constants from `codex-quota.js` (lines 1–91, the block before Color output):
  - OAuth config: `TOKEN_URL`, `AUTHORIZE_URL`, `CLIENT_ID`, `REDIRECT_URI`, `SCOPE`, `OAUTH_TIMEOUT_MS`, `OPENAI_OAUTH_REFRESH_BUFFER_MS`
  - Usage/JWT: `USAGE_URL`, `JWT_CLAIM`, `JWT_PROFILE`
  - Claude constants: `CLAUDE_CREDENTIALS_PATH`, `CLAUDE_MULTI_ACCOUNT_PATHS`, `CLAUDE_API_BASE`, `CLAUDE_ORIGIN`, `CLAUDE_ORGS_URL`, `CLAUDE_ACCOUNT_URL`, `CLAUDE_TIMEOUT_MS`, `CLAUDE_USER_AGENT`
  - Claude OAuth: `CLAUDE_OAUTH_USAGE_URL`, `CLAUDE_OAUTH_VERSION`, `CLAUDE_OAUTH_BETA`, `CLAUDE_OAUTH_REFRESH_BUFFER_MS`, `CLAUDE_OAUTH_AUTHORIZE_URL`, `CLAUDE_OAUTH_TOKEN_URL`, `CLAUDE_OAUTH_REDIRECT_URI`, `CLAUDE_OAUTH_CLIENT_ID`, `CLAUDE_OAUTH_SCOPES`
  - CLI: `PRIMARY_CMD`, `PACKAGE_JSON_PATH`
  - Paths: `MULTI_ACCOUNT_PATHS`, `CODEX_CLI_AUTH_PATH`, `PI_AUTH_PATH`, `DEFAULT_XDG_DATA_HOME`, `MULTI_ACCOUNT_SCHEMA_VERSION`
- [x] Define `PACKAGE_JSON_PATH` safely for module location changes (e.g., `fileURLToPath(new URL("../package.json", import.meta.url))`)
- [x] All exports are named `const` — no logic
- [x] Verify: `bun test` green

### 1.3 — `lib/jwt.js`

- [x] Create `lib/jwt.js`
- [x] Move from `codex-quota.js` (lines 161–190):
  - Functions: `decodeJWT`, `extractAccountId`, `extractProfile`
- [x] Import `JWT_CLAIM`, `JWT_PROFILE` from `lib/constants.js`
- [x] Exports: `{ decodeJWT, extractAccountId, extractProfile }`
- [x] Verify: `bun test` green

### 1.4 — `lib/fs.js`

- [x] Create `lib/fs.js`
- [x] Move from `codex-quota.js` (lines 225–275):
  - Functions: `resolveWritePath`, `writeFileAtomic`
- [x] Exports: `{ resolveWritePath, writeFileAtomic }`
- [x] Verify: `bun test` green

### 1.5 — `lib/paths.js`

- [x] Create `lib/paths.js`
- [x] Move path-resolution functions from Account storage section (lines 192–224):
  - `getOpencodeAuthPath`, `getCodexCliAuthPath`, `getPiAuthPath`
- [x] Import needed constants from `lib/constants.js`
- [x] Exports: `{ getOpencodeAuthPath, getCodexCliAuthPath, getPiAuthPath }`
- [x] Verify: `bun test` green

### 1.6 — `lib/prompts.js`

- [x] Create `lib/prompts.js`
- [x] Move interactive prompt helpers:
  - `promptConfirm`
  - `promptInput`
- [x] Import Node built-in: `createInterface` from `node:readline`
- [x] Exports: `{ promptConfirm, promptInput }`
- [x] Verify: `bun test` green

### Phase 1 checkpoint

- [x] `bun test` — 203 pass
- [x] `cq --version` works
- [x] Commit: `refactor: extract leaf modules (color, constants, jwt, fs, paths, prompts)`

---

## Phase 2 — Extract container and token-matching generics

### 2.1 — `lib/container.js`

- [x] Create `lib/container.js`
- [x] Move from `codex-quota.js` (lines 276–815, the Multi-account container helpers section):
  - `readMultiAccountContainer`
  - `buildMultiAccountPayload`
  - `writeMultiAccountContainer`
  - `mapContainerAccounts`
- [x] Import `writeFileAtomic` from `lib/fs.js`, `MULTI_ACCOUNT_SCHEMA_VERSION` from `lib/constants.js`
- [x] Exports: `{ readMultiAccountContainer, buildMultiAccountPayload, writeMultiAccountContainer, mapContainerAccounts }`
- [x] Verify: `bun test` green

### 2.2 — `lib/token-match.js` (new — unify duplicated patterns)

This is the key deduplication. Currently there are two identical token-match functions and two near-identical normalize/update function pairs.

- [x] Create `lib/token-match.js`
- [x] Implement a single `isOauthTokenMatch({ storedAccess, storedRefresh, previousAccess, previousRefresh, label, storedLabel })` that replaces both `isOpenAiOauthTokenMatch` and `isClaudeOauthTokenMatch` (they are character-for-character identical)
- [x] Implement `normalizeEntryTokens(entry, fieldMap)` — a generic normalizer:
  ```js
  // fieldMap example for OpenAI:
  const OPENAI_TOKEN_FIELDS = {
    access: ["access", "access_token"],
    refresh: ["refresh", "refresh_token"],
    expires: ["expires", "expires_at"],
    accountId: ["accountId", "account_id"],
    idToken: ["idToken", "id_token"],
  };
  // fieldMap example for Claude:
  const CLAUDE_TOKEN_FIELDS = {
    access: ["oauthToken", "oauth_token", "accessToken", "access_token", "access"],
    refresh: ["oauthRefreshToken", "oauth_refresh_token", "refreshToken", "refresh_token", "refresh"],
    scopes: ["oauthScopes", "oauth_scopes", "scopes"],
    expires: ["oauthExpiresAt", "oauth_expires_at", "expiresAt", "expires_at", "expires"],
  };
  ```
  The function iterates `fieldMap` keys and returns the first non-nullish value for each from `entry`
- [x] Implement `resolveKey(entry, candidates)` — returns the first key from `candidates` that exists in `entry`, falling back to `candidates[0]`:
  ```js
  function resolveKey(entry, candidates) {
    for (const key of candidates) {
      if (key in entry) return key;
    }
    return candidates[0];
  }
  ```
- [x] Implement `updateEntryTokens(entry, account, fieldMap)` — generic version of `updateOpenAiOauthEntry` / `updateClaudeOauthEntry`. Uses `resolveKey` for each field in `fieldMap` to write `account[canonicalKey]` into `entry[resolvedKey]`
- [x] Export field-map constants: `OPENAI_TOKEN_FIELDS`, `CLAUDE_TOKEN_FIELDS`
- [x] Exports: `{ isOauthTokenMatch, normalizeEntryTokens, updateEntryTokens, resolveKey, OPENAI_TOKEN_FIELDS, CLAUDE_TOKEN_FIELDS }`
- [x] Add tests for the new generics (small, focused):
  - `isOauthTokenMatch` — port existing tests from both OpenAI and Claude suites
  - `normalizeEntryTokens` with both field maps
  - `resolveKey` edge cases
  - `updateEntryTokens` round-trip
- [x] Verify: `bun test` green

### 2.3 — `lib/auth-store.js` (new — unify auth-file update pattern)

Currently `updateOpencodeAuth`, `updatePiAuth`, `updateOpencodeClaudeAuth`, `updatePiClaudeAuth` all follow the same pattern: read JSON → validate → spread existing → merge provider key → write atomically. Replace with one generic.

- [x] Create `lib/auth-store.js`
- [x] Implement `updateProviderInAuthFile(path, providerKey, newFields, options)`:
  ```js
  /**
   * @param {string} path - Auth file path
   * @param {string} providerKey - e.g., "openai", "anthropic", "openai-codex"
   * @param {Record<string, unknown>} newFields - Fields to merge into the provider object
   * @param {{ mustExist?: boolean, description?: string }} options
   * @returns {{ updated: boolean, path: string, error?: string, skipped?: boolean }}
   */
  ```
  - If `!existsSync(path)` and `mustExist !== false`, return `{ skipped: true }`
  - Read, validate JSON object, spread existing provider section, merge new fields, write atomically
  - Error messages use `options.description` (e.g., "OpenCode auth.json") for context
- [x] Rewrite `updateOpencodeAuth` as: `updateProviderInAuthFile(getOpencodeAuthPath(), "openai", { type: "oauth", access, refresh, expires, accountId }, { description: "OpenCode auth.json" })`
- [x] Rewrite `updatePiAuth` as: `updateProviderInAuthFile(getPiAuthPath(), "openai-codex", { type: "oauth", ... }, { description: "pi auth.json" })`
- [x] Rewrite `updateOpencodeClaudeAuth` as: `updateProviderInAuthFile(getOpencodeAuthPath(), "anthropic", { type: "oauth", access, refresh, expires, scopes }, { description: "OpenCode auth.json" })`
- [x] Rewrite `updatePiClaudeAuth` as: `updateProviderInAuthFile(getPiAuthPath(), "anthropic", { type: "oauth", ... }, { description: "pi auth.json" })`
- [x] Keep `updateClaudeCredentials` as a thin wrapper — it has special logic (renames `claude_ai_oauth` → `claudeAiOauth`, non-provider-key structure), so it doesn't cleanly fit the generic. But it can use the same read/validate/write helpers internally
- [x] Exports: `{ updateProviderInAuthFile }`
- [x] Verify: existing tests for `persistOpenAiOAuthTokens` and `persistClaudeOAuthTokens` still pass (they test the end-to-end behavior, not the internal helpers)
- [x] `bun test` green

### Phase 2 checkpoint

- [x] `bun test` — 203+ pass (new generic tests added)
- [x] Commit: `refactor: unify token match/normalize/update and auth-store patterns`

---

## Phase 3 — Extract account-loading modules

### 3.1 — `lib/codex-accounts.js`

- [x] Create `lib/codex-accounts.js`
- [x] Move Codex account-loading functions:
  - `loadAccountsFromEnv` (uses `isValidAccount`)
  - `loadAccountsFromFile` (uses `readMultiAccountContainer`, `isValidAccount`)
  - `loadAccountFromCodexCli` (uses `getCodexCliAuthPath`, `extractAccountId`)
  - `isValidAccount`
  - `deduplicateAccountsByEmail` (uses `extractProfile`)
  - `resolveCodexActiveStorePath`, `readCodexActiveStoreContainer`, `getCodexActiveLabelInfo`
  - `loadAllAccountsNoDedup`, `loadAllAccounts`
  - `findAccountByLabel`, `getAllLabels`
- [x] **Delete dead legacy loader code**: remove `loadAccounts()`, `saveAccounts()`, and module-level `activeAccountsPath` (no runtime callsites)
- [x] Import from: `lib/constants.js`, `lib/jwt.js`, `lib/container.js`, `lib/paths.js`
- [x] Exports: all moved functions
- [x] Verify: `bun test` green

### 3.2 — `lib/claude-accounts.js`

- [x] Create `lib/claude-accounts.js`
- [x] Move Claude account-loading functions (lines 1472–1673, Claude usage fetch section):
  - `isClaudeSessionKey`, `findClaudeSessionKey`
  - `normalizeClaudeAccount`, `isValidClaudeAccount`
  - `loadClaudeAccountsFromEnv`, `loadClaudeAccountsFromFile`, `loadClaudeAccounts`
  - `resolveClaudeActiveStorePath`, `readClaudeActiveStoreContainer`, `getClaudeActiveLabelInfo`
  - `saveClaudeAccounts`
  - `loadClaudeSessionFromCredentials`, `loadClaudeOAuthToken`
  - `findClaudeAccountByLabel`, `getClaudeLabels`
- [x] Import from: `lib/constants.js`, `lib/container.js`, `lib/paths.js`
- [x] Exports: all moved functions
- [x] Verify: `bun test` green

### 3.3 — Remove dead legacy account persistence helpers

- [x] Remove `loadAccounts()` (legacy pre-container loader)
- [x] Remove `saveAccounts()` (unused)
- [x] Remove module-level mutable `activeAccountsPath`
- [x] Verify no references remain via `rg "\\b(loadAccounts|saveAccounts|activeAccountsPath)\\b"`
- [x] Verify: `bun test` green

### Phase 3 checkpoint

- [x] `bun test` — 203+ pass
- [x] Commit: `refactor: extract codex-accounts, claude-accounts; remove dead legacy loader state`

---

## Phase 4 — Extract token persistence and refresh

### 4.1 — `lib/codex-tokens.js`

- [x] Create `lib/codex-tokens.js`
- [x] Move:
  - `refreshToken` (OpenAI token refresh)
  - `isOpenAiOauthTokenExpiring`
  - `ensureFreshToken`
  - `persistOpenAiOAuthTokens` — rewrite internals to use `isOauthTokenMatch`, `normalizeEntryTokens(entry, OPENAI_TOKEN_FIELDS)`, `updateEntryTokens`, and `updateProviderInAuthFile`
- [x] Import from: `lib/constants.js`, `lib/paths.js`, `lib/jwt.js`, `lib/token-match.js`, `lib/auth-store.js`, `lib/container.js`, `lib/fs.js`
- [x] Exports: `{ refreshToken, isOpenAiOauthTokenExpiring, ensureFreshToken, persistOpenAiOAuthTokens }`
- [x] Verify: `bun test` green (the `persistOpenAiOAuthTokens` and `ensureFreshToken` test suites are the key validators)

### 4.2 — `lib/claude-tokens.js`

- [x] Create `lib/claude-tokens.js`
- [x] Move:
  - `updateClaudeCredentials` (thin wrapper, keeps its special rename logic)
  - `persistClaudeOAuthTokens` — rewrite internals to use `isOauthTokenMatch`, `normalizeEntryTokens(entry, CLAUDE_TOKEN_FIELDS)`, `updateEntryTokens`, and `updateProviderInAuthFile`
  - `ensureFreshClaudeOAuthToken`
  - `refreshClaudeToken`
- [x] Import from: `lib/constants.js`, `lib/paths.js`, `lib/token-match.js`, `lib/auth-store.js`, `lib/container.js`, `lib/fs.js`
- [x] Exports: `{ updateClaudeCredentials, persistClaudeOAuthTokens, ensureFreshClaudeOAuthToken, refreshClaudeToken }`
- [x] Verify: `bun test` green (the `persistClaudeOAuthTokens` test suite is the key validator)

### Phase 4 checkpoint

- [x] `bun test` — all pass
- [x] Commit: `refactor: extract codex-tokens, claude-tokens using shared generics`

---

## Phase 5 — Extract usage fetching and display (split into smaller commits)

### 5.1 — `lib/codex-usage.js`

- [x] Create `lib/codex-usage.js`
- [x] Move `fetchUsage` (lines 1442–1470)
- [x] Import from: `lib/constants.js`
- [x] Exports: `{ fetchUsage }`
- [x] Verify: `bun test` green
- [x] Commit: `refactor: extract codex usage fetch module`

### 5.2 — `lib/claude-usage.js`

- [x] Create `lib/claude-usage.js`
- [x] Move all Claude usage-fetching code (lines 1472–1673 that wasn't moved in 3.2, plus lines 1675–2565):
  - Cookie/session helpers: `extractClaudeCookieValue`, `readClaudeCookiesFromDb`, `loadClaudeCookieCandidates`, `loadClaudeSessionCandidates`
  - Header/fetch: `buildClaudeHeaders`, `fetchClaudeJson`
  - Org resolution: `extractClaudeOrgId`, `normalizeClaudeOrgId`
  - Usage: `fetchClaudeUsageForCredentials`, `fetchClaudeUsageForAccount`
  - OAuth usage: `loadClaudeOAuthFromClaudeCode`, `loadClaudeOAuthFromOpenCode`, `loadClaudeOAuthFromEnv`, `deduplicateClaudeOAuthAccounts`, `deduplicateClaudeResultsByUsage`, `loadAllClaudeOAuthAccounts`, `fetchClaudeOAuthUsage`, `fetchClaudeOAuthUsageForAccount`
- [x] Import from: `lib/constants.js`, `lib/paths.js`, `lib/claude-accounts.js`, `lib/claude-tokens.js`
- [x] Exports: all moved functions
- [x] Verify: `bun test` green
- [x] Commit: `refactor: extract claude usage fetch module`

### 5.3 — `lib/display.js`

- [x] Create `lib/display.js`
- [x] Move all display formatting (lines 2567–3621):
  - Window parsing: `parseWindow`, `formatPercent`, `normalizeClaudeOrgId` (if not already in claude-usage), `isClaudeAuthError`
  - Reset formatting: `formatResetTime`, `formatResetAt`
  - Usage formatting: `formatUsage`, `formatClaudeUsage`
  - Bar rendering: `printBar`
  - Box drawing: `drawBox` and its `BOX_CHARS` constant
  - Account usage builders: `buildAccountUsageLines`, `buildClaudeUsageLines`
  - Claude display helpers: `formatClaudePercentLeft`, `normalizePercentUsed`, `parseClaudeUtilizationWindow`, `parseClaudeWindow`, `getClaudeUsageWindows`, `formatClaudeLabel`, `formatClaudeOverageLine`
  - Path helper: `shortenPath`
- [x] Move help functions: `printHelp`, `printHelpCodex`, `printHelpClaude`, `printHelpAdd`, `printHelpCodexReauth`, `printHelpSwitch`, `printHelpCodexSync`, `printHelpList`, `printHelpRemove`, `printHelpQuota`, `printHelpClaudeAdd`, `printHelpClaudeReauth`, `printHelpClaudeSwitch`, `printHelpClaudeSync`, `printHelpClaudeList`, `printHelpClaudeRemove`, `printHelpClaudeQuota`
- [x] Import from: `lib/constants.js`, `lib/color.js`, `lib/jwt.js`
- [x] Exports: all moved functions
- [x] Verify: `bun test` green
- [x] Commit: `refactor: extract display and help rendering module`

### Phase 5 checkpoint

- [x] `bun test` — all pass
- [x] Smoke check the four Phase 0 commands
- [x] Confirm no mixed responsibility remains in entrypoint for usage/display logic

---

## Phase 6 — Extract OAuth and sync modules (split into smaller commits)

### 6.1 — `lib/oauth.js`

- [x] Create `lib/oauth.js`
- [x] Move OAuth PKCE utilities (lines 3623–4094):
  - `generatePKCE`, `generateState`, `buildAuthUrl`
  - `checkPortAvailable`, `isHeadlessEnvironment`, `openBrowser`
  - `startCallbackServer`, `exchangeCodeForTokens`
  - Callback HTML helpers used by `startCallbackServer`: `SUCCESS_HTML`, `getErrorHtml`
- [x] Import from: `lib/constants.js`, `lib/color.js`
- [x] Exports: all moved functions
- [x] Verify: `bun test` green
- [x] Commit: `refactor: extract shared oauth and callback server module`

### 6.2 — `lib/claude-oauth.js`

- [x] Create `lib/claude-oauth.js`
- [x] Move Claude OAuth browser flow (lines 4096–4375):
  - `buildClaudeAuthUrl`, `parseClaudeCodeState`
  - `exchangeClaudeCodeForTokens`
  - `handleClaudeOAuthFlow`
- [x] Import from: `lib/constants.js`, `lib/oauth.js`, `lib/claude-tokens.js`, `lib/prompts.js`
- [x] Exports: all moved functions
- [x] Verify: `bun test` green
- [x] Commit: `refactor: extract claude oauth browser flow module`

### 6.3 — `lib/sync.js`

- [x] Create `lib/sync.js`
- [x] Move active-label and divergence detection (lines 5135–5770):
  - `readCodexCliAuth`, `resolveCodexCliAccountId`, `normalizeCodexAccountEntry`
  - `getActiveAccountId`, `getActiveAccountInfo`, `formatExpiryStatus`
  - `detectCodexDivergence`, `detectClaudeDivergence`
  - Claude OAuth store import helpers currently adjacent to divergence logic:
    - `isLikelyValidClaudeOauthTokens`, `isClaudeOauthTokenEquivalent`, `findUntrackedClaudeOauthStores`, `maybeImportClaudeOauthStores`
- [x] Verify divergence/import path tests and commit: `refactor: extract sync divergence and claude oauth import helpers`
- [x] Move reverse-sync helpers (lines 5772–7811):
  - Store readers: `readOpencodeOpenAiOauthStore`, `readPiOpenAiOauthStore`, `readCodexCliOpenAiOauthStore`, `readClaudeCodeOauthStore`, `readOpencodeClaudeOauthStore`, `readPiClaudeOauthStore`
  - Fresher-store finders: `findFresherOpenAiOAuthStore`, `findFresherClaudeOAuthStore` — **unify into a single `findFresherOAuthStore(activeTokens, storeReaders)`**:
    ```js
    /**
     * @param {{ refresh: string | null, expires: number, access: string | null }} activeTokens
     * @param {Array<() => { name: string, path: string, exists: boolean, tokens: { access, refresh, expires } | null }>} storeReaders
     * @returns {{ fresher: boolean, store: { name, path, tokens } | null }}
     */
    function findFresherOAuthStore(activeTokens, storeReaders) { ... }
    ```
    Then expose thin wrappers:
    ```js
    function findFresherOpenAiOAuthStore(activeAccount) {
      return findFresherOAuthStore(
        { refresh: activeAccount.refresh, expires: activeAccount.expires ?? 0, access: activeAccount.access },
        [readOpencodeOpenAiOauthStore, readPiOpenAiOauthStore, readCodexCliOpenAiOauthStore],
      );
    }
    ```
  - Sync handlers: `handleCodexSync`, `handleClaudeSync` and their internal helpers
- [x] Import from: `lib/constants.js`, `lib/paths.js`, `lib/jwt.js`, `lib/codex-accounts.js`, `lib/claude-accounts.js`, `lib/codex-tokens.js`, `lib/claude-tokens.js`, `lib/token-match.js`, `lib/container.js`, `lib/display.js`, `lib/color.js`, `lib/prompts.js`
- [x] Exports: all moved functions
- [x] Verify: `bun test` green
- [x] Commit: `refactor: extract reverse-sync store readers and fresher-store generic`

### Phase 6 checkpoint

- [x] `bun test` — all pass
- [x] Smoke check the four Phase 0 commands
- [x] Confirm `findFresherOAuthStore` wrappers preserve existing behavior for both Codex and Claude

---

## Phase 7 — Extract subcommand handlers and slim down entry point

### 7.1 — `lib/handlers.js`

- [x] Create `lib/handlers.js`
- [x] Move all subcommand handlers (lines 4377–5133):
  - Codex: `handleAdd`, `handleCodexReauth`, `handleSwitch`, `handleRemove`
  - Claude: `handleClaudeAdd`, `handleClaudeReauth`, `handleClaudeSwitch`, `handleClaudeRemove`
  - List: `handleList`, `handleClaudeList`
  - Routing: `handleCodex`, `handleClaude`, `handleQuota`
- [x] Import from: `lib/constants.js`, `lib/color.js`, `lib/display.js`, `lib/oauth.js`, `lib/claude-oauth.js`, `lib/codex-accounts.js`, `lib/claude-accounts.js`, `lib/codex-tokens.js`, `lib/claude-tokens.js`, `lib/codex-usage.js`, `lib/claude-usage.js`, `lib/sync.js`, `lib/container.js`, `lib/prompts.js`
- [x] Exports: all handler functions
- [x] Verify: `bun test` green

### 7.2 — Slim down `codex-quota.js` entry point

- [x] `codex-quota.js` becomes ~50–80 lines:
  - Shebang line
  - Imports from `lib/` modules
  - `main()` function (CLI arg parsing + routing to handlers)
  - `isMain` guard
  - Barrel re-exports for `./codex-quota.js` import compatibility (tests + any external consumers)
- [x] The barrel re-export block replaces the current 110-line export block — it re-exports everything from the lib modules so test imports don't break:
  ```js
  // Re-export everything for backward compatibility (tests, external consumers)
  export { GREEN, RED, YELLOW, setNoColorFlag, supportsColor, colorize, ... } from "./lib/color.js";
  export { decodeJWT, extractAccountId, extractProfile } from "./lib/jwt.js";
  // ... etc for each module
  ```
- [x] Verify: all test imports still resolve via `./codex-quota.js`
- [x] `bun test` green
- [x] `cq --version`, `cq --help`, `cq codex quota`, `cq claude quota` all work

### 7.3 — Update packaging and preflight checks

- [x] Add `"lib/"` to the `"files"` array so npm publish includes the modules:
  ```json
  "files": [
    "codex-quota.js",
    "lib/",
    "README.md",
    "LICENSE"
  ]
  ```
- [x] Update `scripts/preflight.js` to explicitly fail when `package.json.files` does not include `"lib/"`
- [x] Add/adjust preflight unit tests in `codex-quota.test.js` for the new `"lib/"` requirement
- [x] Verify: `bun run release:pack` (dry-run) includes all `lib/*.js` files

### Phase 7 checkpoint

- [x] `bun test` — all pass
- [x] `cq --version` returns correct version
- [x] Manual smoke test: `cq --local` shows Codex + Claude output correctly
- [x] Commit: `refactor: extract handlers, slim entry point to barrel re-exports`

---

## Phase 8 — Update tests to import from modules directly

This is optional but recommended for long-term maintainability. The barrel re-exports from Phase 7 mean tests already work, but direct imports make it clear which module each test exercises.

### 8.1 — Migrate test imports

- [x] Update `codex-quota.test.js` import block to import from specific `lib/` modules instead of `./codex-quota.js`:
  ```js
  import { supportsColor, colorize, setNoColorFlag } from "./lib/color.js";
  import { decodeJWT, extractAccountId } from "./lib/jwt.js";
  import { generatePKCE, generateState, buildAuthUrl, ... } from "./lib/oauth.js";
  // etc.
  ```
- [x] Keep the barrel re-exports in `codex-quota.js` for any external consumers
- [x] Verify: `bun test` green

### 8.2 — Add new tests for generics

- [x] Add focused tests for `lib/token-match.js`:
  - `isOauthTokenMatch` — confirm it handles the union of all cases previously tested via `persistOpenAiOAuthTokens` and `persistClaudeOAuthTokens`
  - `normalizeEntryTokens` with both `OPENAI_TOKEN_FIELDS` and `CLAUDE_TOKEN_FIELDS`
  - `updateEntryTokens` round-trip: normalize → update → normalize gives back expected values
  - `resolveKey` with present key, absent key, fallback
- [x] Add focused tests for `lib/auth-store.js`:
  - `updateProviderInAuthFile` — create temp file, update provider, verify JSON structure
  - Skip behavior when file doesn't exist
  - Error handling for invalid JSON
- [x] Add focused test for `findFresherOAuthStore` generic (if not already covered by existing `findFresherOpenAiOAuthStore` / `findFresherClaudeOAuthStore` tests)
- [x] Verify: `bun test` green

### Phase 8 checkpoint

- [x] `bun test` — all pass (203 + new generic tests)
- [x] Commit: `test: migrate imports to lib modules, add generic tests`

---

## Phase 9 — Final cleanup

### 9.1 — Update AGENTS.md

- [x] Update project structure section to reflect new `lib/` layout:
  ```
  codex-quota/
  ├── codex-quota.js         # Entry point, main(), barrel re-exports
  ├── codex-quota.test.js    # Test suite
  ├── lib/
  │   ├── constants.js       # All config constants and path definitions
  │   ├── color.js           # Terminal color output helpers
  │   ├── jwt.js             # JWT decode, profile/account extraction
  │   ├── fs.js              # Atomic file write, symlink-aware write
  │   ├── paths.js           # Auth file path resolution (opencode, codex-cli, pi)
  │   ├── container.js       # Multi-account JSON container read/write/map
  │   ├── token-match.js     # Generic OAuth token matching, normalizing, updating
  │   ├── auth-store.js      # Generic provider-in-auth-file updater
  │   ├── codex-accounts.js  # Codex account loading, dedup, active-label
  │   ├── claude-accounts.js # Claude account loading, session/OAuth resolution
  │   ├── codex-tokens.js    # OpenAI token refresh and multi-store persistence
  │   ├── claude-tokens.js   # Claude token refresh and multi-store persistence
  │   ├── codex-usage.js     # Codex usage API fetch
  │   ├── claude-usage.js    # Claude usage API fetch (session + OAuth)
  │   ├── display.js         # Bars, boxes, usage lines, help text
  │   ├── prompts.js         # Interactive prompt helpers (confirm/input)
  │   ├── oauth.js           # OpenAI OAuth PKCE flow (shared utilities)
  │   ├── claude-oauth.js    # Claude OAuth browser flow
  │   ├── sync.js            # Divergence detection, reverse-sync, fresher-store
  │   └── handlers.js        # Subcommand handlers (add, switch, sync, etc.)
  ├── scripts/
  │   └── preflight.js       # Publish preflight checks
  └── package.json
  ```

### 9.2 — Verify everything end-to-end

- [x] `bun test` — all pass
- [x] `cq --version` — correct
- [x] `cq --help` — renders correctly
- [x] `cq --local` — shows Codex + Claude quota boxes
- [x] `cq codex list` — lists accounts
- [x] `cq claude list` — lists accounts
- [x] `bun run preflight` — passes
- [x] `bun run release:pack` — includes all `lib/*.js` files

### 9.3 — Version bump and publish

- [x] Bump to next minor version (this is a structural change, not a patch): `1.2.0`
- [x] Commit: `refactor: complete modularization — 8K monolith → 19 focused modules`
- [x] Push
- [x] `bun link` + verify `cq --version`

---

## Final module dependency graph

```
codex-quota.js (entry)
  ├── lib/constants.js
  ├── lib/color.js ← constants
  ├── lib/jwt.js ← constants
  ├── lib/fs.js
  ├── lib/paths.js ← constants
  ├── lib/container.js ← fs, constants
  ├── lib/token-match.js (no internal deps)
  ├── lib/auth-store.js ← fs, paths
  ├── lib/codex-accounts.js ← constants, jwt, container, paths
  ├── lib/claude-accounts.js ← constants, container, paths
  ├── lib/codex-tokens.js ← constants, paths, jwt, token-match, auth-store, container, fs
  ├── lib/claude-tokens.js ← constants, paths, token-match, auth-store, container, fs
  ├── lib/codex-usage.js ← constants
  ├── lib/claude-usage.js ← constants, paths, claude-accounts, claude-tokens
  ├── lib/display.js ← constants, color, jwt
  ├── lib/prompts.js (no internal deps)
  ├── lib/oauth.js ← constants, color
  ├── lib/claude-oauth.js ← constants, oauth, claude-tokens, prompts
  ├── lib/sync.js ← constants, paths, jwt, codex-accounts, claude-accounts,
  │                  codex-tokens, claude-tokens, token-match, container,
  │                  display, color, prompts
  └── lib/handlers.js ← (imports from most modules above, incl. prompts)
```

No circular dependencies. `lib/token-match.js` has zero internal deps (pure logic). Leaf modules (`constants`, `fs`, `jwt`, `paths`, `prompts`) depend only on Node.js built-ins.

---

## Risk notes

- **Barrel re-exports keep backward compat** — any external code importing from `./codex-quota.js` continues to work unchanged. Tests can be migrated incrementally.
- **Each phase is independently committable** — if something goes sideways, revert one phase without losing the others.
- **The `files` array in package.json is critical** — forgetting `"lib/"` would publish a broken package. Keep the new explicit preflight check for this as a release gate.
- **Prompt helper extraction (`promptConfirm` / `promptInput`)** touches interactive flows (`claude add`, `claude reauth`, import prompts, remove confirmations). Keep focused smoke checks for TTY behavior and non-interactive safety.
