// A tiny RTMP ingest for tests (RtmpPublisher, IvsForwarder): handshake, chunk parsing, answers
// connect / createStream / publish, and records every message it receives. Not for production.

import net from 'node:net';
import { decodeAmf0All, encodeAmf0All, type Amf0Value } from './amf0.js';

export interface ReceivedMessage {
  type: number;
  timestamp: number;
  streamId: number;
  payload: Buffer;
}

export interface FakeIngestOptions {
  /** Answer publish with this error status code instead of NetStream.Publish.Start. */
  refusePublish?: string;
}

export interface FakeIngest {
  port: number;
  messages: ReceivedMessage[];
  /** AMF0 commands received (name, then the other values). */
  commands: Amf0Value[][];
  /** Resolves when the client sent FCUnpublish. */
  unpublished: Promise<void>;
  /** Drop every connection (a lost network). */
  dropAll(): void;
  close(): Promise<void>;
}

function message(csid: number, type: number, streamId: number, payload: Buffer): Buffer {
  // One chunk is enough for these small replies at the default 128-byte size only if short; use fmt 0 + fmt 3.
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head[0] = csid;
  head.writeUIntBE(0, 1, 3);
  head.writeUIntBE(payload.length, 4, 3);
  head[7] = type;
  head.writeUInt32LE(streamId, 8);
  parts.push(head);
  for (let off = 0; off < payload.length; off += 128) {
    if (off > 0) parts.push(Buffer.from([0xc0 | csid]));
    parts.push(payload.subarray(off, off + 128));
  }
  return Buffer.concat(parts);
}

export async function startFakeIngest(opts: FakeIngestOptions = {}): Promise<FakeIngest> {
  const messages: ReceivedMessage[] = [];
  const commands: Amf0Value[][] = [];
  const sockets = new Set<net.Socket>();
  let markUnpublished: () => void = () => {};
  const unpublished = new Promise<void>((resolve) => {
    markUnpublished = resolve;
  });

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buf: Buffer = Buffer.alloc(0);
    let stage: 'c0c1' | 'c2' | 'chunks' = 'c0c1';
    let chunkSize = 128;
    const state = new Map<number, { ts: number; len: number; type: number; sid: number; parts: Buffer[]; got: number }>();

    const reply = (values: Amf0Value[], streamId = 0) => socket.write(message(3, 20, streamId, encodeAmf0All(values)));

    const onCommand = (values: Amf0Value[], streamId: number) => {
      commands.push(values);
      const [name, txn] = values;
      if (name === 'connect') reply(['_result', txn ?? 1, { fmsVer: 'FMS/3,0,1,123' }, { level: 'status', code: 'NetConnection.Connect.Success' }]);
      else if (name === 'createStream') reply(['_result', txn ?? 0, null, 1]);
      else if (name === 'publish') {
        if (opts.refusePublish) reply(['onStatus', 0, null, { level: 'error', code: opts.refusePublish, description: 'refused' }], streamId);
        else reply(['onStatus', 0, null, { level: 'status', code: 'NetStream.Publish.Start', description: 'ok' }], streamId);
      } else if (name === 'FCUnpublish') markUnpublished();
    };

    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'c0c1') {
        if (buf.length < 1537) return;
        const s1 = Buffer.alloc(1536, 7);
        socket.write(Buffer.concat([Buffer.from([3]), s1, buf.subarray(1, 1537)]));
        buf = buf.subarray(1537);
        stage = 'c2';
      }
      if (stage === 'c2') {
        if (buf.length < 1536) return;
        buf = buf.subarray(1536);
        stage = 'chunks';
      }
      for (;;) {
        if (buf.length < 1) return;
        const fmt = buf[0]! >> 6;
        const csid = buf[0]! & 0x3f;
        const hl = [11, 7, 3, 0][fmt]!;
        if (buf.length < 1 + hl) return;
        const st = state.get(csid) ?? { ts: 0, len: 0, type: 0, sid: 0, parts: [], got: 0 };
        let off = 1;
        let ts = st.ts;
        let len = st.len;
        let type = st.type;
        let sid = st.sid;
        if (fmt <= 2) ts = buf.readUIntBE(off, 3);
        if (fmt <= 1) {
          len = buf.readUIntBE(off + 3, 3);
          type = buf[off + 6]!;
        }
        if (fmt === 0) sid = buf.readUInt32LE(off + 7);
        off += hl;
        if (ts === 0xffffff || (fmt === 3 && st.ts >= 0xffffff)) {
          if (buf.length < off + 4) return;
          ts = buf.readUInt32BE(off);
          off += 4;
        }
        const take = Math.min(chunkSize, len - (fmt === 3 ? st.got : 0));
        if (buf.length < off + take) return;
        if (fmt !== 3) {
          st.parts = [];
          st.got = 0;
        }
        st.ts = fmt === 1 || fmt === 2 ? st.ts + ts : ts;
        st.len = len;
        st.type = type;
        st.sid = sid;
        st.parts.push(Buffer.from(buf.subarray(off, off + take)));
        st.got += take;
        state.set(csid, st);
        buf = buf.subarray(off + take);
        if (st.got >= st.len) {
          const payload = Buffer.concat(st.parts);
          st.parts = [];
          st.got = 0;
          if (st.type === 1) chunkSize = payload.readUInt32BE(0) & 0x7fffffff;
          else if (st.type === 20) onCommand(decodeAmf0All(payload), st.sid);
          else messages.push({ type: st.type, timestamp: st.ts, streamId: st.sid, payload });
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    messages,
    commands,
    unpublished,
    dropAll: () => {
      for (const s of sockets) s.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
