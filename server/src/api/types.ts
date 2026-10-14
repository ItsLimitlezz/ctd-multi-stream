// Wire types of the external API v1 (docs/API.md). Server-side only: the web UI never reads /api/v1.

import type {
  ApiScope,
  DestinationPhase,
  Feed,
  FeedState,
  PlatformId,
  PushStats,
  SessionStatus,
} from '../../../shared/types.js';

export const CONNECTOR = 'ctd-multi-stream';
export const CORE = 'core';

export type ApiEventType =
  | 'chat.message'
  | 'chat.message.deleted'
  | 'chat.user.cleared'
  | 'chat.cleared'
  | 'stream.status'
  | 'feed.status'
  | 'destination.status'
  | 'destination.down'
  | 'destination.up'
  | 'system.notice'
  | 'system.reset';

/** Scope each event type needs. system.reset is a control frame every stream may get. */
export const EVENT_SCOPES: Record<ApiEventType, ApiScope | null> = {
  'chat.message': 'chat:read',
  'chat.message.deleted': 'chat:read',
  'chat.user.cleared': 'chat:read',
  'chat.cleared': 'chat:read',
  'stream.status': 'status:read',
  'feed.status': 'status:read',
  'destination.status': 'status:read',
  'destination.down': 'status:read',
  'destination.up': 'status:read',
  'system.notice': 'status:read',
  'system.reset': null,
};

export const EVENT_TYPES = Object.keys(EVENT_SCOPES) as ApiEventType[];

export interface EnvelopeSource {
  connector: typeof CONNECTOR;
  /** Destination id, or 'core' for session-wide events. */
  connection: string;
  /** PlatformId, or 'core'. */
  platform: PlatformId | typeof CORE;
}

export interface Envelope<T = unknown> {
  id: string;
  type: ApiEventType;
  ts: number;
  src: EnvelopeSource;
  data: T;
}

// ---- status ----

export interface ApiSession {
  status: SessionStatus;
  startedAt: string | null;
  title: string;
  testMode: boolean;
  autoGoLive: boolean;
}

export type ApiFeed = FeedState;

export interface ApiDestination {
  id: string;
  name: string;
  platform: PlatformId;
  feed: Feed;
  enabled: boolean;
  phase: DestinationPhase;
  live: boolean;
  down: boolean;
  message: string | null;
  stats: PushStats | null;
  viewers: number | null;
  watchUrl: string | null;
  recoveries: number;
  lastRecovery: { at: string; reason: string } | null;
  since: string;
}

export interface ApiPlatform {
  platform: PlatformId;
  destinations: string[];
  live: boolean;
  title: string;
  /** Epoch ms since the first of its destinations went live, or null. */
  startedAt: number | null;
  viewers: number | null;
  error: string | null;
}

export interface ApiStatus {
  session: ApiSession;
  feeds: ApiFeed[];
  destinations: ApiDestination[];
  platforms: ApiPlatform[];
}

// ---- chat ----

export type ApiRole = 'broadcaster' | 'moderator' | 'vip' | 'subscriber' | 'member' | 'verified' | 'founder' | 'artist' | 'bot';
export const API_ROLES: readonly ApiRole[] = ['broadcaster', 'moderator', 'vip', 'subscriber', 'member', 'verified', 'founder', 'artist', 'bot'];

export interface ApiChatFragment {
  type: 'text' | 'emote' | 'mention' | 'link' | 'cheermote';
  text: string;
  image?: string;
  animated?: boolean;
  url?: string;
  userId?: string;
  amount?: number;
}

export interface ApiChatMessage {
  id: string;
  platform: PlatformId;
  channel: string;
  destinationId: string;
  platformMessageId: string | null;
  user: {
    id: string;
    login: string | null;
    name: string;
    color: string | null;
    avatar: string | null;
    badges: { id: string; label: string }[];
    roles: ApiRole[];
  };
  text: string;
  fragments: ApiChatFragment[];
  reply: { messageId: string | null; userName: string | null; text: string | null } | null;
  highlighted: boolean;
  action: boolean;
  kind: 'message' | 'event';
  ts: number;
}

export interface ApiChatMessageDeleted {
  messageId: string;
  platformMessageId: string;
  platform: PlatformId;
  destinationId: string;
}

export interface ApiChatUserCleared {
  userId: string | null;
  userName: string | null;
  platform: PlatformId;
  destinationId: string;
}

export interface ApiChatCleared {
  platform: PlatformId;
  destinationId: string;
}

export interface ApiDestinationDown {
  destinationId: string;
  name: string;
  platform: PlatformId;
  phase: DestinationPhase;
  reason: string | null;
}

export interface ApiDestinationUp {
  destinationId: string;
  name: string;
  platform: PlatformId;
  downForSec: number;
  recoveries: number;
}

export interface ApiNotice {
  level: 'info' | 'warn' | 'error';
  message: string;
}
