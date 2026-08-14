/**
 * Clamp a provider-reported quota percentage to the range rendered by the UI.
 * @param {unknown} value
 * @returns {number|null}
 */
export function clampPercent(value) {
	if (value === null || value === undefined || value === "") return null;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return null;
	return Math.max(0, Math.min(100, parsed));
}

/**
 * Classify the tightest quota window for compact and expanded runway displays.
 * @param {{status?: string}|null|undefined} account
 * @param {{remainingPercent?: unknown}|null|undefined} window
 * @returns {{id: string, label: string, copy: string}}
 */
export function riskFor(account, window) {
	if (!account || account.status === "error" || account.status === "unavailable" || !window) {
		return {
			id: "unknown",
			label: account?.status === "error" ? "Unavailable" : "Not reported",
			copy: "No current runway",
		};
	}
	const remaining = clampPercent(window.remainingPercent);
	if (remaining === null) {
		return { id: "unknown", label: "Not reported", copy: "No current runway" };
	}
	if (remaining === 0) {
		return { id: "exhausted", label: "Exhausted", copy: "No quota remaining" };
	}
	if (remaining <= 15) return { id: "tight", label: "Tight", copy: "Likely to exhaust" };
	if (remaining <= 35) return { id: "tight", label: "High", copy: "Use with care" };
	if (remaining <= 55) return { id: "watch", label: "Watch", copy: "Moderate runway" };
	return { id: "safe", label: "Comfortable", copy: "Healthy runway" };
}
