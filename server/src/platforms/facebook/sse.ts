// Incremental Server-Sent Events parser (WHATWG HTML "event stream interpretation"), used for the
// Facebook live_comments stream. Handles chunks split anywhere, including inside a CRLF pair.
// https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation

export interface SseEvent {
  event: string;
  data: string;
  id: string | null;
}

const LINE_END_RE = /[\r\n]/g;

export class SseParser {
  private buf = '';
  private data: string[] = [];
  private eventType = '';
  private lastId: string | null = null;
  private sawFirstChunk = false;

  /** Feed decoded text; returns the events completed by it. */
  push(chunk: string): SseEvent[] {
    if (!this.sawFirstChunk && chunk.length > 0) {
      this.sawFirstChunk = true;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1); // UTF-8 BOM
    }
    this.buf += chunk;
    const out: SseEvent[] = [];
    let start = 0;
    LINE_END_RE.lastIndex = 0;
    for (;;) {
      const m = LINE_END_RE.exec(this.buf);
      if (!m) break;
      const idx = m.index;
      let next = idx + 1;
      if (this.buf[idx] === '\r') {
        // A CR at the very end may be the first half of a CRLF split across chunks.
        if (idx + 1 >= this.buf.length) break;
        if (this.buf[idx + 1] === '\n') next = idx + 2;
      }
      this.line(this.buf.slice(start, idx), out);
      start = next;
      LINE_END_RE.lastIndex = next;
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  /** The stream ended: a pending CR terminates its line; an event without a blank line is dropped. */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buf.endsWith('\r')) this.line(this.buf.slice(0, -1), out);
    this.buf = '';
    this.data = [];
    this.eventType = '';
    return out;
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === '') {
      if (this.data.length > 0) out.push({ event: this.eventType || 'message', data: this.data.join('\n'), id: this.lastId });
      this.data = [];
      this.eventType = '';
      return;
    }
    if (line.startsWith(':')) return; // comment, e.g. Facebook's ": ping" keep-alives
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        this.data.push(value);
        break;
      case 'event':
        this.eventType = value;
        break;
      case 'id':
        if (!value.includes('\0')) this.lastId = value;
        break;
      default:
        break; // 'retry' and unknown fields are ignored
    }
  }
}
