const CACHE = 'kollektivtrafik-v4';
const STATIC = ['/', '/style.css', '/app.js', '/manifest.json', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // API-anrop: network only
  if (url.pathname.startsWith('/api/')) return;
  // Statiska filer: cache first
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
