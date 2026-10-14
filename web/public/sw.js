// CTD Multi-Stream service worker: alert notifications only (web/src/state/alerts.ts).
//
// Android browsers refuse `new Notification()` from a page; only a service worker's
// registration.showNotification() works there. There is deliberately no fetch handler: nothing is
// cached or intercepted, so the app loads exactly as it would without this worker.
// It doesn't make alerts reach a closed or frozen tab (that would need Web Push): the page still
// has to be open to receive the server's notices.

self.addEventListener('install', () => {
  // Replace an older copy right away; there's no cached state to migrate.
  self.skipWaiting();
});

// Clicking an alert brings the app's tab to the front (or opens it if it was closed).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const tab of tabs) {
        try {
          await tab.focus();
          return;
        } catch {
          // This one can't be focused: try the next.
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow('/');
    })(),
  );
});
