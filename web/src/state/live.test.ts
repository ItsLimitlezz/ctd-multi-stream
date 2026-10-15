import { describe, expect, it } from 'vitest';
import type { WsServerMessage } from '@shared/api';
import { liveSocketPath, noticeProfileId, storeShowsProfile } from './live';

describe('live bindings helpers', () => {
  it('the socket path carries the profile', () => {
    expect(liveSocketPath('club')).toBe('/api/ws?profile=club');
  });

  it("hides the previous profile's live data until the store follows a profile switch", () => {
    expect(storeShowsProfile({ profileId: 'club' }, 'club')).toBe(true);
    expect(storeShowsProfile({ profileId: null }, 'club')).toBe(true); // nothing connected yet
    expect(storeShowsProfile({ profileId: 'default' }, 'club')).toBe(false);
  });

  it("reads a notice's profile only when the server stamps one", () => {
    const plain: WsServerMessage = { type: 'notice', level: 'warn', message: 'x' };
    expect(noticeProfileId(plain)).toBeNull();
    expect(noticeProfileId({ ...plain, profileId: 'club' } as WsServerMessage)).toBe('club');
    expect(noticeProfileId({ ...plain, profileId: 5 } as unknown as WsServerMessage)).toBeNull();
  });
});
