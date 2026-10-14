// Hand-written OpenAPI 3.1 description of /api/v1 (served at /api/v1/openapi.json, no auth).
// Keep in sync with docs/API.md.

import { PLATFORM_IDS } from '../../../shared/types.js';
import { CURRENCY_RE, DECIMAL_RE } from './alert-map.js';
import { PROBLEM_TYPE } from './http.js';
import { ALERT_COUNT_UNITS, ALERT_KINDS, API_ROLES, EVENT_TYPES } from './types.js';

/** Minor revision of the v1 contract (additive changes only; see the changelog in docs/API.md). */
export const API_REVISION = '1.1';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (schema: object) => ({ oneOf: [schema, { type: 'null' }] });
const str = { type: 'string' };
const int = { type: 'integer' };
const num = { type: 'number' };
const bool = { type: 'boolean' };
const isoTime = { type: 'string', format: 'date-time' };
const epochMs = { type: 'integer', description: 'Epoch milliseconds' };

const PHASES = ['idle', 'disabled', 'waiting-for-feed', 'preparing', 'connecting', 'confirming', 'live', 'retrying', 'recovering', 'ending', 'error'];

function problemResponse(description: string) {
  return { description, content: { 'application/problem+json': { schema: ref('Problem') } } };
}

const errors = {
  '401': problemResponse('No, unknown or revoked token (`unauthenticated`)'),
  '429': {
    ...problemResponse('Over 600 requests/minute for this token (`rate_limited`)'),
    headers: { 'Retry-After': { schema: int, description: 'Seconds to wait' } },
  },
};

const typesParam = {
  name: 'types',
  in: 'query',
  required: false,
  description: 'Comma-separated event types or globs (`chat.*`, `destination.down`). Default: everything the token\'s scopes allow.',
  schema: str,
};

