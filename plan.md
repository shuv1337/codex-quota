# Active Credential Handling Plan (Codebase-Aligned)

## Goals
- Make active account state explicit and discoverable via `activeLabel` in multi-account files.
- Keep CLI auth files (codex, claude code, opencode, pi) in sync with the active account.
- Detect and warn when CLI auth diverges from the tracked active account.
- Preserve unknown fields and avoid destructive edits.

## Codebase Constraints To Incorporate
- `saveAccounts()` is effectively unused in the current flow; the real writes happen in handlers and token persistence helpers.
- Codex write paths that must preserve root metadata and unknown fields: `handleAdd`, `handleRemove`, `persistOpenAiOAuthTokens`.
- Claude write paths that must preserve root metadata and unknown fields: `handleClaudeRemove`, `persistClaudeOAuthTokens`.
- `findAccountByLabel()` depends on `loadAllAccounts()`, which deduplicates by email. That can drop valid labels when the same email spans multiple workspaces. Active label resolution and switching must not depend on email deduplication.
- Codex active detection currently relies on JWT decode and `codex_quota_label`. Divergence detection should prefer `tokens.account_id` when present.
- Claude does not have a stable `accountId` in the current model. Claude divergence detection must use token matching and degrade gracefully when only session-key credentials exist.

## Current State (Summary)
- Codex and Claude maintain separate multi-account files: `~/.codex-accounts.json` and `~/.claude-accounts.json`.
- Codex also loads accounts from OpenCode's multi-account file: `~/.opencode/openai-codex-auth-accounts.json`.
- Codex CLI auth path: `~/.codex/auth.json`.
- Claude Code auth path: `~/.claude/.credentials.json`.
- OpenCode auth path: `~/.local/share/opencode/auth.json` (supports both providers).
- pi auth path: `~/.pi/agent/auth.json` (supports both providers).
- The `switch` command already pushes tokens to all detected CLI auth files.
- No tracking of which account is "active" in the multi-account files.
- Native CLI logins (e.g., `codex auth`) can diverge from codex-quota managed state.

## Proposed Data Model

### File-level markers (minimal)
Add to both `~/.codex-accounts.json` and `~/.claude-accounts.json` at the root level:
- `schemaVersion` (number, start at 1) - for future migrations
- `activeLabel` (string | null) - the currently active account label

### Root container preservation rules
- Support both array format and object format when reading.
- When writing, preserve the original container shape if possible.
- When the root is an object, preserve unknown root-level fields.
- Always merge in `schemaVersion` and `activeLabel` without dropping unrelated fields.

### Example structure
```json
{
  "schemaVersion": 1,
  "activeLabel": "work",
  "accounts": [
    {
      "label": "work",
      "accountId": "acc_xxx",
      "access": "...",
      "refresh": "...",
      "expires": 1234567890
    },
    {
      "label": "personal",
      "accountId": "acc_yyy",
      "access": "...",
      "refresh": "...",
      "expires": 1234567890
    }
  ]
}
```

### What we're NOT adding
- Per-account metadata (lastUsedAt, lastSwitchedAt, displayName, notes)
- Identity blocks (provider/userId/email objects)
- Cross-file sync between Codex and Claude files
- activeUpdatedAt timestamp

## Sync Architecture

### Source of truth
The multi-account file (`~/.codex-accounts.json` or `~/.claude-accounts.json`) is the source of truth for which account should be active. CLI auth files are derived from this.

### Precedence and activeLabel resolution
- If `CODEX_ACCOUNTS`/`CLAUDE_ACCOUNTS` env var is present, it is read-only and cannot carry `activeLabel`.
- For Codex, `activeLabel` is stored only in the first resolved multi-account file in this order: `~/.codex-accounts.json`, then `~/.opencode/openai-codex-auth-accounts.json`.
- For Claude, `activeLabel` is stored only in `~/.claude-accounts.json`.
- If multiple files contain the same label, the first file above wins and is the only one updated.
- Active label resolution and switching must use a no-dedup path. Email-based deduplication remains display-only.

### Legacy marker coexistence and guarded migration
- Continue writing `codex_quota_label` into `~/.codex/auth.json` for compatibility.
- If `activeLabel` is missing but `codex_quota_label` is present, attempt migration on first write with an accountId guard.
- Migration guard step: resolve the CLI accountId by preferring `tokens.account_id` and falling back to JWT decode.
- Migration guard step: resolve the label from `codex_quota_label` via a no-dedup label lookup.
- Migration guard step: only persist `activeLabel` when the label resolves and the accountId matches the CLI accountId.
- If the guard fails, do not migrate; instead treat it as divergence and warn.

### Provider isolation
- Codex accounts sync to: codex CLI, opencode (openai section), pi (openai-codex section).
- Claude accounts sync to: claude code, opencode (anthropic section), pi (anthropic section).
- No sync between Codex and Claude account files.

