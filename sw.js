/* Service worker: saves a copy of the app files on the phone so it
   opens instantly and works with no internet connection.

   IMPORTANT: after you edit any file, bump the version number below
   (v1 -> v2). That's what tells the phone to fetch the new code. */

const CACHE = 'budget-v17';

const FILES = [
  '.',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png'
];

// Runs once when a new version is installed: download and store the files.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache =>
      // {cache: 'reload'} forces a fresh trip to the network for each
      // file. Without it the browser can hand back its own cached copy
      // and a new version would install stale code.
      cache.addAll(FILES.map(file => new Request(file, { cache: 'reload' })))
    )
  );
  self.skipWaiting(); // don't wait for old tabs to close
});

// Runs after install: throw away caches from older versions.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Every request: serve the saved copy if we have one, otherwise go online.
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  // Only handle our own files. Anything on another domain is left alone.
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then(hit => {
      if (hit) return hit;

      return fetch(request).catch(() => {
        // Offline and not in the cache. If this was the browser trying to
        // open a page — say you launched the app with a ?something on the
        // end, which does not match the cached address exactly — hand back
        // the app itself rather than an error page.
        if (request.mode === 'navigate') {
          return caches.match('index.html');
        }
        // Anything else genuinely is not available offline.
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    })
  );
});
