// Small fakes shared by the media module's unit tests (no runtime use).

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import pino, { type Logger } from 'pino';
import type { ScopedSecrets } from '../services.js';

/** Minimal ChildProcess stand-in: piped stdout/stderr, kill() and scripted exits. */
export class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: (NodeJS.Signals | number | undefined)[] = [];
  /** Signals the fake ignores (to test SIGKILL escalation). */
  ignore = new Set<string>();

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    if (this.ignore.has(String(signal ?? 'SIGTERM'))) return true;
    this.exit(null, typeof signal === 'string' ? signal : 'SIGTERM');
    return true;
  }

  /** Simulate the process ending (emits 'exit' then 'close'). */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }

  /** Simulate a spawn failure (ENOENT etc.). */
  failToSpawn(code = 'ENOENT'): void {
    this.pid = undefined;
    const err = Object.assign(new Error(`spawn fake ${code}`), { code });
    this.emit('error', err);
    this.emit('close', -2, null);
  }

  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

export interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  child: FakeChild;
}

/** Spawn function that records calls and returns FakeChild instances. */
export function fakeSpawn() {
  const calls: SpawnCall[] = [];
  const spawn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    const child = new FakeChild();
    calls.push({ command, args, options, child });
    return child.asChild();
  };
  return { spawn, calls, last: () => calls.at(-1) };
}

export function memorySecrets(initial: Record<string, string> = {}): ScopedSecrets & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => {
      data.set(k, v);
    },
    delete: async (k) => {
      data.delete(k);
    },
    getJson: async <T>(k: string) => {
      const v = data.get(k);
      return v === undefined ? null : (JSON.parse(v) as T);
    },
    setJson: async (k, v) => {
      data.set(k, JSON.stringify(v));
    },
  };
}

/** pino logger that records every line (to assert that secrets never reach logs). */
export function captureLogger(): { log: Logger; text: () => string } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { log: pino({ level: 'trace' }, sink), text: () => chunks.join('') };
}

/** Let pending stream 'data' events and promise callbacks run. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((r) => process.nextTick(r));
}
