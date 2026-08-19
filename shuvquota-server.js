#!/usr/bin/env node

/**
 * shuvquota PWA server entry point.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./lib/env.js";
import {
	DEFAULT_SHUVQUOTA_HOST,
	DEFAULT_SHUVQUOTA_PORT,
	buildAllowedHosts,
	createShuvquotaServer,
} from "./lib/shuvquota-server.js";

loadEnvFile();

export * from "./lib/shuvquota-server.js";

/**
 * @param {unknown} value
 * @returns {number}
 */
export function parseShuvquotaPort(value) {
	if (value === undefined || value === null || value === "") return DEFAULT_SHUVQUOTA_PORT;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error("SHUVQUOTA_PORT must be an integer from 1 to 65535");
	}
	return port;
}

/**
 * Start the shuvquota HTTP server from environment configuration.
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {Promise<import("node:http").Server>}
 */
export async function main(env = process.env) {
	const host = env.SHUVQUOTA_HOST?.trim() || DEFAULT_SHUVQUOTA_HOST;
	const port = parseShuvquotaPort(env.SHUVQUOTA_PORT);
	const allowedHosts = buildAllowedHosts(env.SHUVQUOTA_ALLOWED_HOSTS, host);
	const server = createShuvquotaServer({ host, allowedHosts });

	await new Promise((resolvePromise, rejectPromise) => {
		const onError = error => {
			server.off("listening", onListening);
			rejectPromise(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolvePromise();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});

	console.log(`shuvquota listening on http://${host}:${port}`);

	let closing = false;
	const close = signal => {
		if (closing) return;
		closing = true;
		server.close(error => {
			if (error) {
				console.error("shuvquota failed to stop cleanly");
				process.exitCode = 1;
			} else if (signal) {
				process.exitCode = 0;
			}
		});
	};
	process.once("SIGINT", () => close("SIGINT"));
	process.once("SIGTERM", () => close("SIGTERM"));
	return server;
}

let isMain = false;
try {
	isMain = process.argv[1]
		? realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
		: false;
} catch {
	isMain = false;
}

if (isMain) {
	main().catch(() => {
		console.error("shuvquota failed to start");
		process.exitCode = 1;
	});
}
