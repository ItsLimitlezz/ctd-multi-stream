import { describe, expect, it, vi } from 'vitest';
import type { LiveHealthEvent } from '../types.js';
import { pollViewers } from './viewers.js';

async function take(it: AsyncGenerator<LiveHealthEvent>, n: number): Promise<LiveHealthEvent[]> {
  const out: LiveHealthEvent[] = [];
  while (out.length < n) {
    const r = await it.next();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

describe('pollViewers', () => {
  it('yields every read, keeps the last count through one failure, then reports null', async () => {
    const reads: (number | null | Error)[] = [5, null, new Error('boom'), 7, new Error('a'), new Error('b'), 9];
    const read = vi.fn(async () => {
      const next = reads.shift();
      if (next instanceof Error) throw next;
      return next ?? null;
    });
    const ctl = new AbortController();
    const events = await take(pollViewers(read, ctl.signal, { intervalMs: 1 }), 5);
    ctl.abort();
    expect(events).toEqual([
      { type: 'viewers', count: 5 },
      { type: 'viewers', count: null },
      // the single failure yields nothing
      { type: 'viewers', count: 7 },
      // first of two failures: nothing; second: null
      { type: 'viewers', count: null },
      { type: 'viewers', count: 9 },
    ]);
    expect(read).toHaveBeenCalledTimes(7);
  });

  it('never yields ended, and returns once aborted (also mid-wait)', async () => {
    const ctl = new AbortController();
    const it = pollViewers(async () => 3, ctl.signal, { intervalMs: 60_000 });
    expect((await it.next()).value).toEqual({ type: 'viewers', count: 3 });
    const pending = it.next();
    setTimeout(() => ctl.abort(), 10);
    expect(await pending).toEqual({ done: true, value: undefined });
  });

  it('returns quietly when the read fails because of the abort', async () => {
    const ctl = new AbortController();
    const it = pollViewers(
      async () => {
        ctl.abort();
        throw new Error('aborted');
      },
      ctl.signal,
    );
    expect(await it.next()).toEqual({ done: true, value: undefined });
  });
});
