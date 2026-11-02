// CommonCents service worker — cache app shell, network-first for API.
const SHELL = 'cc-shell-__BUILD_ID__';   // filled in by the server: a hash of the app shell
const ASSETS = ['/', '/index.html', '/app.js', '/industry.css', '/sw-register.js', '/manifest.json', '/icons/icon-180.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return; // never cache API
  e.respondWith(
    fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {});
      return r;
    }).catch(() => caches.match(e.request).then((m) => m || caches.match('/index.html')))
  );
});
