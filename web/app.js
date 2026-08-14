import { clampPercent, riskFor } from "./quota-risk.js?v=13";

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 75 * 1000;
const HISTORY_LIMIT = 12;

const PROVIDER_ICONS = Object.freeze({
	codex: "/icons/providers/openai.svg",
	claude: "/icons/providers/anthropic.svg",
	grok: "/icons/providers/xai.svg",
	synthetic: "/icons/providers/synthetic.svg",
	antigravity: "/icons/providers/antigravity.svg",
	"opencode-go": "/icons/providers/opencode-go.svg",
});

const state = {
	activeView: "overview",
	deferredInstallPrompt: null,
	history: [],
	isLoading: false,
	isOffline: !navigator.onLine,
	nextRefreshAt: Date.now() + REFRESH_INTERVAL_MS,
	scope: "all",
	snapshot: null,
	stale: false,
};

const elements = {
	emptyState: document.querySelector("#empty-state"),
	historyEmpty: document.querySelector("#history-empty"),
	historyList: document.querySelector("#history-list"),
	installState: document.querySelector("#install-state"),
	liveBadge: document.querySelector("#live-badge"),
	localState: document.querySelector(".local-state"),
	navItems: [...document.querySelectorAll("[data-view]")],
	nextScan: document.querySelector("#next-scan"),
	notice: document.querySelector("#notice"),
	providerList: document.querySelector("#provider-list"),
	railConnection: document.querySelector("#rail-connection"),
	railInstall: document.querySelector("#rail-install"),
	refreshButton: document.querySelector("#refresh-button"),
	scanState: document.querySelector("#scan-state"),
	scopeSelect: document.querySelector("#scope-select"),
	settingsConnection: document.querySelector("#settings-connection"),
	settingsInstall: document.querySelector("#settings-install"),
	timezoneCopy: document.querySelector("#timezone-copy"),
	toast: document.querySelector("#toast"),
	updatedAt: document.querySelector("#updated-at"),
	views: [...document.querySelectorAll("[data-view-panel]")],
};

function element(tagName, options = {}, children = []) {
	const node = document.createElement(tagName);
	if (options.className) node.className = options.className;
	if (options.text !== undefined) node.textContent = String(options.text);
	for (const [name, value] of Object.entries(options.attributes ?? {})) {
		if (value !== null && value !== undefined) node.setAttribute(name, String(value));
	}
	for (const child of children) {
		if (child) node.append(child);
	}
	return node;
}

function image(src, alt = "", className = "") {
	return element("img", { className, attributes: { src, alt } });
}

function clear(node) {
	while (node.firstChild) node.firstChild.remove();
}

function formatPercent(value) {
	const percent = clampPercent(value);
	if (percent === null) return "—";
	return Number.isInteger(percent) ? String(percent) : percent.toFixed(1);
}

