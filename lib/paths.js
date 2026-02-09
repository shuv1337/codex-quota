/**
 * Auth file path resolution for OpenCode, Codex CLI, and pi.
 * Depends only on lib/constants.js.
 */

import { join } from "node:path";
import { DEFAULT_XDG_DATA_HOME, CODEX_CLI_AUTH_PATH, PI_AUTH_PATH } from "./constants.js";

/**
 * Resolve OpenCode auth.json path using XDG_DATA_HOME
 * @returns {string}
 */
export function getOpencodeAuthPath() {
	const dataHome = process.env.XDG_DATA_HOME || DEFAULT_XDG_DATA_HOME;
	return join(dataHome, "opencode", "auth.json");
}

/**
 * Resolve Codex CLI auth.json path with optional override.
 * @returns {string}
 */
export function getCodexCliAuthPath() {
	const override = process.env.CODEX_AUTH_PATH;
	return override ? override : CODEX_CLI_AUTH_PATH;
}

/**
 * Resolve pi auth.json path with optional override.
 * @returns {string}
 */
export function getPiAuthPath() {
	const override = process.env.PI_AUTH_PATH;
	return override ? override : PI_AUTH_PATH;
}
