import { afterEach, describe, expect, it, vi } from 'vitest';
import { installProcessHandlers } from './main.js';

let uninstall: (() => void) | null = null;

afterEach(() => {
  uninstall?.();
  uninstall = null;
});

type ExceptionListener = (err: unknown, origin: string) => void;
type RejectionListener = (reason: unknown, promise: Promise<unknown>) => void;

/**
 * Installs the handlers and returns them. They are called directly rather than through
 * process.emit, which would also run the test runner's own crash handlers.
 */
function setup() {
  const log = { fatal: vi.fn(), error: vi.fn() };
  const exit = vi.fn();
  const before = { exception: process.listeners('uncaughtException'), rejection: process.listeners('unhandledRejection') };
  uninstall = installProcessHandlers(log, exit);
  const onException = process.listeners('uncaughtException').find((l) => !before.exception.includes(l)) as ExceptionListener | undefined;
  const onRejection = process.listeners('unhandledRejection').find((l) => !before.rejection.includes(l)) as RejectionListener | undefined;
  if (!onException || !onRejection) throw new Error('handlers not installed');
  return { log, exit, before, onException, onRejection };
}

describe('installProcessHandlers', () => {
  it('uncaught exception: logs it (without secrets) and exits non-zero once', () => {
    const { log, exit, onException } = setup();
    onException(new Error('connect failed rtmp://live.example.com/app/sk_live_123'), 'uncaughtException');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.fatal).toHaveBeenCalledTimes(1);
    const [fields, message] = log.fatal.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toMatch(/uncaught exception/);
    expect(fields).toMatchObject({ name: 'Error', origin: 'uncaughtException', error: expect.stringContaining('rtmp://live.example.com') });
    expect(JSON.stringify(fields)).not.toContain('sk_live_123');
    expect(typeof fields.stack).toBe('string');

    onException(new Error('again'), 'uncaughtException');
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('unhandled rejection: logs it and keeps running', () => {
    const { log, exit, onRejection } = setup();
    onRejection('plain reason https://api.example.com/x?token=secret', Promise.resolve());
    expect(exit).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
    const [fields, message] = log.error.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toBe('unhandled promise rejection');
    expect(fields.error).toContain('https://api.example.com/x');
    expect(JSON.stringify(fields)).not.toContain('secret');
  });

  it('a throwing logger still exits; the returned function removes the handlers', () => {
    const { log, exit, before, onException, onRejection } = setup();
    log.fatal.mockImplementation(() => {
      throw new Error('stdout closed');
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    onException(new Error('boom'), 'uncaughtException');
    expect(exit).toHaveBeenCalledWith(1);
    spy.mockRestore();

    uninstall?.();
    uninstall = null;
    expect(process.listeners('uncaughtException')).not.toContain(onException);
    expect(process.listeners('unhandledRejection')).not.toContain(onRejection);
    expect(process.listeners('uncaughtException')).toHaveLength(before.exception.length);
  });
});
