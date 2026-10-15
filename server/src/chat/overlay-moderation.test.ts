import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { WsServerMessage } from '../../../shared/api.js';
import type { ChatModeration } from '../../../shared/types.js';
import { EventBus } from '../events.js';
import chatRoutes from '../http/routes/chat.js';
import type { AppServices, ChatHub } from '../services.js';
import overlayModeration from './overlay-moderation.js';

const TOKEN = 'A'.repeat(43);
const CLUB_TOKEN = 'C'.repeat(43);
const deleted: ChatModeration = {
  kind: 'message-deleted',
  platform: 'twitch',
  destinationId: 'd1',
  profileId: 'default',
  ts: '2026-10-13T12:00:00.000Z',
  messageId: 'twitch:1',
  platformMessageId: '1',
};
const clubCleared: ChatModeration = { kind: 'cleared', platform: 'kick', destinationId: 'd9', profileId: 'club', ts: '2026-10-13T12:00:00.000Z' };

let app: FastifyInstance;
let bus: EventBus;
let tokens: Record<string, string>;

beforeEach(async () => {
  bus = new EventBus();
  tokens = { default: TOKEN, club: CLUB_TOKEN };
  const chat = {
    recent: vi.fn(() => []),
    overlayToken: vi.fn(async (profileId = 'default') => tokens[profileId]),
    rotateOverlayToken: vi.fn(async (profileId = 'default') => tokens[profileId]),
    profileForOverlayToken: vi.fn(async (token: string) => Object.entries(tokens).find(([, t]) => t === token)?.[0] ?? null),
    attach: vi.fn(),
  } as unknown as ChatHub;
  const services = { log: pino({ level: 'silent' }), bus, chat, repos: { audit: { log: vi.fn() } }, publicBaseUrl: () => 'https://h' } as unknown as AppServices;
  app = Fastify();
  await app.register(websocket);
  await app.register(chatRoutes, { services });
  await app.register(overlayModeration, { services });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function connect(path: string) {
  const messages: WsServerMessage[] = [];
  let resolveClosed!: (code: number) => void;
  const closed = new Promise<number>((r) => (resolveClosed = r));
  const ws = (await app.injectWS(path, {}, {
    onInit(socket) {
      socket.on('message', (data: Buffer) => messages.push(JSON.parse(data.toString()) as WsServerMessage));
      socket.on('close', (code: number) => resolveClosed(code));
    },
  })) as unknown as WebSocket;
  return { ws, messages, closed };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('overlay moderation forwarding', () => {
  it('forwards chat-moderation to overlay sockets with a valid token', async () => {
    const { messages } = await connect(`/overlay/ws?token=${TOKEN}`);
    await tick();
    bus.emit('chat-moderation', deleted);
    await tick();
    expect(messages).toEqual([{ type: 'chat-moderation', moderation: deleted }]);
  });

  it('sends nothing to sockets with a bad token, and stops after close', async () => {
    const bad = await connect('/overlay/ws?token=wrong');
    expect(await bad.closed).toBe(4401);
    const good = await connect(`/overlay/ws?token=${TOKEN}`);
    await tick();
    good.ws.close();
    await tick();
    bus.emit('chat-moderation', deleted);
    await tick();
    expect(bad.messages).toEqual([]);
    expect(good.messages).toEqual([]);
  });

  it("forwards only the moderation of the token's profile", async () => {
    const main = await connect(`/overlay/ws?token=${TOKEN}`);
    const club = await connect(`/overlay/ws?token=${CLUB_TOKEN}`);
    await tick();
    bus.emit('chat-moderation', deleted);
    bus.emit('chat-moderation', clubCleared);
    // Moderation from before profiles carried no profile: it belongs to the default profile.
    const { profileId: _drop, ...legacy } = deleted;
    bus.emit('chat-moderation', legacy as ChatModeration);
    await tick();
    expect(main.messages).toEqual([
      { type: 'chat-moderation', moderation: deleted },
      { type: 'chat-moderation', moderation: legacy },
    ]);
    expect(club.messages).toEqual([{ type: 'chat-moderation', moderation: clubCleared }]);
  });
});
