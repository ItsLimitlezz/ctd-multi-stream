import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALERT_PREFS_KEY,
  ALERT_WORKER_URL,
  alertForNotice,
  alertPattern,
  enableAlerts,
  getAlertPrefs,
  notificationHint,
  notificationStatus,
  notificationsNeedWorker,
  parseAlertPrefs,
  readAlertPrefs,
  reloadAlertPrefs,
  requestNotificationPermission,
  schedulePattern,
  setAlertPrefs,
  showAlertNotification,
  soundForLevel,
  startAlertWorker,
  subscribeAlertPrefs,
  subscribeNotificationStatus,
  testAlert,
  writeAlertPrefs,
  type AlertEnv,
  type AlertOutputs,
  type AudioOut,
  type NotificationCtor,
  type StorageLike,
} from './alerts';

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

const throwingStorage: StorageLike = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

afterEach(() => {
  reloadAlertPrefs(new MemoryStorage());
});

describe('alert preference storage', () => {
  it('parses stored JSON defensively (off by default)', () => {
    expect(parseAlertPrefs(null)).toEqual({ enabled: false, speak: false });
    expect(parseAlertPrefs('{"enabled":true}')).toEqual({ enabled: true, speak: false });
    expect(parseAlertPrefs('{"enabled":"yes","speak":true}')).toEqual({ enabled: false, speak: true });
    expect(parseAlertPrefs('not json')).toEqual({ enabled: false, speak: false });
    expect(parseAlertPrefs('[true]')).toEqual({ enabled: false, speak: false });
    expect(parseAlertPrefs('null')).toEqual({ enabled: false, speak: false });
  });

  it('round-trips through storage under one key', () => {
    const s = new MemoryStorage();
    expect(writeAlertPrefs({ enabled: true, speak: false }, s)).toBe(true);
    expect([...s.data.keys()]).toEqual([ALERT_PREFS_KEY]);
    expect(readAlertPrefs(s)).toEqual({ enabled: true, speak: false });
  });

  it('survives storage that throws or is missing', () => {
    expect(readAlertPrefs(throwingStorage)).toEqual({ enabled: false, speak: false });
    expect(writeAlertPrefs({ enabled: true, speak: true }, throwingStorage)).toBe(false);
    expect(readAlertPrefs(null)).toEqual({ enabled: false, speak: false });
    expect(writeAlertPrefs({ enabled: true, speak: true }, null)).toBe(false);
  });

  it('keeps the setting in memory and notifies subscribers, even when it cannot be saved', () => {
    const s = new MemoryStorage();
    reloadAlertPrefs(s);
    const seen: boolean[] = [];
    const off = subscribeAlertPrefs(() => seen.push(getAlertPrefs().enabled));
    setAlertPrefs({ enabled: true }, s);
    expect(readAlertPrefs(s).enabled).toBe(true);
    setAlertPrefs({ speak: true }, throwingStorage);
    expect(getAlertPrefs()).toEqual({ enabled: true, speak: true });
    off();
    setAlertPrefs({ enabled: false }, s);
    expect(seen).toEqual([true, true]);
    expect(reloadAlertPrefs(s)).toEqual({ enabled: false, speak: true });
  });
});

const fakeNotification = (permission: NotificationPermission, answer: NotificationPermission = permission) => {
  const created: { title: string; options?: NotificationOptions }[] = [];
  class FakeNotification {
    static permission = permission;
    static requestPermission = vi.fn(async () => {
      FakeNotification.permission = answer;
      return answer;
    });
    onclick: ((this: never, ev: Event) => unknown) | null = null;
    constructor(title: string, options?: NotificationOptions) {
      created.push({ title, options });
    }
    close(): void {}
  }
  return { Ctor: FakeNotification as unknown as NotificationCtor & { requestPermission: ReturnType<typeof vi.fn> }, created };
};

