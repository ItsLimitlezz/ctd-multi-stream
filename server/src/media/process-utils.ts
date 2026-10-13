import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Readable } from 'node:stream';

/** Injectable spawn (tests pass a fake). Must return a process with piped stdout/stderr. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export const defaultSpawn: SpawnFn = (command, args, options) => nodeSpawn(command, args, options);

/** Call `onLine` for each complete line of a stream (handles \r\n and partial chunks). */
export function onLines(stream: Readable | null | undefined, onLine: (line: string) => void, maxLine = 64 * 1024): void {
  if (!stream) return;
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.search(/[\r\n]/)) >= 0) {
      if (buf[idx] === '\r' && idx === buf.length - 1) break; // may be a \r\n split across chunks
      const line = buf.slice(0, idx);
      buf = buf.slice(buf[idx] === '\r' && buf[idx + 1] === '\n' ? idx + 2 : idx + 1);
      onLine(line);
    }
    if (buf.length > maxLine) buf = buf.slice(-maxLine); // never grow without bound
  });
  stream.on('end', () => {
    const rest = buf.replace(/\r$/, '');
    buf = '';
    if (rest) onLine(rest);
  });
  stream.on('error', () => {
    // the process 'close'/'error' handlers report failures
  });
}

export function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

/** Resolves when the process has exited (immediately if it already has). */
export function waitForExit(proc: ChildProcess): Promise<void> {
  if (hasExited(proc)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      proc.off('exit', done);
      proc.off('error', onError);
      resolve();
    };
    // A spawn failure emits 'error' without 'exit'.
    const onError = () => {
      if (proc.pid === undefined) done();
    };
    proc.on('exit', done);
    proc.on('error', onError);
  });
}

/**
 * Ask a process to stop (SIGTERM), then SIGKILL after `graceMs`. On Windows `kill()` always
 * terminates immediately. Resolves once the process has exited.
 */
export async function terminate(proc: ChildProcess, graceMs = 5_000): Promise<void> {
  if (hasExited(proc) || proc.pid === undefined) return;
  const exited = waitForExit(proc);
  try {
    proc.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
  } catch {
    // already gone
  }
  if ((await raceTimeout(exited, graceMs)) === 'timeout') {
    try {
      proc.kill('SIGKILL');
    } catch {
      // already gone
    }
    await raceTimeout(exited, 2_000); // don't hang shutdown on an unkillable process
  }
}

async function raceTimeout(p: Promise<void>, ms: number): Promise<'done' | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([p.then(() => 'done' as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