export function openApiDocument(version: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'CTD Multi-Stream external API',
      version: `${API_REVISION} (server ${version})`,
      description:
        'Read-only API for other apps (CTD Overlay, the CTD OBS plugin, bots). Create a token in Settings → API and send it as `Authorization: Bearer ctd_pat_…`. Full guide: docs/API.md.',
      license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
    },
    servers: [{ url: '/api/v1' }],
    security: [{ bearer: [] }],
    tags: [{ name: 'status' }, { name: 'chat' }, { name: 'events' }],
    paths: {
      '/': {
        get: {
          summary: 'Who am I',
          operationId: 'whoAmI',
          responses: { '200': { description: 'Server and token info', content: { 'application/json': { schema: ref('WhoAmI') } } }, ...errors },
        },
      },
      '/openapi.json': {
        get: {
          summary: 'This document',
          operationId: 'openApi',
          security: [],
          responses: { '200': { description: 'OpenAPI 3.1 document', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/status': {
        get: {
          summary: 'Session, feeds, destinations and per-platform rollup',
          operationId: 'getStatus',
          tags: ['status'],
          description: 'Needs `status:read`.',
          responses: {
            '200': { description: 'Current status', content: { 'application/json': { schema: ref('Status') } } },
            ...errors,
            '403': problemResponse('Token lacks status:read (`missing_scope`)'),
          },
        },
      },
      '/chat': {
        get: {
          summary: 'Recent chat (after moderation), oldest first',
          operationId: 'getChat',
          tags: ['chat'],
          description: 'Needs `chat:read`. Session-scoped: the server keeps the last 500 messages.',
          parameters: [
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 500, default: 200 } },
            { name: 'after', in: 'query', required: false, description: 'Only messages newer than this envelope id', schema: ref('Ulid') },
          ],
          responses: {
            '200': { description: 'chat.message envelopes', content: { 'application/json': { schema: ref('ChatResponse') } } },
            '400': problemResponse('Bad limit or after (`invalid`)'),
            ...errors,
            '403': problemResponse('Token lacks chat:read (`missing_scope`)'),
          },
        },
      },
      '/events': {
        get: {
          summary: 'Live events (Server-Sent Events)',
          operationId: 'streamEvents',
          tags: ['events'],
          description:
            'Every frame: `id: <envelope id>`, `event: <type>`, `data: <envelope JSON>`. Resume with `Last-Event-ID` (or `?cursor=`); when an event you would receive (by `types` and scopes) after that cursor has left the buffer (2000 events / 15 minutes), or the cursor is from before a restart, the stream first sends `system.reset`. Without a cursor the stream starts with one `stream.status` and one `destination.status` per destination. Heartbeat `: ping` every 15 s. At most 5 concurrent streams per token. Browsers may pass the token as `?access_token=` (prefer the header).',
          parameters: [
            typesParam,
            { name: 'cursor', in: 'query', required: false, schema: ref('Ulid') },
            { name: 'Last-Event-ID', in: 'header', required: false, schema: ref('Ulid') },
            { name: 'access_token', in: 'query', required: false, schema: str },
          ],
          responses: {
            '200': { description: 'text/event-stream of envelopes', content: { 'text/event-stream': { schema: ref('Envelope') } } },
            '400': problemResponse('Bad cursor or types (`invalid`)'),
            ...errors,
            '403': problemResponse('The requested types need a scope the token lacks (`missing_scope`)'),
          },
        },
      },
      '/events/poll': {
        get: {
          summary: 'Polling alternative to /events',
          operationId: 'pollEvents',
          tags: ['events'],
          description:
            'Same envelopes and buffer as /events. Without `after` it returns no items, only the current cursor (`next`). `next` moves past events the `types` filter skipped.',
          parameters: [typesParam, { name: 'after', in: 'query', required: false, schema: ref('Ulid') }],
          responses: {
            '200': { description: 'Envelopes after the cursor', content: { 'application/json': { schema: ref('PollResponse') } } },
            '400': problemResponse('Bad after or types (`invalid`)'),
            ...errors,
            '403': problemResponse('The requested types need a scope the token lacks (`missing_scope`)'),
          },
        },
      },
    },
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'ctd_pat_ token from Settings → API' } },
      schemas: {
        Ulid: { type: 'string', pattern: '^[0-7][0-9A-HJKMNP-TV-Z]{25}$', description: 'ULID: unique, sortable by time' },
        Problem: {
          type: 'object',
          required: ['type', 'title', 'status', 'detail', 'code'],
          properties: {
            type: { type: 'string', const: PROBLEM_TYPE },
            title: str,
            status: int,
            detail: str,
            code: { enum: ['unauthenticated', 'missing_scope', 'invalid', 'rate_limited', 'not_found', 'internal'] },
          },
        },
        WhoAmI: {
          type: 'object',
          required: ['name', 'version', 'apiVersion', 'token'],
          properties: {
            name: { const: 'ctd-multi-stream' },
            version: str,
            apiVersion: { const: 1 },
            token: { type: 'object', properties: { name: str, scopes: { type: 'array', items: { enum: ['chat:read', 'status:read'] } } } },
          },
        },
        Platform: { enum: [...PLATFORM_IDS] },
        Session: {
          type: 'object',
          required: ['status', 'startedAt', 'title', 'testMode', 'autoGoLive'],
          properties: {
            status: { enum: ['offline', 'starting', 'live', 'stopping'] },
            startedAt: nullable(isoTime),
            title: str,
            testMode: {
              type: 'boolean',
              description:
                'Test mode: every destination streams with its platform’s private/test setting; destinations without one are skipped (phase disabled, message "Skipped — <Platform> has no test mode"). Channel titles (Twitch, Kick) are never changed in test mode',
            },
            autoGoLive: bool,
          },
        },
        Feed: {
          type: 'object',
          required: ['feed', 'online', 'since', 'video', 'audio', 'bitrateKbps'],
          properties: {
            feed: { enum: ['landscape', 'vertical'] },
            online: bool,
            since: nullable(isoTime),
            video: nullable({ type: 'object', properties: { codec: str, width: int, height: int, fps: num } }),
            audio: nullable({ type: 'object', properties: { codec: str, sampleRate: int, channels: int } }),
            bitrateKbps: nullable(num),
          },
        },
        Destination: {
          type: 'object',
          required: ['id', 'name', 'platform', 'feed', 'enabled', 'phase', 'live', 'down', 'message', 'stats', 'viewers', 'watchUrl', 'recoveries', 'lastRecovery', 'since'],
          properties: {
            id: str,
            name: str,
            platform: ref('Platform'),
            feed: { enum: ['landscape', 'vertical'] },
            enabled: bool,
            phase: { enum: PHASES },
            live: bool,
            down: { type: 'boolean', description: 'Session running, destination enabled (not skipped by test mode) and not reaching the platform (error, retrying, recovering, waiting-for-feed)' },
            message: nullable(str),
            stats: nullable({ type: 'object', properties: { bitrateKbps: num, fps: num, speed: num, uptimeSec: num } }),
            viewers: { oneOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }], description: 'null when unknown' },
            watchUrl: nullable(str),
            recoveries: int,
            lastRecovery: nullable({ type: 'object', properties: { at: isoTime, reason: str } }),
            since: isoTime,
          },
        },
        PlatformRollup: {
          type: 'object',
          required: ['platform', 'destinations', 'live', 'title', 'startedAt', 'viewers', 'error'],
          properties: {
            platform: ref('Platform'),
            destinations: { type: 'array', items: str },
            live: bool,
            title: str,
            startedAt: nullable(epochMs),
            viewers: nullable(int),
            error: nullable(str),
          },
        },
        Status: {
          type: 'object',
          required: ['session', 'feeds', 'destinations', 'platforms'],
          properties: {
            session: ref('Session'),
            feeds: { type: 'array', items: ref('Feed') },
            destinations: { type: 'array', items: ref('Destination') },
            platforms: { type: 'array', items: ref('PlatformRollup') },
          },
        },
        Envelope: {
          type: 'object',
          required: ['id', 'type', 'ts', 'src', 'data'],
          properties: {
            id: ref('Ulid'),
            type: { enum: [...EVENT_TYPES] },
            ts: epochMs,
            src: {
              type: 'object',
              properties: {
                connector: { const: 'ctd-multi-stream' },
                connection: { type: 'string', description: 'Destination id, or core' },
                platform: { enum: [...PLATFORM_IDS, 'core'] },
              },
            },
            data: {
              description: 'Depends on type',
              oneOf: [
                ref('ChatMessage'),
                ref('ChatMessageDeleted'),
                ref('ChatUserCleared'),
                ref('ChatCleared'),
                ref('Alert'),
                ref('Session'),
                ref('Feed'),
                ref('Destination'),
                ref('DestinationDown'),
                ref('DestinationUp'),
                ref('Notice'),
                { type: 'object', maxProperties: 0, description: 'system.reset' },
              ],
            },
          },
        },
        ChatFragment: {
          type: 'object',
          required: ['type', 'text'],
          properties: {
            type: { enum: ['text', 'emote', 'mention', 'link', 'cheermote'], description: 'mention is reserved (not sent yet); treat unknown types as text' },
            text: str,
            image: str,
            animated: bool,
            url: str,
            userId: str,
            amount: { type: 'number', description: 'cheermote fragments (Twitch cheers): the bits it stands for' },
          },
        },
        ChatMessage: {
          type: 'object',
          required: ['id', 'platform', 'channel', 'destinationId', 'platformMessageId', 'user', 'text', 'fragments', 'reply', 'highlighted', 'action', 'kind', 'ts'],
          properties: {
            id: { type: 'string', description: 'Stable, platform-prefixed: use it to apply deletions' },
            platform: ref('Platform'),
            channel: { type: 'string', description: 'Destination name' },
            destinationId: str,
            platformMessageId: nullable(str),
            user: {
              type: 'object',
              required: ['id', 'login', 'name', 'color', 'avatar', 'badges', 'roles'],
              properties: {
                id: { type: 'string', description: '<platform>:<id>, or <platform>:name:<display name>' },
                login: nullable(str),
                name: str,
                color: nullable({ type: 'string', pattern: '^#[0-9A-F]{6}$' }),
                avatar: nullable({ type: 'string', description: 'https URL' }),
                badges: { type: 'array', items: { type: 'object', properties: { id: str, label: str } } },
                roles: { type: 'array', items: { enum: [...API_ROLES] } },
              },
            },
            text: str,
            fragments: { type: 'array', items: ref('ChatFragment'), description: 'Joining every text equals `text`' },
            reply: nullable({ type: 'object', properties: { messageId: nullable(str), userName: nullable(str), text: nullable(str) } }),
            highlighted: bool,
            action: bool,
            kind: { enum: ['message', 'event'] },
            ts: epochMs,
          },
        },
        ChatMessageDeleted: {
          type: 'object',
          properties: {
            messageId: { type: 'string', description: 'The deleted message’s `id` (platform-prefixed)' },
            platformMessageId: str,
            platform: ref('Platform'),
            destinationId: str,
          },
        },
        ChatUserCleared: {
          type: 'object',
          properties: { userId: nullable(str), userName: nullable(str), platform: ref('Platform'), destinationId: str },
        },
        ChatCleared: { type: 'object', properties: { platform: ref('Platform'), destinationId: str } },
        Alert: {
          type: 'object',
          description:
            'alert.<kind> data: the CTD Overlay alert payload plus its source. Fields that don’t apply are omitted. Also sent as a chat.message (kind "event") with messageId.',
          required: ['kind', 'user', 'platform', 'destinationId', 'messageId', 'ts'],
          properties: {
            kind: { enum: [...ALERT_KINDS] },
            user: {
              type: 'object',
              required: ['name'],
              properties: {
                id: { type: 'string', description: 'Same form as chat.message user.id; absent for anonymous users' },
                name: str,
                avatar: { type: 'string', description: 'https URL' },
                anonymous: { const: true },
              },
            },
            amount: {
              oneOf: [
                {
                  type: 'object',
                  required: ['unit', 'value'],
                  properties: { unit: { enum: [...ALERT_COUNT_UNITS] }, value: { type: 'integer', minimum: 0 } },
                },
                {
                  type: 'object',
                  required: ['unit', 'value', 'currency'],
                  properties: {
                    unit: { const: 'currency' },
                    value: { type: 'string', pattern: DECIMAL_RE.source, description: 'Decimal string, never a float' },
                    currency: { type: 'string', pattern: CURRENCY_RE.source, description: 'ISO 4217' },
                  },
                },
              ],
            },
            tier: str,
            message: { type: 'object', required: ['text'], properties: { text: str } },
            gift: nullable({ type: 'object', properties: { recipients: { type: 'array', items: str }, total: { type: 'integer', minimum: 0 } } }),
            platform: ref('Platform'),
            destinationId: str,
            messageId: { type: 'string', description: 'id of the chat.message that carried the alert' },
            ts: epochMs,
          },
        },
        DestinationDown: {
          type: 'object',
          properties: { destinationId: str, name: str, platform: ref('Platform'), phase: { enum: PHASES }, reason: nullable(str) },
        },
        DestinationUp: {
          type: 'object',
          properties: { destinationId: str, name: str, platform: ref('Platform'), downForSec: int, recoveries: int },
        },
        Notice: { type: 'object', properties: { level: { enum: ['info', 'warn', 'error'] }, message: str } },
        ChatResponse: {
          type: 'object',
          required: ['items', 'next'],
          properties: { items: { type: 'array', items: ref('Envelope') }, next: ref('Ulid') },
        },
        PollResponse: {
          type: 'object',
          required: ['items', 'next', 'reset'],
          properties: {
            items: { type: 'array', items: ref('Envelope') },
            next: ref('Ulid'),
            reset: {
              type: 'boolean',
              description: 'An event you would receive (by `types` and scopes) after `after` has left the buffer, or `after` is from before a restart: refetch /status and /chat',
            },
          },
        },
      },
    },
  };
}
