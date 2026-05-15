/**
 * Mischess Service Worker
 *
 * Strategy:
 *  - Network-first for HTML and app bundles (always pick up deploys quickly)
 *  - Cache only as offline fallback
 *  - New versions activate immediately (skipWaiting + clients.claim)
 *
 * Bump VERSION on each deploy so old caches are purged.
 */

const VERSION = 'v9';
const STATIC_CACHE = `mischess-static-${VERSION}`;
const HTML_CACHE = `mischess-html-${VERSION}`;

const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => cache.addAll(PRECACHE)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => k.startsWith('mischess-') && !k.endsWith(VERSION))
        .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/ws')) return;

  const isHtml = req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html');
  const isAppAsset =
    url.pathname.startsWith('/css/') ||
    url.pathname.startsWith('/js/') ||
    url.pathname.startsWith('/img/') ||
    url.pathname === '/manifest.webmanifest';

  if (isHtml || isAppAsset) {
    event.respondWith(networkFirst(req, isHtml ? HTML_CACHE : STATIC_CACHE));
  }
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
    return fresh;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    if (req.mode === 'navigate') return caches.match('/') || new Response('Offline', { status: 503 });
    return new Response('', { status: 404 });
  }
}
