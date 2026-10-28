'use strict';
const SHELL = 'bunker-shell-v2';
const FILES = ['/', '/style.css', '/app.js', '/manifest.webmanifest', '/theme.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first for the app shell, so updates show up; cache only as offline fallback. Never cache the API.
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {}); }
    return r;
  }).catch(() => caches.match(e.request)));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch (x) { d = { title: 'bunker', body: 'New activity' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'bunker', {
    body: d.body || 'New activity',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: d.url || '#/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '#/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    if (cs.length) { cs[0].postMessage({ url }); return cs[0].focus(); }
    return self.clients.openWindow('/' + url);
  }));
});
