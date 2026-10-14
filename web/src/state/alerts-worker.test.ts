import { describe, expect, it, vi } from 'vitest';
// web/public/sw.js (served at /sw.js): run it against a fake ServiceWorkerGlobalScope.
import source from '../../public/sw.js?raw';

type Handler = (event: unknown) => void;

function loadWorker(tabs: { focus: () => Promise<unknown> }[]) {
  const handlers = new Map<string, Handler>();
  const self = {
    addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
    skipWaiting: vi.fn(async () => undefined),
    clients: {
      matchAll: vi.fn(async () => tabs),
      openWindow: vi.fn(async () => null),
    },
  };
  new Function('self', source)(self);
  return { handlers, self };
}

async function click(handlers: Map<string, Handler>) {
  let done: Promise<unknown> = Promise.resolve();
  const notification = { close: vi.fn() };
  handlers.get('notificationclick')?.({ notification, waitUntil: (p: Promise<unknown>) => (done = p) });
  await done;
  return notification;
}

describe('alerts service worker (public/sw.js)', () => {
  it('only handles install and notification clicks: no fetch handler, nothing cached', () => {
    const { handlers, self } = loadWorker([]);
    expect([...handlers.keys()].sort()).toEqual(['install', 'notificationclick']);
    handlers.get('install')?.({});
    expect(self.skipWaiting).toHaveBeenCalled();
    expect(source).not.toMatch(/caches\.|addEventListener\(['"]fetch/);
  });

  it('a click closes the notification and focuses an open tab', async () => {
    const hidden = {
      focus: vi.fn(async () => {
        throw new Error('InvalidAccessError');
      }),
    };
    const open = { focus: vi.fn(async () => undefined) };
    const { handlers, self } = loadWorker([hidden, open]);
    const notification = await click(handlers);
    expect(notification.close).toHaveBeenCalled();
    expect(self.clients.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
    expect(open.focus).toHaveBeenCalled();
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });

  it('opens the app when no tab is left', async () => {
    const { handlers, self } = loadWorker([]);
    await click(handlers);
    expect(self.clients.openWindow).toHaveBeenCalledWith('/');
  });
});