function parseDate(value) {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function formatUpdated(value) {
	const date = parseDate(value);
	if (!date) return "Not updated yet";
	return `Updated ${new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
	}).format(date)}`;
}

function formatResetDate(value) {
	const date = parseDate(value);
	if (!date) return { primary: "No reset supplied", secondary: "Provider did not report a time" };
	const now = new Date();
	const sameDay = date.toDateString() === now.toDateString();
	const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
	const primary = sameDay
		? "Today"
		: date.toDateString() === tomorrow.toDateString()
			? "Tomorrow"
			: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
	return {
		primary,
		secondary: new Intl.DateTimeFormat(undefined, {
			month: "short",
			day: "numeric",
			year: "numeric",
			hour: "numeric",
			minute: "2-digit",
		}).format(date),
	};
}

function formatCountdown(value) {
	const date = parseDate(value);
	if (!date) return "Reset time unavailable";
	const diff = date.getTime() - Date.now();
	if (diff <= 0) return "Reset due now";
	const minutes = Math.max(1, Math.floor(diff / 60000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	if (days > 0) return `in ${days}d ${hours}h`;
	if (hours > 0) return `in ${hours}h ${mins}m`;
	return `in ${mins}m`;
}

function tightestWindow(account) {
	const windows = Array.isArray(account?.windows) ? account.windows : [];
	return windows
		.filter(window => clampPercent(window?.remainingPercent) !== null)
		.sort((left, right) => left.remainingPercent - right.remainingPercent)[0] ?? null;
}

function showToast(message) {
	elements.toast.textContent = message;
	elements.toast.hidden = false;
	window.clearTimeout(showToast.timeout);
	showToast.timeout = window.setTimeout(() => {
		elements.toast.hidden = true;
	}, 4200);
}

function setView(view, updateHash = true) {
	const allowed = new Set(["overview", "history", "settings"]);
	state.activeView = allowed.has(view) ? view : "overview";
	for (const item of elements.navItems) {
		const active = item.dataset.view === state.activeView;
		item.classList.toggle("is-active", active);
		if (active) item.setAttribute("aria-current", "page");
		else item.removeAttribute("aria-current");
	}
	for (const panel of elements.views) {
		const active = panel.dataset.viewPanel === state.activeView;
		panel.hidden = !active;
		panel.classList.toggle("is-active", active);
	}
	if (updateHash) history.replaceState(null, "", `#${state.activeView}`);
	if (state.activeView === "history") renderHistory();
	document.querySelector(`#${state.activeView}-view`)?.focus({ preventScroll: true });
}

function providerRows(snapshot) {
	const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
	return providers.flatMap(provider => {
		const accounts = Array.isArray(provider.accounts) ? provider.accounts : [];
		if (accounts.length === 0) {
			return [{
				provider,
				account: null,
				rowKey: `${provider.id}:empty`,
			}];
		}
		return accounts.map((account, index) => ({
			provider,
			account,
			rowKey: `${provider.id}:${index}`,
		}));
	});
}

function filteredRows(rows) {
	if (state.scope === "all") return rows;
	if (state.scope.startsWith("provider:")) {
		const providerId = state.scope.slice("provider:".length);
		return rows.filter(row => row.provider.id === providerId);
	}
	if (state.scope.startsWith("account:")) {
		const rowKey = state.scope.slice("account:".length);
		return rows.filter(row => row.rowKey === rowKey);
	}
	return rows;
}

function cell(label, className, children) {
	return element("div", { className: `quota-cell ${className}` }, [
		element("span", { className: "cell-label", text: label }),
		...children,
	]);
}

function providerSetupHint(providerId) {
	if (providerId === "opencode-go") {
		return "Set the OpenCode Go workspace and dashboard cookie in ~/.codex-quota.env.";
	}
	if (providerId === "grok") {
		return "Sign in with SuperGrok OAuth in pi, OpenCode, or Hermes.";
	}
	if (providerId === "synthetic") {
		return "Set SYNTHETIC_API_KEY or configure Synthetic in shuvcode.";
	}
	if (providerId === "antigravity") {
		return "Connect Google AI Pro in shuvcode, or set ANTIGRAVITY_REFRESH.";
	}
	return `Run codex-quota ${providerId} add to configure this provider.`;
}

function renderProviderRow(row) {
	const { provider, account } = row;
	const window = tightestWindow(account);
	const risk = riskFor(account, window);
	const remaining = clampPercent(window?.remainingPercent);
	const reset = formatResetDate(window?.resetAt);
	const windows = Array.isArray(account?.windows) ? account.windows : [];
	const iconPath = PROVIDER_ICONS[provider.id] ?? PROVIDER_ICONS.codex;
	const details = element("details", {
		className: "provider-entry",
		attributes: { "data-risk": risk.id },
	});
	const providerCopy = element("div", {}, [
		element("strong", { className: "provider-name", text: provider.name ?? provider.id }),
		element("span", {
			className: "provider-plan",
			text: account
				? account.plan ?? "Plan not reported"
				: provider.error ?? "No account configured",
		}),
		element("span", { className: "provider-tag", text: window?.label ?? "Local" }),
	]);
	const providerCell = cell("Provider", "provider-cell", [
		element("span", { className: "provider-icon-shell" }, [image(iconPath)]),
		providerCopy,
	]);

	const progress = element("progress", {
		className: "quota-progress",
		attributes: {
			max: "100",
			value: remaining ?? "0",
			"aria-label": `${provider.name ?? provider.id} quota remaining`,
		},
	});
	const remainingCell = cell("Remaining", "remaining-cell", [
		element("span", { className: "remaining-number" }, [
			document.createTextNode(formatPercent(remaining)),
			element("span", { text: "%" }),
		]),
		progress,
		element("span", {
			className: "remaining-caption",
			text: remaining === null ? "No quota reported" : `${formatPercent(remaining)}% remaining`,
		}),
	]);

	const resetCell = cell("Reset (local time)", "reset-cell", [
		element("span", { className: "reset-primary", text: reset.primary }),
		element("span", { className: "reset-date", text: reset.secondary }),
		element("span", { className: "reset-countdown", text: formatCountdown(window?.resetAt) }),
		element("span", { className: "mobile-risk", text: risk.label }),
	]);

	const accountCell = cell("Account", "account-cell", [
		element("span", {
			className: "account-primary",
			text: account?.email ?? account?.label ?? "Not configured",
		}),
		element("span", { className: "account-tag", text: account?.label ?? "Local" }),
	]);

	const riskCell = cell("Risk", "risk-cell", [
		element("span", { className: "risk-label", text: risk.label }),
		element("span", { className: "risk-copy", text: risk.copy }),
	]);

	const limitText = windows.length === 0
		? "No limits"
		: windows.length === 1 ? windows[0].label : `${windows[0].label} +${windows.length - 1}`;
	const limitsCell = cell("Limits", "limits-cell", [
		element("span", { className: "limit-primary", text: limitText }),
		element("span", {
			className: "limit-secondary",
			text: account?.bankedResets
				? `${account.bankedResets.availableCount} banked resets`
				: windows.length > 0 ? "Open for details" : "Quota unavailable",
		}),
		image("/icons/ui/chevron-down.svg", "", "row-chevron"),
	]);

	const summary = element("summary", { className: "quota-row" }, [
		providerCell,
		remainingCell,
		resetCell,
		accountCell,
		riskCell,
		limitsCell,
	]);
	details.append(summary);

	const detailBody = element("div", { className: "quota-details" });
	if (windows.length > 0) {
		for (const limit of windows) {
			const limitReset = formatResetDate(limit.resetAt);
			detailBody.append(element("div", { className: "limit-detail" }, [
				element("strong", { text: limit.label ?? "Quota limit" }),
				element("span", { text: `${formatPercent(limit.remainingPercent)}% remaining` }),
				element("span", { text: limit.resetAt ? `${limitReset.secondary} · ${formatCountdown(limit.resetAt)}` : "No reset supplied" }),
			]));
		}
	} else {
		detailBody.append(element("div", { className: "limit-detail" }, [
			element("strong", { text: provider.error ?? "No account configured" }),
			element("span", { text: providerSetupHint(provider.id) }),
		]));
	}
	if (account?.bankedResets) {
		const expirations = Array.isArray(account.bankedResets.expirations)
			? account.bankedResets.expirations.map(value => formatResetDate(value).secondary).join(" · ")
			: "Expiration dates unavailable";
		detailBody.append(element("div", { className: "banked-resets" }, [
			element("strong", { text: `${account.bankedResets.availableCount} Codex banked resets available` }),
			element("span", { text: expirations }),
		]));
	}
	details.append(detailBody);
	return details;
}

function updateScopeOptions(rows) {
	const previous = state.scope;
	const options = [{ value: "all", label: `All accounts (${rows.filter(row => row.account).length})` }];
	const providers = new Map();
	for (const row of rows) providers.set(row.provider.id, row.provider.name ?? row.provider.id);
	for (const [id, name] of providers) options.push({ value: `provider:${id}`, label: name });
	for (const row of rows.filter(item => item.account)) {
		options.push({
			value: `account:${row.rowKey}`,
			label: `${row.provider.name}: ${row.account.label}`,
		});
	}
	clear(elements.scopeSelect);
	for (const option of options) {
		elements.scopeSelect.append(element("option", {
			text: option.label,
			attributes: { value: option.value },
		}));
	}
	state.scope = options.some(option => option.value === previous) ? previous : "all";
	elements.scopeSelect.value = state.scope;
}

function renderOverview() {
	clear(elements.providerList);
	if (!state.snapshot) {
		elements.providerList.append(element("div", {
			className: "loading-row",
			text: state.isLoading ? "Scanning local provider quotas…" : "Quota data has not loaded yet.",
		}));
		elements.emptyState.hidden = true;
		return;
	}
	const rows = providerRows(state.snapshot);
	updateScopeOptions(rows);
	const visibleRows = filteredRows(rows);
	for (const row of visibleRows) elements.providerList.append(renderProviderRow(row));
	elements.emptyState.hidden = visibleRows.length > 0;

	const partialProviders = state.snapshot.providers?.filter(provider => provider.error) ?? [];
	const diverged = Object.entries(state.snapshot.divergence ?? {})
		.filter(([, value]) => value)
		.map(([key]) => key === "codex" ? "Codex" : "Claude");
	const notices = [];
	if (state.stale) notices.push("Showing the last in-memory scan; live quota is currently unavailable.");
	if (partialProviders.length > 0) {
		notices.push(`${partialProviders.length} provider${partialProviders.length === 1 ? " has" : "s have"} incomplete data.`);
	}
	if (diverged.length > 0) notices.push(`${diverged.join(" and ")} active account state has diverged.`);
	elements.notice.textContent = notices.join(" ");
	elements.notice.hidden = notices.length === 0;
}

function captureHistory(snapshot) {
	if (!snapshot?.generatedAt) return;
	if (state.history[0]?.generatedAt === snapshot.generatedAt) return;
	const rows = providerRows(snapshot).filter(row => row.account);
	const tightest = rows
		.map(row => ({ provider: row.provider.name, account: row.account.label, window: tightestWindow(row.account) }))
		.filter(item => item.window)
		.sort((left, right) => left.window.remainingPercent - right.window.remainingPercent)[0] ?? null;
	state.history.unshift({
		accountCount: snapshot.summary?.accountCount ?? rows.length,
		generatedAt: snapshot.generatedAt,
		providerCount: snapshot.summary?.providerCount ?? snapshot.providers?.length ?? 0,
		tightest,
	});
	state.history = state.history.slice(0, HISTORY_LIMIT);
}

function renderHistory() {
	clear(elements.historyList);
	elements.historyEmpty.hidden = state.history.length > 0;
	for (const item of state.history) {
		const runway = item.tightest
			? `${formatPercent(item.tightest.window.remainingPercent)}% · ${item.tightest.provider}`
			: "No runway reported";
		elements.historyList.append(element("article", { className: "history-item" }, [
			element("div", {}, [
				element("strong", { text: formatUpdated(item.generatedAt).replace("Updated ", "") }),
				element("time", { text: formatCountdown(item.generatedAt), attributes: { datetime: item.generatedAt } }),
			]),
			element("span", { className: "history-runway", text: runway }),
			element("span", { text: `${item.accountCount} account${item.accountCount === 1 ? "" : "s"}` }),
		]));
	}
}

function updateConnectionUi() {
	const offline = state.isOffline;
	elements.localState.classList.toggle("is-offline", offline);
	elements.railConnection.textContent = offline ? "Offline shell" : "Local data";
	elements.liveBadge.textContent = offline ? "OFFLINE" : state.stale ? "STALE" : "LIVE · LOCAL";
	elements.settingsConnection.textContent = offline ? "Offline" : state.stale ? "Stale" : state.snapshot ? "Connected" : "Waiting";
	if (offline) {
		elements.scanState.textContent = state.snapshot ? "Offline · last scan in memory" : "Offline · live quota unavailable";
		elements.scanState.className = "scan-state is-stale";
	}
}

function updateScanUi() {
	elements.refreshButton.disabled = state.isLoading;
	if (state.isLoading) {
		elements.scanState.textContent = "Scanning local providers";
		elements.scanState.className = "scan-state is-loading";
	} else if (state.stale) {
		elements.scanState.textContent = "Live scan unavailable";
		elements.scanState.className = "scan-state is-stale";
	} else if (state.snapshot) {
		const duration = Number(state.snapshot.scanDurationMs);
		elements.scanState.textContent = Number.isFinite(duration)
			? `Scan complete in ${(duration / 1000).toFixed(1)}s`
			: "Scan complete";
		elements.scanState.className = "scan-state";
	} else {
		elements.scanState.textContent = "Waiting for first scan";
		elements.scanState.className = "scan-state";
	}
	elements.updatedAt.textContent = formatUpdated(state.snapshot?.generatedAt);
	updateConnectionUi();
}

async function refreshQuota({ manual = false } = {}) {
	if (state.isLoading) return;
	state.isLoading = true;
	updateScanUi();
	renderOverview();
	const controller = new AbortController();
	const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch("/api/quota", {
			cache: "no-store",
			credentials: "same-origin",
			headers: { Accept: "application/json" },
			signal: controller.signal,
		});
		const snapshot = await response.json();
		if (!response.ok) throw new Error("Quota service unavailable");
		if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.providers)) {
			throw new Error("Unsupported quota snapshot");
		}
		state.snapshot = snapshot;
		state.stale = false;
		state.isOffline = false;
		state.nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
		captureHistory(snapshot);
		if (manual) showToast("Quota runway refreshed.");
	} catch (error) {
		state.stale = Boolean(state.snapshot);
		state.isOffline = !navigator.onLine;
		if (manual || !state.snapshot) {
			showToast(error?.name === "AbortError" ? "Quota scan timed out." : "Live quota is unavailable.");
		}
	} finally {
		window.clearTimeout(timeout);
		state.isLoading = false;
		updateScanUi();
		renderOverview();
		renderHistory();
	}
}

