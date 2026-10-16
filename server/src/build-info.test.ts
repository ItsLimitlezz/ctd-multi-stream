import { describe, expect, it } from 'vitest';
import { buildInfo, loadConfig } from './config.js';

describe('build info', () => {
  it('takes the short commit and an ISO build time from the image', () => {
    expect(buildInfo('D6B0C9E1234567890abcdef1234567890abcdef1', '2026-10-17T05:30:00Z')).toEqual({
      commit: 'd6b0c9e',
      date: '2026-10-17T05:30:00.000Z',
    });
  });

  it('a local build (or junk) has none', () => {
    expect(buildInfo(undefined, undefined)).toEqual({ commit: null, date: null });
    expect(buildInfo('not-a-sha', 'yesterday')).toEqual({ commit: null, date: null });
    expect(loadConfig({ CTD_BUILD_COMMIT: 'abc1234', CTD_BUILD_DATE: '' }, '0.1.0').build).toEqual({ commit: 'abc1234', date: null });
  });
});
