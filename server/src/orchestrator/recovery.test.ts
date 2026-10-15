// Takedown recovery ("Stream Guard"): live health watcher, push-down rule, fresh lives after the
// platform kills one, per-attempt deadlines, give-up after back-to-back failed attempts, the
// create/kill loop guard, and teardown safety.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Destination, FieldSpec } from '../../../shared/types.js';
import {
  DriverError,
  type ChatMessageInput,
  type LiveHealthEvent,
  type LiveRecoveryPolicy,
  type PreparedLive,
} from '../platforms/types.js';
import { normalizeFields } from '../http/validation.js';
import { advance, dest, driver, flush, goLive, harness, prepared, type EndMock, type HarnessOptions } from './test-helpers.js';

const POLICY: LiveRecoveryPolicy = { pushDownConfirmMs: 5_000, maxAttempts: 3 };
const TAKEDOWN = 'Your live video was removed for copyright';
const GIVE_UP = "Couldn't get Instagram live again — gave up after 3 failed attempts. Check it and press Retry.";
const REJECTED = 'The platform rejected the stream';

/** A controllable PreparedLive.health source: emit() feeds events to the current watcher. */
class HealthFeed {
  readonly signals: AbortSignal[] = [];
  /** The next `n` watcher starts throw right away. */
  throwNext = 0;
  private pending: LiveHealthEvent[] = [];
  private wake: (() => void) | null = null;

