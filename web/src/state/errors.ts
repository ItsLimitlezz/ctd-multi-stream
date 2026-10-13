// Turn API/network errors into short user-facing messages.

import { ApiRequestError } from '../api';

export function isApiError(err: unknown, status?: number, code?: string): err is ApiRequestError {
  if (!(err instanceof ApiRequestError)) return false;
  if (status !== undefined && err.status !== status) return false;
  if (code !== undefined && err.code !== code) return false;
  return true;
}

/** fetch() rejects with TypeError when the server can't be reached. */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.code === 'csrf') return 'Your security token expired. Reload the page and try again.';
    if (err.status === 429) return err.message || 'Too many requests. Wait a moment and try again.';
    if (err.status === 403 && err.code === 'forbidden') return 'Only admins can do that.';
    if (err.status >= 500 && !err.message) return 'The server hit an error. Check the container logs.';
    return err.message || `Request failed (${err.status})`;
  }
  if (isNetworkError(err)) return "Can't reach the server. Check your connection.";
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong.';
}

/** Login form errors. Returns '' for the TOTP challenge itself (not an error). */
export function loginErrorMessage(err: unknown, totpSent: boolean): string {
  if (err instanceof ApiRequestError) {
    if (err.code === 'totp_required') {
      return totpSent ? "That code didn't work. Check your authenticator app (and your phone's clock) and try again." : '';
    }
    if (err.status === 423 || err.code === 'locked') {
      return err.message || 'This account is temporarily locked after too many failed attempts. Try again later.';
    }
    if (err.status === 429 || err.code === 'rate_limited') {
      return err.message || 'Too many sign-in attempts from your network. Wait a few minutes and try again.';
    }
    if (err.status === 401) return 'Invalid username or password.';
  }
  return errorMessage(err);
}

/** Setup form errors. */
export function setupErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 403 && err.code !== 'csrf') {
      return "That setup code isn't right. Use the code from the latest container logs — a new one is printed every time the app restarts.";
    }
    if (err.status === 409) return 'This instance is already set up. Sign in instead.';
    if (err.status === 429) return err.message || 'Too many attempts. Wait a minute and try again.';
  }
  return errorMessage(err);
}
