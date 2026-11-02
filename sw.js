// BLOXNOVA service worker: shows order notifications in the phone / desktop notification bar.
const ICON = '/assets/icons/icon-192.png'
const BADGE = '/assets/icons/badge-96.png'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

function show(data) {
  const kind = data.kind || 'info'
  return self.registration.showNotification(data.title || 'BLOXNOVA', {
    body: data.body || '',
    icon: ICON,
    badge: BADGE,
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    requireInteraction: kind === 'admin' || kind === 'done',
    vibrate: kind === 'rejected' ? [200, 80, 200] : [80, 40, 160],
    timestamp: Date.now(),
    data: { url: data.url || '/', kind },
    actions: kind === 'admin' ? [{ action: 'open', title: 'Buka Dashboard' }] : [{ action: 'open', title: 'Lihat Pesanan' }],
  })
}

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = { body: event.data?.text() } }
  event.waitUntil(
    show(data).then(() =>
      // Let open tabs refresh right away instead of waiting for the next poll.
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => tabs.forEach((t) => t.postMessage({ type: 'push', data }))),
    ),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
      const tab = tabs.find((t) => new URL(t.url).origin === self.location.origin)
      if (tab) return tab.focus().then(() => tab.postMessage({ type: 'open', url }))
      return self.clients.openWindow(url)
    }),
  )
})

// Lets the page show a notification-bar alert through the worker (required on Android).
self.addEventListener('message', (event) => {
  if (event.data?.type === 'notify') event.waitUntil(show(event.data.data || {}))
})
