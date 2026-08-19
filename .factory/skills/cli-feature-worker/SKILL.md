---
name: cli-feature-worker
description: Implements Node.js CLI features with TDD for the shuvquota project
---

# CLI Feature Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use for any feature that involves creating or modifying `lib/*.js` modules, updating `shuvquota.js` (routing, barrel re-exports), adding tests to `shuvquota.test.js`, or modifying `lib/display.js` / `lib/handlers.js` / `lib/constants.js`.

## Work Procedure

### Step 1: Understand the Feature

Read the feature description, preconditions, expectedBehavior, and verificationSteps carefully. Read `AGENTS.md` for conventions and boundaries. Read any referenced library files in `.factory/library/`.

### Step 2: Investigate Existing Patterns

Before writing any code, read the existing parallel modules to understand patterns:
- For account modules: read `lib/codex-accounts.js` or `lib/claude-accounts.js`
- For usage modules: read `lib/codex-usage.js` or `lib/claude-usage.js`
- For token modules: read `lib/codex-tokens.js` or `lib/claude-tokens.js`
- For handlers: read `lib/handlers.js` (look at `handleCodex`/`handleClaude` switch statements)
- For display: read `lib/display.js` (look at `buildAccountUsageLines`/`buildClaudeUsageLines`)
- For constants: read `lib/constants.js` for naming conventions
- For tests: read `shuvquota.test.js` for test patterns, mock helpers, cleanup patterns

Match the existing patterns exactly. Do not invent new patterns.

### Step 3: Write Tests First (RED)

Add test cases to `shuvquota.test.js` (or the appropriate test file) BEFORE writing implementation:
- Import from `./shuvquota.js` (barrel re-exports), NOT from `lib/` directly
- Use `describe`/`test`/`expect` structure
- Add `beforeEach`/`afterEach` for environment cleanup
- Use `os.tmpdir()` for temp files
- Mock API responses using the documented format from AGENTS.md
- Cover: happy path, error cases, edge cases from the feature's expectedBehavior

Run `bun test` to confirm the new tests FAIL (since implementation doesn't exist yet).

### Step 4: Implement (GREEN)

Write the implementation in `lib/*.js` modules:
- Follow existing module patterns exactly (imports, error handling, JSDoc, section dividers)
- Use tabs for indentation, double quotes, semicolons
- Use `node:` prefix for Node.js built-in imports
- Add barrel re-exports to `shuvquota.js` for ALL new exports
- If modifying `handlers.js`, add routing in the correct switch statement
- If modifying `constants.js`, follow UPPER_SNAKE_CASE naming
- If adding display functions, use existing `drawBox`, `printBar`, `shortenPath` helpers

Run `bun test` to confirm all tests PASS (both new and existing).

### Step 5: Verify

1. Run `bun test` — ALL tests must pass (existing + new), zero failures
2. Run `node shuvquota.js` to verify the CLI still works for existing providers
3. If the feature adds CLI commands, run them manually and verify output
4. Run `node scripts/preflight.js` to verify package integrity
5. Check that no sensitive data (API keys, JWTs, encryption keys) appears in any output

### Step 6: Commit

Commit with a descriptive message following the project's commit style (see `git log --oneline`).

## Example Handoff

```json
{
  "salientSummary": "Implemented lib/factory-usage.js with fetchFactoryUsage() supporting both JWT and API key auth, billing period calculation with configurable start day, and monthly token aggregation. Added 18 tests covering happy path, billing edge cases, auth fallback, and error handling. All 224 tests pass (206 existing + 18 new).",
  "whatWasImplemented": "Created lib/factory-usage.js with fetchFactoryUsage(account, billingDay), computeBillingPeriod(billingDay, now), and sumDailyTokens(data) functions. Added FACTORY_USAGE_URL, FACTORY_TIMEOUT_MS constants. Added barrel re-exports. Integrated into handleQuota for scope 'factory' and 'all'.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      { "command": "bun test", "exitCode": 0, "observation": "224 tests passed, 0 failed" },
      { "command": "node shuvquota.js factory quota --json", "exitCode": 0, "observation": "Outputs valid JSON with Factory usage data structure" },
      { "command": "node shuvquota.js", "exitCode": 0, "observation": "Default view shows Codex, Claude, and Factory sections" },
      { "command": "node scripts/preflight.js", "exitCode": 0, "observation": "All preflight checks pass, lib/ included in files array" }
    ],
    "interactiveChecks": [
      { "action": "Ran cq factory quota with mock account", "observed": "Box rendered with usage bar, billing period, model breakdown" },
      { "action": "Ran cq factory quota --billing-day 15", "observed": "Billing period adjusted to 15th-to-15th window" },
      { "action": "Ran cq codex quota after changes", "observed": "Codex output unchanged from before" }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "shuvquota.test.js",
        "cases": [
          { "name": "fetchFactoryUsage returns parsed usage data", "verifies": "Happy path API call" },
          { "name": "fetchFactoryUsage falls back to API key", "verifies": "JWT unavailable, uses fk- key" },
          { "name": "computeBillingPeriod defaults to day 1", "verifies": "Default billing period" },
          { "name": "computeBillingPeriod handles day 31 in February", "verifies": "Clamp to last day" }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- Feature depends on a module that doesn't exist yet (e.g., factory-accounts.js not created)
- The Factory Analytics API format differs from what's documented in AGENTS.md
- Existing test failures unrelated to your changes (beyond the known 5 port-conflict tests)
- Circular dependency detected between Factory modules and existing modules
- Cannot match existing patterns because the existing code structure doesn't support the needed change
