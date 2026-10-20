// Opt-in alerts for server notices (e.g. "Instagram ended the live (copyright)â€¦", "â€¦is live again"):
// a sound generated with the Web Audio API (no audio files, nothing external), a browser
// notification (through the notifications-only service worker web/public/sw.js when it runs,
// which Android requires) and, optionally, the message read aloud. The preference is per browser
// (localStorage); every storage access is guarded because it can throw or be unavailable.

import { useSyncExternalStore } from 'react';

export type NoticeLevel = 'info' | 'warn' | 'error';

export interface AlertPrefs {
  /** Sound + notification: an alarm for warn/error notices, a gentle chime for info ones. */
  enabled: boolean;
  /** Also read the notice aloud (speech synthesis). */
  speak: boolean;
}

export const ALERT_PREFS_KEY = 'ctd.alerts';
export const DEFAULT_ALERT_PREFS: Readonly<AlertPrefs> = Object.freeze({ enabled: false, speak: false });

// ---------------------------------------------------------------------------
// Preference storage
// ---------------------------------------------------------------------------

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** window.localStorage, or null when it's unavailable (tests, blocked site data, some private modes). */
function browserStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function parseAlertPrefs(raw: string | null | undefined): AlertPrefs {
  if (!raw) return { ...DEFAULT_ALERT_PREFS };
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ...DEFAULT_ALERT_PREFS };
    const o = v as Record<string, unknown>;
    return { enabled: o.enabled === true, speak: o.speak === true };
  } catch {
    return { ...DEFAULT_ALERT_PREFS };
  }
}

export function readAlertPrefs(storage: StorageLike | null = browserStorage()): AlertPrefs {
  try {
    return parseAlertPrefs(storage?.getItem(ALERT_PREFS_KEY));
  } catch {
    return { ...DEFAULT_ALERT_PREFS };
  }
}

/** False when the preference couldn't be saved (it still applies until the page is reloaded). */
export function writeAlertPrefs(prefs: AlertPrefs, storage: StorageLike | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(ALERT_PREFS_KEY, JSON.stringify({ enabled: prefs.enabled, speak: prefs.speak }));
    return true;
  } catch {
    return false;
  }
}

let current: AlertPrefs | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Current preferences (read from storage once, then kept in memory). */
export function getAlertPrefs(): AlertPrefs {
  current ??= readAlertPrefs();
  return current;
}

/** Re-read the stored preferences (e.g. after another tab changed them). */
export function reloadAlertPrefs(storage?: StorageLike | null): AlertPrefs {
  current = readAlertPrefs(storage);
  emit();
  return current;
}

export function setAlertPrefs(patch: Partial<AlertPrefs>, storage?: StorageLike | null): AlertPrefs {
  current = { ...getAlertPrefs(), ...patch };
  writeAlertPrefs(current, storage);
  emit();
  return current;
}

function onStorage(e: StorageEvent): void {
  if (e.key === ALERT_PREFS_KEY) {
    current = parseAlertPrefs(e.newValue);
    emit();
  }
}

// Follow changes made in other tabs while anything needs the preference (subscribers, installAlerts).
let storageUsers = 0;
function retainStorageSync(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  if (storageUsers++ === 0) window.addEventListener('storage', onStorage);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--storageUsers === 0) window.removeEventListener('storage', onStorage);
  };
}

export function subscribeAlertPrefs(listener: () => void): () => void {
  listeners.add(listener);
  const release = retainStorageSync();
  return () => {
    listeners.delete(listener);
    release();
  };
}

export function useAlertPrefs(): AlertPrefs {
  return useSyncExternalStore(subscribeAlertPrefs, getAlertPrefs, getAlertPrefs);
}

// ---------------------------------------------------------------------------
// Browser notifications
// ---------------------------------------------------------------------------

/**
 * Permission, or why notifications can't be used here. 'unavailable': the browser has the
 * Notification API but can't show pop-ups from this page. Android browsers only show them through
 * a service worker (`new Notification()` throws "Illegal constructor"), and ours can't run there,
 * e.g. on a self-signed certificate.
 */
export type NotificationStatus = NotificationPermission | 'unsupported' | 'insecure' | 'unavailable';

interface NotificationLike {
  onclick: ((this: never, ev: Event) => unknown) | null;
  close(): void;
}

export interface NotificationCtor {
  new (title: string, options?: NotificationOptions): NotificationLike;
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
}

/** The part of a ServiceWorkerRegistration the alerts use. */
export interface AlertWorker {
  showNotification(title: string, options?: NotificationOptions): Promise<void>;
}