describe('browser notifications', () => {
  it('reports why notifications are unavailable', () => {
    expect(notificationStatus({})).toBe('unsupported');
    expect(notificationStatus({ isSecureContext: false, Notification: fakeNotification('default').Ctor })).toBe('insecure');
    expect(notificationStatus({ isSecureContext: true, Notification: fakeNotification('denied').Ctor })).toBe('denied');
    expect(notificationStatus({ isSecureContext: true, Notification: fakeNotification('granted').Ctor })).toBe('granted');
    expect(notificationHint('granted')).toBeNull();
    expect(notificationHint('insecure')).toMatch(/HTTPS.*localhost/);
    expect(notificationHint('denied')).toMatch(/blocked/);
    expect(notificationHint('unsupported')).toMatch(/doesn't support/);
  });

  it('asks for permission only when undecided', async () => {
    const undecided = fakeNotification('default', 'granted');
    expect(await requestNotificationPermission({ isSecureContext: true, Notification: undecided.Ctor })).toBe('granted');
    expect(undecided.Ctor.requestPermission).toHaveBeenCalledTimes(1);

    const blocked = fakeNotification('denied');
    expect(await requestNotificationPermission({ isSecureContext: true, Notification: blocked.Ctor })).toBe('denied');
    expect(blocked.Ctor.requestPermission).not.toHaveBeenCalled();

    const insecure = fakeNotification('default');
    expect(await requestNotificationPermission({ isSecureContext: false, Notification: insecure.Ctor })).toBe('insecure');
    expect(insecure.Ctor.requestPermission).not.toHaveBeenCalled();
  });

  it('shows a notification with the notice text when allowed', () => {
    const { Ctor, created } = fakeNotification('granted');
    const env: AlertEnv = { isSecureContext: true, Notification: Ctor };
    expect(showAlertNotification('warn', 'Instagram ended the live (copyright). Starting a new one…', env)).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]?.title).toMatch(/^Stream alert/);
    expect(created[0]?.options?.body).toBe('Instagram ended the live (copyright). Starting a new one…');
    expect(created[0]?.options?.icon).toBe('/favicon.svg');
    // Same notice in several tabs -> same tag (one notification).
    showAlertNotification('warn', 'Instagram ended the live (copyright). Starting a new one…', env);
    expect(created[1]?.options?.tag).toBe(created[0]?.options?.tag);
    showAlertNotification('error', 'gave up', env);
    expect(created[2]?.options?.requireInteraction).toBe(true);
    expect(created[2]?.title).toMatch(/^Stream needs attention/);

    expect(showAlertNotification('warn', 'x', { isSecureContext: true, Notification: fakeNotification('default').Ctor })).toBe(false);
  });
});

/** Like Android Chrome: permission can be granted, but `new Notification()` throws. */
const illegalCtor = (error: Error = new TypeError('Illegal constructor')) => {
  let attempts = 0;
  const Ctor = class {
    static permission: NotificationPermission = 'granted';
    static requestPermission = vi.fn(async () => 'granted' as const);
    constructor() {
      attempts++;
      throw error;
    }
  } as unknown as NotificationCtor & { requestPermission: ReturnType<typeof vi.fn> };
  return { Ctor, attempts: () => attempts };
};

const fakeWorker = (result: Promise<void> = Promise.resolve()) => {
  const shown: { title: string; options?: NotificationOptions }[] = [];
  return {
    shown,
    worker: {
      showNotification: vi.fn((title: string, options?: NotificationOptions) => {
        shown.push({ title, options });
        return result;
      }),
    },
  };
};

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

