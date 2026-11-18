const CACHE = "mi-drive-v1";
const SHELL = ["./", "index.html", "app.js", "manifest.webmanifest", "icon.svg"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", e => {
  const u = e.request.url;
  if (e.request.method !== "GET" || u.includes("googleapis.com") || u.includes("accounts.google.com")) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