  readonly source = (signal: AbortSignal): AsyncIterable<LiveHealthEvent> => {
    this.signals.push(signal);
    if (this.throwNext > 0) {
      this.throwNext -= 1;
      return failing();
    }
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

async function* failing(): AsyncGenerator<LiveHealthEvent> {
  throw new Error('producer page crashed');
}

const chatSource = async function* (signal: AbortSignal): AsyncIterable<ChatMessageInput> {
  await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
};

interface Live {
  live: PreparedLive & { end: EndMock };
  health: HealthFeed;
  confirm: ReturnType<typeof vi.fn<(signal: AbortSignal) => Promise<void>>>;
}

/** An Instagram-like live: confirm resolves, health is controllable, recovery policy set. */
function igLive(over: Omit<Partial<PreparedLive>, 'end'> = {}): Live {
  const health = new HealthFeed();
  const confirm = vi.fn(async (_signal: AbortSignal) => {});
  const live = prepared({ confirm, health: health.source, recovery: POLICY, chat: chatSource, ...over });
  return { live, health, confirm };
}

type PrepareResult = PreparedLive | Error | Promise<PreparedLive>;

/** prepare() returning the scripted results in order (Error → thrown). */
function scripted(results: PrepareResult[]) {
  let i = 0;
  return vi.fn(async (_d: Destination, _a: Account | null, _title: string): Promise<PreparedLive> => {
    const r = results[i++];
    if (r === undefined) throw new Error('no more scripted lives');
    if (r instanceof Error) throw r;
    return r;
  });
}

const LINK_FIELDS: FieldSpec[] = [
  { key: 'links', label: 'Links', type: 'links' },
  {
    key: 'linkMode',
    label: 'Link mode',
    type: 'select',
    default: 'rotate',
    options: [
      { value: 'rotate', label: 'Rotate' },
      { value: 'first', label: 'First' },
    ],
  },
];

function igHarness(
  prepare: ReturnType<typeof scripted>,
  settings: Record<string, unknown> = {},
  extra: Pick<HarnessOptions, 'graceSec' | 'timings'> = {},
) {
  return harness({
    dests: [dest('ig', { platform: 'instagram', name: 'IG' })],
    drivers: [driver('instagram', { prepare }, { name: 'Instagram', destinationFields: LINK_FIELDS })],
    settings,
    ...extra,
  });
}

/** Go live and confirm. */
async function liveNow(h: ReturnType<typeof igHarness>): Promise<void> {
  await goLive(h, ['ig']);
  await flush();
  expect(h.phase('ig')).toBe('live');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('takedown via the health watcher', () => {
  it('ends the killed live and goes live again on a fresh one with the current title', async () => {
    const a = igLive();
    const b = igLive();
    const prepare = scripted([a.live, b.live]);
    const h = igHarness(prepare, { 'session.title': 'Saturday set' });
    await liveNow(h);
    expect(a.health.signals).toHaveLength(1);
    expect(h.chat.attaches).toHaveLength(1);
    expect(h.destState('ig')).toMatchObject({ recoveries: 0, lastRecovery: null });

    await h.orch.setTitle('Late night set');
    a.health.emit({ type: 'ended', reason: TAKEDOWN });
    await flush();

    // Old live torn down: health + chat stopped, push stopped, end() called.
    expect(a.health.signals[0]?.aborted).toBe(true);
    expect(h.chat.attaches[0]?.signal.aborted).toBe(true);
    expect(h.pushes.stops).toEqual(['ig']);
    expect(a.live.end).toHaveBeenCalledTimes(1);

    // A fresh live with the current title, pushing to its own key.
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[1]?.[2]).toBe('Late night set');
    expect(h.pushes.starts).toHaveLength(2);
    expect(h.phase('ig')).toBe('recovering');
    expect(h.destState('ig').lastRecovery).toEqual({ at: expect.any(String), reason: TAKEDOWN });
    expect(h.destState('ig').message).toContain(`Instagram ended the live (${TAKEDOWN})`);

    h.pushes.running('ig');
    await flush();
    const st = h.destState('ig');
    expect(st.phase).toBe('live');
    expect(st.recoveries).toBe(1);
    expect(st.message).toBeNull();
    expect(b.confirm).toHaveBeenCalledTimes(1);
    expect(b.health.signals).toHaveLength(1);
    expect(h.chat.attaches).toHaveLength(2);
    expect(h.chat.attaches[1]?.signal.aborted).toBe(false);
    expect(b.live.end).not.toHaveBeenCalled();

    // recovering throughout: no preparing/connecting/confirming flashes during the recovery.
    expect(h.history('ig')).toEqual(['preparing', 'connecting', 'confirming', 'live', 'recovering', 'live']);
    expect(h.notices).toEqual([
      { level: 'warn', message: `IG: Instagram ended the live (${TAKEDOWN}). Starting a new one…`, profileId: 'default' },
      { level: 'info', message: 'IG: Instagram is live again (recovery #1)', profileId: 'default' },
    ]);
  });

  it('counts recoveries across takedowns and keeps them across push restarts; a new session resets them', async () => {
    const lives = [igLive(), igLive(), igLive(), igLive()];
    const prepare = scripted(lives.map((l) => l.live));
    const h = igHarness(prepare, { 'session.autoGoLive': false });
    await h.orch.init();
    await h.orch.start('manual');
    h.media.set('landscape', true);
    await flush();
    h.pushes.running('ig');
    await flush();
    expect(h.phase('ig')).toBe('live');

    lives[0]!.health.emit({ type: 'ended', reason: 'first' });
    await flush();
    h.pushes.running('ig');
    await flush();
    await advance(10 * 60_000); // stable
    lives[1]!.health.emit({ type: 'ended', reason: 'second' });
    await flush();
    h.pushes.running('ig');
    await flush();
    expect(h.destState('ig')).toMatchObject({ phase: 'live', recoveries: 2, lastRecovery: { reason: 'second' } });

    // Brief feed loss: push restarts on the same live, the count stays.
    h.media.set('landscape', false);
    await flush();
    h.media.set('landscape', true);
    await flush();
    h.pushes.running('ig');
    await flush();
    expect(h.destState('ig')).toMatchObject({ phase: 'live', recoveries: 2 });
    expect(prepare).toHaveBeenCalledTimes(3);

    await h.orch.stop();
    expect(h.destState('ig')).toMatchObject({ phase: 'idle', recoveries: 2 });
    await h.orch.start('manual');
    await flush();
    expect(h.destState('ig')).toMatchObject({ recoveries: 0, lastRecovery: null });
  });

  it('a live without a recovery policy that the platform ends becomes an error', async () => {
    const a = igLive({ recovery: undefined });
    const prepare = scripted([a.live]);
    const h = igHarness(prepare);
    await liveNow(h);
    a.health.emit({ type: 'ended', reason: 'Live video ended' });
    await flush();
    expect(h.phase('ig')).toBe('error');
    expect(h.destState('ig').message).toBe('Instagram ended the live (Live video ended)');
    expect(a.live.end).toHaveBeenCalledTimes(1);
    expect(h.notices.at(-1)).toMatchObject({ level: 'error' });
    await advance(10 * 60_000);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('warning sets the message without leaving live; ok clears it', async () => {
    const a = igLive();
    const h = igHarness(scripted([a.live]));
    await liveNow(h);
    a.health.emit({ type: 'warning', message: 'Viewer count unavailable' });
    await flush();
    expect(h.destState('ig')).toMatchObject({ phase: 'live', message: 'Viewer count unavailable' });
    h.pushes.running('ig'); // periodic stats keep the warning
    await flush();
    expect(h.destState('ig').message).toBe('Viewer count unavailable');
    a.health.emit({ type: 'ok' });
    await flush();
    expect(h.destState('ig')).toMatchObject({ phase: 'live', message: null });
  });

  it('restarts a failing health watcher with backoff while live', async () => {
    const a = igLive();
    a.health.throwNext = 3;
    const prepare = scripted([a.live, igLive().live]);
    const h = igHarness(prepare);
    await liveNow(h);
    expect(a.health.signals).toHaveLength(1);
    await advance(999);
    expect(a.health.signals).toHaveLength(1);
    await advance(1);
    expect(a.health.signals).toHaveLength(2);
    await advance(2_000);
    expect(a.health.signals).toHaveLength(3);
    await advance(4_000);
    expect(a.health.signals).toHaveLength(4); // this one works
    await advance(60_000);
    expect(a.health.signals).toHaveLength(4);
    expect(h.phase('ig')).toBe('live');

    a.health.emit({ type: 'ended', reason: TAKEDOWN });
    await flush();
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('ended while the OBS feed is offline just drops the live; a normal prepare follows when it returns', async () => {
    const a = igLive();
    const b = igLive();
    const prepare = scripted([a.live, b.live]);
    const h = igHarness(prepare);
    await liveNow(h);
    h.media.set('landscape', false);
    await flush();
    a.health.emit({ type: 'ended', reason: 'Live video ended' });
    await flush();
    expect(a.live.end).toHaveBeenCalledTimes(1);
    expect(h.phase('ig')).toBe('waiting-for-feed');
    expect(h.destState('ig').message).toContain('Instagram ended the live');
    expect(prepare).toHaveBeenCalledTimes(1);

    h.media.set('landscape', true);
    await flush();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(h.phase('ig')).toBe('connecting');
    h.pushes.running('ig');
    await flush();
    expect(h.destState('ig')).toMatchObject({ phase: 'live', recoveries: 0 });
    expect(h.notices.some((n) => n.level === 'warn')).toBe(false);
  });

  it('a title change while recovering is skipped and applied to the new live', async () => {
    const a = igLive();
    let finish!: (p: PreparedLive) => void;
    const setTitle = vi.fn(async () => {});
    const b = igLive({ setTitle });
    const prepare = scripted([a.live, new Promise<PreparedLive>((r) => (finish = r))]);
    const h = igHarness(prepare, { 'session.title': 'Old' });
    await liveNow(h);
    a.health.emit({ type: 'ended', reason: TAKEDOWN });
    await flush();
    expect(h.phase('ig')).toBe('recovering');
    expect(await h.orch.setTitle('New')).toEqual([
      { destinationId: 'ig', ok: true, skipped: true, error: expect.any(String) },
    ]);
    finish(b.live);
    await flush();
    expect(setTitle).toHaveBeenCalledWith('New', expect.any(AbortSignal));
  });
});

describe('push-down rule', () => {
  it('push down 5 s while the feed is online → recovery', async () => {
    const a = igLive();
    const b = igLive();
    const prepare = scripted([a.live, b.live]);
    const h = igHarness(prepare);
    await liveNow(h);

    h.pushes.emit('ig', 'retrying', { message: 'Connection reset by peer', attempt: 1 });
    await flush();
    expect(h.phase('ig')).toBe('retrying');
    h.pushes.emit('ig', 'starting');
    await advance(2_000);
    h.pushes.emit('ig', 'retrying', { message: 'Connection refused', attempt: 2 });
    await advance(2_999);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(a.live.end).not.toHaveBeenCalled();

    await advance(1);
    expect(a.live.end).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(h.phase('ig')).toBe('recovering');
    const reason = h.destState('ig').lastRecovery?.reason ?? '';
    expect(reason).toContain('relay down for 5 s');
    expect(reason).toContain('Connection refused');
    expect(h.notices[0]).toMatchObject({ level: 'warn' });

    h.pushes.running('ig');
    await flush();
    expect(h.destState('ig')).toMatchObject({ phase: 'live', recoveries: 1 });
  });

  it('does not fire when the feed goes offline (OBS-disconnect grace applies instead)', async () => {
    const a = igLive();
    const prepare = scripted([a.live, igLive().live]);
    const h = igHarness(prepare);
    await liveNow(h);
    h.pushes.emit('ig', 'retrying', { message: 'Input ended', attempt: 1 });
    await flush();
    h.media.set('landscape', false);
    await flush();
    await advance(10_000);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(a.live.end).not.toHaveBeenCalled();
    expect(h.phase('ig')).toBe('waiting-for-feed');

    // Feed back: same live, push restarted, no recovery.
    h.media.set('landscape', true);
    await flush();
    h.pushes.running('ig');
    await flush();
    expect(h.destState('ig')).toMatchObject({ phase: 'live', recoveries: 0 });
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('does not fire when the push is running again within 5 s', async () => {
    const a = igLive();
    const prepare = scripted([a.live, igLive().live]);
    const h = igHarness(prepare);
    await liveNow(h);
    h.pushes.emit('ig', 'retrying', { message: 'Connection reset', attempt: 1 });
    await advance(4_000);
    h.pushes.running('ig');
    await advance(60_000);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(h.phase('ig')).toBe('live');
  });

  it('does not fire without a recovery policy', async () => {
    const a = igLive({ recovery: undefined });
    const prepare = scripted([a.live, igLive().live]);
    const h = igHarness(prepare);
    await liveNow(h);
    h.pushes.emit('ig', 'retrying', { message: 'Connection refused', attempt: 1 });
    await advance(60_000);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(h.phase('ig')).toBe('retrying');
    expect(a.live.end).not.toHaveBeenCalled();
  });

  it('does not fire before the live was confirmed', async () => {
    let finish!: () => void;
    const a = igLive({ confirm: vi.fn(() => new Promise<void>((r) => (finish = r))) });
    const prepare = scripted([a.live, igLive().live]);
    const h = igHarness(prepare);
    await goLive(h, ['ig']);
    expect(h.phase('ig')).toBe('confirming');
    h.pushes.emit('ig', 'retrying', { message: 'Connection refused', attempt: 1 });
    await advance(30_000);
    expect(prepare).toHaveBeenCalledTimes(1);
    finish();
    h.pushes.running('ig');
    await flush();
    expect(h.phase('ig')).toBe('live');
  });
});

describe('failed recoveries', () => {
  it('3 back-to-back failed attempts (5 s, 15 s apart) → error; Retry starts over', async () => {
    const a = igLive();
    const fail = () => new Error("Instagram couldn't create the live");
    const c = igLive();
    const prepare = scripted([a.live, fail(), fail(), fail(), c.live]);
    const h = igHarness(prepare);
    await liveNow(h);

    a.health.emit({ type: 'ended', reason: TAKEDOWN });
    await flush();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(h.phase('ig')).toBe('recovering');
    expect(h.destState('ig').message).toContain('trying again in 5 s');

    await advance(4_999);
    expect(prepare).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(h.destState('ig').message).toContain('trying again in 15 s');

    await advance(15_000);
    expect(prepare).toHaveBeenCalledTimes(4);
    expect(h.phase('ig')).toBe('error');
    expect(h.destState('ig').message).toBe(GIVE_UP);
    expect(h.notices.at(-1)).toEqual({ level: 'error', message: `IG: ${GIVE_UP}`, profileId: 'default' });
    await advance(10 * 60_000);
    expect(prepare).toHaveBeenCalledTimes(4);

    await h.orch.retryDestination('ig');
    await flush();
    expect(prepare).toHaveBeenCalledTimes(5);
    expect(h.phase('ig')).toBe('connecting');
    h.pushes.running('ig');
    await flush();
    expect(h.destState('ig')).toMatchObject({ phase: 'live', message: null });
  });

  it('recoveries the platform ends again are not failures: a long DJ set keeps getting fresh lives', async () => {
    const lives = Array.from({ length: 13 }, () => igLive());
    const prepare = scripted(lives.map((l) => l.live));
    const h = igHarness(prepare);
    await liveNow(h);

    // DPRTMNT: Instagram flags the set again ~3 minutes into every new live, all night.
    for (let i = 0; i < 12; i++) {
      await advance(3 * 60_000);
      lives[i]!.health.emit({ type: 'ended', reason: TAKEDOWN });
      await flush();
      expect(h.phase('ig')).toBe('recovering');
      h.pushes.running('ig');
      await flush();
      expect(h.destState('ig')).toMatchObject({ phase: 'live', recoveries: i + 1 });
    }
    expect(prepare).toHaveBeenCalledTimes(13);
    expect(h.notices.some((n) => n.level === 'error')).toBe(false);
  });

  it('failures must be back-to-back: a recovery that went live resets the count, however soon it is ended', async () => {
    const a = igLive();
    const b = igLive();
    const c = igLive();
    const fail = () => new Error('upstream 500');
    const prepare = scripted([a.live, fail(), b.live, fail(), fail(), c.live]);
    const h = igHarness(prepare);
    await liveNow(h);

    a.health.emit({ type: 'ended', reason: TAKEDOWN }); // failure 1
    await flush();
    expect(h.destState('ig').message).toContain('trying again in 5 s');
    await advance(5_000); // b goes live: count reset
    h.pushes.running('ig');
    await flush();
    expect(h.destState('ig')).toMatchObject({ phase: 'live', recoveries: 1 });

    await advance(30_000);
    b.health.emit({ type: 'ended', reason: TAKEDOWN }); // not a failure; the next attempt fails → failure 1 again
    await flush();
    expect(h.phase('ig')).toBe('recovering');
    expect(h.destState('ig').message).toContain('trying again in 5 s');
    await advance(5_000); // failure 2
    expect(h.destState('ig').message).toContain('trying again in 15 s');
    await advance(15_000); // attempt 3 succeeds
    expect(prepare).toHaveBeenCalledTimes(6);
    h.pushes.running('ig');
    await flush();
    expect(h.destState('ig')).toMatchObject({ phase: 'live', recoveries: 2 });
    expect(h.notices.some((n) => n.level === 'error')).toBe(false);
  });

  it('a needs-login error while recovering fails right away', async () => {
    const a = igLive();
    const prepare = scripted([a.live, new DriverError('Log in to Instagram again', 'needs-login')]);
    const h = igHarness(prepare);
    await liveNow(h);
    a.health.emit({ type: 'ended', reason: TAKEDOWN });
    await flush();
    expect(h.phase('ig')).toBe('error');
    expect(h.destState('ig').message).toBe('Log in to Instagram again');
    await advance(10 * 60_000);
    expect(prepare).toHaveBeenCalledTimes(2);
  });
});

describe('confirm during recovery', () => {
  it('video never arrives → restart the push once and confirm again', async () => {
    const a = igLive();
    const b = igLive();
    b.confirm.mockRejectedValueOnce(new DriverError('Instagram never received the video — check the vertical feed', 'timeout'));
    const prepare = scripted([a.live, b.live]);
    const h = igHarness(prepare);
    await liveNow(h);

    a.health.emit({ type: 'ended', reason: TAKEDOWN });
    await flush();
    expect(h.pushes.starts).toHaveLength(2);
    h.pushes.running('ig');
    await flush();
    // Kicked: push stopped and started again on the same (new) live.
    expect(b.confirm).toHaveBeenCalledTimes(1);
    expect(h.pushes.stops).toEqual(['ig', 'ig']);
    expect(h.pushes.starts).toHaveLength(3);
    expect(h.pushes.starts[2]?.plan).toBe(b.live.push);
    expect(h.phase('ig')).toBe('recovering');
    expect(b.live.end).not.toHaveBeenCalled();

    h.pushes.running('ig');
    await flush();
    expect(b.confirm).toHaveBeenCalledTimes(2);
    expect(h.destState('ig')).toMatchObject({ phase: 'live', recoveries: 1 });
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('a second timeout counts as a failed attempt; other confirm errors fail without a kick', async () => {
    const a = igLive();
    const b = igLive();
    b.confirm.mockRejectedValue(new DriverError('Instagram never received the video', 'timeout'));
    const c = igLive();
    c.confirm.mockRejectedValue(new Error('Go live button not found'));
    const d = igLive();
    const prepare = scripted([a.live, b.live, c.live, d.live]);
    const h = igHarness(prepare);
    await liveNow(h);

    a.health.emit({ type: 'ended', reason: TAKEDOWN });
    await flush();
    h.pushes.running('ig'); // confirm 1 times out → kick
    await flush();
    h.pushes.running('ig'); // confirm 2 times out → failure 1
    await flush();
    expect(b.confirm).toHaveBeenCalledTimes(2);
    expect(b.live.end).toHaveBeenCalledTimes(1);
    expect(h.phase('ig')).toBe('recovering');
    expect(h.destState('ig').message).toContain('trying again in 5 s');

    await advance(5_000);
    expect(prepare).toHaveBeenCalledTimes(3);
    const startsBefore = h.pushes.starts.length;
    h.pushes.running('ig'); // not a timeout → failure 2 without a kick
    await flush();
    expect(c.confirm).toHaveBeenCalledTimes(1);
    expect(h.pushes.starts).toHaveLength(startsBefore);
    expect(c.live.end).toHaveBeenCalledTimes(1);

    await advance(15_000);
    h.pushes.running('ig');
    await flush();
    expect(h.destState('ig')).toMatchObject({ phase: 'live', recoveries: 1 });
  });

  it('the orchestrator confirm timeout also triggers the kick', async () => {
    const a = igLive();
    const b = igLive();
    b.confirm.mockImplementationOnce(() => new Promise<void>(() => {}));
    const prepare = scripted([a.live, b.live]);
    const h = igHarness(prepare);
    await liveNow(h);
    a.health.emit({ type: 'ended', reason: TAKEDOWN });
    await flush();
    h.pushes.running('ig');
    await advance(180_000);
    expect(h.pushes.starts).toHaveLength(3);
    h.pushes.running('ig');
    await flush();
    expect(h.destState('ig')).toMatchObject({ phase: 'live', recoveries: 1 });
  });
});

describe('recovery attempt deadline', () => {
  it('the push to the new live never runs: restart it once, then the attempt fails; 3 such attempts → error', async () => {
    const a = igLive();
    const b = igLive();
    const c = igLive();
    const d = igLive();
    const prepare = scripted([a.live, b.live, c.live, d.live]);
    const h = igHarness(prepare);
    await liveNow(h);

    a.health.emit({ type: 'ended', reason: TAKEDOWN });
    await flush();
    expect(h.pushes.starts).toHaveLength(2);
    h.pushes.emit('ig', 'retrying', { message: REJECTED, attempt: 1 });
    await advance(89_999);
    expect(h.pushes.starts).toHaveLength(2);
    expect(h.phase('ig')).toBe('recovering');

    await advance(1); // 90 s without 'running' → kick: same live, push restarted
    expect(h.pushes.stops).toEqual(['ig', 'ig']);
    expect(h.pushes.starts).toHaveLength(3);
    expect(h.pushes.starts[2]?.plan).toBe(b.live.push);
    expect(b.live.end).not.toHaveBeenCalled();
    expect(h.phase('ig')).toBe('recovering');

    h.pushes.emit('ig', 'retrying', { message: REJECTED, attempt: 1 });
    await advance(90_000); // still nothing → failure 1
    expect(b.live.end).toHaveBeenCalledTimes(1);
    expect(b.confirm).not.toHaveBeenCalled();
    expect(h.pushes.starts).toHaveLength(3);
    expect(h.destState('ig').message).toContain(`Instagram never received the video: ${REJECTED}`);
    expect(h.destState('ig').message).toContain('trying again in 5 s');

    await advance(5_000); // c: same → failure 2
    expect(prepare).toHaveBeenCalledTimes(3);
    await advance(180_000);
    expect(c.live.end).toHaveBeenCalledTimes(1);
    expect(h.destState('ig').message).toContain('trying again in 15 s');

    await advance(15_000); // d: same → failure 3 → give up
    expect(prepare).toHaveBeenCalledTimes(4);
    await advance(180_000);
    expect(d.live.end).toHaveBeenCalledTimes(1);
    expect(h.phase('ig')).toBe('error');
    expect(h.destState('ig').message).toBe(GIVE_UP);
    expect(h.notices.at(-1)).toEqual({ level: 'error', message: `IG: ${GIVE_UP}`, profileId: 'default' });
    await advance(10 * 60_000);
    expect(prepare).toHaveBeenCalledTimes(4);
  });

  it('a push that reaches running in time goes live as usual', async () => {
    const a = igLive();
    const b = igLive();
    const prepare = scripted([a.live, b.live, igLive().live]);
    const h = igHarness(prepare);
    await liveNow(h);
    a.health.emit({ type: 'ended', reason: TAKEDOWN });
    await flush();
    h.pushes.emit('ig', 'retrying', { message: REJECTED, attempt: 1 });
    await advance(80_000);
    h.pushes.running('ig');
    await flush();
    expect(h.destState('ig')).toMatchObject({ phase: 'live', recoveries: 1 });
    await advance(10 * 60_000);
    expect(h.pushes.starts).toHaveLength(2);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(h.phase('ig')).toBe('live');
  });

  it('after a kick (confirm timed out), a push that never runs again fails the attempt without a second kick', async () => {
    const a = igLive();
    const b = igLive();
    b.confirm.mockRejectedValueOnce(new DriverError('Instagram never received the video', 'timeout'));
    const c = igLive();
    const prepare = scripted([a.live, b.live, c.live]);
    const h = igHarness(prepare);
    await liveNow(h);
    a.health.emit({ type: 'ended', reason: TAKEDOWN });
    await flush();
    h.pushes.running('ig'); // confirm times out → kick
    await flush();
    expect(h.pushes.starts).toHaveLength(3);

    h.pushes.emit('ig', 'retrying', { message: REJECTED, attempt: 1 });
    await advance(90_000);
    expect(b.live.end).toHaveBeenCalledTimes(1);
    expect(h.pushes.starts).toHaveLength(3);
    expect(h.destState('ig').message).toContain('trying again in 5 s');

    await advance(5_000);
    h.pushes.running('ig');
    await flush();
    expect(h.destState('ig')).toMatchObject({ phase: 'live', recoveries: 1 });
  });

  it('the platform shows the new live but the push to it stays down → the attempt fails without a kick', async () => {
    const a = igLive();
    let release!: () => void;
    const b = igLive({ confirm: vi.fn(() => new Promise<void>((r) => (release = r))) });
    const c = igLive();
    const prepare = scripted([a.live, b.live, c.live]);
    const h = igHarness(prepare);
    await liveNow(h);
    a.health.emit({ type: 'ended', reason: TAKEDOWN });
    await flush();
    h.pushes.running('ig'); // confirm starts
    await flush();
    h.pushes.emit('ig', 'retrying', { message: 'Connection reset', attempt: 1 });
    await flush();
    release(); // Instagram went live, but our push is down
    await flush();
    expect(h.phase('ig')).toBe('recovering');

    await advance(4_999); // pushDownConfirmMs
    expect(b.live.end).not.toHaveBeenCalled();
    await advance(1);
    expect(b.live.end).toHaveBeenCalledTimes(1);
    expect(h.pushes.starts).toHaveLength(2);
    expect(h.destState('ig').message).toContain('the relay to the new live stayed down: Connection reset');
    expect(h.destState('ig').message).toContain('trying again in 5 s');

    await advance(5_000);
    h.pushes.running('ig');
    await flush();
    expect(h.destState('ig')).toMatchObject({ phase: 'live', recoveries: 1 });
  });

  it('the push coming back right after confirm still goes live', async () => {
    const a = igLive();
    let release!: () => void;
    const b = igLive({ confirm: vi.fn(() => new Promise<void>((r) => (release = r))) });
    const prepare = scripted([a.live, b.live, igLive().live]);
    const h = igHarness(prepare);
    await liveNow(h);
    a.health.emit({ type: 'ended', reason: TAKEDOWN });
    await flush();
    h.pushes.running('ig');
    await flush();
    h.pushes.emit('ig', 'retrying', { message: 'Connection reset', attempt: 1 });
    await flush();
    release();
    await advance(3_000);
    h.pushes.running('ig');
    await flush();
    expect(h.destState('ig')).toMatchObject({ phase: 'live', recoveries: 1 });
    await advance(10 * 60_000);
    expect(b.live.end).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('OBS going offline mid-recovery is the feed grace logic, not a failed attempt', async () => {
    const a = igLive();
    const b = igLive();
    const prepare = scripted([a.live, b.live, igLive().live]);
    const h = igHarness(prepare, {}, { graceSec: 600 });
    await liveNow(h);
    a.health.emit({ type: 'ended', reason: TAKEDOWN });
    await flush();
    h.pushes.emit('ig', 'retrying', { message: REJECTED, attempt: 1 });
    await flush();
    h.media.set('landscape', false);
    await flush();
    expect(h.phase('ig')).toBe('waiting-for-feed');

    await advance(5 * 60_000); // well past the attempt deadline, inside the feed grace
    expect(b.live.end).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(h.pushes.starts).toHaveLength(2);
    expect(h.notices.some((n) => n.level === 'error')).toBe(false);

    h.media.set('landscape', true); // same new live, push restarted
    await flush();
    expect(h.pushes.starts).toHaveLength(3);
    expect(h.phase('ig')).toBe('recovering');
    h.pushes.running('ig');
    await flush();
    expect(h.destState('ig')).toMatchObject({ phase: 'live', recoveries: 1 });
    expect(prepare).toHaveBeenCalledTimes(2);
  });
});

describe('create/kill loop guard', () => {
  it('stops recovering once the platform ended 10 lives within 20 minutes', async () => {
    const reason = '0 viewers for 5 s';
    const lives = Array.from({ length: 11 }, () => igLive());
    const prepare = scripted(lives.map((l) => l.live));
    const h = igHarness(prepare);
    await liveNow(h);
    for (let i = 0; i < 9; i++) {
      await advance(65_000);
      lives[i]!.health.emit({ type: 'ended', reason });
      await flush();
      h.pushes.running('ig');
      await flush();
      expect(h.destState('ig')).toMatchObject({ phase: 'live', recoveries: i + 1 });
    }

    await advance(65_000);
    lives[9]!.health.emit({ type: 'ended', reason });
    await flush();
    const message = `Instagram ended the live 10 times within 20 min (latest: ${reason}) — stopped starting new ones. Check it and press Retry.`;
    expect(h.destState('ig')).toMatchObject({ phase: 'error', message, recoveries: 9, lastRecovery: { reason } });
    expect(lives[9]!.live.end).toHaveBeenCalledTimes(1);
    expect(h.notices.at(-1)).toEqual({ level: 'error', message: `IG: ${message}`, profileId: 'default' });
    await advance(10 * 60_000);
    expect(prepare).toHaveBeenCalledTimes(10);
  });

  it('only counts takedowns inside the window', async () => {
    const lives = Array.from({ length: 6 }, () => igLive());
    const prepare = scripted(lives.map((l) => l.live));
    const h = igHarness(prepare, {}, { timings: { recoveryLoopMax: 3, recoveryLoopWindowMs: 10 * 60_000 } });
    await liveNow(h);
    const kill = async (i: number, afterMs: number) => {
      await advance(afterMs);
      lives[i]!.health.emit({ type: 'ended', reason: TAKEDOWN });
      await flush();
      h.pushes.running('ig');
      await flush();
    };
    await kill(0, 60_000); // t = 1 min
    await kill(1, 5 * 60_000); // t = 6 min
    await kill(2, 6 * 60_000); // t = 12 min: the 1 min one has left the window
    expect(h.destState('ig')).toMatchObject({ phase: 'live', recoveries: 3 });
    await kill(3, 60_000); // t = 13 min: 3 within 10 min
    expect(h.phase('ig')).toBe('error');
    expect(h.destState('ig').message).toContain('ended the live 3 times within 10 min');
    expect(prepare).toHaveBeenCalledTimes(4);
  });
});

describe('teardown during recovery', () => {
  it('stop while the new live is being prepared: nothing leaks, no further prepare', async () => {
    const a = igLive();
    let finish!: (p: PreparedLive) => void;
    const b = igLive();
    const prepare = scripted([a.live, new Promise<PreparedLive>((r) => (finish = r))]);
    const h = igHarness(prepare);
    await liveNow(h);
    a.health.emit({ type: 'ended', reason: TAKEDOWN });
    await flush();
    expect(h.phase('ig')).toBe('recovering');

    await h.orch.stop();
    expect(h.orch.state().status).toBe('offline');
    expect(h.phase('ig')).toBe('idle');
    expect(h.contexts[1]?.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    finish(b.live); // late result: ended, never pushed
    await flush();
    expect(b.live.end).toHaveBeenCalledTimes(1);
    expect(h.pushes.starts).toHaveLength(1);
    await advance(10 * 60_000);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(b.health.signals).toHaveLength(0);
    expect(h.chat.attaches.every((c) => c.signal.aborted)).toBe(true);
    expect(h.phase('ig')).toBe('idle');
  });

  it('stop during the backoff between attempts cancels the next attempt', async () => {
    const a = igLive();
    const prepare = scripted([a.live, new Error('upstream 500'), igLive().live]);
    const h = igHarness(prepare);
    await liveNow(h);
    a.health.emit({ type: 'ended', reason: TAKEDOWN });
    await flush();
    expect(h.destState('ig').message).toContain('trying again');
    await h.orch.stop();
    expect(vi.getTimerCount()).toBe(0);
    await advance(10 * 60_000);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(h.phase('ig')).toBe('idle');
  });

  it('stop while the push to the new live is connecting cancels the attempt deadline', async () => {
    const a = igLive();
    const b = igLive();
    const prepare = scripted([a.live, b.live, igLive().live]);
    const h = igHarness(prepare);
    await liveNow(h);
    a.health.emit({ type: 'ended', reason: TAKEDOWN });
    await flush();
    h.pushes.emit('ig', 'retrying', { message: REJECTED, attempt: 1 });
    await flush();
    await h.orch.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(b.live.end).toHaveBeenCalledTimes(1);
    await advance(10 * 60_000);
    expect(h.pushes.starts).toHaveLength(2);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(h.phase('ig')).toBe('idle');
  });

  it('stop while the new live is confirming ends it and stops its push', async () => {
    const a = igLive();
    const b = igLive({ confirm: vi.fn(() => new Promise<void>(() => {})) });
    const prepare = scripted([a.live, b.live]);
    const h = igHarness(prepare);
    await liveNow(h);
    a.health.emit({ type: 'ended', reason: TAKEDOWN });
    await flush();
    h.pushes.running('ig');
    await flush();
    expect(h.phase('ig')).toBe('recovering');
    await h.orch.stop();
    expect(b.live.end).toHaveBeenCalledTimes(1);
    expect(h.pushes.isRunning('ig')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await advance(10 * 60_000);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('a stopped session ignores late health events and push-down timers', async () => {
    const a = igLive();
    const prepare = scripted([a.live, igLive().live]);
    const h = igHarness(prepare);
    await liveNow(h);
    h.pushes.emit('ig', 'retrying', { message: 'Connection refused', attempt: 1 });
    await flush();
    await h.orch.stop();
    a.health.emit({ type: 'ended', reason: TAKEDOWN });
    await advance(60_000);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(a.live.end).toHaveBeenCalledTimes(1);
    expect(h.notices.some((n) => n.level === 'warn')).toBe(false);
  });
});

describe('links option edits mid-session', () => {
  it('do not restart the live; other option edits still do', async () => {
    const a = igLive();
    const b = igLive();
    const prepare = scripted([a.live, b.live]);
    const h = igHarness(prepare);
    h.dests.set('ig', { ...h.dests.get('ig')!, options: { links: [], linkMode: 'rotate' } });
    await liveNow(h);

    h.dests.set('ig', {
      ...h.dests.get('ig')!,
      options: { links: [{ title: 'Kick', url: 'https://kick.com/dprtmnttoronto' }], linkMode: 'rotate' },
    });
    await h.orch.destinationChanged('ig');
    await flush();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(a.live.end).not.toHaveBeenCalled();
    expect(h.phase('ig')).toBe('live');

    h.dests.set('ig', { ...h.dests.get('ig')!, options: { ...h.dests.get('ig')!.options, linkMode: 'first' } });
    await h.orch.destinationChanged('ig');
    await flush();
    expect(a.live.end).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('a pre-upgrade destination: a save that only backfills new option defaults does not restart the live', async () => {
    // Instagram's fields; a destination created before Stream Guard has only audience + goLiveTimeoutSec.
    const fields: FieldSpec[] = [
      {
        key: 'audience',
        label: 'Audience',
        type: 'select',
        default: 'public',
        options: [
          { value: 'public', label: 'Public' },
          { value: 'practice', label: 'Practice' },
        ],
      },
      { key: 'goLiveTimeoutSec', label: 'Go-live timeout', type: 'number', default: 90 },
      { key: 'autoRecover', label: 'Auto-recover', type: 'boolean', default: true },
      { key: 'takedownConfirmSec', label: 'Takedown confirm', type: 'number', default: 5 },
      { key: 'zeroViewerSec', label: 'Zero viewers', type: 'number', default: 0 },
      ...LINK_FIELDS,
    ];
    const a = igLive();
    const prepare = scripted([a.live, igLive().live]);
    const h = harness({
      // `retired` is a stale key of a removed field: a save drops it.
      dests: [dest('ig', { platform: 'instagram', name: 'IG', options: { audience: 'practice', goLiveTimeoutSec: 60, retired: 1 } })],
      drivers: [driver('instagram', { prepare }, { name: 'Instagram', destinationFields: fields })],
    });
    await liveNow(h);
    const save = async (input: Record<string, unknown>) => {
      const current = h.dests.get('ig')!;
      h.dests.set('ig', { ...current, options: normalizeFields(fields, input, current.options) });
      await h.orch.destinationChanged('ig');
      await flush();
    };

    await save({ links: [{ title: 'Kick', url: 'https://kick.com/dprtmnttoronto' }] });
    expect(h.dests.get('ig')!.options).toEqual({
      audience: 'practice',
      goLiveTimeoutSec: 60,
      autoRecover: true,
      takedownConfirmSec: 5,
      zeroViewerSec: 0,
      links: [{ title: 'Kick', url: 'https://kick.com/dprtmnttoronto' }],
      linkMode: 'rotate',
    });
    await save({ goLiveTimeoutSec: '60', zeroViewerSec: '' }); // same effective values
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(a.live.end).not.toHaveBeenCalled();
    expect(h.phase('ig')).toBe('live');

    // A real change still restarts: autoRecover is fixed into the current live when it is prepared.
    await save({ autoRecover: false });
    expect(a.live.end).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(2);
  });
});
