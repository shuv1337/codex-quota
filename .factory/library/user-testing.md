# User Testing

Testing surface, validation approach, and resource cost classification.

**What belongs here:** How to test the application, what surfaces exist, setup needed for validation.
**What does NOT belong here:** Test implementation details (those go in the test file).

---

## Validation Surface
- **Surface type:** Terminal CLI
- **Tool:** Direct CLI execution (`node shuvquota.js ...`)
- **What to check:** stdout content, stderr content, exit codes, file state (container files, auth.v2 files)

## Testing Approach
- Run CLI commands and check output format, content, exit codes
- Check file system state after operations (container JSON, auth files, permissions)
- **Limitation:** Factory Analytics API returns 403 for test org. All API interactions are tested with mocked responses in unit tests.

## Validation Concurrency
- **Max concurrent validators:** 5
- **Rationale:** CLI tool with no services, each test is a quick process execution. Machine has 124GB RAM, 24 cores — no resource constraints.

## CLI Commands to Test
```
node shuvquota.js                          # default view (all providers)
node shuvquota.js factory quota            # Factory-only quota
node shuvquota.js factory quota --json     # JSON output
node shuvquota.js factory quota --billing-day 15  # Custom billing
node shuvquota.js factory list             # List accounts
node shuvquota.js factory add              # Add account flow
node shuvquota.js factory switch <label>   # Switch active account
node shuvquota.js factory remove <label>   # Remove account
```

## Flow Validator Guidance: Terminal CLI

### Testing Method
Each flow validator verifies assertions by:
1. **Running targeted unit tests** via `bun test --grep "<pattern>"` to check function-level correctness
2. **Running CLI commands** via `node shuvquota.js <args>` and checking stdout/stderr/exit code
3. **Inspecting source code** to verify implementation details (imports, patterns, conventions)

### Isolation Rules
- Each validator operates independently — no shared mutable state
- CLI commands are read-only (no Factory accounts configured in this environment, so no file mutations)
- Unit tests use temp directories and mock data, so they don't interfere
- The Factory Analytics API is not enabled (returns 403) — this is expected and documented

### Key Test Patterns
- Tests import from `./shuvquota.js` (barrel re-exports)
- Test groups are organized by `describe()` blocks with descriptive names
- Use `bun test --grep "<describe-name>"` to run specific groups
- 5 pre-existing test failures on `startCallbackServer` (port 1455 in use) — these are NOT related to Factory features

### What NOT to do
- Do NOT attempt to call the Factory Analytics API (it returns 403)
- Do NOT modify files in `~/.factory/` or `~/.factory-accounts.json`
- Do NOT modify any source or test files
- Do NOT install dependencies
