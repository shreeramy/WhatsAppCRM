// Service worker for Web Push — shows "new message" alerts even when the
// CRM tab is in the background or closed (and on Android / installed iOS
// apps, as a system notification from the top of the screen).
//
// Payload (JSON, sent by src/lib/push/send.ts): { title, body, url, tag }

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  const title = data.title || 'New message'
  const url = data.url || '/inbox'

  event.waitUntil(
    (async () => {
      // Skip when the user is already looking at this exact chat.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const viewing = windows.some((c) => {
        if (c.visibilityState !== 'visible' || !c.focused) return false
        try {
          const u = new URL(c.url)
          return u.pathname + u.search === url
        } catch {
          return false
        }
      })
      if (viewing) return

      await self.registration.showNotification(title, {
        body: data.body || '',
        tag: data.tag,
        renotify: Boolean(data.tag),
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { url },
      })
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/inbox'
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const c of windows) {
        if (new URL(c.url).origin === self.location.origin) {
          await c.focus()
          if ('navigate' in c) await c.navigate(url)
          return
        }
      }
      await self.clients.openWindow(url)
    })(),
  )
})