function updateCountdown() {
	const remaining = state.nextRefreshAt - Date.now();
	if (remaining <= 0) {
		elements.nextScan.textContent = document.hidden ? "Next scan when this tab is visible" : "Next scan due now";
		if (!document.hidden && !state.isLoading && navigator.onLine) refreshQuota();
		return;
	}
	const seconds = Math.ceil(remaining / 1000);
	const minutes = Math.floor(seconds / 60);
	const rest = String(seconds % 60).padStart(2, "0");
	elements.nextScan.textContent = `Next scan in ${minutes}:${rest}`;
}

function isInstalled() {
	return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

function updateInstallUi() {
	if (isInstalled()) {
		elements.installState.textContent = "Installed and running as a standalone app.";
		elements.settingsInstall.hidden = true;
		elements.railInstall.hidden = true;
		return;
	}
	elements.settingsInstall.hidden = false;
	elements.railInstall.hidden = false;
	if (state.deferredInstallPrompt) {
		elements.installState.textContent = "Ready to install on this device.";
		elements.settingsInstall.disabled = false;
	} else {
		elements.installState.textContent = "Use your browser's Add to Home Screen action.";
		elements.settingsInstall.disabled = false;
	}
}

async function requestInstall() {
	if (!state.deferredInstallPrompt) {
		showToast("Use your browser menu and choose Add to Home Screen.");
		return;
	}
	state.deferredInstallPrompt.prompt();
	const choice = await state.deferredInstallPrompt.userChoice;
	state.deferredInstallPrompt = null;
	showToast(choice.outcome === "accepted" ? "shuvquota installation started." : "Installation dismissed.");
	updateInstallUi();
}

function initializeNavigation() {
	for (const item of elements.navItems) {
		item.addEventListener("click", () => setView(item.dataset.view));
	}
	window.addEventListener("hashchange", () => setView(location.hash.slice(1), false));
	setView(location.hash.slice(1) || "overview", false);
}

function initializeEvents() {
	elements.refreshButton.addEventListener("click", () => refreshQuota({ manual: true }));
	elements.scopeSelect.addEventListener("change", event => {
		state.scope = event.target.value;
		renderOverview();
	});
	elements.railInstall.addEventListener("click", requestInstall);
	elements.settingsInstall.addEventListener("click", requestInstall);
	window.addEventListener("beforeinstallprompt", event => {
		event.preventDefault();
		state.deferredInstallPrompt = event;
		updateInstallUi();
	});
	window.addEventListener("appinstalled", () => {
		state.deferredInstallPrompt = null;
		showToast("shuvquota is installed.");
		updateInstallUi();
	});
	window.addEventListener("offline", () => {
		state.isOffline = true;
		state.stale = Boolean(state.snapshot);
		updateScanUi();
		renderOverview();
	});
	window.addEventListener("online", () => {
		state.isOffline = false;
		updateScanUi();
		refreshQuota();
	});
	document.addEventListener("visibilitychange", () => {
		if (!document.hidden && Date.now() >= state.nextRefreshAt && navigator.onLine) refreshQuota();
	});
}

async function registerServiceWorker() {
	if (!("serviceWorker" in navigator)) return;
	try {
		await navigator.serviceWorker.register("/sw.js", { scope: "/" });
	} catch {
		showToast("Offline shell setup is unavailable in this browser.");
	}
}

function initialize() {
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	elements.timezoneCopy.textContent = timezone
		? `All times use ${timezone}`
		: "All times use your local timezone";
	initializeNavigation();
	initializeEvents();
	updateInstallUi();
	updateScanUi();
	updateCountdown();
	window.setInterval(updateCountdown, 1000);
	registerServiceWorker();
	refreshQuota();
}

initialize();
