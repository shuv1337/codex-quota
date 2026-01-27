# codex-quota

Multi-account manager for OpenAI Codex CLI and OpenCode. Add, switch, list, and remove accounts with OAuth browser authentication. Seamlessly switch between both tools with shared credentials.

Zero dependencies - uses Node.js built-ins only.

## Installation

```bash
npm install -g codex-quota
```

Or with bun:

```bash
bun add -g codex-quota
```

After installation, both `codex-quota` and `cq` commands are available.

## Quick Start

```bash
# Add a new account (opens browser for OAuth)
codex-quota codex add personal

# Add a Claude credential (interactive)
codex-quota claude add work

# Check quota for all accounts
codex-quota

# Switch active Codex account
codex-quota codex switch personal

# Switch Claude credentials
codex-quota claude switch work

# Sync activeLabel to CLI auth files
codex-quota codex sync
codex-quota claude sync

# Preview sync without writing files
codex-quota codex sync --dry-run
codex-quota claude sync --dry-run

# List accounts
codex-quota codex list
codex-quota claude list

# Remove an account
codex-quota codex remove old-account
codex-quota claude remove old-account
```

## Commands

Run `codex-quota` with no namespace to check combined Codex + Claude usage.

### codex quota

Check usage quota for Codex accounts.

```bash
codex-quota codex quota            # All Codex accounts
codex-quota codex quota personal   # Specific account
codex-quota codex quota --json     # JSON output
```

### claude quota

Check usage quota for Claude accounts.

```bash
codex-quota claude quota           # All Claude accounts
codex-quota claude quota work      # Specific credential
codex-quota claude quota --json    # JSON output
```

### codex add

Add a new Codex account via OAuth browser authentication.

```bash
codex-quota codex add                # Label derived from email
codex-quota codex add work           # With explicit label
codex-quota codex add --no-browser   # Print URL (for SSH/headless)
```

### claude add

Add a Claude credential interactively.

```bash
codex-quota claude add               # Prompt for label + credentials
codex-quota claude add work          # With explicit label
codex-quota claude add work --json   # JSON output
```

### codex switch

Switch the active account for Codex CLI, OpenCode, and pi.

```bash
codex-quota codex switch personal
```

When you run `codex switch`:

1. **Codex CLI** - Updates `~/.codex/auth.json` with the selected account tokens
2. **OpenCode** - If `~/.local/share/opencode/auth.json` exists, updates the `openai` provider entry
3. **pi** - If `~/.pi/agent/auth.json` exists, updates the `openai-codex` provider entry

It also updates `activeLabel` in `~/.codex-accounts.json` when available.

### claude switch

Switch Claude Code, OpenCode, and pi to a stored Claude credential.

```bash
codex-quota claude switch work
```

This updates `activeLabel` in `~/.claude-accounts.json` when available. OAuth-based
credentials are required to update CLI auth files.

### codex list

List all Codex accounts from all sources with status indicators.

```bash
codex-quota codex list
codex-quota codex list --json
```

Output shows:
- `*` = active account (from `activeLabel`)
- `~` = CLI auth account when it diverges from `activeLabel`
- Email, plan type, token expiry
- Source file for each account

If CLI auth diverges from the tracked `activeLabel`, `list` and `quota` print a warning and
suggest `codex-quota codex sync` to realign.

### claude list

List Claude credentials from `CLAUDE_ACCOUNTS` or `~/.claude-accounts.json`.

```bash
codex-quota claude list
codex-quota claude list --json
```

Output shows:
- `*` = active account (from `activeLabel`)
- Source file for each credential

For OAuth-based accounts, `list` and `quota` warn when stored tokens diverge from the
`activeLabel` account. Session-key-only accounts are skipped.

### codex remove

Remove a Codex account from storage.

```bash
codex-quota codex remove old-account
```

Note: Accounts from `CODEX_ACCOUNTS` env var cannot be removed via CLI.

### claude remove

Remove a Claude credential from storage.

```bash
codex-quota claude remove old-account
```

Note: Accounts from `CLAUDE_ACCOUNTS` env var cannot be removed via CLI.

### codex sync

Sync the `activeLabel` Codex account to CLI auth files.

```bash
codex-quota codex sync
codex-quota codex sync --dry-run
codex-quota codex sync --json
```

This updates:
1. `~/.codex/auth.json`
2. `~/.local/share/opencode/auth.json` (if it exists)
3. `~/.pi/agent/auth.json` (if it exists)

