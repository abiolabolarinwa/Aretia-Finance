/* Aretia alerts: shows a notification when the site's push arrives, even with the wallet closed.
 *
 * The push itself carries no text. This worker asks the site for the messages waiting for this browser (the channel
 * number and secret come in this script's address) and shows each one. Clicking a notification opens the wallet at
 * the page it names. Nothing here can see a key or move funds. */
const params = new URL(self.location.href).searchParams;
const channel = params.get('c');
const secret = params.get('s');

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

async function waiting() {
  if (!channel || !secret) return [];
  try {
    const res = await fetch(`/api/swings-notify?inbox=${encodeURIComponent(channel)}&s=${encodeURIComponent(secret)}`, { cache: 'no-store' });
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body.messages) ? body.messages : [];
  } catch {
    return [];
  }
}

/** A same-origin path for a notification to open, or '/wallet'. "//evil.example" and "/\\evil.example" resolve to another origin and are refused. */
function sameOriginPath(u) {
  if (typeof u !== 'string' || u.length > 500) return '/wallet';
  try {
    const parsed = new URL(u, self.location.origin);
    return parsed.origin === self.location.origin ? parsed.pathname + parsed.search + parsed.hash : '/wallet';
  } catch {
    return '/wallet';
  }
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      const messages = await waiting();
      // A push always shows something: browsers (iPhone especially) withdraw permission from sites that stay silent.
      if (messages.length === 0) messages.push({ title: 'Aretia alert', body: 'Open Aretia to see what moved.', url: '/wallet#/favourites' });
      for (const m of messages.slice(0, 6)) {
        const url = sameOriginPath(m.url);
        await self.registration.showNotification(String(m.title || 'Aretia alert').slice(0, 120), { body: String(m.body || '').slice(0, 300), icon: '/assets/logo-mark.png', badge: '/assets/logo-mark.png', tag: `aretia-${url}-${String(m.title).slice(0, 40)}`, data: { url } });
      }
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = sameOriginPath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
          await c.focus();
          if ('navigate' in c) await c.navigate(url).catch(() => undefined);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
