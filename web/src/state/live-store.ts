// Framework-free live state: reducer for WsServerMessage, the store, and a reconnecting
// WebSocket client. React bindings live in live.tsx.

import type { WsServerMessage } from '@shared/api';
import type { Account, ChatMessage, SessionState } from '@shared/types';

export const CHAT_LIMIT = 500;
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 15_000;

export interface LiveState {
  /** WebSocket open and greeted by the server. */
  connected: boolean;
  /** Number of successful connections (hello messages) so far. */
  connections: number;
  session: SessionState | null;
  /** Combined chat, oldest first, capped at CHAT_LIMIT. */
  chat: ChatMessage[];
  /** Latest account updates pushed by the server, by id. */
  accounts: Readonly<Record<string, Account>>;
  /** Bumped on every 'account' message and on reconnect. */
  accountsVersion: number;
  /** Bumped on every 'destinations-changed' message and on reconnect. */
  destinationsVersion: number;
}

export const initialLiveState: LiveState = {
  connected: false,
  connections: 0,
  session: null,
  chat: [],
  accounts: {},
  accountsVersion: 0,
  destinationsVersion: 0,
};

// ---------------------------------------------------------------------------
// Parsing + reducer
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse one WebSocket frame. Unknown or malformed messages return null (ignored). */
export function parseServerMessage(raw: unknown): WsServerMessage | null {
  if (typeof raw !== 'string') return null;
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(d)) return null;
  switch (d.type) {
    case 'hello':
      return isObject(d.session) && Array.isArray(d.chat) ? (d as WsServerMessage) : null;
    case 'session':
      return isObject(d.session) ? (d as WsServerMessage) : null;
    case 'feed':
      return isObject(d.feed) ? (d as WsServerMessage) : null;
    case 'destination':
      return isObject(d.state) ? (d as WsServerMessage) : null;
    case 'chat':
      return isObject(d.message) ? (d as WsServerMessage) : null;
    case 'account':
      return isObject(d.account) ? (d as WsServerMessage) : null;
    case 'destinations-changed':
      return d as WsServerMessage;
    case 'notice':
      return typeof d.message === 'string' ? (d as WsServerMessage) : null;
    default:
      return null;
  }
}

function tsOf(m: ChatMessage): number {
  const t = Date.parse(m.ts);
  return Number.isNaN(t) ? 0 : t;
}

/** Append new messages (deduplicated by id), keep chronological order, cap the length. */
export function mergeChat(existing: ChatMessage[], incoming: readonly ChatMessage[], limit = CHAT_LIMIT): ChatMessage[] {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map((m) => m.id));
  const added: ChatMessage[] = [];
  for (const m of incoming) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    added.push(m);
  }
  if (added.length === 0) return existing;
  const merged = existing.concat(added);
  // Fast path: live messages arrive in order. Otherwise (e.g. history after a reconnect) sort.
  let ordered = true;
  for (let i = Math.max(1, existing.length); i < merged.length; i++) {
    if (tsOf(merged[i] as ChatMessage) < tsOf(merged[i - 1] as ChatMessage)) {
      ordered = false;
      break;
    }
  }
  if (!ordered) merged.sort((a, b) => tsOf(a) - tsOf(b));
  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}

function upsert<T>(list: readonly T[], item: T, same: (x: T) => boolean): T[] {
  const i = list.findIndex(same);
  if (i === -1) return [...list, item];
  const copy = list.slice();
  copy[i] = item;
  return copy;
}

