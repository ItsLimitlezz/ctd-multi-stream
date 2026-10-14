import { EventEmitter } from 'node:events';
import type {
  Account,
  ChatMessage,
  ChatModeration,
  DestinationState,
  FeedState,
  PushStats,
  SessionState,
} from '../../shared/types.js';

/**
 * State reported by the FFmpeg supervisor for one push (keyed by destination id).
 * 'failed' is final (retrying can't help, e.g. FFmpeg missing or an unsupported plan): the push is no
 * longer supervised and the orchestrator treats it as an error.
 */
export type PushStatus = 'starting' | 'running' | 'retrying' | 'stopped' | 'failed';

export interface PushEvent {
  id: string;
  status: PushStatus;
  message: string | null;
  stats: PushStats | null;
  attempt: number;
}

export interface AppEvents {
  /** A feed went online/offline or its stats changed (emitted by MediaServer). */
  feed: [FeedState];
  /** FFmpeg push status changes and periodic stats (emitted by PushSupervisor). */
  push: [PushEvent];
  /** Full session snapshot (emitted by Orchestrator on any session-level change). */
  session: [SessionState];
  /** One destination's state changed (emitted by Orchestrator). */
  destination: [DestinationState];
  /** New chat message (emitted by ChatHub). */
  chat: [ChatMessage];
  /** Chat removed by moderation: deleted message, banned/timed-out user, cleared chat (emitted by ChatHub). */
  'chat-moderation': [ChatModeration];
  /** Account changed (status, label...) (emitted by account routes / drivers via DriverContext). */
  account: [Account];
  /** Destination list or config changed (emitted by destination routes). */
  'destinations-changed': [];
  /** User-facing notice (any component). */
  notice: [{ level: 'info' | 'warn' | 'error'; message: string }];
}

/** Typed wrapper around EventEmitter. */
export class EventBus {
  private readonly ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(100);
  }

  emit<K extends keyof AppEvents>(event: K, ...args: AppEvents[K]): void {
    this.ee.emit(event, ...args);
  }

  on<K extends keyof AppEvents>(event: K, listener: (...args: AppEvents[K]) => void): () => void {
    this.ee.on(event, listener as (...a: unknown[]) => void);
    return () => this.ee.off(event, listener as (...a: unknown[]) => void);
  }

  once<K extends keyof AppEvents>(event: K, listener: (...args: AppEvents[K]) => void): () => void {
    this.ee.once(event, listener as (...a: unknown[]) => void);
    return () => this.ee.off(event, listener as (...a: unknown[]) => void);
  }
}
