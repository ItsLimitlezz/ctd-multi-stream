import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  awaitBounded,
  errorMessage,
  isAbortError,
  redactText,
  SerialQueue,
  stableStringify,
  textLength,
  TimeoutError,
} from './async-utils.js';

describe('awaitBounded', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('resolves with the work result', async () => {
    await expect(awaitBounded(async () => 42, { ms: 1000, what: 'Work' })).resolves.toBe(42);
  });

  it('passes through rejections and sync throws', async () => {
    await expect(awaitBounded(async () => Promise.reject(new Error('nope')), { ms: 1000, what: 'Work' })).rejects.toThrow('nope');
    await expect(
      awaitBounded(
        () => {
          throw new Error('sync');
        },
        { ms: 1000, what: 'Work' },
      ),
    ).rejects.toThrow('sync');
  });

  it('times out, aborts the inner signal and hands a late value to onLate', async () => {
    let inner: AbortSignal | null = null;
    let finish!: (v: string) => void;
    const onLate = vi.fn();
    const p = awaitBounded(
      (signal) => {
        inner = signal;
        return new Promise<string>((r) => (finish = r));
      },
      { ms: 5000, what: 'Slow thing', onLate },
    );
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    await expect(p).rejects.toThrow('Slow thing timed out after 5 s');
    expect(inner!.aborted).toBe(true);
    finish('late');
    await Promise.resolve();
    await Promise.resolve();
    expect(onLate).toHaveBeenCalledWith('late');
  });

  it('rejects with AbortError when the outer signal aborts, and swallows late rejections', async () => {
    const ctl = new AbortController();
    let fail!: (e: Error) => void;
    const p = awaitBounded(() => new Promise<void>((_r, rej) => (fail = rej)), { ms: 5000, what: 'X', signal: ctl.signal });
    ctl.abort();
    const err = await p.catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
    fail(new Error('late failure')); // must not become an unhandled rejection
    await Promise.resolve();
  });

  it('does not run the work when already aborted', async () => {
    const work = vi.fn(async () => 1);
    const err = await awaitBounded(work, { ms: 1000, what: 'X', signal: AbortSignal.abort() }).catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
    expect(work).not.toHaveBeenCalled();
  });
});

describe('SerialQueue', () => {
  it('runs tasks one at a time in order, even when one fails', async () => {
    const q = new SerialQueue();
    const order: string[] = [];
    let release!: () => void;
    const a = q.run(async () => {
      order.push('a:start');
      await new Promise<void>((r) => (release = r));
      order.push('a:end');
    });
    const b = q.run(() => {
      order.push('b');
      throw new Error('b failed');
    });
    const c = q.run(() => {
      order.push('c');
      return 'c';
    });
    await new Promise<void>((r) => setImmediate(r));
    expect(order).toEqual(['a:start']);
    release();
    await a;
    await expect(b).rejects.toThrow('b failed');
    await expect(c).resolves.toBe('c');
    expect(order).toEqual(['a:start', 'a:end', 'b', 'c']);
  });

  it('waits for the `after` promise, even if it rejects', async () => {
    let fail!: (e: Error) => void;
    const after = new Promise<void>((_r, rej) => (fail = rej));
    const q = new SerialQueue(after);
    const task = vi.fn();
    const done = q.run(task);
    await new Promise<void>((r) => setImmediate(r));
    expect(task).not.toHaveBeenCalled();
    fail(new Error('previous teardown failed'));
    await done;
    expect(task).toHaveBeenCalledTimes(1);
  });
});

describe('redaction and helpers', () => {
  it('strips stream keys from rtmp/srt URLs and queries from http URLs', () => {
    expect(redactText('push to rtmps://a.rtmp.youtube.com:443/live2/abcd-efgh failed')).toBe(
      'push to rtmps://a.rtmp.youtube.com:443/… failed',
    );
    expect(redactText('srt://host:9000?streamid=secret')).toBe('srt://host:9000/…');
    expect(redactText('GET https://api.example.com/v1/x?access_token=t0k3n#frag')).toBe('GET https://api.example.com/v1/x?…');
    expect(redactText('See https://help.example.com/live for details')).toBe('See https://help.example.com/live for details');
  });

  it('errorMessage handles non-errors and empty messages', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('text')).toBe('text');
    expect(errorMessage({})).toBe('Unknown error');
    expect(errorMessage(new Error(''))).toBe('Unknown error');
  });

  it('textLength counts code points', () => {
    expect(textLength('abc')).toBe(3);
    expect(textLength('😀😀')).toBe(2);
  });

  it('stableStringify sorts object keys recursively', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
    expect(stableStringify([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });
});