export function reduceLive(state: LiveState, msg: WsServerMessage): LiveState {
  switch (msg.type) {
    case 'hello': {
      // On a reconnect, anything may have changed while we were away: let pages refetch.
      const bump = state.connections > 0 ? 1 : 0;
      return {
        ...state,
        connections: state.connections + 1,
        session: msg.session,
        chat: mergeChat(state.chat, msg.chat),
        accountsVersion: state.accountsVersion + bump,
        destinationsVersion: state.destinationsVersion + bump,
      };
    }
    case 'session':
      return { ...state, session: msg.session };
    case 'feed':
      if (!state.session) return state;
      return {
        ...state,
        session: { ...state.session, feeds: upsert(state.session.feeds, msg.feed, (f) => f.feed === msg.feed.feed) },
      };
    case 'destination':
      if (!state.session) return state;
      return {
        ...state,
        session: {
          ...state.session,
          destinations: upsert(
            state.session.destinations,
            msg.state,
            (d) => d.destinationId === msg.state.destinationId,
          ),
        },
      };
    case 'chat': {
      const chat = mergeChat(state.chat, [msg.message]);
      return chat === state.chat ? state : { ...state, chat };
    }
    case 'account':
      return {
        ...state,
        accounts: { ...state.accounts, [msg.account.id]: msg.account },
        accountsVersion: state.accountsVersion + 1,
      };
    case 'destinations-changed':
      return { ...state, destinationsVersion: state.destinationsVersion + 1 };
    case 'notice':
      return state;
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class LiveStore {
  private state: LiveState = initialLiveState;
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(msg: WsServerMessage) => void>();

  getState = (): LiveState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Raw message listeners (called after the state is updated). */
  onEvent = (listener: (msg: WsServerMessage) => void): (() => void) => {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  };

  dispatch(msg: WsServerMessage): void {
    this.set(reduceLive(this.state, msg));
    for (const l of this.eventListeners) {
      try {
        l(msg);
      } catch (err) {
        console.error('live event listener failed', err);
      }
    }
  }

  setConnected(connected: boolean): void {
    if (this.state.connected !== connected) this.set({ ...this.state, connected });
  }

  /** Apply a SessionState returned by a REST call (e.g. start/stop). */
  applySession(session: SessionState): void {
    this.set({ ...this.state, session });
  }

  /** Use a REST snapshot only while the WebSocket hasn't delivered one yet. */
  seedSession(session: SessionState): void {
    if (!this.state.session) this.applySession(session);
  }

  /** Merge fields into the current session (e.g. the title after a successful update). */
  patchSession(patch: Partial<SessionState>): void {
    if (this.state.session) this.applySession({ ...this.state.session, ...patch });
  }

  mergeChat(messages: readonly ChatMessage[]): void {
    const chat = mergeChat(this.state.chat, messages);
    if (chat !== this.state.chat) this.set({ ...this.state, chat });
  }

  reset(): void {
    this.set(initialLiveState);
  }

  private set(next: LiveState): void {
    if (next === this.state) return;
    this.state = next;
    for (const l of this.listeners) l();
  }
}

// ---------------------------------------------------------------------------
// Reconnecting WebSocket client
// ---------------------------------------------------------------------------

/** The subset of WebSocket we use (lets tests inject a fake). */
export interface SocketLike {
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}

export interface LiveConnectionOptions {
  url: () => string;
  onMessage: (msg: WsServerMessage) => void;
  onConnectedChange: (connected: boolean) => void;
  /**
   * Called before reconnecting when the previous attempt never got a 'hello' (upgrade
   * rejected or server down). Resolve false to stop for good (session expired).
   */
  checkAuth?: () => Promise<boolean>;
  createSocket?: (url: string) => SocketLike;
}

/** 1 s, 2 s, 4 s, 8 s, then 15 s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, Math.min(attempt, 10)));
}

const defaultCreateSocket = (url: string): SocketLike => new WebSocket(url) as unknown as SocketLike;

export class LiveConnection {
  private socket: SocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = true;
  private greeted = false;
  private connected = false;
  /** Generation counter so late async callbacks from an old attempt are ignored. */
  private gen = 0;

  constructor(private readonly opts: LiveConnectionOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.gen++;
    this.clearTimer();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close(1000, 'bye');
      } catch {
        /* already closed */
      }
    }
    this.setConnected(false);
  }

  /** Reconnect right away if we're waiting to retry (network back, tab visible again). */
  kick(): void {
    if (this.stopped || this.socket || !this.timer) return;
    this.clearTimer();
    this.attempt = 0;
    this.open();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private open(): void {
    const gen = ++this.gen;
    this.greeted = false;
    let s: SocketLike;
    try {
      s = (this.opts.createSocket ?? defaultCreateSocket)(this.opts.url());
    } catch {
      this.scheduleReconnect(gen);
      return;
    }
    this.socket = s;
    const current = () => gen === this.gen && this.socket === s;
    s.onmessage = (ev) => {
      if (!current()) return;
      const msg = parseServerMessage(ev.data);
      if (!msg) return;
      if (msg.type === 'hello') {
        this.greeted = true;
        this.attempt = 0;
        this.setConnected(true);
      }
      this.opts.onMessage(msg);
    };
    s.onclose = (ev) => {
      if (!current()) return;
      this.socket = null;
      // 4401 = the server ended our session (logout, expiry, user removed): re-check auth before
      // reconnecting, which sends the app to the login page.
      if ((ev as { code?: number } | null)?.code === 4401) this.greeted = false;
      this.setConnected(false);
      this.scheduleReconnect(gen);
    };
    s.onerror = () => {
      /* 'close' always follows */
    };
  }

  private scheduleReconnect(gen: number): void {
    if (this.stopped) return;
    const needsAuthCheck = !this.greeted && this.opts.checkAuth !== undefined;
    const delay = reconnectDelay(this.attempt++);
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped || gen !== this.gen) return;
      if (!needsAuthCheck || !this.opts.checkAuth) {
        this.open();
        return;
      }
      this.opts.checkAuth().then(
        (ok) => {
          if (this.stopped || gen !== this.gen || this.socket) return;
          if (ok) this.open();
          else this.stop();
        },
        () => {
          if (!this.stopped && gen === this.gen && !this.socket) this.open();
        },
      );
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.opts.onConnectedChange(connected);
  }
}
