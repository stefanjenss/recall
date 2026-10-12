// Recall service worker: lets the app load and run without a network
// connection after the first visit.
//
// This file is a template. The build (vite.config.ts, `recallServiceWorker`)
// replaces __RECALL_VERSION__ and __RECALL_PRECACHE__ and writes it to
// dist/sw.js. It is never bundled into the app.
//
// Strategy: every build output is precached at install time under a
// versioned cache, then served cache-first. A new deploy produces a new
// version; the new worker installs in the background and waits until the
// learner chooses to reload (the app shows a prompt), so a study session is
// never swapped out from under them. Card data lives in IndexedDB and is
// never touched here.
//
// The worker answers only navigations and requests for this build's own
// files. Everything else, including the sync server's API under `api/` and
// any other origin, goes to the network untouched and is never cached.

const VERSION = '__RECALL_VERSION__';
const PRECACHE = __RECALL_PRECACHE__;
const CACHE = `recall-${VERSION}`;
const SCOPE = self.registration.scope;
const INDEX = new URL('./index.html', SCOPE).href;
const PRECACHED = new Set(PRECACHE.map((path) => new URL(path, SCOPE).href));
// The sync client calls `api/` next to the app; the server itself always
// serves it from `/api/`. Both are the same when the app is at the root.
const API_PATHS = [new URL('./api/', SCOPE).pathname, '/api/'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // `cache: 'reload'` bypasses the HTTP cache so a new version never
      // stores a stale copy of index.html from a previous deploy.
      cache.addAll(PRECACHE.map((path) => new Request(new URL(path, self.registration.scope), { cache: 'reload' }))),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith('recall-') && key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (API_PATHS.some((path) => url.pathname.startsWith(path))) return;

  if (request.mode === 'navigate') {
    // Hash routing means every page is index.html.
    event.respondWith(fromCache(INDEX).then((cached) => cached || fetch(request)));
    return;
  }
  if (!PRECACHED.has(url.origin + url.pathname)) return;
  event.respondWith(fromCache(request).then((cached) => cached || fetch(request)));
});

async function fromCache(request) {
  const cache = await caches.open(CACHE);
  // Every cached file belongs to this exact build, so request headers can't
  // change what it should return. Ignoring Vary matters: some servers send
  // `Vary: Origin`, and module scripts are requested with an Origin header
  // that the precache requests didn't have.
  return cache.match(request, { ignoreSearch: true, ignoreVary: true });
}
