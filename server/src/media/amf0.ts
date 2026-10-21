// AMF0 (Action Message Format) encoding/decoding for RTMP commands (rtmp-publisher.ts): numbers,
// booleans, strings, objects, ECMA and strict arrays, null/undefined. Dates and long strings decode;
// nothing else is needed to publish.

export type Amf0Value = number | boolean | string | null | undefined | Amf0Value[] | { [key: string]: Amf0Value };

const NUMBER = 0x00;
const BOOLEAN = 0x01;
const STRING = 0x02;
const OBJECT = 0x03;
const NULL = 0x05;
const UNDEFINED = 0x06;
const ECMA_ARRAY = 0x08;
const OBJECT_END = 0x09;
const STRICT_ARRAY = 0x0a;
const DATE = 0x0b;
const LONG_STRING = 0x0c;

function key(name: string): Buffer {
  const s = Buffer.from(name, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(s.length);
  return Buffer.concat([len, s]);
}

export function encodeAmf0(value: Amf0Value): Buffer {
  if (value === null) return Buffer.from([NULL]);
  if (value === undefined) return Buffer.from([UNDEFINED]);
  if (typeof value === 'number') {
    const b = Buffer.alloc(9);
    b[0] = NUMBER;
    b.writeDoubleBE(value, 1);
    return b;
  }
  if (typeof value === 'boolean') return Buffer.from([BOOLEAN, value ? 1 : 0]);
  if (typeof value === 'string') {
    const s = Buffer.from(value, 'utf8');
    if (s.length > 0xffff) {
      const head = Buffer.alloc(5);
      head[0] = LONG_STRING;
      head.writeUInt32BE(s.length, 1);
      return Buffer.concat([head, s]);
    }
    return Buffer.concat([Buffer.from([STRING]), key(value)]);
  }
  if (Array.isArray(value)) {
    const head = Buffer.alloc(5);
    head[0] = STRICT_ARRAY;
    head.writeUInt32BE(value.length, 1);
    return Buffer.concat([head, ...value.map(encodeAmf0)]);
  }
  const parts: Buffer[] = [Buffer.from([OBJECT])];
  for (const [k, v] of Object.entries(value)) parts.push(key(k), encodeAmf0(v));
  parts.push(Buffer.from([0, 0, OBJECT_END]));
  return Buffer.concat(parts);
}

/** Encode several values back to back (a command: name, transaction id, object, args...). */
export function encodeAmf0All(values: readonly Amf0Value[]): Buffer {
  return Buffer.concat(values.map(encodeAmf0));
}

/** Decode every value in `buf`. Throws on malformed data. */
export function decodeAmf0All(buf: Buffer): Amf0Value[] {
  const out: Amf0Value[] = [];
  let off = 0;
  while (off < buf.length) {
    const [v, next] = decodeAt(buf, off);
    out.push(v);
    off = next;
  }
  return out;
}

function need(buf: Buffer, off: number, n: number): void {
  if (off + n > buf.length) throw new Error('Truncated AMF0 data');
}

function readKey(buf: Buffer, off: number): [string, number] {
  need(buf, off, 2);
  const len = buf.readUInt16BE(off);
  need(buf, off + 2, len);
  return [buf.toString('utf8', off + 2, off + 2 + len), off + 2 + len];
}

function readProps(buf: Buffer, off: number): [{ [key: string]: Amf0Value }, number] {
  const obj: { [key: string]: Amf0Value } = {};
  for (;;) {
    need(buf, off, 3);
    if (buf.readUInt16BE(off) === 0 && buf[off + 2] === OBJECT_END) return [obj, off + 3];
    const [k, afterKey] = readKey(buf, off);
    const [v, next] = decodeAt(buf, afterKey);
    if (k !== '__proto__') obj[k] = v;
    off = next;
  }
}

function decodeAt(buf: Buffer, off: number): [Amf0Value, number] {
  need(buf, off, 1);
  const type = buf[off]!;
  off += 1;
  switch (type) {
    case NUMBER:
      need(buf, off, 8);
      return [buf.readDoubleBE(off), off + 8];
    case BOOLEAN:
      need(buf, off, 1);
      return [buf[off] !== 0, off + 1];
    case STRING:
      return readKey(buf, off);
    case LONG_STRING: {
      need(buf, off, 4);
      const len = buf.readUInt32BE(off);
      need(buf, off + 4, len);
      return [buf.toString('utf8', off + 4, off + 4 + len), off + 4 + len];
    }
    case OBJECT:
      return readProps(buf, off);
    case ECMA_ARRAY:
      need(buf, off, 4);
      return readProps(buf, off + 4);
    case STRICT_ARRAY: {
      need(buf, off, 4);
      const count = buf.readUInt32BE(off);
      off += 4;
      const arr: Amf0Value[] = [];
      for (let i = 0; i < count; i++) {
        const [v, next] = decodeAt(buf, off);
        arr.push(v);
        off = next;
      }
      return [arr, off];
    }
    case DATE:
      need(buf, off, 10);
      return [buf.readDoubleBE(off), off + 10];
    case NULL:
      return [null, off];
    case UNDEFINED:
      return [undefined, off];
    default:
      throw new Error(`Unsupported AMF0 type 0x${type.toString(16)}`);
  }
}
