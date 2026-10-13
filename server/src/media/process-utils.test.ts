import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onLines, terminate, waitForExit } from './process-utils.js';
import { FakeChild, flush } from './test-helpers.js';

describe('onLines', () => {
  it('splits \\n, \\r\\n and \\r across chunk boundaries', async () => {
    const s = new PassThrough();
    const lines: string[] = [];
    onLines(s, (l) => lines.push(l));
    const ended = new Promise((r) => s.on('end', r));
    s.write('a=1\nb=');
    s.write('2\r');
    s.write('\nc=3\rd=4');
    s.end('\n tail');
    await ended;
    await flush();
    expect(lines).toEqual(['a=1', 'b=2', 'c=3', 'd=4', ' tail']);
  });

  it('ignores a missing stream', () => {
    expect(() => onLines(null, () => {})).not.toThrow();
  });
});

describe('terminate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately for exited processes', async () => {
    const c = new FakeChild();
    c.exit(0);
    await terminate(c.asChild());
    await waitForExit(c.asChild());
    expect(c.signals).toEqual([]);
  });

  it('sends SIGTERM (plain kill on Windows) and escalates to SIGKILL after the grace period', async () => {
    vi.useFakeTimers();
    const c = new FakeChild();
    c.ignore.add('SIGTERM');
    const done = terminate(c.asChild(), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(c.signals).toEqual([process.platform === 'win32' ? undefined : 'SIGTERM', 'SIGKILL']);
  });
});
