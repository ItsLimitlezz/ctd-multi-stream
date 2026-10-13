import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, dismissToast, getToasts, MAX_TOASTS, subscribeToasts, toast } from './toast';

describe('toast store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearToasts();
  });
  afterEach(() => {
    clearToasts();
    vi.useRealTimers();
  });

  it('adds, auto-dismisses and notifies', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToasts(listener);
    toast.success('Saved');
    expect(getToasts()).toMatchObject([{ message: 'Saved', tone: 'success', count: 1 }]);
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3500);
    expect(getToasts()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('merges identical toasts and restarts their timer', () => {
    toast.error('Boom');
    vi.advanceTimersByTime(7000);
    const id = toast.error('Boom');
    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0]).toMatchObject({ id, count: 2 });
    vi.advanceTimersByTime(7000);
    expect(getToasts()).toHaveLength(1); // timer was restarted
    vi.advanceTimersByTime(1000);
    expect(getToasts()).toHaveLength(0);
  });

  it('keeps at most MAX_TOASTS (oldest dropped) and supports sticky + manual dismiss', () => {
    for (let i = 0; i < MAX_TOASTS + 2; i++) toast(`n${i}`);
    expect(getToasts().map((t) => t.message)).toEqual(Array.from({ length: MAX_TOASTS }, (_, i) => `n${i + 2}`));
    clearToasts();
    const id = toast.warn('sticky', { durationMs: 0 });
    vi.advanceTimersByTime(600_000);
    expect(getToasts()).toHaveLength(1);
    dismissToast(id);
    expect(getToasts()).toHaveLength(0);
    dismissToast(id); // no-op
  });
});
