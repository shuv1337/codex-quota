/**
 * OpenAI OAuth PKCE flow (shared utilities).
 * Depends on: lib/constants.js, lib/color.js
 */

import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import {
	TOKEN_URL,
	AUTHORIZE_URL,
	CLIENT_ID,
	REDIRECT_URI,
	SCOPE,
	OAUTH_TIMEOUT_MS,
	JWT_CLAIM,
	PRIMARY_CMD,
} from "./constants.js";
import { decodeJWT, extractAccountId, extractProfile } from "./jwt.js";

export function generatePKCE() {
	// Generate 32 random bytes and encode as base64url
	const verifier = randomBytes(32)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");
	
	// Generate SHA256 hash of verifier and encode as base64url
	const challenge = createHash("sha256")
		.update(verifier)
		.digest("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");
	
	return { verifier, challenge };
}

/**
 * Generate random state string for OAuth CSRF protection
 * @returns {string} 64-character hex string (32 random bytes)
 */
export function generateState() {
	return randomBytes(32).toString("hex");
}

/**
 * Build the OAuth authorization URL with all required parameters
 * @param {string} codeChallenge - PKCE code challenge (base64url-encoded SHA256)
 * @param {string} state - Random state string for CSRF protection
 * @returns {string} Complete authorization URL
 */
export function buildAuthUrl(codeChallenge, state) {
	const params = new URLSearchParams({
		response_type: "code",
		client_id: CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		scope: SCOPE,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
		state: state,
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
		originator: "codex_cli_rs",
	});
	// Use %20 instead of + for spaces (matches official Codex CLI)
	return `${AUTHORIZE_URL}?${params.toString().replace(/\+/g, "%20")}`;
}

/**
 * Check if a port is available for binding
 * @param {number} port - Port number to check
 * @returns {Promise<boolean>} True if port is available, false if in use
 */
export function checkPortAvailable(port) {
	return new Promise((resolve) => {
		const server = createServer();
		
		server.once("error", (err) => {
			if (err.code === "EADDRINUSE") {
				resolve(false);
			} else {
				// Other errors - treat as unavailable to be safe
				resolve(false);
			}
		});
		
		server.once("listening", () => {
			// Port is available - close immediately and report success
			server.close(() => {
				resolve(true);
			});
		});
		
		server.listen(port, "127.0.0.1");
	});
}

/**
 * Detect if running in a headless environment (SSH, no display)
 * Used to determine whether to open browser or print URL for manual copy
 * @returns {boolean} True if headless environment detected
 */
export function isHeadlessEnvironment() {
	// Check for SSH session
	if (process.env.SSH_CLIENT || process.env.SSH_TTY) {
		return true;
	}
	
	// On Linux, check for display server
	if (process.platform === "linux") {
		if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
			return true;
		}
	}
	
	return false;
}

/**
 * Open a URL in the default browser, or print URL if headless/--no-browser
 * @param {string} url - URL to open
 * @param {{ noBrowser?: boolean }} options - Options including --no-browser flag
 * @returns {boolean} True if browser was opened, false if URL was printed
 */
export function openBrowser(url, options = {}) {
	// If --no-browser flag or headless environment, only print URL (don't open browser)
	if (options.noBrowser || isHeadlessEnvironment()) {
		console.log("\nOpen this URL in your browser to authenticate:");
		console.log(`\n  ${url}\n`);
		return false;
	}

	// Platform-specific browser open commands
	let cmd;
	let args;

	switch (process.platform) {
		case "darwin":
			cmd = "open";
			args = [url];
			break;
		case "win32":
			cmd = "cmd";
			args = ["/c", "start", "", url];
			break;
		default:
			// Linux and other Unix-like systems
			cmd = "xdg-open";
			args = [url];
			break;
	}

	try {
		// Spawn detached process so it doesn't block the CLI
		const child = spawn(cmd, args, {
			detached: true,
			stdio: "ignore",
		});

		// Unref to allow the parent process to exit independently
		child.unref();

		console.log("\nOpening browser for authentication...");
		console.log("\nIf the browser doesn't open, use this URL:");
		console.log(`\n  ${url}\n`);
		return true;
	} catch {
		// If spawn fails, fall back to printing URL
		console.log("\nCould not open browser. Open this URL manually:");
		console.log(`\n  ${url}\n`);
		return false;
	}
}

/**
 * HTML page shown to user after successful OAuth callback
 * Minimal, self-contained page that closes automatically after 3 seconds
 */
export const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authentication Successful</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    p { font-size: 1.1rem; opacity: 0.9; }
    .checkmark {
      font-size: 4rem;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="checkmark">✓</div>
    <h1>Authentication Successful</h1>
    <p>You can close this window and return to the terminal.</p>
  </div>
  <script>setTimeout(() => window.close(), 3000);</script>
</body>
</html>`;

/**
 * Error HTML page shown when OAuth callback has an error
 * @param {string} message - Error message to display
 * @returns {string} HTML page content
 */
export function getErrorHtml(message) {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authentication Failed</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%);
      color: white;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    p { font-size: 1.1rem; opacity: 0.9; }
    .icon {
      font-size: 4rem;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">✗</div>
    <h1>Authentication Failed</h1>
    <p>${message}</p>
    <p>You can close this window and try again.</p>
  </div>
</body>
</html>`;
}

/**
 * Exchange authorization code for tokens using the OAuth token endpoint
 * @param {string} code - Authorization code from OAuth callback
 * @param {string} codeVerifier - PKCE code verifier used when generating the challenge
 * @returns {Promise<{accessToken: string, refreshToken: string, idToken: string, expires: number, accountId: string, email: string | null}>}
 * @throws {Error} If token exchange fails
 */
