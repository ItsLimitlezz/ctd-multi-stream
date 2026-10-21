// Enhanced FLV (v2) reading for the Twitch Dual Format relay (ivs-forwarder.ts): split FFmpeg's FLV
// output into tags, find each video tag's track and H.264 data, and insert NAL units in front of an
// IDR. Formats: FLV 10.1 (tags), Enhanced RTMP v2 (https://veovera.org/docs/enhanced/enhanced-rtmp-v2):
//
//   legacy video   [frameType:4 codecId:4] [AVCPacketType] [CTS:3] data            (track 0, H.264)
//   extended       [1 frameType:3 packetType:4] [FourCC:4] [CTS:3 if CodedFrames] data
//   multitrack     [1 frameType:3 6] [multitrackType:4 packetType:4] [FourCC:4] [trackId] [CTS:3 if CodedFrames] data
//
// FFmpeg 8's flvenc sends track 0 (H.264) as legacy packets and the other tracks as multitrack
// OneTrack packets, which is what Amazon IVS asks for. H.264 data is AVCC: length-prefixed NAL units.

export const TAG_AUDIO = 8;
export const TAG_VIDEO = 9;
export const TAG_SCRIPT = 18;

export interface FlvTag {
  type: number;
  /** Milliseconds (DTS). */
  timestamp: number;
  body: Buffer;
}

/** Incremental FLV parser: push() chunks of the byte stream, get whole tags back. */
export class FlvReader {
  private buf: Buffer = Buffer.alloc(0);
  private headerDone = false;

  push(chunk: Buffer): FlvTag[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const tags: FlvTag[] = [];
    if (!this.headerDone) {
      if (this.buf.length < 9) return tags;
      if (this.buf.toString('latin1', 0, 3) !== 'FLV') throw new Error('Not an FLV stream');
      const dataOffset = this.buf.readUInt32BE(5);
      if (this.buf.length < dataOffset + 4) return tags;
      this.buf = this.buf.subarray(dataOffset + 4); // header + PreviousTagSize0
      this.headerDone = true;
    }
    let off = 0;
    while (this.buf.length - off >= 11) {
      const size = this.buf.readUIntBE(off + 1, 3);
      if (this.buf.length - off < 11 + size + 4) break;
      const type = this.buf[off]! & 0x1f;
      const timestamp = (this.buf.readUIntBE(off + 4, 3) | (this.buf[off + 7]! << 24)) >>> 0;
      tags.push({ type, timestamp, body: Buffer.from(this.buf.subarray(off + 11, off + 11 + size)) });
      off += 11 + size + 4;
    }
    this.buf = this.buf.subarray(off);
    return tags;
  }
}

const PACKET_SEQUENCE_START = 0;
const PACKET_CODED_FRAMES = 1;
const PACKET_CODED_FRAMES_X = 3;
const PACKET_MULTITRACK = 6;
const MULTITRACK_ONE_TRACK = 0;
const LEGACY_AVC = 7;

export interface VideoTagInfo {
  track: number;
  /** H.264 (legacy codec 7 or FourCC avc1). */
  avc: boolean;
  kind: 'sequence-start' | 'frame' | 'other';
  /** Offset of the AVCC data (frames) or the avcC record (sequence start) in the tag body. */
  dataOffset: number;
}

/** What a video tag carries, or null for one this relay doesn't understand (it's forwarded as is). */
export function parseVideoTag(body: Buffer): VideoTagInfo | null {
  if (body.length < 2) return null;
  const b0 = body[0]!;
  if ((b0 & 0x80) === 0) {
    // Legacy: track 0.
    if ((b0 & 0x0f) !== LEGACY_AVC || body.length < 5) return { track: 0, avc: false, kind: 'other', dataOffset: 0 };
    const avcType = body[1];
    return { track: 0, avc: true, kind: avcType === 0 ? 'sequence-start' : avcType === 1 ? 'frame' : 'other', dataOffset: 5 };
  }
  let packetType = b0 & 0x0f;
  let off = 1;
  let track = 0;
  if (packetType === PACKET_MULTITRACK) {
    const b1 = body[1]!;
    if (b1 >> 4 !== MULTITRACK_ONE_TRACK) return null; // ffmpeg sends one track per packet
    packetType = b1 & 0x0f;
    off = 2;
    if (body.length < off + 5) return null;
    const avc = body.toString('latin1', off, off + 4) === 'avc1';
    track = body[off + 4]!;
    off += 5;
    return classify(packetType, avc, track, off, body.length);
  }
  if (body.length < off + 4) return null;
  const avc = body.toString('latin1', off, off + 4) === 'avc1';
  return classify(packetType, avc, track, off + 4, body.length);
}

function classify(packetType: number, avc: boolean, track: number, off: number, length: number): VideoTagInfo | null {
  if (packetType === PACKET_SEQUENCE_START) return { track, avc, kind: 'sequence-start', dataOffset: off };
  if (packetType === PACKET_CODED_FRAMES) return off + 3 <= length ? { track, avc, kind: 'frame', dataOffset: off + 3 } : null;
  if (packetType === PACKET_CODED_FRAMES_X) return { track, avc, kind: 'frame', dataOffset: off };
  return { track, avc, kind: 'other', dataOffset: off };
}

/** NAL length size from an avcC record (lengthSizeMinusOne + 1), 4 when it can't be read. */
export function avcLengthSize(avcC: Buffer): number {
  return avcC.length >= 5 ? (avcC[4]! & 0x03) + 1 : 4;
}

/** Index (in the AVCC data) of the first IDR slice NAL unit, or -1. */
export function findIdr(data: Buffer, lengthSize: number): number {
  let off = 0;
  while (off + lengthSize < data.length) {
    const len = data.readUIntBE(off, lengthSize);
    const type = data[off + lengthSize]! & 0x1f;
    if (type === 5) return off;
    if (type === 1) return -1; // a non-IDR slice first: not an IDR access unit
    off += lengthSize + len;
  }
  return -1;
}

/**
 * The tag body with `nals` (each written with a length prefix) inserted right before the first IDR
 * slice, or null when the frame has no IDR.
 */
export function insertBeforeIdr(body: Buffer, dataOffset: number, lengthSize: number, nals: readonly Buffer[]): Buffer | null {
  const data = body.subarray(dataOffset);
  const at = findIdr(data, lengthSize);
  if (at < 0) return null;
  const parts: Buffer[] = [body.subarray(0, dataOffset + at)];
  for (const nal of nals) {
    const prefix = Buffer.alloc(lengthSize);
    prefix.writeUIntBE(nal.length, 0, lengthSize);
    parts.push(prefix, nal);
  }
  parts.push(data.subarray(at));
  return Buffer.concat(parts);
}