### claude sync

Sync the `activeLabel` Claude account to CLI auth files.

```bash
codex-quota claude sync
codex-quota claude sync --dry-run
codex-quota claude sync --json
```

Only OAuth-based Claude accounts can be synced. Session-key-only accounts are skipped with
a warning.

## Options

| Option | Description |
|--------|-------------|
| `--json` | Output in JSON format |
| `--dry-run` | Preview sync without writing files |
| `--no-browser` | Print auth URL instead of opening browser |
| `--no-color` | Disable colored output |
| `--version, -v` | Show version number |
| `--help, -h` | Show help |

## Account Sources

Accounts are loaded from these locations (in order). Read/write indicates whether the CLI
reads from or writes to each path.

| Source | Purpose | Read | Write |
|--------|---------|------|-------|
| `CODEX_ACCOUNTS` env var | JSON array of accounts | Yes | No |
| `~/.codex-accounts.json` | Primary multi-account file (shared with OpenCode) | Yes | Yes (`add`, `remove`) |
| `~/.opencode/openai-codex-auth-accounts.json` | OpenCode accounts | Yes | No |
| `~/.codex/auth.json` | Codex CLI single-account (label `codex-cli`) | Yes | Yes (`switch`) |
| `~/.local/share/opencode/auth.json` | OpenCode auth file (`openai` provider) | No | Yes (`switch` if it exists) |
| `~/.pi/agent/auth.json` | pi auth file (`openai-codex` provider) | No | Yes (`switch` if it exists) |

New accounts added via `codex-quota codex add` are saved to `~/.codex-accounts.json`, which is
shared with OpenCode.

Claude sources (in order):

| Source | Purpose | Read | Write |
|--------|---------|------|-------|
| `CLAUDE_ACCOUNTS` env var | JSON array of credentials | Yes | No |
| `~/.claude-accounts.json` | Claude multi-account file | Yes | Yes (`add`, `remove`) |
| `~/.claude/.credentials.json` | Claude Code credentials | Yes | Yes (`switch`, `sync`) |
| `~/.local/share/opencode/auth.json` | OpenCode auth file (`anthropic` provider) | No | Yes (`switch`, `sync` if it exists) |
| `~/.pi/agent/auth.json` | pi auth file (`anthropic` provider) | No | Yes (`switch`, `sync` if it exists) |

## Multi-Account JSON Schema

File: `~/.codex-accounts.json`

```json
{
  "schemaVersion": 1,
  "activeLabel": "personal",
  "accounts": [
    {
      "label": "personal",
      "accountId": "chatgpt-account-uuid",
      "access": "access-token",
      "refresh": "refresh-token",
      "idToken": "id-token-or-null",
      "expires": 1234567890000
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | number | Schema version marker (root field) |
| `activeLabel` | string\|null | Active account label (root field) |
| `label` | string | Unique identifier for the account |
| `accountId` | string | ChatGPT account UUID |
| `access` | string | OAuth access token |
| `refresh` | string | OAuth refresh token |
| `idToken` | string\|null | OAuth ID token (optional, for email extraction) |
| `expires` | number | Token expiry timestamp in milliseconds |

Root-level fields are preserved on write; unknown root fields are kept intact.

Claude multi-account files (`~/.claude-accounts.json`) use the same root fields
(`schemaVersion`, `activeLabel`) and store account entries that include a
`sessionKey` or OAuth tokens.

## OAuth Flow

The `codex add` command uses OAuth 2.0 with PKCE for secure browser authentication:

1. Generates PKCE code verifier and challenge
2. Starts local callback server on `http://127.0.0.1:1455`
3. Opens browser to OpenAI authorization page
4. User authenticates in browser
5. Callback server receives authorization code
6. Exchanges code for tokens using PKCE verifier
7. Saves tokens to `~/.codex-accounts.json`

### Headless/SSH Mode

In SSH sessions or headless environments (detected via `SSH_CLIENT`, `SSH_TTY`, or missing `DISPLAY`), the auth URL is printed instead of opening a browser:

```bash
codex-quota codex add --no-browser
# Prints: Open this URL in your browser: https://auth.openai.com/authorize?...
```

Copy the URL to a browser on another machine, complete authentication, and the callback will be received by the local server.

## Troubleshooting

### Port 1455 in use

```
Error: Port 1455 is in use. Close other codex-quota instances and retry.
```

