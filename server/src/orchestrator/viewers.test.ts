// Viewer counts from the live health watcher, and health watchers for lives without Stream Guard.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveHealthEvent, PreparedLive } from '../platforms/types.js';
import { viewerCount } from './destination-runner.js';
import { advance, dest, driver, flush, goLive, harness, prepared } from './test-helpers.js';

/** A controllable PreparedLive.health source. */
class Health {
  readonly signals: AbortSignal[] = [];
  private pending: LiveHealthEvent[] = [];
  private wake: (() => void) | null = null;

  readonly source = (signal: AbortSignal): AsyncIterable<LiveHealthEvent> => {
    this.signals.push(signal);
    return this.iterate(signal);
  };

  emit(ev: LiveHealthEvent): void {
    this.pending.push(ev);
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private async *iterate(signal: AbortSignal): AsyncGenerator<LiveHealthEvent> {
    while (!signal.aborted) {
      const next = this.pending.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

function twitchHarness(lives: PreparedLive[]) {
  let i = 0;
  const prepare = vi.fn(async () => {
    const live = lives[i++];
    if (!live) throw new Error('no more lives');
    return live;
  });
  const h = harness({ dests: [dest('tw', { platform: 'twitch', name: 'Twitch' })], drivers: [driver('twitch', { prepare }, { name: 'Twitch' })] });
  return { h, prepare };
}

const viewerEvents = (h: ReturnType<typeof twitchHarness>['h']) => h.destEvents.filter((e) => e.destinationId === 'tw').map((e) => e.viewers ?? null);

describe('viewerCount', () => {
  it('keeps non-negative counts (rounded), everything else is unknown', () => {
    expect(viewerCount(0)).toBe(0);
    expect(viewerCount(214)).toBe(214);
    expect(viewerCount(12.6)).toBe(13);
    expect(viewerCount(-1)).toBeNull();
    expect(viewerCount(Number.NaN)).toBeNull();
    expect(viewerCount(Number.POSITIVE_INFINITY)).toBeNull();
    expect(viewerCount('12')).toBeNull();
    expect(viewerCount(null)).toBeNull();
  });
});

describe('viewers', () => {
  it('a live without a recovery policy still runs its health watcher; viewers land on the destination state', async () => {
    const health = new Health();
    const live = prepared({ health: health.source });
    const { h } = twitchHarness([live]);
    await goLive(h, ['tw']);
    expect(h.phase('tw')).toBe('live');
    expect(health.signals).toHaveLength(1);
    expect(h.destState('tw').viewers).toBeNull();

    health.emit({ type: 'viewers', count: 214 });
    await flush();
    expect(h.destState('tw')).toMatchObject({ phase: 'live', viewers: 214 });

    // Same count again: no new destination event.
    const before = h.destEvents.length;
    health.emit({ type: 'viewers', count: 214 });
    await flush();
    expect(h.destEvents).toHaveLength(before);

    health.emit({ type: 'viewers', count: 230 });
    await flush();
    expect(h.destState('tw').viewers).toBe(230);
    health.emit({ type: 'viewers', count: null }); // hidden / unknown
    await flush();
    expect(h.destState('tw').viewers).toBeNull();
    health.emit({ type: 'viewers', count: -5 });
    await flush();
    expect(h.destState('tw').viewers).toBeNull();
    health.emit({ type: 'viewers', count: 9 });
    await flush();
    expect(viewerEvents(h).filter((v) => v !== null)).toEqual([214, 230, 9]);

    // Push stats keep the count.
    h.pushes.running('tw');
    await flush();
    expect(h.destState('tw').viewers).toBe(9);
  });

  it('viewers go back to unknown when the live ends (stop), and the watcher stops', async () => {
    const health = new Health();
    const { h } = twitchHarness([prepared({ health: health.source })]);
    await goLive(h, ['tw']);
    health.emit({ type: 'viewers', count: 50 });
    await flush();
    expect(h.destState('tw').viewers).toBe(50);
    await h.orch.stop();
    expect(health.signals[0]?.aborted).toBe(true);
    expect(h.destState('tw')).toMatchObject({ phase: 'idle', viewers: null });
    // A late event from the old watcher changes nothing.
    health.emit({ type: 'viewers', count: 99 });
    await flush();
    expect(h.destState('tw').viewers).toBeNull();
  });

  it('a feed-loss pause keeps the count; the grace expiry (live ended) clears it', async () => {
    const health = new Health();
    const { h } = twitchHarness([prepared({ health: health.source }), prepared()]);
    await goLive(h, ['tw']);
    health.emit({ type: 'viewers', count: 12 });
    await flush();
    h.media.set('landscape', false);
    await flush();
    expect(h.destState('tw')).toMatchObject({ phase: 'waiting-for-feed', viewers: 12 });
    await advance(15_000); // grace (the session itself stops on the same timer)
    expect(h.destState('tw').viewers).toBeNull();
  });

  it('a live without a recovery policy that the platform ends is still an error', async () => {
    const health = new Health();
    const live = prepared({ health: health.source });
    const { h, prepare } = twitchHarness([live]);
    await goLive(h, ['tw']);
    health.emit({ type: 'viewers', count: 3 });
    health.emit({ type: 'ended', reason: 'stream offline' });
    await flush();
    expect(h.destState('tw')).toMatchObject({ phase: 'error', message: 'Twitch ended the live (stream offline)', viewers: null });
    expect(live.end).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('the session snapshot carries viewers and a fresh session starts with none', async () => {
    const health = new Health();
    const { h } = twitchHarness([prepared({ health: health.source }), prepared()]);
    await goLive(h, ['tw']);
    health.emit({ type: 'viewers', count: 7 });
    await flush();
    expect(h.orch.state().destinations[0]).toMatchObject({ destinationId: 'tw', viewers: 7 });
    await h.orch.stop();
    await h.orch.start('manual');
    await flush();
    expect(h.destState('tw').viewers).toBeNull();
  });
});
