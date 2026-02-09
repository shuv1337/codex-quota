/**
 * Multi-account container read/write/map helpers.
 * Depends on: lib/fs.js, lib/constants.js
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs.js";
import { MULTI_ACCOUNT_SCHEMA_VERSION } from "./constants.js";

/**
 * Read a multi-account container while preserving root shape and fields.
 * Supports both array roots and object roots with an accounts field.
 * @param {string} filePath - Path to the multi-account JSON file
 * @returns {{
 * 	filePath: string,
 * 	exists: boolean,
 * 	rootType: "missing" | "array" | "object" | "invalid",
 * 	rootFields: Record<string, unknown>,
 * 	schemaVersion: number,
 * 	activeLabel: string | null,
 * 	accounts: unknown[],
 * }}
 */
export function readMultiAccountContainer(filePath) {
	const container = {
		filePath,
		exists: existsSync(filePath),
		rootType: "missing",
		rootFields: {},
		schemaVersion: 0,
		activeLabel: null,
		accounts: [],
	};
	if (!container.exists) {
		return container;
	}

	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);

		if (Array.isArray(parsed)) {
			container.rootType = "array";
			container.accounts = parsed;
			return container;
		}

		if (!parsed || typeof parsed !== "object") {
			container.rootType = "invalid";
			return container;
		}

		container.rootType = "object";
		const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
		container.accounts = accounts;
		container.schemaVersion = typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 0;
		container.activeLabel = typeof parsed.activeLabel === "string"
			? parsed.activeLabel
			: parsed.activeLabel === null
				? null
				: null;

		for (const [key, value] of Object.entries(parsed)) {
			if (key === "accounts" || key === "schemaVersion" || key === "activeLabel") {
				continue;
			}
			container.rootFields[key] = value;
		}
	} catch {
		container.rootType = "invalid";
	}

	return container;
}

/**
 * Build a container payload that preserves root fields while merging markers.
 * @param {ReturnType<typeof readMultiAccountContainer>} container
 * @param {unknown[]} accounts - Raw accounts array to persist
 * @param {{ activeLabel?: string | null, schemaVersion?: number }} [overrides]
 * @returns {Record<string, unknown>}
 */
export function buildMultiAccountPayload(container, accounts, overrides = {}) {
	const schemaVersionFromContainer = typeof container.schemaVersion === "number"
		? container.schemaVersion
		: 0;
	const schemaVersionOverride = typeof overrides.schemaVersion === "number"
		? overrides.schemaVersion
		: 0;
	const schemaVersion = Math.max(
		schemaVersionFromContainer,
		schemaVersionOverride,
		MULTI_ACCOUNT_SCHEMA_VERSION,
	);

	const activeLabelCandidate = overrides.activeLabel !== undefined
		? overrides.activeLabel
		: container.activeLabel;
	const activeLabel = typeof activeLabelCandidate === "string" && activeLabelCandidate
		? activeLabelCandidate
		: null;

	return {
		...container.rootFields,
		schemaVersion,
		activeLabel,
		accounts,
	};
}

/**
 * Write a multi-account container while preserving root fields and markers.
 * @param {string} filePath - Path to write
 * @param {ReturnType<typeof readMultiAccountContainer>} container - Container metadata
 * @param {unknown[]} accounts - Raw accounts array to persist
 * @param {{ activeLabel?: string | null, schemaVersion?: number }} [overrides]
 * @param {{ mode?: number }} [options]
 * @returns {{ path: string, payload: Record<string, unknown> }}
 */
export function writeMultiAccountContainer(filePath, container, accounts, overrides = {}, options = {}) {
	const payload = buildMultiAccountPayload(container, accounts, overrides);
	const mode = options.mode ?? 0o600;
	const path = writeFileAtomic(filePath, JSON.stringify(payload, null, 2) + "\n", { mode });
	return { path, payload };
}

/**
 * Map over container accounts while tracking whether anything changed.
 * @param {ReturnType<typeof readMultiAccountContainer>} container
 * @param {(entry: unknown, index: number) => unknown} mapper
 * @returns {{ updated: boolean, accounts: unknown[] }}
 */
export function mapContainerAccounts(container, mapper) {
	let updated = false;
	const accounts = container.accounts.map((entry, index) => {
		const nextEntry = mapper(entry, index);
		if (nextEntry !== entry) {
			updated = true;
		}
		return nextEntry;
	});
	return { updated, accounts };
}
