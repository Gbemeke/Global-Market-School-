// Global Market School — minimal service worker
//
// Its only job is to satisfy the browser's "installable PWA" requirement
// (manifest + a registered service worker with a fetch handler). It does
// NOT cache pages, scripts, or data — every request passes straight
// through to the network. This site's own recent history is exactly why:
// a stale cached page silently hid real fixes from students for hours.
// A caching service worker is a foot-gun on a site like this until there
// is a deliberate, carefully-scoped offline strategy in place.

self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
  event.respondWith(fetch(event.request));
});
