// SMSPin service worker — installable PWA with an offline app shell.
// Strategy: network-first for navigations (always fresh content when online,
// cached shell when offline); stale-while-revalidate for static assets.
// API and auth traffic is never cached so balances/codes are always live.
const VERSION = "smspin-v1";
const SHELL = ["/", "/offline/", "/manifest.json", "/favicon.svg", "/ui.js", "/help.js", "/help.css"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isStatic(url) {
  return /\.(?:css|js|woff2?|svg|png|jpe?g|webp|ico)$/.test(url.pathname);
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never cache API, auth, admin or dashboard data — it must stay live.
  if (/^\/(api|auth|admin)\//.test(url.pathname)) return;

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match("/offline/")))
    );
    return;
  }

  if (isStatic(url)) {
    e.respondWith(
      caches.match(req).then(cached => {
        const network = fetch(req).then(res => {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});

// Push (E11): show a notification when the server pushes one.
self.addEventListener("push", e => {
  let data = { title: "SMSPin", body: "You have a new update." };
  try { if (e.data) data = Object.assign(data, e.data.json()); } catch (err) {}
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: "/favicon.svg",
    badge: "/favicon.svg",
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window" }).then(cs => {
    for (const c of cs) { if (c.url && "focus" in c) return c.focus(); }
    return self.clients.openWindow("/dashboard/");
  }));
});
