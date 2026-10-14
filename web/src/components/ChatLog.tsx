import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ChatAlertKind, ChatMessage } from '@shared/types';
import { alertParts, chatSegments, messageAlert } from './chat-format';
import { formatClock } from './format';
import { ArrowDownIcon, BoltIcon, CoinIcon, CrownIcon, GemIcon, GiftIcon, HeartIcon, StarIcon, UsersIcon } from './icons';
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

function tsOf(m: ChatMessage | undefined): number {
  const t = m ? Date.parse(m.ts) : Number.NaN;
  return Number.isNaN(t) ? 0 : t;
}

/**
 * How many messages arrived after the previous last one. Moderation can remove that message (or
 * the newest ones), so when it's gone count by timestamp instead of treating everything as new.
 */
export function countNewMessages(messages: readonly ChatMessage[], prev: { id: string; ts: number } | null): number {
  if (!prev) return messages.length;
  const idx = messages.findIndex((m) => m.id === prev.id);
  if (idx !== -1) return messages.length - 1 - idx;
  let n = 0;
  for (const m of messages) if (tsOf(m) > prev.ts) n++;
  return n;
}

/**
 * Scrolling chat list that sticks to the bottom while the user is there and shows a
 * "jump to latest" button when they have scrolled up. Text is rendered as plain text nodes.
 */
export function ChatLog({ messages, compact = false, emptyText = 'No messages yet.', className }: ChatLogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const lastRef = useRef<{ id: string; ts: number } | null>(null);
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
    const last = messages[messages.length - 1];
    const lastId = last?.id ?? null;
    if (!el || lastId === (lastRef.current?.id ?? null)) return;
    const added = countNewMessages(messages, lastRef.current);
    lastRef.current = last ? { id: last.id, ts: tsOf(last) } : null;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    } else if (added > 0) {
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

const ALERT_ICON: Record<ChatAlertKind, (p: { width: number; height: number }) => ReactNode> = {
  follow: HeartIcon,
  subscription: StarIcon,
  gift: GiftIcon,
  cheer: GemIcon,
  kicks: BoltIcon,
  raid: UsersIcon,
  membership: CrownIcon,
  superchat: CoinIcon,
  tip: CoinIcon,
};

/** Sub / gift / cheer / raid / Super Chat… tag at the start of an alert line. */
function AlertTag({ kind, label, amount, tier }: { kind: ChatAlertKind; label: string; amount: string | null; tier: string | null }) {
  const Icon = ALERT_ICON[kind];
  return (
    <span className="chat-alert-tag">
      <Icon width={13} height={13} />
      <span>{label}</span>
      {amount && <b className="chat-alert-amount">{amount}</b>}
      {tier && <span className="chat-alert-tier">{tier}</span>}
    </span>
  );
}

function MessageText({ message, style }: { message: ChatMessage; style?: CSSProperties }) {
  const segments = chatSegments(message);
  return (
    <span className="chat-text" style={style}>
      {segments.map((s, i) =>
        s.kind === 'emote' ? (
          <img key={i} className="chat-emote" src={s.src} alt={s.text} title={s.text} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
        ) : s.kind === 'mention' ? (
          <span key={i} className="chat-mention">
            {s.text}
          </span>
        ) : (
          s.text
        ),
      )}
    </span>
  );
}

const ChatRow = memo(function ChatRow({ message: m, compact }: { message: ChatMessage; compact: boolean }) {
  const color = safeHexColor(m.author.color);
  const badges = !compact && m.author.badges ? m.author.badges.slice(0, 3) : [];
  const alert = messageAlert(m);
  const parts = alert ? alertParts(alert) : null;
  const action = m.action === true && m.kind === 'message';
  const colorStyle = color ? ({ '--author-color': color } as CSSProperties) : undefined;
  return (
    <div
      className={cx(
        'chat-msg',
        m.kind === 'event' && 'is-event',
        alert && `is-alert alert-${alert.kind}`,
        m.highlighted === true && 'is-highlighted',
        action && 'is-action',
      )}
    >
      <time className="chat-time" dateTime={m.ts}>
        {formatClock(m.ts)}
      </time>
      <PlatformBadge platform={m.platform} size="sm" />
      <div className="chat-body">
        {alert && parts && <AlertTag kind={alert.kind} label={parts.label} amount={parts.amount} tier={parts.tier} />}
        {badges.map((b) => (
          <span key={b} className="chat-badge">
            {b}
          </span>
        ))}
        <span className="chat-author" style={colorStyle}>
          {m.author.name}
        </span>
        {/* /me: the whole line in the author's color, like the platforms show it. */}
        <MessageText message={m} style={action ? colorStyle : undefined} />
      </div>
    </div>
  );
});