## Divergence Detection

### Codex divergence detection
Detection compares CLI accountId to the accountId of the `activeLabel` account.

How to detect:
1. Load Codex CLI auth (`~/.codex/auth.json`).
2. Resolve CLI accountId by preferring `tokens.account_id`.
3. If `tokens.account_id` is missing, decode the access token JWT and extract `chatgpt_account_id`.
4. Load the activeLabel account from the multi-account source of truth (no-dedup).
5. Compare accountIds.

Why accountId, not email:
A single email can be associated with multiple OpenAI workspaces (personal plus team accounts). The `accountId` is workspace-specific and correctly identifies which account is active.

Warning format:
```
Warning: CLI auth diverged from activeLabel
  Active: work (acc_xxx)
  CLI:    personal (acc_yyy)

Run 'codex-quota codex sync' to push active account to CLI.
```

### Claude divergence detection (token-based)
Claude does not expose a stable `accountId` in the current model, so divergence detection is token-based and best-effort.

How to detect:
1. Only attempt divergence detection for OAuth-capable accounts.
2. Load the relevant Claude CLI auth stores (Claude Code credentials, OpenCode, pi).
3. Resolve the activeLabel account from the Claude multi-account file (no-dedup).
4. Prefer refresh-token matching when both sides have refresh tokens.
5. Fall back to access-token matching when refresh tokens are not available.
6. If the activeLabel account has no OAuth tokens (session-key-only), skip divergence detection with a clear message.

## Behavior Changes

### On `switch`
1. Find account by label using a no-dedup label lookup.
2. Refresh token if needed (existing).
3. Update `activeLabel` in the multi-account source of truth using container-preserving writes.
4. Push tokens to CLI auth files (existing).
5. Continue writing `codex_quota_label` for Codex.

### On `add`
- Preserve unknown root fields and root shape when writing.
- Do not drop existing `activeLabel` or `schemaVersion`.
- This requires replacing direct `{ accounts }` writes with container-preserving helpers.

### On `list`
1. Load accounts (existing).
2. Run divergence detection.
3. Show warning if diverged.
4. Display accounts with active indicator (existing).

### On `quota`
1. Load accounts and fetch usage (existing).
2. Run divergence detection for each provider being shown.
3. Show warning if diverged.
4. Display usage (existing).

### On `remove`
- If removing the account matching `activeLabel`, set `activeLabel` to `null`.
- Do not drop root metadata or unknown root fields.
- For Codex, only clear `codex_quota_label` when the CLI accountId matches the removed account.

## CLI Enhancements

### New subcommand: `sync`
Bi-directional sync for the `activeLabel` account:
1. Push: write the active account's tokens to all CLI auth files.
2. Pull (reverse-sync): if a CLI store (e.g., OpenCode) has the same refresh token but a newer access token / expiry, pull that token back into the multi-account file.

```
codex-quota codex sync [options]
codex-quota claude sync [options]
```

Flags:
- `--json` for machine-readable output
- `--dry-run` shows what would be synced without writing

Use cases:
- Re-sync after manual edits to CLI auth files
- Fix divergence after native CLI login
- Pull freshly refreshed tokens from OpenCode back into codex-quota (reverse-sync)
- Verify sync state without running switch

Notes:
- Claude `sync` only applies to OAuth-based accounts.
- Session-key-only Claude accounts are skipped with a warning.
- `sync` requires a resolved `activeLabel` in a writable multi-account file.
- Reverse-sync matches by refresh token; if the CLI store has the same refresh token but a newer `expires` (or newer `access` when expires is missing), the CLI token is considered fresher and is pulled back.
- Only stores that exist and contain OAuth tokens for the active account are considered for reverse-sync.

Output (human):
```
Syncing active account: work <user@example.com>

Pulled fresher token from:
  ~/.local/share/opencode/auth.json

Updated:
  ~/.codex/auth.json

Skipped (not found):
  ~/.pi/agent/auth.json
```

Output (JSON):
```json
{
  "success": true,
  "activeLabel": "work",
  "email": "user@example.com",
  "accountId": "acc_xxx",
  "pulled": [
    "~/.local/share/opencode/auth.json"
  ],
  "updated": [
    "~/.codex/auth.json"
  ],
  "skipped": [
    "~/.pi/agent/auth.json"
  ]
}
```

### Removed from original plan
- `--sync-status` flag (divergence warnings are always shown)
- `--also-clear-active` on remove (automatic now)
- `--apply` flag on sync (sync always applies; use `--dry-run` to preview)
- `--include-missing` flag (not needed without cross-file sync)

