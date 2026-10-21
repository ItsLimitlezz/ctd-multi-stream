// Twitch Dual Format through Relay, last leg: FFmpeg (buildIvsArgs) writes the encoded tracks as
// Enhanced FLV to stdout; this reads the tags, puts the broadcast performance metrics (bpm.ts) in
// front of every IDR on every track, and publishes the stream with RtmpPublisher. Amazon IVS
// disconnects multitrack streams whose IDRs lack the metrics, which FFmpeg can't add itself.

import type { Readable } from 'node:stream';
import type { Logger } from 'pino';
import { BpmCounters, bpmNals } from './bpm.js';
import { avcLengthSize, findIdr, FlvReader, insertBeforeIdr, parseVideoTag, TAG_AUDIO, TAG_SCRIPT, TAG_VIDEO, type FlvTag } from './eflv.js';
import { RTMP_AUDIO, RTMP_DATA, RTMP_VIDEO, RtmpPublisher } from './rtmp-publisher.js';

/** What the forwarder needs from a publisher (RtmpPublisher; fakes in tests). */
export interface TagPublisher {
  send(type: number, timestamp: number, body: Buffer): boolean;
  close(): Promise<void>;
  on(event: 'drain', fn: () => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  once(event: 'drain', fn: () => void): unknown;
}

export interface IvsForwarderOptions {
  log: Pick<Logger, 'info' | 'warn'>;
  /** Test seam: open the publishing connection (default RtmpPublisher.open). */
  publish?: (url: string) => Promise<TagPublisher>;
  now?: () => number;
}

/** Adds the IVS metrics to video tags (one instance per stream: counters span the whole stream). */
export class BpmInserter {
  private readonly counters = new BpmCounters();
  private readonly lengthSize = new Map<number, number>();
  idrs = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** The tag body to send (with the metrics in front of an IDR). */
  video(body: Buffer): Buffer {
    const info = parseVideoTag(body);
    if (!info?.avc) return body;
    if (info.kind === 'sequence-start') {
      this.lengthSize.set(info.track, avcLengthSize(body.subarray(info.dataOffset)));
      return body;
    }
    if (info.kind !== 'frame') return body;
    const size = this.lengthSize.get(info.track) ?? 4;
    let out = body;
    if (findIdr(body.subarray(info.dataOffset), size) >= 0) {
      const c = this.counters.atIdr(info.track);
      out = insertBeforeIdr(body, info.dataOffset, size, bpmNals(this.now(), c.session, c.rendition)) ?? body;
      this.idrs++;
    }
    this.counters.frame(info.track);
    return out;
  }
}

export class IvsForwarder {
  private publisher: TagPublisher | null = null;
  private readonly reader = new FlvReader();
  private readonly bpm: BpmInserter;
  private stopped = false;
  private failed = false;

  constructor(
    private readonly url: string,
    private readonly opts: IvsForwarderOptions,
  ) {
    this.bpm = new BpmInserter(opts.now);
  }

  /**
   * Publish FFmpeg's stdout. `onFatal` is called once if the stream can't continue (connection
   * refused or lost, unreadable FFmpeg output); the caller then stops FFmpeg and retries.
   */
  start(input: Readable, onFatal: (err: Error) => void): void {
    const fatal = (err: Error) => {
      if (this.failed || this.stopped) return;
      this.failed = true;
      input.pause();
      onFatal(err);
    };
    // Hold FFmpeg's output (the pipe fills and FFmpeg waits) until the connection is publishing.
    input.pause();
    const publish = this.opts.publish ?? ((url: string) => RtmpPublisher.open(url));
    publish(this.url).then(
      (pub) => {
        if (this.stopped) {
          void pub.close();
          return;
        }
        this.publisher = pub;
        pub.on('error', fatal);
        this.opts.log.info('twitch dual format: publishing');
        input.on('data', (chunk: Buffer) => {
          let tags: FlvTag[];
          try {
            tags = this.reader.push(chunk);
          } catch (err) {
            fatal(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          let writable = true;
          for (const tag of tags) writable = this.forward(pub, tag) && writable;
          if (!writable && !this.failed) {
            input.pause();
            pub.once('drain', () => {
              if (!this.failed && !this.stopped) input.resume();
            });
          }
        });
        input.resume();
      },
      (err: unknown) => fatal(err instanceof Error ? err : new Error(String(err))),
    );
  }

  private forward(pub: TagPublisher, tag: FlvTag): boolean {
    if (tag.type === TAG_VIDEO) return pub.send(RTMP_VIDEO, tag.timestamp, this.bpm.video(tag.body));
    if (tag.type === TAG_AUDIO) return pub.send(RTMP_AUDIO, tag.timestamp, tag.body);
    if (tag.type === TAG_SCRIPT) return pub.send(RTMP_DATA, tag.timestamp, tag.body);
    return true;
  }

  /** End the stream properly (FCUnpublish) and close the connection. */
  async close(): Promise<void> {
    this.stopped = true;
    const pub = this.publisher;
    this.publisher = null;
    if (pub) await pub.close().catch(() => {});
  }
}