describe('browsers that only show notifications from a service worker (Android)', () => {
  it('detects them without creating a notification', () => {
    expect(notificationsNeedWorker({ userAgent: ANDROID_UA })).toBe(true);
    expect(notificationsNeedWorker({ userAgent: DESKTOP_UA, userAgentData: { mobile: true } })).toBe(true);
    expect(notificationsNeedWorker({ userAgent: DESKTOP_UA, userAgentData: { mobile: false } })).toBe(false);
    expect(notificationsNeedWorker(undefined)).toBe(false);
  });

  it('reports pop-ups as unavailable (sound only) until the service worker runs', () => {
    const granted = fakeNotification('granted');
    const android: AlertEnv = { isSecureContext: true, Notification: granted.Ctor, workerOnly: true };
    expect(notificationStatus(android)).toBe('unavailable');
    expect(notificationStatus({ ...android, Notification: fakeNotification('denied').Ctor })).toBe('unavailable');
    expect(notificationHint('unavailable')).toMatch(/sound still plays/);
    expect(notificationHint('unavailable')).toMatch(/keep this tab open/);
    expect(showAlertNotification('warn', 'x', android)).toBe(false);
    expect(granted.created).toHaveLength(0);

    const { worker } = fakeWorker();
    expect(notificationStatus({ ...android, worker })).toBe('granted');
    expect(notificationStatus({ ...android, worker, Notification: fakeNotification('default').Ctor })).toBe('default');
    expect(notificationStatus({ ...android, worker, Notification: fakeNotification('denied').Ctor })).toBe('denied');
  });

  it('a constructor that throws "Illegal constructor" flips the status to unavailable', () => {
    const { Ctor, attempts } = illegalCtor();
    const env: AlertEnv = { isSecureContext: true, Notification: Ctor };
    expect(notificationStatus(env)).toBe('granted');
    const changes = vi.fn();
    const off = subscribeNotificationStatus(changes);
    expect(showAlertNotification('warn', 'Instagram ended the live', env)).toBe(false);
    off();
    expect(changes).toHaveBeenCalledTimes(1);
    expect(notificationStatus(env)).toBe('unavailable');
    expect(notificationHint(notificationStatus(env))).toMatch(/sound still plays/);
    // Not retried: the browser already said no.
    expect(showAlertNotification('warn', 'again', env)).toBe(false);
    expect(attempts()).toBe(1);
    // A worker that starts later still shows them.
    const { worker, shown } = fakeWorker();
    expect(notificationStatus({ ...env, worker })).toBe('granted');
    expect(showAlertNotification('warn', 'back', { ...env, worker })).toBe(true);
    expect(shown).toHaveLength(1);
  });

  it('other constructor errors are not treated as a refusal', () => {
    const { Ctor } = illegalCtor(new Error('quota'));
    const env: AlertEnv = { isSecureContext: true, Notification: Ctor };
    expect(showAlertNotification('warn', 'x', env)).toBe(false);
    expect(notificationStatus(env)).toBe('granted');
  });

  it('shows notifications through the service worker when it runs', () => {
    const { Ctor, created } = fakeNotification('granted');
    const { worker, shown } = fakeWorker();
    const env: AlertEnv = { isSecureContext: true, Notification: Ctor, worker, workerOnly: true };
    expect(showAlertNotification('error', 'Instagram: gave up after 3 attempts', env)).toBe(true);
    expect(created).toHaveLength(0);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toMatch(/^Stream needs attention/);
    expect(shown[0]?.options).toMatchObject({ body: 'Instagram: gave up after 3 attempts', icon: '/favicon.svg', requireInteraction: true });
    expect(shown[0]?.options?.tag).toMatch(/^ctd-error-/);
  });

  it('falls back to the constructor when the worker refuses', async () => {
    const { Ctor, created } = fakeNotification('granted');
    const { worker } = fakeWorker(Promise.reject(new TypeError('No active registration')));
    expect(showAlertNotification('warn', 'x', { isSecureContext: true, Notification: Ctor, worker })).toBe(true);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]?.options?.body).toBe('x');
  });

  it("doesn't ask for a permission that couldn't be used; asks once the worker runs", async () => {
    const undecided = fakeNotification('default', 'granted');
    const android: AlertEnv = { isSecureContext: true, Notification: undecided.Ctor, workerOnly: true };
    expect(await requestNotificationPermission(android)).toBe('unavailable');
    expect(undecided.Ctor.requestPermission).not.toHaveBeenCalled();

    const changes = vi.fn();
    const off = subscribeNotificationStatus(changes);
    expect(await requestNotificationPermission({ ...android, worker: fakeWorker().worker })).toBe('granted');
    off();
    expect(undecided.Ctor.requestPermission).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('enabling alerts there reports sound only', async () => {
    const n = fakeNotification('default', 'granted');
    const status = await enableAlerts({ isSecureContext: true, Notification: n.Ctor, workerOnly: true }, { play: () => true });
    expect(status).toBe('unavailable');
    expect(getAlertPrefs().enabled).toBe(true);
  });

  it('registers the notifications-only worker and resolves once it is active', async () => {
    const { worker } = fakeWorker();
    const register = vi.fn(async () => ({}));
    expect(await startAlertWorker({ register, ready: Promise.resolve(worker) })).toBe(worker);
    expect(register).toHaveBeenCalledWith(ALERT_WORKER_URL);
    expect(ALERT_WORKER_URL).toBe('/sw.js');

    // e.g. a self-signed certificate: Chrome refuses the registration.
    const refused = vi.fn(async () => {
      throw new DOMException('An SSL certificate error occurred', 'SecurityError');
    });
    expect(await startAlertWorker({ register: refused, ready: new Promise(() => undefined) })).toBeNull();
    expect(await startAlertWorker(undefined)).toBeNull();
  });
});

