import { useEffect, useMemo, useState } from 'react';
import type { ChatMessage, PlatformId } from '@shared/types';
import { PLATFORM_IDS } from '@shared/types';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { ChatLog } from '../components/ChatLog';
import { plural } from '../components/format';
import { PlatformBadge, platformName } from '../components/PlatformBadge';
import { useChat, useLiveActions, useLiveStatus } from '../state/live';

/** Platforms that appear in the chat (plus any selected), in the standard platform order. */
export function chatPlatforms(chat: readonly ChatMessage[], selected: ReadonlySet<PlatformId>): { id: PlatformId; count: number }[] {
  const counts = new Map<PlatformId, number>();
  for (const m of chat) counts.set(m.platform, (counts.get(m.platform) ?? 0) + 1);
  for (const p of selected) if (!counts.has(p)) counts.set(p, 0);
  return PLATFORM_IDS.filter((p) => counts.has(p)).map((id) => ({ id, count: counts.get(id) ?? 0 }));
}

export function filterChat(chat: ChatMessage[], selected: ReadonlySet<PlatformId>): ChatMessage[] {
  return selected.size === 0 ? chat : chat.filter((m) => selected.has(m.platform));
}

export default function ChatPage() {
  const chat = useChat();
  const connected = useLiveStatus();
  const { mergeChat } = useLiveActions();
  const [selected, setSelected] = useState<ReadonlySet<PlatformId>>(() => new Set());

  // REST fallback for history if the live socket isn't up yet on mount (merge dedupes by id).
  const connectedOnMount = connected;
  useEffect(() => {
    if (!connectedOnMount) api.recentChat(200).then(mergeChat, () => undefined);
  }, [mergeChat]);

  const platforms = useMemo(() => chatPlatforms(chat, selected), [chat, selected]);
  const messages = useMemo(() => filterChat(chat, selected), [chat, selected]);
  const filterKey = [...selected].sort().join(',');

  const toggle = (p: PlatformId) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  return (
    <div className="chat-page">
      <div className="page-header">
        <div>
          <h1>Chat</h1>
          <p>Read-only chat from every platform, newest at the bottom.</p>
        </div>
        <div className="row">
          {!connected && (
            <Badge tone="warn" dot pulse>
              Reconnecting
            </Badge>
          )}
          <span className="muted small">{plural(messages.length, 'message')}</span>
        </div>
      </div>
      {platforms.length > 1 || selected.size > 0 ? (
        <div className="chips" role="group" aria-label="Filter by platform">
          <button type="button" className="chip is-text" aria-pressed={selected.size === 0} onClick={() => setSelected(new Set())}>
            All
          </button>
          {platforms.map((p) => (
            <button key={p.id} type="button" className="chip" aria-pressed={selected.has(p.id)} onClick={() => toggle(p.id)}>
              <PlatformBadge platform={p.id} size="sm" />
              {platformName(p.id)}
              <span className="chip-count">{p.count}</span>
            </button>
          ))}
        </div>
      ) : null}
      <Card className="chat-card" flush>
        <ChatLog
          key={filterKey}
          messages={messages}
          emptyText={
            selected.size > 0
              ? 'No messages from the selected platforms yet.'
              : 'No chat messages yet. Chat appears here while you are live on platforms with chat support.'
          }
        />
      </Card>
    </div>
  );
}
