/**
 * Interactive prompt helpers.
 * Zero internal dependencies — only uses Node.js built-ins.
 */

import { createInterface } from "node:readline";

/**
 * Prompt for confirmation using readline
 * @param {string} message - Message to display
 * @returns {Promise<boolean>} True if user confirms (y/Y), false otherwise
 */
export async function promptConfirm(message) {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => {
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y");
		});
	});
}

export async function promptInput(message, options = {}) {
	const { allowEmpty = false } = options;
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => {
		rl.question(message, (answer) => {
			rl.close();
			if (allowEmpty) {
				resolve(answer);
				return;
			}
			resolve(answer.trim());
		});
	});
}
