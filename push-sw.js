// Web Push service worker: shows مُجتمعي notifications (new orders, …)
// even when the app is closed, and opens the app when one is tapped.
//
// Also the app's root service worker for "install the app" (registered on
// Android phones by index.html / the app): Chrome's automatic install
// prompt (beforeinstallprompt → «نزّله») wants a worker with a fetch
// handler. It only touches page navigations — straight to the network
// (with navigation preload, so no added delay) and a small offline page
// when there's no connection; every other request is left alone.
// «المحفّظ»'s own worker (/tutor/sw.js, scope /tutor/) still controls
// /tutor/ — the narrower scope wins.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  if (self.registration.navigationPreload) {
    try { await self.registration.navigationPreload.enable(); } catch (e) {}
  }
  await self.clients.claim();
})()));

const OFFLINE_HTML = '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1"><title>مفيش نت</title></head>' +
  '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0B1530;color:#fff;font-family:system-ui,sans-serif;text-align:center">' +
  '<div><p style="font-size:20px;font-weight:800">مفيش اتصال بالإنترنت</p><p style="opacity:.75">اتأكد من النت وجرّب تاني.</p>' +
  '<button onclick="location.reload()" style="border:0;border-radius:12px;padding:12px 22px;background:#F2B661;color:#0B1530;font-weight:800;font-size:15px">جرّب تاني</button></div></body></html>';

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith((async () => {
    try {
      const preloaded = await event.preloadResponse;
      if (preloaded) return preloaded;
      return await fetch(event.request);
    } catch (e) {
      return new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
  })());
});

// iOS (home-screen app, 16.4+) and Chrome require a visible notification
// for every push — a push that shows nothing gets the subscription revoked.
// Web Push can't play our own sound while the app is closed: the phone
// plays its notification sound; tapping a prayer notification opens the
// app, which plays the chosen adhan (?adhan=<prayer>).
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: event.data && event.data.text() }; }
  const title = data.title || 'مُجتمعي';
  const url = data.url || '/';
  // The app's links keep their query in the #fragment (/#/masjid/tools/reminders?adhan=asr).
  const m = /[?&]adhan=([a-z]+)/.exec(url);
  const adhan = m ? m[1] : null;
  const opts = {
    body: data.body || '',
    icon: '/icons/Icon-192.png',
    badge: '/icons/Icon-192.png',
    dir: 'rtl',
    lang: 'ar',
    data: { url: url },
    vibrate: adhan ? [300, 120, 300, 120, 300] : [120, 60, 120],
  };
  if (adhan) {
    opts.tag = 'adhan-' + adhan;
    opts.renotify = true;
    opts.requireInteraction = true;
  }
  event.waitUntil(self.registration.showNotification(title, opts).catch(() =>
    self.registration.showNotification(title, { body: opts.body, data: opts.data })));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (!c.url.startsWith(self.location.origin)) continue;
      try {
        await c.focus();
        // Only a client this worker controls can be navigated.
        if (c.navigate) { await c.navigate(url); return; }
      } catch (e) {}
      try { c.postMessage({ type: 'm3-open', url: url }); return; } catch (e) {}
    }
    return self.clients.openWindow(url);
  })());
});
