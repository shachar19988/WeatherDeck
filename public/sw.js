const CACHE = 'weatherdeck-shell-v2';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg'];

// addAll() rejects the whole install if a single entry is missing, so each
// shell file is added on its own.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.all(SHELL.map(url => cache.add(url).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Forecast APIs live on other origins. Caching them here would serve stale
  // weather behind the app's own offline handling, so they are left alone.
  if (url.origin !== self.location.origin) return;

  // Navigations: fresh document when possible, cached shell when not.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put('/index.html', copy)).catch(() => undefined);
          return response;
        })
        .catch(() => caches.match('/index.html').then(hit => hit || caches.match('/'))),
    );
    return;
  }

  // Build output is content-hashed, so a hit is always valid.
  event.respondWith(
    caches.match(request).then(hit => hit || fetch(request).then(response => {
      if (response.ok && response.type === 'basic') {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => undefined);
      }
      return response;
    })),
  );
});
