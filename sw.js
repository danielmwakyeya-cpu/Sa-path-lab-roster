// Minimal service worker — required by browsers for "Add to Home Screen" installability.
// Deliberately does no caching: this app relies on live Firebase data,
// so we never want a stale cached response served instead of a fresh network request.
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  // Pass every request straight through to the network.
});
