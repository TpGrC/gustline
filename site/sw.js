// Windrova service worker: makes the site installable and opens instantly.
// Pages are network-first (always fresh); icons are cached; forecast data is never cached here.
const C = 'windrova-v8', SHELL = ['/', '/index.html', '/logo.svg', '/icon-192.png', '/manifest.webmanifest'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/data/')) return;
  const req = e.request.mode === 'navigate' || SHELL.includes(u.pathname) ? new Request(e.request, { cache: 'no-cache' }) : e.request;
  e.respondWith(fetch(req).then(r => { if (r.ok && SHELL.includes(u.pathname)) { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)); } return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('/'))));
});
