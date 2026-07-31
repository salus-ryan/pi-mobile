const CACHE = "pi-mobile-v3";
const SHELL = [
  "/",
  "/styles.css?v=3",
  "/app.js?v=3",
  "/vendor/katex/katex.min.css?v=2",
  "/vendor/katex/katex.min.js?v=2",
  "/manifest.webmanifest",
  "/icon.svg",
];
self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL))));
self.addEventListener("activate", (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))));
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.pathname.startsWith("/api/") || url.pathname === "/events") return;
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put(event.request, copy)); return response;
  }).catch(() => caches.match(event.request)));
});