export async function exchangeCodeForTokens(code, codeVerifier) {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code: code,
		client_id: CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		code_verifier: codeVerifier,
	});
	
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: body.toString(),
	});
	
	if (!res.ok) {
		let errorMessage = `HTTP ${res.status}`;
		try {
			const errorJson = await res.json();
			if (errorJson.error_description) {
				errorMessage = errorJson.error_description;
			} else if (errorJson.error) {
				errorMessage = errorJson.error;
			}
		} catch {
			// Response not JSON - use HTTP status message
		}
		throw new Error(`Token exchange failed: ${errorMessage}`);
	}
	
	const json = await res.json();
	
	// Validate required fields
	if (!json.access_token) {
		throw new Error("Token exchange failed: Missing access_token in response");
	}
	if (!json.refresh_token) {
		throw new Error("Token exchange failed: Missing refresh_token in response");
	}
	if (typeof json.expires_in !== "number") {
		throw new Error("Token exchange failed: Missing or invalid expires_in in response");
	}
	
	// Calculate expires timestamp (milliseconds since epoch)
	const expires = Date.now() + json.expires_in * 1000;
	
	// Extract account_id and email from id_token JWT claims
	const idToken = json.id_token || null;
	let accountId = null;
	let email = null;
	
	// Try to get account_id from access_token first (more reliable)
	accountId = extractAccountId(json.access_token);
	
	// Extract email from id_token if present
	if (idToken) {
		const idPayload = decodeJWT(idToken);
		if (idPayload) {
			email = idPayload.email || null;
			// Fallback: get account_id from id_token if not in access_token
			if (!accountId) {
				accountId = idPayload[JWT_CLAIM]?.chatgpt_account_id || null;
			}
		}
	}
	
	// If still no account_id, try extracting from access_token profile
	if (!accountId) {
		const profile = extractProfile(json.access_token);
		email = email || profile.email;
	}
	
	if (!accountId) {
		throw new Error("Token exchange failed: Could not extract account_id from tokens");
	}
	
	return {
		accessToken: json.access_token,
		refreshToken: json.refresh_token,
		idToken: idToken,
		expires: expires,
		accountId: accountId,
		email: email,
	};
}

/**
 * Start local HTTP server to receive OAuth callback
 * Server listens on port 1455 for /auth/callback path
 * @param {string} expectedState - State string to verify against CSRF attacks
 * @returns {Promise<{code: string, state: string}>} Resolves with auth code and state, rejects on error/timeout
 */
export function startCallbackServer(expectedState) {
	return new Promise((resolve, reject) => {
		let serverClosed = false;
		let timeoutId = null;
		let sigintHandler = null;
		
		const server = createHttpServer((req, res) => {
			// Only handle /auth/callback path
			const url = new URL(req.url, `http://${req.headers.host}`);
			
			if (url.pathname !== "/auth/callback") {
				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("Not Found");
				return;
			}
			
			// Parse query parameters
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			const error = url.searchParams.get("error");
			const errorDescription = url.searchParams.get("error_description");
			
			// Handle error response from OAuth provider
			if (error) {
				const message = errorDescription || error;
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(getErrorHtml(message));
				cleanup();
				reject(new Error(`OAuth error: ${message}`));
				return;
			}
			
			// Validate required parameters
			if (!code) {
				res.writeHead(400, { "Content-Type": "text/html" });
				res.end(getErrorHtml("Missing authorization code"));
				cleanup();
				reject(new Error("Missing authorization code in callback"));
				return;
			}
			
			if (!state) {
				res.writeHead(400, { "Content-Type": "text/html" });
				res.end(getErrorHtml("Missing state parameter"));
				cleanup();
				reject(new Error("Missing state parameter in callback"));
				return;
			}
			
			// Verify state matches to prevent CSRF attacks
			if (state !== expectedState) {
				res.writeHead(400, { "Content-Type": "text/html" });
				res.end(getErrorHtml("State mismatch - possible CSRF attack"));
				cleanup();
				reject(new Error("State mismatch. Possible CSRF attack."));
				return;
			}
			
			// Success! Serve success page and resolve
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(SUCCESS_HTML);
			cleanup();
			resolve({ code, state });
		});
		
		/**
		 * Clean up server resources
		 */
		function cleanup() {
			if (serverClosed) return;
			serverClosed = true;
			
			// Clear timeout
			if (timeoutId) {
				clearTimeout(timeoutId);
				timeoutId = null;
			}
			
			// Remove SIGINT handler
			if (sigintHandler) {
				process.removeListener("SIGINT", sigintHandler);
				sigintHandler = null;
			}
			
			// Close server
			server.close();
		}
		
		// Handle server errors
		server.on("error", (err) => {
			cleanup();
			if (err.code === "EADDRINUSE") {
				reject(new Error(`Port 1455 is in use. Close other ${PRIMARY_CMD} instances and retry.`));
			} else {
				reject(new Error(`Server error: ${err.message}`));
			}
		});
		
		// Set timeout for authentication (default 2 minutes)
		timeoutId = setTimeout(() => {
			cleanup();
			reject(new Error(`Authentication timed out after 2 minutes. Run '${PRIMARY_CMD} codex add' to try again.`));
		}, OAUTH_TIMEOUT_MS);
		
		// Handle Ctrl+C gracefully
		sigintHandler = () => {
			console.log("\nAuthentication cancelled.");
			cleanup();
			reject(new Error("Authentication cancelled by user."));
		};
		process.on("SIGINT", sigintHandler);
		
		// Start listening on localhost only (security)
		server.listen(1455, "127.0.0.1", () => {
			// Server is ready - caller will open browser
		});
	});
}

