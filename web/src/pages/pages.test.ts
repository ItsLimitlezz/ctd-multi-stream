import { describe, expect, it } from 'vitest';
import type { WsServerMessage } from '@shared/api';
import type { ChatMessage, Feed, FeedState, PlatformId, SessionState } from '@shared/types';
import { LiveStore } from '../state/live-store';
import { chatPlatforms, filterChat } from './ChatPage';
import { applySessionResult, statusSubtitle } from './DashboardPage';
import { groupSecret, validatePasswordChange } from './ProfilePage';
import { validateSetup } from './SetupPage';

const msg = (id: string, platform: PlatformId): ChatMessage => ({
  id,
  platform,
  destinationId: 'd',
  author: { name: 'a' },
  text: 't',
  ts: '2026-10-11T10:00:00.000Z',
  kind: 'message',
});

describe('page helpers', () => {
  it('validates the setup form', () => {
    expect(validateSetup({ setupCode: '', username: ' ', password: 'short', confirm: 'x' })).toEqual({
      setupCode: expect.any(String),
      username: expect.any(String),
      password: expect.stringContaining('10'),
      confirm: expect.any(String),
    });
    expect(validateSetup({ setupCode: 'ABCD-EFGH-JKLM', username: 'admin', password: 'long enough pw', confirm: 'long enough pw' })).toEqual({});
  });

  it('validates password changes', () => {
    expect(validatePasswordChange('', 'short', 'other')).toEqual({
      current: expect.any(String),
      next: expect.any(String),
      confirm: expect.any(String),
    });
    expect(validatePasswordChange('same password', 'same password', 'same password').next).toMatch(/different/);
    expect(validatePasswordChange('old password', 'new password!', 'new password!')).toEqual({});
  });

  it('groups TOTP secrets for reading', () => {
    expect(groupSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
    expect(groupSecret('ABCDEF')).toBe('ABCD EF');
  });

  it('lists chat platforms in standard order with counts and filters', () => {
    const chat = [msg('1', 'youtube'), msg('2', 'twitch'), msg('3', 'youtube')];
    expect(chatPlatforms(chat, new Set())).toEqual([
      { id: 'twitch', count: 1 },
      { id: 'youtube', count: 2 },
    ]);
    expect(chatPlatforms(chat, new Set<PlatformId>(['kick'])).map((p) => p.id)).toEqual(['twitch', 'youtube', 'kick']);
    expect(filterChat(chat, new Set()).length).toBe(3);
    expect(filterChat(chat, new Set<PlatformId>(['youtube'])).map((m) => m.id)).toEqual(['1', '3']);
  });
});

const feed = (f: Feed, online: boolean): FeedState => ({ feed: f, online, since: null, video: null, audio: null, bitrateKbps: null });
const session = (over: Partial<SessionState> = {}): SessionState => ({
  status: 'offline',
  sessionId: null,
  startedAt: null,
  title: 't',
  autoGoLive: true,
  feeds: [feed('landscape', false), feed('vertical', false)],
  destinations: [],
  ...over,
});

describe('dashboard status', () => {
  it('only says "Waiting for OBS" while no feed is online', () => {
    expect(statusSubtitle(session())).toMatch(/^Waiting for OBS/);
    // After a manual stop with OBS still streaming, nothing starts by itself.
    const obsOn = statusSubtitle(session({ feeds: [feed('landscape', true), feed('vertical', false)] }));
    expect(obsOn).toMatch(/^OBS is streaming/);
    expect(obsOn).toContain('Go live');
    expect(statusSubtitle(session({ autoGoLive: false }))).toBe('Press "Go live" when you are ready.');
    expect(statusSubtitle(session({ autoGoLive: false, feeds: [feed('landscape', true)] }))).toBe('Press "Go live" when you are ready.');
  });

  it("the auto toggle's REST snapshot doesn't undo a newer WebSocket 'live'", () => {
    const store = new LiveStore();
    store.dispatch({ type: 'hello', session: session({ autoGoLive: false }), chat: [] } as WsServerMessage);
    // The auto start triggered by the toggle reaches the socket before the PUT's reply.
    store.dispatch({ type: 'session', session: session({ status: 'live', sessionId: 's1', autoGoLive: true }) });
    applySessionResult('auto', session({ status: 'offline', autoGoLive: true }), store);
    expect(store.getState().session).toMatchObject({ status: 'live', sessionId: 's1', autoGoLive: true });

    // Start / stop answer after the operation finished: their snapshot replaces the state.
    applySessionResult('stop', session({ status: 'offline', autoGoLive: true }), store);
    expect(store.getState().session?.status).toBe('offline');
  });
});
