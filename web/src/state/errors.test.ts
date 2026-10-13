import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../api';
import { errorMessage, isApiError, loginErrorMessage, setupErrorMessage } from './errors';

describe('errorMessage', () => {
  it('uses the server message for API errors', () => {
    expect(errorMessage(new ApiRequestError(400, 'title: too long', 'invalid'))).toBe('title: too long');
    expect(errorMessage(new ApiRequestError(500, ''))).toMatch(/server/i);
  });

  it('special-cases CSRF, forbidden and network errors', () => {
    expect(errorMessage(new ApiRequestError(403, 'csrf', 'csrf'))).toMatch(/reload/i);
    expect(errorMessage(new ApiRequestError(403, 'Admin only', 'forbidden'))).toMatch(/admins/i);
    expect(errorMessage(new TypeError('Failed to fetch'))).toMatch(/reach the server/i);
    expect(errorMessage('weird')).toBe('Something went wrong.');
  });

  it('isApiError filters by status and code', () => {
    const e = new ApiRequestError(401, 'x', 'totp_required');
    expect(isApiError(e)).toBe(true);
    expect(isApiError(e, 401)).toBe(true);
    expect(isApiError(e, 403)).toBe(false);
    expect(isApiError(e, undefined, 'totp_required')).toBe(true);
    expect(isApiError(new Error('x'))).toBe(false);
  });
});

describe('loginErrorMessage', () => {
  it('treats the first TOTP challenge as a prompt, not an error', () => {
    const e = new ApiRequestError(401, 'Code required', 'totp_required');
    expect(loginErrorMessage(e, false)).toBe('');
    expect(loginErrorMessage(e, true)).toMatch(/code didn't work/i);
  });

  it('explains lockout, rate limiting and bad credentials', () => {
    expect(loginErrorMessage(new ApiRequestError(423, 'Account locked. Try again in 14 minutes.', 'locked'), false)).toBe(
      'Account locked. Try again in 14 minutes.',
    );
    expect(loginErrorMessage(new ApiRequestError(429, '', 'rate_limited'), false)).toMatch(/too many/i);
    expect(loginErrorMessage(new ApiRequestError(429, 'Too many attempts. Try again in 1 minute.'), false)).toMatch(/1 minute/);
    expect(loginErrorMessage(new ApiRequestError(401, 'Invalid username or password', 'invalid_credentials'), false)).toBe(
      'Invalid username or password.',
    );
  });
});

describe('setupErrorMessage', () => {
  it('explains a wrong setup code and an already-claimed instance', () => {
    expect(setupErrorMessage(new ApiRequestError(403, 'Invalid setup code'))).toMatch(/container logs/);
    expect(setupErrorMessage(new ApiRequestError(409, 'Already set up'))).toMatch(/already set up/i);
    expect(setupErrorMessage(new ApiRequestError(400, 'password: too short', 'invalid'))).toBe('password: too short');
  });
});