/** The bits of `window` the alerts use (injectable for tests). */
export interface AlertEnv {
  isSecureContext?: boolean;
  Notification?: NotificationCtor;
  focus?: () => void;
  /** Active service-worker registration (public/sw.js) that shows notifications; none yet when absent. */
  worker?: AlertWorker | null;
  /** This browser can only show notifications through a service worker (Android). */
  workerOnly?: boolean;
}

/** URL of the notifications-only service worker (web/public/sw.js). */
export const ALERT_WORKER_URL = '/sw.js';

let alertWorker: AlertWorker | null = null;
/** Notification constructors that threw "Illegal constructor" here (checked per constructor so tests stay isolated). */
const blockedCtors = new WeakSet<object>();

const notificationListeners = new Set<() => void>();
function emitNotificationChange(): void {
  for (const l of notificationListeners) l();
}

/**
 * Android browsers (Chrome first) refuse `new Notification()` from a page: only a service worker can
 * show one. Detected without creating a notification; a desktop-mode user agent is still caught the
 * first time the constructor throws.
 */
export function notificationsNeedWorker(nav?: { userAgent?: string; userAgentData?: { mobile?: boolean } }): boolean {
  if (!nav) return false;
  return nav.userAgentData?.mobile === true || /Android/i.test(nav.userAgent ?? '');
}

function browserEnv(): AlertEnv {
  if (typeof window === 'undefined') return {};
  const w = window as unknown as { isSecureContext?: boolean; Notification?: NotificationCtor };
  return {
    isSecureContext: w.isSecureContext,
    Notification: w.Notification,
    focus: () => window.focus(),
    worker: alertWorker,
    workerOnly: typeof navigator !== 'undefined' && notificationsNeedWorker(navigator as Navigator & { userAgentData?: { mobile?: boolean } }),
  };
}

function canPopUp(env: AlertEnv, N: NotificationCtor): boolean {
  if (env.worker) return true;
  return !env.workerOnly && !blockedCtors.has(N);
}

function statusFor(permission: NotificationPermission, env: AlertEnv, N: NotificationCtor): NotificationStatus {
  // Before 'denied': allowing them in the site settings wouldn't help.
  if (!canPopUp(env, N)) return 'unavailable';
  return permission === 'granted' || permission === 'denied' ? permission : 'default';
}

export function notificationStatus(env: AlertEnv = browserEnv()): NotificationStatus {
  // Browsers only grant notifications to secure origins (HTTPS or localhost).
  if (env.isSecureContext === false) return 'insecure';
  const N = env.Notification;
  if (!N) return 'unsupported';
  return statusFor(N.permission, env, N);
}

/** Changes the status can't be observed for otherwise: our own prompts, the worker starting, a refused constructor. */
export function subscribeNotificationStatus(listener: () => void): () => void {
  notificationListeners.add(listener);
  return () => {
    notificationListeners.delete(listener);
  };
}

const currentNotificationStatus = (): NotificationStatus => notificationStatus();

export function useNotificationStatus(): NotificationStatus {
  return useSyncExternalStore(subscribeNotificationStatus, currentNotificationStatus, currentNotificationStatus);
}

/** Ask for permission when it hasn't been decided yet (and pop-ups can work here); call it from a click. */
export async function requestNotificationPermission(env: AlertEnv = browserEnv()): Promise<NotificationStatus> {
  const status = notificationStatus(env);
  const N = env.Notification;
  if (status !== 'default' || !N) return status;
  try {
    const p = await N.requestPermission();
    return statusFor(p, env, N);
  } catch {
    return notificationStatus(env);
  } finally {
    emitNotificationChange();
  }
}

/** What to tell the user about notifications (null when they work). */
export function notificationHint(status: NotificationStatus): string | null {
  switch (status) {
    case 'granted':
      return null;
    case 'default':
      return 'Allow notifications to also get a pop-up when this tab is in the background.';
    case 'denied':
      return "Notifications are blocked for this site. Allow them in your browser's site settings to get pop-ups; the alert sound still plays.";
    case 'insecure':
      return 'Browser notifications only work over HTTPS (or on localhost). Open the app with https:// to get pop-ups; the alert sound still plays.';
    case 'unavailable':
      return "Pop-ups aren't available in this browser on this device: on Android they need the app opened over HTTPS with a trusted (not self-signed) certificate. The alert sound still plays; keep this tab open and on screen.";
    case 'unsupported':
      return "This browser doesn't support notifications; the alert sound still plays.";
  }
}