## Safety and Write Strategy
- Always use `writeFileAtomic` and preserve symlinks (existing).
- Centralize multi-account reads and writes through container-aware helpers.
- Preserve unknown root fields and preserve root shape where possible.
- Skip updates for accounts from env vars (`source: "env"`).
- Handle missing or corrupted files gracefully.
- Keep email deduplication as display-only; do not use it for label resolution, switching, or activeLabel decisions.

## Test Plan

### Unit tests
- No-dedup label resolution still finds all labels even when dedup-by-email would collapse them.
- `activeLabel` updates on switch.
- `activeLabel` clears when removing the active account.
- Codex divergence detection prefers `tokens.account_id` over JWT decode.
- Guarded migration: `codex_quota_label` migrates only when accountId matches CLI accountId.
- Unknown root fields are preserved when writing multi-account files.
- `schemaVersion` is written and preserved.
- Container shape is preserved where possible (array vs object).
- Claude divergence detection uses refresh-token matching when available and degrades gracefully otherwise.
- `--dry-run` sync performs no writes.
- Reverse-sync: CLI store with matching refresh but newer expires is detected as fresher.
- Reverse-sync: fresher CLI token is pulled into multi-account file before forward push.

### Integration tests
- Codex `sync` pushes tokens to all existing CLI auth files.
- Claude `sync` pushes OAuth tokens to all existing CLI auth files.
- Claude `sync` skips session-key-only accounts with a warning.
- `list` shows a divergence warning when CLI auth diverges.
- `quota` shows a divergence warning when CLI auth diverges.
- Backwards compatibility: files without `activeLabel` or `schemaVersion` still load correctly.
- Backwards compatibility: files with extra root fields are not clobbered by add, remove, or token refresh persistence.
- Codex `sync` pulls fresher token from OpenCode when refresh matches and expires is newer.
- Claude `sync` pulls fresher token from OpenCode when refresh matches and expires is newer.

## Implementation Steps

1. Introduce multi-account container helpers and stop relying on `saveAccounts()`. Implement helpers that read containers while capturing root shape, root fields, and accounts; write containers by merging `schemaVersion` and `activeLabel` while preserving root fields and root shape; and provide targeted update helpers for `activeLabel` and account entries.

2. Add no-dedup account resolution helpers for label and active label workflows. Create a label lookup that does not deduplicate by email, and use deduplication by email only for display flows.

3. Update all existing multi-account write paths to use container-aware helpers. Codex updates: `handleAdd`, `handleRemove`, and the multi-account portion of `persistOpenAiOAuthTokens`. Claude updates: `handleClaudeRemove` and the multi-account portion of `persistClaudeOAuthTokens`. Ensure these updates preserve root metadata and unknown fields.

4. Implement `activeLabel` updates on switch using the source of truth container. Codex: update `handleSwitch` to set `activeLabel` after a successful refresh and before syncing tokens. Claude: update `handleClaudeSwitch` similarly, while skipping env-sourced accounts.

5. Implement divergence detection helpers with provider-specific logic. Codex: read CLI accountId by preferring `tokens.account_id`, falling back to JWT decode, and add guarded migration from `codex_quota_label` to `activeLabel` using the accountId match guard. Claude: implement token-based divergence detection that prefers refresh-token matching, falls back to access-token matching, and skips session-key-only accounts.

6. Implement the `sync` subcommand with bi-directional support. Add `handleCodexSync(args, flags)` and `handleClaudeSync(args, flags)`:
   - Resolve the activeLabel account from the source of truth container using no-dedup lookup.
   - Reverse-sync (pull): for each CLI store (OpenCode, pi, codex CLI / Claude Code), compare refresh tokens. If they match and the CLI store has a newer `expires` (or newer `access` when expires unavailable), pull that token into the multi-account file using `persistOpenAiOAuthTokens` / `persistClaudeOAuthTokens`.
   - Forward-sync (push): after reverse-sync, push the (now freshest) active account tokens to all CLI stores.
   - Support `--dry-run` by computing the update set without writing.
   - Ensure Claude sync skips non-OAuth accounts with a warning.

7. Wire `sync` into routing, flags, and help output. Update flag parsing to include `--dry-run`, update the Codex and Claude routers to handle `sync`, and update help text to document `sync` and `--dry-run`.

8. Add tests covering the new helpers and the updated integration points. Include unit tests for container helpers, no-dedup label lookup, divergence detection, migration guards, and `--dry-run`, plus integration tests for `sync`, add/remove preservation behavior, and divergence warnings on `list` and `quota`.

## Rollout Notes
- Backwards compatible: missing `activeLabel` defaults to `null`, missing `schemaVersion` is treated as 0.
- Existing files without these fields will be upgraded on first write.
- No breaking changes to account structure.
- `sync` is additive; existing switch behavior is preserved.
- Migration guard: if `codex_quota_label` exists and `activeLabel` is missing, only migrate when the CLI accountId matches the label's accountId.
