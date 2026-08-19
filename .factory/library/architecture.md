# Architecture

Architectural decisions, patterns discovered, and conventions.

**What belongs here:** Architectural patterns, module organization, import conventions, coding style notes.
**What does NOT belong here:** Environment-specific details (use `environment.md`).

---

## Module Pattern
Each provider (Codex, Claude, Factory) has parallel module sets:
- `*-accounts.js` — Account loading, deduplication, active-label management
- `*-tokens.js` — Token refresh and multi-store persistence
- `*-usage.js` — API usage fetching

Shared modules used by all providers:
- `container.js` — Multi-account JSON container CRUD
- `token-match.js` — Generic OAuth token matching with field maps
- `fs.js` — Atomic file writes
- `constants.js` — All configuration in one file
- `display.js` — Terminal rendering (bars, boxes, usage lines)
- `handlers.js` — CLI subcommand dispatchers

## Entry Point Pattern
`shuvquota.js` is a thin shell:
1. Imports from `lib/` modules
2. `main()` — CLI arg parsing + routing to handlers
3. `isMain` guard — only runs when executed directly
4. **Barrel re-exports** — re-exports every symbol from `lib/` so tests and consumers import from `./shuvquota.js`

**CRITICAL:** Any new export must be added in TWO places:
1. The `lib/*.js` module where the function lives
2. The barrel re-export block at the bottom of `shuvquota.js`

## CLI Routing
- First non-flag arg is checked for namespace (`"codex"`, `"claude"`, `"factory"`)
- Each namespace routes to its handler (`handleCodex`, `handleClaude`, `handleFactory`)
- Default (no namespace): `handleQuota(nonFlagArgs, flags, "all")` — shows all providers
- `handleQuota` scope parameter: `"all"`, `"codex"`, `"claude"`, `"factory"`

## Account Loading Hierarchy
Checked in order:
1. Environment variable (e.g., `FACTORY_ACCOUNTS` JSON)
2. Multi-account file(s) on disk (e.g., `~/.factory-accounts.json`)
3. Single-account fallback (e.g., `~/.factory/auth.v2.file`)

## Container Schema
```json
{
  "schemaVersion": 1,
  "activeLabel": "work",
  "accounts": [
    { "label": "work", "accountId": "...", ... }
  ]
}
```

## Token Match Field Maps
Define per-provider field maps for `normalizeEntryTokens` and `updateEntryTokens`:
- `OPENAI_TOKEN_FIELDS` — for Codex
- `CLAUDE_TOKEN_FIELDS` — for Claude
- `FACTORY_TOKEN_FIELDS` — for Factory (to be created)

## Factory-Specific Patterns
- Auth uses AES-256-GCM encryption (unique among providers)
- Factory accounts can have both an encrypted JWT AND an API key
- JWT is preferred for auth, API key is fallback
- Billing period is monthly with configurable start day
- Usage is org-level (not per-user like Codex/Claude)