describe('alert sounds', () => {
  it('uses an alarm for warn/error and a gentle chime for info', () => {
    expect(soundForLevel('warn')).toBe('alarm');
    expect(soundForLevel('error')).toBe('alarm');
    expect(soundForLevel('info')).toBe('gentle');
    const alarm = alertPattern('alarm');
    const gentle = alertPattern('gentle');
    expect(alarm.length).toBeGreaterThan(gentle.length);
    for (const s of [...alarm, ...gentle]) {
      expect(s.gain).toBeGreaterThan(0);
      expect(s.gain).toBeLessThanOrEqual(0.3);
      expect(s.dur).toBeGreaterThan(0);
    }
    const end = (steps: typeof alarm) => Math.max(...steps.map((s) => s.at + s.dur));
    expect(end(alarm)).toBeLessThan(2);
    expect(end(gentle)).toBeLessThan(1.5);
    expect(gentle.every((s) => s.type === 'sine')).toBe(true);
  });

  it('schedules one oscillator per note with click-free envelopes', () => {
    const started: number[] = [];
    const ramps: number[] = [];
    const param = () => ({
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn((v: number) => ramps.push(v)),
    });
    const ctx = {
      currentTime: 10,
      destination: {},
      createOscillator: () => ({
        type: 'sine',
        frequency: param(),
        connect: vi.fn(),
        start: (t: number) => started.push(t),
        stop: vi.fn(),
      }),
      createGain: () => ({ gain: param(), connect: vi.fn() }),
    } as unknown as AudioOut;
    const steps = alertPattern('alarm');
    schedulePattern(ctx, steps);
    expect(started).toHaveLength(steps.length);
    expect(Math.min(...started)).toBeGreaterThanOrEqual(10);
    expect(ramps.filter((v) => v === 0.0001)).toHaveLength(steps.length);
  });
});

describe('alerts for notices', () => {
  const outputs = () => {
    const calls: string[] = [];
    const out: AlertOutputs = {
      play: (s) => (calls.push(`play:${s}`), true),
      notify: (level, msg) => (calls.push(`notify:${level}:${msg}`), true),
      speak: (msg) => (calls.push(`speak:${msg}`), true),
    };
    return { calls, out };
  };

  it('does nothing while alerts are off', () => {
    const { calls, out } = outputs();
    expect(alertForNotice('warn', 'taken down', { enabled: false, speak: true }, out)).toEqual({ sound: null, notified: false, spoke: false });
    expect(calls).toEqual([]);
  });

  it('takedown (warn) -> alarm + notification; back up (info) -> chime + notification', () => {
    const { calls, out } = outputs();
    expect(alertForNotice('warn', 'Instagram ended the live', { enabled: true, speak: false }, out)).toEqual({
      sound: 'alarm',
      notified: true,
      spoke: false,
    });
    alertForNotice('info', 'Instagram is live again (recovery #1)', { enabled: true, speak: true }, out);
    expect(calls).toEqual([
      'play:alarm',
      'notify:warn:Instagram ended the live',
      'play:gentle',
      'notify:info:Instagram is live again (recovery #1)',
      'speak:Instagram is live again (recovery #1)',
    ]);
  });

  it('reports a sound that could not play', () => {
    expect(alertForNotice('error', 'x', { enabled: true, speak: false }, { play: () => false, notify: () => false, speak: () => false })).toEqual({
      sound: null,
      notified: false,
      spoke: false,
    });
  });

  it('enabling saves the setting, plays a chime and asks for notification permission', async () => {
    const played: string[] = [];
    const n = fakeNotification('default', 'granted');
    const status = await enableAlerts({ isSecureContext: true, Notification: n.Ctor }, { play: (s) => (played.push(s), true) });
    expect(status).toBe('granted');
    expect(getAlertPrefs().enabled).toBe(true);
    expect(played).toEqual(['gentle']);
    expect(n.Ctor.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('the test alert plays even while alerts are off', () => {
    const { calls, out } = outputs();
    reloadAlertPrefs(new MemoryStorage());
    expect(testAlert(out).sound).toBe('alarm');
    expect(calls[0]).toBe('play:alarm');
    expect(getAlertPrefs().enabled).toBe(false);
  });
});