function noticeTitle(level: NoticeLevel): string {
  if (level === 'error') return 'Stream needs attention';
  if (level === 'info') return 'Stream update';
  return 'Stream alert';
}

/** Short stable hash: identical notices from several open tabs collapse into one notification. */
function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function showWithConstructor(N: NotificationCtor, title: string, options: NotificationOptions, env: AlertEnv): boolean {
  if (blockedCtors.has(N)) return false;
  try {
    const n = new N(title, options);
    n.onclick = () => {
      try {
        env.focus?.();
      } catch {
        /* ignore */
      }
      n.close();
    };
    return true;
  } catch (err) {
    // "Illegal constructor": this browser only shows notifications from a service worker (Android).
    // Remember it so the status (and the UI) stops claiming pop-ups work.
    if (err instanceof TypeError) {
      blockedCtors.add(N);
      emitNotificationChange();
    }
    return false;
  }
}

/**
 * Show a notification when permission is granted: through the service worker when it runs (the
 * only way on Android; it focuses the tab on click), else with `new Notification()`. Never throws.
 * True means it was shown or handed to the worker.
 */
export function showAlertNotification(level: NoticeLevel, message: string, env: AlertEnv = browserEnv()): boolean {
  const N = env.Notification;
  if (notificationStatus(env) !== 'granted' || !N) return false;
  const title = `${noticeTitle(level)} Â· CTD Relay`;
  const options: NotificationOptions = {
    body: message,
    tag: `ctd-${level}-${hashText(message)}`,
    icon: '/icon-192.png', // PNG: Android notifications don't show SVG icons
    requireInteraction: level === 'error',
  };
  const worker = env.worker;
  if (worker) {
    try {
      worker.showNotification(title, options).catch(() => showWithConstructor(N, title, options, env));
      return true;
    } catch {
      /* fall back to the constructor */
    }
  }
  return showWithConstructor(N, title, options, env);
}

export interface WorkerContainerLike {
  register(scriptURL: string): Promise<unknown>;
  readonly ready: Promise<AlertWorker>;
}

/**
 * Register the notifications-only service worker and resolve with its registration once active;
 * null when it can't run here (no support, private mode, a self-signed certificateâ€¦). Never rejects.
 */
export async function startAlertWorker(container: WorkerContainerLike | null | undefined): Promise<AlertWorker | null> {
  if (!container) return null;
  try {
    await container.register(ALERT_WORKER_URL);
    return await container.ready;
  } catch {
    return null;
  }
}

let workerStart: Promise<AlertWorker | null> | null = null;

/** Start the worker once per page, on secure origins with the Notification API. */
function ensureAlertWorker(): void {
  if (workerStart || typeof window === 'undefined' || typeof navigator === 'undefined') return;
  if (!window.isSecureContext || !('Notification' in window) || !('serviceWorker' in navigator)) return;
  workerStart = startAlertWorker(navigator.serviceWorker).then((worker) => {
    alertWorker = worker;
    if (worker) emitNotificationChange();
    return worker;
  });
}

// ---------------------------------------------------------------------------
// Sound (Web Audio, generated)
// ---------------------------------------------------------------------------

export type AlertSound = 'alarm' | 'gentle';

export interface ToneStep {
  freq: number;
  /** Start, seconds from the beginning of the pattern. */
  at: number;
  /** Seconds. */
  dur: number;
  type: OscillatorType;
  /** Peak gain (0â€“1). */
  gain: number;
}

export function soundForLevel(level: string): AlertSound {
  return level === 'info' ? 'gentle' : 'alarm';
}

export function alertPattern(sound: AlertSound): ToneStep[] {
  if (sound === 'gentle') {
    // Two soft rising notes (E5 â†’ B5).
    return [
      { freq: 659.25, at: 0, dur: 0.4, type: 'sine', gain: 0.2 },
      { freq: 987.77, at: 0.18, dur: 0.6, type: 'sine', gain: 0.18 },
    ];
  }
  // Three two-tone pulses (~1.3 s): meant to cut through a loud room.
  const steps: ToneStep[] = [];
  for (let i = 0; i < 3; i++) {
    steps.push({ freq: 880, at: i * 0.44, dur: 0.17, type: 'square', gain: 0.2 });
    steps.push({ freq: 660, at: i * 0.44 + 0.2, dur: 0.17, type: 'square', gain: 0.2 });
  }
  return steps;
}

export type AudioOut = Pick<BaseAudioContext, 'currentTime' | 'destination' | 'createOscillator' | 'createGain'>;

