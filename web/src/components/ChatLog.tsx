import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ChatMessage } from '@shared/types';
import { formatClock } from './format';
import { ArrowDownIcon } from './icons';
import { PlatformBadge } from './PlatformBadge';
import { cx, safeHexColor } from './utils';

export interface ChatLogProps {
  /** Oldest first. */
  messages: readonly ChatMessage[];
  /** Denser rows, no author badges (dashboard panel). */
  compact?: boolean;
  emptyText?: ReactNode;
  className?: string;
}

const STICK_PX = 48;

/**
 * Scrolling chat list that sticks to the bottom while the user is there and shows a
 * "jump to latest" button when they have scrolled up. Text is rendered as plain text nodes.
 */
export function ChatLog({ messages, compact = false, emptyText = 'No messages yet.', className }: ChatLogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const lastIdRef = useRef<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
    if (bottom) setUnseen(0);
  };

  useLayoutEffect(() => {
    const el = ref.current;
    const lastId = messages[messages.length - 1]?.id ?? null;
    if (!el || lastId === lastIdRef.current) return;
    const prevIdx = lastIdRef.current === null ? -1 : messages.findIndex((m) => m.id === lastIdRef.current);
    lastIdRef.current = lastId;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      const added = prevIdx === -1 ? messages.length : messages.length - 1 - prevIdx;
      setUnseen((n) => n + added);
    }
  }, [messages]);

  const jumpToLatest = () => {
    const el = ref.current;
    if (!el) return;
    // Instant (not smooth): a message arriving mid-animation would otherwise un-stick the log.
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
    setUnseen(0);
  };

  return (
    <div className={cx('chat-log-wrap', className)}>
      <div ref={ref} className={cx('chat-log', compact && 'is-compact')} onScroll={onScroll} role="log" aria-label="Chat messages" tabIndex={0}>
        {messages.length === 0 ? <div className="chat-empty">{emptyText}</div> : messages.map((m) => <ChatRow key={m.id} message={m} compact={compact} />)}
      </div>
      {!atBottom && messages.length > 0 && (
        <button type="button" className="btn btn-primary btn-sm chat-jump" onClick={jumpToLatest}>
          <ArrowDownIcon width={14} height={14} />
          {unseen > 0 ? `${unseen > 99 ? '99+' : unseen} new` : 'Jump to latest'}
        </button>
      )}
    </div>
  );
}

const ChatRow = memo(function ChatRow({ message: m, compact }: { message: ChatMessage; compact: boolean }) {
  const color = safeHexColor(m.author.color);
  const badges = !compact && m.author.badges ? m.author.badges.slice(0, 3) : [];
  return (
    <div className={cx('chat-msg', m.kind === 'event' && 'is-event')}>
      <time className="chat-time" dateTime={m.ts}>
        {formatClock(m.ts)}
      </time>
      <PlatformBadge platform={m.platform} size="sm" />
      <div className="chat-body">
        {badges.map((b) => (
          <span key={b} className="chat-badge">
            {b}
          </span>
        ))}
        <span className="chat-author" style={color ? ({ '--author-color': color } as CSSProperties) : undefined}>
          {m.author.name}
        </span>
        <span className="chat-text">{m.text}</span>
      </div>
    </div>
  );
});
