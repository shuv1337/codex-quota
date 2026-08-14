const CACHE_VERSION = "v13";
const SHELL_CACHE = `shuvquota-shell-${CACHE_VERSION}`;
const STATIC_CACHE = `shuvquota-static-${CACHE_VERSION}`;

const SHELL_URLS = [
	"/index.html",
	"/app.js?v=13",
	"/quota-risk.js?v=13",
	"/styles.css?v=13",
	"/manifest.webmanifest",
	"/fonts/barlow-condensed-500.woff2",
	"/fonts/barlow-condensed-600.woff2",
	"/fonts/barlow-condensed-700.woff2",
	"/fonts/ibm-plex-mono-400.woff2",
	"/fonts/ibm-plex-mono-500.woff2",
	"/fonts/inter-400.woff2",
	"/fonts/inter-500.woff2",
	"/fonts/inter-600.woff2",
	"/icons/devil-phone.svg",
	"/icons/favicon.ico",
	"/icons/icon-180.png",
	"/icons/icon-192.png",
	"/icons/icon-512.png",
	"/icons/icon-maskable-512.png",
	"/icons/providers/openai.svg",
	"/icons/providers/anthropic.svg",
	"/icons/providers/xai.svg",
	"/icons/providers/synthetic.svg",
	"/icons/providers/antigravity.svg",
	"/icons/providers/opencode-go.svg",
	"/icons/ui/overview.svg",
	"/icons/ui/history.svg",
	"/icons/ui/settings.svg",
	"/icons/ui/refresh.svg",
	"/icons/ui/user.svg",
	"/icons/ui/download.svg",
	"/icons/ui/chevron-down.svg",
	"/icons/ui/clock.svg",
	"/icons/ui/offline.svg"
];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches.open(SHELL_CACHE)
			.then((cache) => cache.addAll(SHELL_URLS))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches.keys()
			.then((keys) => Promise.all(
				keys
					.filter((key) => key.startsWith("shuvquota-")
						&& key !== SHELL_CACHE
						&& key !== STATIC_CACHE)
					.map((key) => caches.delete(key))
			))
			.then(() => self.clients.claim())
	);
});

function isApiRequest(url) {
	return url.pathname === "/api" || url.pathname.startsWith("/api/");
}

async function networkFirstNavigation(request) {
	try {
		return await fetch(request);
	} catch {
		return (await caches.match("/index.html"))
			?? new Response("shuvquota is offline", {
				status: 503,
				headers: { "Content-Type": "text/plain; charset=utf-8" }
			});
	}
}

async function staleWhileRevalidate(request) {
	const cached = await caches.match(request);
	const refresh = fetch(request).then(async (response) => {
		if (response.ok) {
			const cache = await caches.open(STATIC_CACHE);
			await cache.put(request, response.clone());
		}
		return response;
	});

	if (cached) {
		refresh.catch(() => undefined);
		return cached;
	}

	try {
		return await refresh;
	} catch {
		return new Response("Asset unavailable while offline", {
			status: 503,
			headers: { "Content-Type": "text/plain; charset=utf-8" }
		});
	}
}

self.addEventListener("fetch", (event) => {
	const { request } = event;
	if (request.method !== "GET") return;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;

	if (isApiRequest(url)) {
		event.respondWith(fetch(request));
		return;
	}

	if (request.mode === "navigate") {
		event.respondWith(networkFirstNavigation(request));
		return;
	}

	const isStaticAsset = ["font", "image", "script", "style"].includes(request.destination)
		|| url.pathname.endsWith(".webmanifest");
	if (isStaticAsset) event.respondWith(staleWhileRevalidate(request));
});