Another process is using port 1455. Check for:
- Other `codex-quota codex add` commands running
- OpenCode or Codex CLI auth processes

Find and kill the process:
```bash
lsof -i :1455
kill <pid>
```

### SSH/Headless authentication

If browser doesn't open in SSH session:

1. Use `--no-browser` flag: `codex-quota codex add --no-browser`
2. Copy the printed URL to a browser on another machine
3. Complete authentication in browser
4. The callback is received by the server running over SSH

### Token refresh failures

If token refresh fails:
```
Error: Failed to refresh token. Re-authenticate with 'codex-quota codex add'.
```

The refresh token may have expired. Add the account again:
```bash
codex-quota codex remove expired-account
codex-quota codex add new-label
```

### Environment variable accounts

Accounts from `CODEX_ACCOUNTS` env var cannot be removed via CLI:
```
Error: Cannot remove account from CODEX_ACCOUNTS env var. Modify the env var directly.
```

Edit your shell configuration to remove the account from the env var.

## JSON Output

All commands support `--json` for scripting:

```bash
# Quota (combined)
codex-quota --json
# {"codex":[{"label":"personal","email":"user@example.com","usage":{...}}],"claude":[...]}

# List (Codex)
codex-quota codex list --json
# {"accounts":[{"label":"personal","isActive":true,"email":"...","source":"..."}]}

# Add (Codex, success)
codex-quota codex add work --json
# {"success":true,"label":"work","email":"user@example.com","accountId":"...","source":"~/.codex-accounts.json"}

# Switch (Codex)
codex-quota codex switch personal --json
# {"success":true,"label":"personal","email":"...","authPath":"~/.codex/auth.json"}

# Sync (Codex)
codex-quota codex sync --json
# {"success":true,"activeLabel":"work","updated":["~/.codex/auth.json",...],"skipped":[...]}

# Errors include structured data
codex-quota codex switch nonexistent --json
# {"success":false,"error":"Account not found","availableLabels":["personal","work"]}
```

## Claude Code Usage (Optional)

Use the `claude` namespace to check Claude usage alongside OpenAI quotas:

```bash
codex-quota claude quota
```

If multiple Claude accounts are configured, each account is fetched and displayed separately.

To add a Claude credential interactively:

```bash
codex-quota claude add
```

This uses your local Claude session to call:
- `https://claude.ai/api/organizations`
- `https://claude.ai/api/organizations/{orgId}/usage`
- `https://claude.ai/api/organizations/{orgId}/overage_spend_limit`
- `https://claude.ai/api/account`

Authentication sources (in order):
1. `CLAUDE_ACCOUNTS` env var (JSON array or `{ accounts: [...] }`)
2. `~/.claude-accounts.json` (multi-account format)
3. Browser cookies (Chromium/Chrome) to read `sessionKey` and `lastActiveOrg`
4. `~/.claude/.credentials.json` OAuth `accessToken`

Multi-account format (Claude):
```json
{
  "accounts": [
    {
      "label": "personal",
      "sessionKey": "sk-ant-oat...",
      "cfClearance": "cf_clearance...",
      "oauthToken": "claude-ai-access-token",
      "orgId": "org_uuid_optional"
    }
  ]
}
```

Notes:
- Only `label` plus one of `sessionKey` or `oauthToken` is required.
- `cfClearance`, `orgId`, and `cookies` are optional.

Environment overrides:
- `CLAUDE_ACCOUNTS` to supply multi-account JSON directly
- `CLAUDE_CREDENTIALS_PATH` to point to a different credentials file
- `CLAUDE_COOKIE_DB_PATH` to point to a specific Chromium/Chrome Cookies DB

Codex overrides:
- `CODEX_ACCOUNTS` to supply multi-account JSON directly (read-only)
- `CODEX_AUTH_PATH` to point to a different Codex CLI auth file
- `XDG_DATA_HOME` to relocate OpenCode auth paths
- `PI_AUTH_PATH` to point to a different pi auth file

Notes:
- On Linux, cookie access requires `sqlite3` and `secret-tool` (libsecret) to decrypt cookies.
- For best results, keep `claude.ai` logged in within your Chromium/Chrome profile.

## Releasing

- Run `bun test` and `bun run preflight` before publishing.
- Bump version with `bun pm version patch|minor|major`.
- Dry-run the package with `bun run release:pack`.
- Publish with `bun run release:publish` (local publish, no provenance).
- Ensure the git working tree is clean.

## License

MIT
