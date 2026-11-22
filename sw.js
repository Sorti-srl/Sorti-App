// Sorti · Service worker per le notifiche push
// Mostra le notifiche anche a dashboard chiusa e, al tocco, apre il cestino.
// Non mette in cache la dashboard: gli aggiornamenti del sito restano immediati.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch (e) {
    d = { body: event.data ? event.data.text() : "" };
  }
  const title = d.title || "Sorti";
  const options = {
    body: d.body || "",
    icon: "assets/icon-192.png",
    badge: "assets/badge-96.png",
    tag: d.tag || undefined,
    renotify: !!d.tag,
    timestamp: Date.now(),
    data: { bin_id: d.bin_id || null, url: d.url || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const binId = event.notification.data && event.notification.data.bin_id;
  // Link costruito sull'indirizzo reale della dashboard (GitHub Pages, Cloudflare, ...)
  const target = new URL(binId ? `./?bin=${encodeURIComponent(binId)}` : "./", self.registration.scope).href;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of windows) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        if (binId) w.postMessage({ type: "sorti-open-bin", bin_id: binId });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
