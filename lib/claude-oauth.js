/**
 * Claude OAuth browser flow.
 * Depends on: lib/constants.js, lib/oauth.js, lib/claude-tokens.js, lib/prompts.js
 */

import {
	CLAUDE_OAUTH_AUTHORIZE_URL,
	CLAUDE_OAUTH_TOKEN_URL,
	CLAUDE_OAUTH_REDIRECT_URI,
	CLAUDE_OAUTH_CLIENT_ID,
	CLAUDE_OAUTH_SCOPES,
	CLAUDE_OAUTH_REFRESH_BUFFER_MS,
	OAUTH_TIMEOUT_MS,
} from "./constants.js";
import { generatePKCE, generateState, openBrowser } from "./oauth.js";
import { refreshClaudeToken, persistClaudeOAuthTokens } from "./claude-tokens.js";
import { promptInput } from "./prompts.js";

export function buildClaudeAuthUrl(codeChallenge, state) {
	const params = new URLSearchParams({
		response_type: "code",
		client_id: CLAUDE_OAUTH_CLIENT_ID,
		redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
		scope: CLAUDE_OAUTH_SCOPES,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
		state: state,
		code: "true", // Display code in browser for user to copy
	});
	// Use %20 instead of + for spaces
	return `${CLAUDE_OAUTH_AUTHORIZE_URL}?${params.toString().replace(/\+/g, "%20")}`;
}

/**
 * Parse user input containing Claude OAuth code and state
 * Accepts formats:
 *   - "code#state" (code with state suffix)
 *   - "code" (code only, state validation skipped)
 *   - Full callback URL: https://console.anthropic.com/oauth/code/callback?code=...&state=...
 * @param {string} input - User input string
 * @param {string} expectedState - Expected state for CSRF validation
 * @returns {{ code: string, state: string | null }} Parsed code and optional state
 */
export function parseClaudeCodeState(input) {
	const trimmed = (input ?? "").trim();
	if (!trimmed) {
		return { code: null, state: null };
	}

	// Check if it's a full callback URL
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
		try {
			const url = new URL(trimmed);
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			return { code: code || null, state: state || null };
		} catch {
			return { code: null, state: null };
		}
	}

	// Check for code#state format
	if (trimmed.includes("#")) {
		const [code, state] = trimmed.split("#", 2);
		return { code: code || null, state: state || null };
	}

	// Plain code only
	return { code: trimmed, state: null };
}

/**
 * Exchange Claude authorization code for tokens
 * @param {string} code - Authorization code from callback
 * @param {string} codeVerifier - PKCE code verifier
 * @param {string} state - OAuth state for CSRF validation
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresIn: number }>}
 */
export async function exchangeClaudeCodeForTokens(code, codeVerifier, state) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), OAUTH_TIMEOUT_MS);

	try {
		const body = {
			grant_type: "authorization_code",
			code: code,
			state: state,
			redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
			client_id: CLAUDE_OAUTH_CLIENT_ID,
			code_verifier: codeVerifier,
		};

		const response = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Token exchange failed: ${response.status} ${text}`);
		}

		const data = await response.json();

		return {
			accessToken: data.access_token,
			refreshToken: data.refresh_token || null,
			expiresIn: data.expires_in || 3600,
		};
	} finally {
		clearTimeout(timeout);
	}
}

// refreshClaudeToken, isClaudeOauthTokenExpiring, resolveClaudeOauthAccountFields,
// ensureFreshClaudeOAuthToken are in ./claude-tokens.js

/**
 * Run the Claude OAuth browser flow to get tokens
 * @param {{ noBrowser: boolean }} flags - CLI flags
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: number, scopes: string }>}
 */
export async function handleClaudeOAuthFlow(flags) {
	// 1. Generate PKCE code verifier and challenge
	const { verifier, challenge } = generatePKCE();

	// 2. Generate random state for CSRF protection
	const state = generateState();

	// 3. Build authorization URL
	const authUrl = buildClaudeAuthUrl(challenge, state);

	// 4. Print instructions
	console.log("\nStarting Claude OAuth authentication...\n");

	// 5. Open browser or print URL
	openBrowser(authUrl, { noBrowser: flags.noBrowser });

	// 6. Prompt user to paste code
	console.log("After authenticating in the browser, you will see a code.");
	console.log("Copy the entire code (including any #state portion) and paste it below.\n");

	const input = await promptInput("Paste code#state here: ");
	const { code, state: returnedState } = parseClaudeCodeState(input);

	if (!code) {
		throw new Error("No authorization code provided. Authentication cancelled.");
	}

	// 7. Validate state if provided (CSRF protection)
	if (returnedState && returnedState !== state) {
		throw new Error("State mismatch. Possible CSRF attack. Please try again.");
	}

	// 8. Exchange code for tokens
	console.log("\nExchanging code for tokens...");
	const stateToSend = returnedState ?? state;
	const tokens = await exchangeClaudeCodeForTokens(code, verifier, stateToSend);

	// 9. Calculate expiry timestamp
	const expiresAt = Date.now() + (tokens.expiresIn * 1000);

	return {
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		expiresAt: expiresAt,
		scopes: CLAUDE_OAUTH_SCOPES,
	};
}

