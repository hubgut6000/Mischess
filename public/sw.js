/**
 * Mischess Service Worker
 *
 * Strategy:
 *  - Network-first for HTML (always get the latest UI shell)
 *  - Stale-while-revalidate for static assets (CSS/JS/images)
 *  - When a new version is detected, the page is notified to prompt the user
 *
 * Update protocol:
 *  - sw.js itself is fetched with cache: 'no-store' by the browser when registering
 *  - When this file changes (we bump VERSION), the browser sees a new SW
 *  - The new SW installs in the background; clients are notified via postMessage
 */

const VERSION = 'v6';
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
  // Don't auto-skipWaiting — we want the user to control the upgrade
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

  // Only handle GET requests
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Don't intercept API requests, WebSocket, or cross-origin
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/ws')) return;

  // HTML requests: network-first, fall back to cache
  if (req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html')) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(HTML_CACHE);
        cache.put(req, fresh.clone()).catch(() => {});
        return fresh;
      } catch (e) {
        const cached = await caches.match(req);
        return cached || caches.match('/');
      }
    })());
    return;
  }

  // Static assets: stale-while-revalidate
  if (url.pathname.startsWith('/css/') ||
      url.pathname.startsWith('/js/') ||
      url.pathname.startsWith('/img/') ||
      url.pathname === '/manifest.webmanifest') {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      const cached = await cache.match(req);
      const networkPromise = fetch(req).then(res => {
        if (res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      }).catch(() => null);
      return cached || networkPromise || new Response('', { status: 404 });
    })());
    return;
  }
});
