# AGENTS.md - Coding Agent Guidelines

Guidelines for AI coding agents working in this repository.

## Project Overview

`codex-quota` is a zero-dependency Node.js CLI for managing multiple OpenAI Codex OAuth accounts. Provides account management (add, switch, remove, list) and quota checking using only Node.js built-in modules.

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
```

## Project Structure

```
codex-quota/
├── codex-quota.js       # Main CLI script (all code in single file)
├── codex-quota.test.js  # Test suite using Bun test runner
├── package.json         # Project config, scripts, bin entries
└── README.md            # User documentation
```

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

Separate major sections with ASCII art:
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

## Exports for Testing

Export internal functions at file bottom:
```javascript
export { loadAccountsFromEnv, loadAccountsFromFile, ... };
```

Use conditional main execution:
```javascript
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	main().catch(e => { console.error(e.message); process.exit(1); });
}
```
