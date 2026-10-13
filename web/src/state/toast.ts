// Global toast store. `toast()` works anywhere (no hook needed); <ToastProvider> renders them.

import { useSyncExternalStore } from 'react';

export type ToastTone = 'info' | 'success' | 'warn' | 'error';

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  /** How many times this same message was raised while visible. */
  count: number;
}

export interface ToastOptions {
  tone?: ToastTone;
  /** Auto-dismiss after this many ms; 0 keeps it until dismissed. */
  durationMs?: number;
}

export const MAX_TOASTS = 4;
const DEFAULT_MS: Record<ToastTone, number> = { info: 4500, success: 3500, warn: 6500, error: 8000 };

let items: readonly ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const l of listeners) l();
}

function clearTimer(id: number): void {
  const t = timers.get(id);
  if (t !== undefined) clearTimeout(t);
  timers.delete(id);
}

function schedule(id: number, ms: number): void {
  clearTimer(id);
  if (ms > 0) timers.set(id, setTimeout(() => dismissToast(id), ms));
}

function show(message: string, opts: ToastOptions = {}): number {
  const tone = opts.tone ?? 'info';
  const text = message.trim() || 'Something happened';
  const existing = items.find((t) => t.message === text && t.tone === tone);
  let id: number;
  if (existing) {
    id = existing.id;
    items = items.map((t) => (t.id === id ? { ...t, count: t.count + 1 } : t));
  } else {
    id = nextId++;
    items = [...items, { id, message: text, tone, count: 1 }];
    while (items.length > MAX_TOASTS) {
      const oldest = items[0];
      if (!oldest) break;
      clearTimer(oldest.id);
      items = items.slice(1);
    }
  }
  schedule(id, opts.durationMs ?? DEFAULT_MS[tone]);
  emit();
  return id;
}

/** Show a toast. Also: toast.success / toast.error / toast.warn / toast.info. Returns its id. */
export const toast = Object.assign(show, {
  info: (message: string, opts?: Omit<ToastOptions, 'tone'>) => show(message, { ...opts, tone: 'info' }),
  success: (message: string, opts?: Omit<ToastOptions, 'tone'>) => show(message, { ...opts, tone: 'success' }),
  warn: (message: string, opts?: Omit<ToastOptions, 'tone'>) => show(message, { ...opts, tone: 'warn' }),
  error: (message: string, opts?: Omit<ToastOptions, 'tone'>) => show(message, { ...opts, tone: 'error' }),
});

export function dismissToast(id: number): void {
  if (!items.some((t) => t.id === id)) return;
  clearTimer(id);
  items = items.filter((t) => t.id !== id);
  emit();
}

export function clearToasts(): void {
  for (const id of timers.keys()) clearTimer(id);
  items = [];
  emit();
}

export function getToasts(): readonly ToastItem[] {
  return items;
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Visible toasts (oldest first). */
export function useToasts(): readonly ToastItem[] {
  return useSyncExternalStore(subscribeToasts, getToasts, getToasts);
}
