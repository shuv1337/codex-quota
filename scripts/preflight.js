#!/usr/bin/env node

/**
 * Release preflight checks for codex-quota
 * 
 * Validates package.json metadata and git state before publishing.
 * Run with: node scripts/preflight.js
 * Exit code 0 = all checks pass, 1 = one or more checks failed
 */

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const EXPECTED_NAME = "codex-quota";
const REQUIRED_FILES = ["codex-quota.js", "lib/", "README.md", "LICENSE"];

// ─────────────────────────────────────────────────────────────────────────────
// Check functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check that package.json name equals expected value
 * @param {object} pkg - parsed package.json
 * @returns {{pass: boolean, message: string}}
 */
function checkPackageName(pkg) {
	if (pkg.name === EXPECTED_NAME) {
		return { pass: true, message: `package.json name is '${EXPECTED_NAME}'` };
	}
	return { 
		pass: false, 
		message: `package.json name is '${pkg.name}', expected '${EXPECTED_NAME}'` 
	};
}

/**
 * Check that package.json has files array
 * @param {object} pkg - parsed package.json
 * @returns {{pass: boolean, message: string}}
 */
function checkFilesArrayExists(pkg) {
	if (Array.isArray(pkg.files)) {
		return { pass: true, message: "package.json has files array" };
	}
	return { pass: false, message: "package.json missing files array" };
}

/**
 * Check that files array includes all required files
 * @param {object} pkg - parsed package.json
 * @returns {{pass: boolean, message: string}}
 */
function checkRequiredFiles(pkg) {
	if (!Array.isArray(pkg.files)) {
		return { pass: false, message: "package.json files is not an array" };
	}
	
	const missing = REQUIRED_FILES.filter(f => !pkg.files.includes(f));
	if (missing.length === 0) {
		return { pass: true, message: `files array includes all required files: ${REQUIRED_FILES.join(", ")}` };
	}
	return { 
		pass: false, 
		message: `files array missing: ${missing.join(", ")}` 
	};
}

/**
 * Check that git working tree is clean
 * @returns {{pass: boolean, message: string}}
 */
function checkGitClean() {
	try {
		const status = execSync("git status --porcelain", { 
			cwd: ROOT, 
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"]
		}).trim();
		
		if (status === "") {
			return { pass: true, message: "git working tree is clean" };
		}
		
		const changedFiles = status.split("\n").length;
		return { 
			pass: false, 
			message: `git working tree has ${changedFiles} uncommitted change(s)` 
		};
	} catch (e) {
		return { pass: false, message: `git status failed: ${e.message}` };
	}
}

/**
 * Check that required files exist on disk
 * @returns {{pass: boolean, message: string}}
 */
function checkFilesExist() {
	const missing = REQUIRED_FILES.filter(f => !existsSync(join(ROOT, f)));
	if (missing.length === 0) {
		return { pass: true, message: "all required files exist on disk" };
	}
	return { 
		pass: false, 
		message: `missing files on disk: ${missing.join(", ")}` 
	};
}

/**
 * Build preflight checks for the current configuration
 * @param {object} pkg - parsed package.json
 * @param {{ skipGit?: boolean }} options
 * @returns {Array<{pass: boolean, message: string}>}
 */
function buildChecks(pkg, { skipGit = false } = {}) {
	const checks = [
		checkPackageName(pkg),
		checkFilesArrayExists(pkg),
		checkRequiredFiles(pkg),
		checkFilesExist(),
	];

	if (!skipGit) {
		checks.push(checkGitClean());
	}

	return checks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
	console.log("Preflight checks for codex-quota release\n");
	
	// Load package.json
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
	} catch (e) {
		console.error(`Error: Cannot read package.json: ${e.message}`);
		process.exit(1);
	}
	
	// Run all checks
	const checks = buildChecks(pkg);
	
	let hasFailures = false;
	
	for (const check of checks) {
		const icon = check.pass ? "\u2713" : "\u2717";
		const color = check.pass ? "\x1b[32m" : "\x1b[31m";
		console.log(`${color}${icon}\x1b[0m ${check.message}`);
		if (!check.pass) hasFailures = true;
	}
	
	console.log("");
	
	if (hasFailures) {
		console.log("\x1b[31mPreflight checks failed.\x1b[0m Fix the issues above before publishing.");
		process.exit(1);
	}
	
	console.log("\x1b[32mAll preflight checks passed.\x1b[0m Ready to publish.");
	process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	main();
}

export {
	buildChecks,
	checkPackageName,
	checkFilesArrayExists,
	checkRequiredFiles,
	checkFilesExist,
	checkGitClean,
};
