// Offline support: app shell is cached; elevation tiles are cached as they are used.
const SHELL = 'ma-roim-shell-v1';
const TILES = 'ma-roim-tiles-v1';
const FILES = ['./', 'index.html', 'style.css', 'manifest.webmanifest', 'icon.svg',
  'js/app.js', 'js/geo.js', 'js/dem.js', 'js/data.js', 'js/orientation.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.hostname === 's3.amazonaws.com' && url.pathname.includes('/terrarium/')) {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin === location.origin && e.request.method === 'GET') {
    // network first, so updates show up; cache as fallback when offline
    e.respondWith(fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(SHELL).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request)));
  }
});
