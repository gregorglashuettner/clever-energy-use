self.addEventListener('push', (event) => {
  const payload = event.data ? event.data.json() : {};
  if (!payload.body) return;

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Update', {
      body: payload.body,
      data: payload.data || {},
      vibrate: [100, 50, 100]
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = new URL('./', self.location.href).href;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
      return undefined;
    })
  );
});
