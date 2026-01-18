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
codex-quota add personal

# Check quota for all accounts
codex-quota

# Switch active account
codex-quota switch personal

# List all accounts
codex-quota list

# Remove an account
codex-quota remove old-account
```

## Commands

### quota (default)

Check usage quota for accounts.

```bash
codex-quota                    # All accounts
codex-quota personal           # Specific account
codex-quota --json             # JSON output
```

### add

Add a new account via OAuth browser authentication.

```bash
codex-quota add                # Label derived from email
codex-quota add work           # With explicit label
codex-quota add --no-browser   # Print URL (for SSH/headless)
```

### switch

Switch the active account for both Codex CLI and OpenCode.

```bash
codex-quota switch personal
```

When you run `switch`:

1. **Codex CLI** - Updates `~/.codex/auth.json` with the selected account tokens
2. **OpenCode** - If `~/.local/share/opencode/auth.json` exists, updates the `openai` provider entry

This enables seamless switching between both tools using a single command. Your credentials stay in sync automatically.

### list

List all accounts from all sources with status indicators.

```bash
codex-quota list
codex-quota list --json
```

Output shows:
- `*` = active account (matches `~/.codex/auth.json`)
- Email, plan type, token expiry
- Source file for each account

### remove

Remove an account from storage.

```bash
codex-quota remove old-account
```

Note: Accounts from `CODEX_ACCOUNTS` env var cannot be removed via CLI.

## Options

| Option | Description |
|--------|-------------|
| `--json` | Output in JSON format |
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

New accounts added via `codex-quota add` are saved to `~/.codex-accounts.json`, which is
shared with OpenCode.

## Multi-Account JSON Schema

File: `~/.codex-accounts.json`

```json
{
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
| `label` | string | Unique identifier for the account |
| `accountId` | string | ChatGPT account UUID |
| `access` | string | OAuth access token |
| `refresh` | string | OAuth refresh token |
| `idToken` | string\|null | OAuth ID token (optional, for email extraction) |
| `expires` | number | Token expiry timestamp in milliseconds |

**Note:** The `idToken` field was added in v1.0.0. Older files without this field are still supported.

## OAuth Flow

The `add` command uses OAuth 2.0 with PKCE for secure browser authentication:

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
codex-quota add --no-browser
# Prints: Open this URL in your browser: https://auth.openai.com/authorize?...
```

Copy the URL to a browser on another machine, complete authentication, and the callback will be received by the local server.

## Troubleshooting

### Port 1455 in use

```
Error: Port 1455 is in use. Close other codex-quota instances and retry.
```

Another process is using port 1455. Check for:
- Other `codex-quota add` commands running
- OpenCode or Codex CLI auth processes

Find and kill the process:
```bash
lsof -i :1455
kill <pid>
```

### SSH/Headless authentication

If browser doesn't open in SSH session:

1. Use `--no-browser` flag: `codex-quota add --no-browser`
2. Copy the printed URL to a browser on another machine
3. Complete authentication in browser
4. The callback is received by the server running over SSH

### Token refresh failures

If token refresh fails:
```
Error: Failed to refresh token. Re-authenticate with 'codex-quota add'.
```

The refresh token may have expired. Add the account again:
```bash
codex-quota remove expired-account
codex-quota add new-label
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
# Quota
codex-quota --json
# [{"label":"personal","email":"user@example.com","usage":{...},"source":"~/.codex-accounts.json"}]

# List
codex-quota list --json
# {"accounts":[{"label":"personal","isActive":true,"email":"...","source":"..."}]}

# Add (success)
codex-quota add work --json
# {"success":true,"label":"work","email":"user@example.com","accountId":"...","source":"~/.codex-accounts.json"}

# Switch
codex-quota switch personal --json
# {"success":true,"label":"personal","email":"...","authPath":"~/.codex/auth.json"}

# Errors include structured data
codex-quota switch nonexistent --json
# {"success":false,"error":"Account not found","availableLabels":["personal","work"]}
```

## Releasing

- Run `bun test` and `bun run preflight` before publishing.
- Bump version with `bun pm version patch|minor|major`.
- Dry-run the package with `bun run release:pack`.
- Publish with `bun run release:publish` (local publish, no provenance).
- Ensure the git working tree is clean.

## License

MIT
