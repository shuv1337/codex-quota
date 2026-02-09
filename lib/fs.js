/**
 * File system helpers: symlink-aware write, atomic file operations.
 * Zero internal dependencies — only uses Node.js built-ins.
 */

import {
	existsSync,
	writeFileSync,
	mkdirSync,
	chmodSync,
	renameSync,
	realpathSync,
	lstatSync,
	readlinkSync,
} from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";

/**
 * Resolve the correct write target for a path, preserving symlink files.
 * @param {string} filePath - Intended path to write
 * @returns {{ path: string, isSymlink: boolean }}
 */
export function resolveWritePath(filePath) {
	try {
		const stats = lstatSync(filePath);
		if (!stats.isSymbolicLink()) {
			return { path: filePath, isSymlink: false };
		}
		try {
			return { path: realpathSync(filePath), isSymlink: true };
		} catch {
			let linkTarget = readlinkSync(filePath);
			if (!isAbsolute(linkTarget)) {
				linkTarget = resolve(dirname(filePath), linkTarget);
			}
			return { path: linkTarget, isSymlink: true };
		}
	} catch {
		return { path: filePath, isSymlink: false };
	}
}

/**
 * Write a file atomically while preserving existing symlink files.
 * @param {string} filePath - Intended path to write
 * @param {string} contents - File contents
 * @param {{ mode?: number }} [options]
 * @returns {string} Actual path written
 */
export function writeFileAtomic(filePath, contents, options = {}) {
	const { path: targetPath } = resolveWritePath(filePath);
	const dir = dirname(targetPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const tempPath = `${targetPath}.tmp`;
	writeFileSync(tempPath, contents, "utf-8");
	if (options.mode !== undefined) {
		chmodSync(tempPath, options.mode);
	}
	renameSync(tempPath, targetPath);
	return targetPath;
}
