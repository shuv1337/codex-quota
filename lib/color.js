/**
 * Terminal color output helpers.
 * Zero internal dependencies — only uses Node.js built-ins.
 */

import { readFileSync } from "node:fs";
import { PACKAGE_JSON_PATH } from "./constants.js";

// ANSI color codes
export const GREEN = "\x1b[32m";
export const RED = "\x1b[31m";
export const YELLOW = "\x1b[33m";
export const RESET = "\x1b[0m";

// Global flag set by main() based on CLI args
let noColorFlag = false;

/**
 * Set the noColorFlag value (for testing purposes)
 * @param {boolean} value - Whether to disable colors
 */
export function setNoColorFlag(value) {
	noColorFlag = value;
}

/**
 * Check if terminal supports colors
 * Respects NO_COLOR env var (https://no-color.org/) and --no-color flag
 * @returns {boolean} true if colors should be used
 */
export function supportsColor() {
	// Respect --no-color CLI flag
	if (noColorFlag) return false;
	// Respect NO_COLOR env var (any non-empty value disables color)
	if (process.env.NO_COLOR) return false;
	// Check if stdout is a TTY (not piped/redirected)
	if (!process.stdout.isTTY) return false;
	return true;
}

/**
 * Apply color to text if terminal supports it
 * @param {string} text - Text to colorize
 * @param {string} color - ANSI color code (GREEN, RED, YELLOW)
 * @returns {string} Colorized text or plain text if colors disabled
 */
export function colorize(text, color) {
	if (!supportsColor()) return text;
	return `${color}${text}${RESET}`;
}

/**
 * Output data as formatted JSON to stdout
 * Standardizes JSON output across all handlers with 2-space indent
 * @param {any} data - Data to serialize and output
 */
export function outputJson(data) {
	console.log(JSON.stringify(data, null, 2));
}

/**
 * Get the CLI version from package.json
 * @returns {string}
 */
export function getPackageVersion() {
	try {
		const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8"));
		return pkg.version || "unknown";
	} catch {
		return "unknown";
	}
}