/** Schedule a pattern on an audio context (short attack/decay ramps, so no clicks). */
export function schedulePattern(ctx: AudioOut, steps: readonly ToneStep[]): void {
  const t0 = ctx.currentTime + 0.02;
  for (const s of steps) {
    const start = t0 + s.at;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = s.type;
    osc.frequency.setValueAtTime(s.freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(s.gain, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + s.dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + s.dur + 0.03);
  }
}

let audioCtx: AudioContext | null = null;

function audioContextCtor(): (new () => AudioContext) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Create / resume the shared AudioContext. Browsers only start audio after a user gesture, so
 * call this from clicks (enabling alerts does; installAlerts covers later page loads).
 */
export function unlockAudio(): AudioContext | null {
  try {
    if (!audioCtx) {
      const Ctor = audioContextCtor();
      if (!Ctor) return null;
      audioCtx = new Ctor();
    }
    if (audioCtx.state === 'suspended') void audioCtx.resume().catch(() => undefined);
    return audioCtx;
  } catch {
    return null;
  }
}

/** A sound that couldn't start within this time (audio still locked) is dropped, never played late. */
const STALE_SOUND_MS = 3000;

/** Play an alert sound. False when audio is unavailable. */
export function playAlertSound(sound: AlertSound): boolean {
  const ctx = unlockAudio();
  if (!ctx) return false;
  const steps = alertPattern(sound);
  try {
    if (ctx.state === 'running') {
      schedulePattern(ctx, steps);
      return true;
    }
    const asked = Date.now();
    ctx.resume().then(
      () => {
        if (ctx.state === 'running' && Date.now() - asked < STALE_SOUND_MS) schedulePattern(ctx, steps);
      },
      () => undefined,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Page-wide setup while signed in (LiveProvider): start the notifications service worker, when
 * alerts are on unlock audio on clicks / key presses (a reloaded page starts with audio locked),
 * and follow the setting when another tab changes it. Returns a cleanup function.
 */
export function installAlerts(): () => void {
  if (typeof document === 'undefined') return () => undefined;
  ensureAlertWorker();
  const onGesture = () => {
    if (getAlertPrefs().enabled) unlockAudio();
  };
  document.addEventListener('pointerdown', onGesture, true);
  document.addEventListener('keydown', onGesture, true);
  const releaseStorage = retainStorageSync();
  return () => {
    document.removeEventListener('pointerdown', onGesture, true);
    document.removeEventListener('keydown', onGesture, true);
    releaseStorage();
  };
}

// ---------------------------------------------------------------------------
// Speech
// ---------------------------------------------------------------------------

export function speakAlert(message: string): boolean {
  try {
    if (typeof window === 'undefined' || !window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') return false;
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(message.slice(0, 300)));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

export interface AlertOutputs {
  play: (sound: AlertSound) => boolean;
  notify: (level: NoticeLevel, message: string) => boolean;
  speak: (message: string) => boolean;
}

const browserOutputs: AlertOutputs = {
  play: playAlertSound,
  notify: (level, message) => showAlertNotification(level, message),
  speak: speakAlert,
};

export interface AlertResult {
  sound: AlertSound | null;
  notified: boolean;
  spoke: boolean;
}

/** React to a server notice (the toast is shown separately). Does nothing while alerts are off. */
export function alertForNotice(
  level: NoticeLevel,
  message: string,
  prefs: AlertPrefs = getAlertPrefs(),
  out: AlertOutputs = browserOutputs,
): AlertResult {
  if (!prefs.enabled) return { sound: null, notified: false, spoke: false };
  const sound = soundForLevel(level);
  const played = out.play(sound);
  const notified = out.notify(level, message);
  const spoke = prefs.speak ? out.speak(message) : false;
  return { sound: played ? sound : null, notified, spoke };
}

/**
 * Turn alerts on. Call it straight from a click: the synchronous part unlocks audio, plays a
 * short confirmation chime and asks for notification permission inside the user gesture.
 */
export function enableAlerts(env: AlertEnv = browserEnv(), out: Pick<AlertOutputs, 'play'> = browserOutputs): Promise<NotificationStatus> {
  setAlertPrefs({ enabled: true });
  out.play('gentle');
  return requestNotificationPermission(env);
}

export function disableAlerts(): void {
  setAlertPrefs({ enabled: false });
}

export const TEST_ALERT_MESSAGE = 'Test alert: this is how CTD Relay tells you a platform ended the live.';

/** Play the takedown alert once (whatever the on/off setting). */
export function testAlert(out: AlertOutputs = browserOutputs): AlertResult {
  return alertForNotice('warn', TEST_ALERT_MESSAGE, { ...getAlertPrefs(), enabled: true }, out);
}
