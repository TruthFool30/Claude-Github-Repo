// Minimal service worker: makes Hearth installable and keeps the app shell available offline.
// API calls and uploads always go to the network.
const CACHE = 'hearth-shell-v1';
const SHELL = ['/', '/favicon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;
  if (request.mode === 'navigate') {
    // Network first for pages, fall back to the cached shell when offline.
    event.respondWith(fetch(request).catch(() => caches.match('/')));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    // Hashed build assets: cache first.
    event.respondWith(
      caches.match(request).then(
        (hit) => hit || fetch(request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
          return res;
        }),
      ),
    );
  }
});
