// Validation for messages the login viewer's web client sends (see BrowserClientMessage in shared/api.ts).

import { z } from 'zod';
import type { BrowserClientMessage } from '../../../shared/api.js';

const coord = z.number().min(-100_000).max(100_000);
const delta = z.number().min(-100_000).max(100_000);

const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('mouse'),
    action: z.enum(['move', 'down', 'up', 'wheel']),
    x: coord,
    y: coord,
    button: z.enum(['left', 'right', 'middle']).optional(),
    clickCount: z.number().int().min(1).max(4).optional(),
    deltaX: delta.optional(),
    deltaY: delta.optional(),
  }),
  z.object({
    type: z.literal('key'),
    action: z.enum(['down', 'up']),
    key: z.string().min(1).max(40),
    code: z.string().max(40),
    text: z.string().max(16).optional(),
    modifiers: z.number().int().min(0).max(15),
  }),
  z.object({ type: z.literal('type'), text: z.string().min(1).max(20_000) }),
  z.object({ type: z.literal('navigate'), url: z.string().min(1).max(4096) }),
  z.object({ type: z.literal('back') }),
  z.object({ type: z.literal('reload') }),
  z.object({
    type: z.literal('resize'),
    width: z.number().min(1).max(100_000),
    height: z.number().min(1).max(100_000),
  }),
]);

/** Parse one client message (already JSON-decoded). Returns null when invalid. */
export function parseBrowserClientMessage(raw: unknown): BrowserClientMessage | null {
  const result = clientMessageSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/** Decode a raw WebSocket text payload into a validated client message, or null. */
export function decodeBrowserClientMessage(data: Buffer | ArrayBuffer | Buffer[] | string): BrowserClientMessage | null {
  let text: string;
  if (typeof data === 'string') text = data;
  else if (Array.isArray(data)) text = Buffer.concat(data).toString('utf8');
  else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8');
  else text = data.toString('utf8');
  try {
    return parseBrowserClientMessage(JSON.parse(text));
  } catch {
    return null;
  }
}
