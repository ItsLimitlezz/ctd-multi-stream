import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { PLATFORM_IDS } from '../../../shared/types.js';
import { OVERLAY_CSS, OVERLAY_HTML, OVERLAY_JS, PLATFORM_BADGES } from './overlay-assets.js';

// ---- minimal DOM / WebSocket fakes, just enough for the overlay script ----

class FakeElement {
  className = '';
  textContent = '';
  title = '';
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  classList = { add: (c: string) => (this.className = `${this.className} ${c}`.trim()) };

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value);
  }
  append(...nodes: FakeElement[]): void {
    for (const n of nodes) this.appendChild(n);
  }
  appendChild(node: FakeElement): FakeElement {
    node.parent = this;
    this.children.push(node);
    return node;
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  get childElementCount(): number {
    return this.children.length;
  }
  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
}

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'chat', message }) });
  }
}

function runOverlay(href: string) {
  FakeSocket.instances = [];
  const list = new FakeElement('ol');
  const timers: { fn: () => void; ms: number }[] = [];
  const url = new URL(href);
  const context = vm.createContext({
    location: { href, search: url.search, protocol: url.protocol },
    document: {
      getElementById: (id: string) => (id === 'chat' ? list : null),
      createElement: (tag: string) => new FakeElement(tag),
    },
    WebSocket: FakeSocket,
    URL,
    URLSearchParams,
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
  });
  vm.runInContext(OVERLAY_JS, context);
  return { list, timers, sockets: FakeSocket.instances };
}

function chat(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    platform: 'twitch',
    destinationId: 'd',
    author: { name: `user-${id}` },
    text: `hello ${id}`,
    ts: new Date().toISOString(),
    kind: 'message',
    ...over,
  };
}

describe('overlay assets', () => {
  it('has one badge per platform with the brand colors', () => {
    expect(Object.keys(PLATFORM_BADGES).sort()).toEqual([...PLATFORM_IDS].sort());
    expect(PLATFORM_BADGES.twitch.bg).toBe('#9146FF');
    expect(PLATFORM_BADGES.x).toMatchObject({ bg: '#000000', fg: '#FFFFFF' });
    expect(PLATFORM_BADGES.tiktok).toMatchObject({ bg: '#00F2EA', fg: '#000000' });
  });

  it('HTML has no inline script or handlers and references the external assets', () => {
    expect(OVERLAY_HTML).toContain('<script src="chat.js" defer></script>');
    expect(OVERLAY_HTML).toContain('href="chat.css"');
    expect(OVERLAY_HTML.match(/<script/g)).toHaveLength(1);
    expect(OVERLAY_HTML).not.toMatch(/\son\w+=/i);
    expect(OVERLAY_HTML).not.toMatch(/token/i);
  });

  it('CSS keeps the page transparent', () => {
    expect(OVERLAY_CSS).toMatch(/background:\s*transparent/);
  });

  it('script is valid JS and never parses user text as HTML', () => {
    expect(() => new vm.Script(OVERLAY_JS)).not.toThrow();
    expect(OVERLAY_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });
});

describe('overlay script behavior', () => {
  it('connects to wss://<host>/overlay/ws with the token on https pages', () => {
    const { sockets } = runOverlay('https://203.0.113.7/overlay/chat?token=tok_123&max=3');
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe('wss://203.0.113.7/overlay/ws?token=tok_123');
  });

  it('uses ws:// on http pages and does nothing without a token', () => {
    expect(runOverlay('http://localhost:8443/overlay/chat?token=a').sockets[0]?.url).toBe(
      'ws://localhost:8443/overlay/ws?token=a',
    );
    expect(runOverlay('http://localhost:8443/overlay/chat').sockets).toHaveLength(0);
  });

  it('renders badge, author and text with textContent, dedupes and keeps max messages', () => {
    const { list, sockets } = runOverlay('https://h/overlay/chat?token=t&max=3');
    const ws = sockets[0]!;
    ws.onopen?.();
    ws.deliver(chat('1', { text: '<img src=x onerror=alert(1)>', author: { name: '<b>x</b>', color: '#ff0000' } }));
    ws.deliver(chat('1'));
    expect(list.children).toHaveLength(1);

    const [badge, author, text] = list.children[0]!.children;
    expect(badge).toMatchObject({ className: 'badge', textContent: 'T', title: 'Twitch' });
    expect(badge?.style).toMatchObject({ backgroundColor: '#9146FF', color: '#FFFFFF' });
    expect(author).toMatchObject({ className: 'author', textContent: '<b>x</b>' });
    expect(author?.style.color).toBe('#ff0000');
    expect(text).toMatchObject({ className: 'text', textContent: '<img src=x onerror=alert(1)>' });
    expect(list.children[0]?.attributes['data-platform']).toBe('twitch');

    ws.deliver(chat('2', { platform: 'evil"platform', author: { name: 'y', color: 'red;background:url(x)' } }));
    const unknown = list.children[1]!;
    expect(unknown.attributes['data-platform']).toBe('unknown');
    expect(unknown.children[0]?.textContent).toBe('?');
    expect(unknown.children[1]?.style.color).toBeUndefined();

    ws.deliver(chat('3', { kind: 'event' }));
    ws.deliver(chat('4'));
    expect(list.children.map((c) => c.children[2]?.textContent)).toEqual(['hello 2', 'hello 3', 'hello 4']);
    expect(list.children[1]?.className).toBe('msg event');

    // Ignores junk frames and non-chat messages.
    ws.onmessage?.({ data: 'not json' });
    ws.onmessage?.({ data: JSON.stringify({ type: 'session' }) });
    expect(list.children).toHaveLength(3);
  });

  it('fades messages after `fade` seconds and skips history older than that', () => {
    const { list, sockets, timers } = runOverlay('https://h/overlay/chat?token=t&fade=10');
    const ws = sockets[0]!;
    ws.deliver(chat('old', { ts: new Date(Date.now() - 60_000).toISOString() }));
    expect(list.children).toHaveLength(0);
    ws.deliver(chat('new'));
    expect(list.children).toHaveLength(1);
    const fade = timers.at(-1)!;
    expect(fade.ms).toBeGreaterThan(9000);
    expect(fade.ms).toBeLessThanOrEqual(10_000);
    fade.fn();
    expect(list.children[0]?.className).toBe('msg fading');
    timers.at(-1)!.fn();
    expect(list.children).toHaveLength(0);
  });

  it('removes moderated messages from the screen', () => {
    const { list, sockets } = runOverlay('https://h/overlay/chat?token=t&max=20');
    const ws = sockets[0]!;
    const moderate = (moderation: unknown) => ws.onmessage?.({ data: JSON.stringify({ type: 'chat-moderation', moderation }) });
    const texts = () => list.children.map((c) => c.children[2]?.textContent);

    ws.deliver(chat('twitch:1', { author: { name: 'Ann', id: 'u-ann' } }));
    ws.deliver(chat('twitch:2', { author: { name: 'Bob', id: 'u-bob' } }));
    ws.deliver(chat('twitch:3', { author: { name: 'Ann', id: 'u-ann' } }));
    ws.deliver(chat('youtube:4', { platform: 'youtube', destinationId: 'yt', author: { name: 'Cy' } }));
    ws.deliver(chat('youtube:5', { platform: 'youtube', destinationId: 'yt', author: { name: 'Dee', login: 'dee_l' } }));
    ws.deliver(chat('twitch:6', { author: { name: 'Eve' }, platformMessageId: 'raw-6' }));
    expect(list.children).toHaveLength(6);

    moderate({ kind: 'message-deleted', platform: 'twitch', destinationId: 'd', messageId: 'twitch:2', platformMessageId: '2' });
    expect(texts()).toEqual(['hello twitch:1', 'hello twitch:3', 'hello youtube:4', 'hello youtube:5', 'hello twitch:6']);

    // Unknown hub id: falls back to the platform message id.
    moderate({ kind: 'message-deleted', platform: 'twitch', destinationId: 'd', messageId: null, platformMessageId: 'raw-6' });
    expect(list.children).toHaveLength(4);

    // Another destination's moderation never touches this one.
    moderate({ kind: 'user-cleared', platform: 'twitch', destinationId: 'other', userId: 'u-ann', userName: null });
    expect(list.children).toHaveLength(4);

    moderate({ kind: 'user-cleared', platform: 'twitch', destinationId: 'd', userId: 'u-ann', userName: 'Ann' });
    expect(texts()).toEqual(['hello youtube:4', 'hello youtube:5']);

    moderate({ kind: 'user-cleared', platform: 'youtube', destinationId: 'yt', userId: null, userName: 'DEE_L' });
    expect(texts()).toEqual(['hello youtube:4']);

    moderate({ kind: 'cleared', platform: 'youtube', destinationId: 'yt' });
    expect(list.children).toHaveLength(0);

    // Junk is ignored; a deleted message id stays "seen" (not re-rendered by a replay).
    moderate(null);
    moderate({ kind: 'cleared' });
    ws.deliver(chat('twitch:1'));
    expect(list.children).toHaveLength(0);
    ws.deliver(chat('twitch:7'));
    expect(list.children).toHaveLength(1);
  });

  it('reconnects with backoff, but stops for good on close code 4401', () => {
    const { sockets, timers } = runOverlay('https://h/overlay/chat?token=t');
    sockets[0]!.onclose?.({ code: 1006 });
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBeGreaterThanOrEqual(1000);
    expect(timers[0]!.ms).toBeLessThan(1250);
    timers[0]!.fn();
    expect(sockets).toHaveLength(2);
    sockets[1]!.onclose?.({ code: 1006 });
    expect(timers[1]!.ms).toBeGreaterThanOrEqual(2000); // doubled
    timers[1]!.fn();
    sockets[2]!.onclose?.({ code: 4401 });
    expect(timers).toHaveLength(2);
  });
});
