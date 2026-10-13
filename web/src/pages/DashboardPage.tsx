import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Destination, DestinationPhase, DestinationState, Feed, FeedState, SessionState, TitleResult } from '@shared/types';
import { FEEDS } from '@shared/types';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { Button, buttonClass } from '../components/Button';
import { Card } from '../components/Card';
import { ChatLog } from '../components/ChatLog';
import { ConfirmButton } from '../components/ConfirmButton';
import { EmptyState } from '../components/EmptyState';
import { Field } from '../components/Field';
import {
  elapsedSeconds,
  formatAudio,
  formatBitrate,
  formatClock,
  formatDuration,
  formatFps,
  formatResolution,
  plural,
} from '../components/format';
import { BroadcastIcon, ExternalIcon, LandscapeIcon, RetryIcon, VerticalIcon } from '../components/icons';
import { PhaseBadge } from '../components/PhaseBadge';
import { PlatformBadge, platformName } from '../components/PlatformBadge';
import { Spinner } from '../components/Spinner';
import { StatusDot } from '../components/StatusDot';
import { TextInput } from '../components/TextInput';
import { toast } from '../components/Toast';
import { Toggle } from '../components/Toggle';
import { cx, safeHttpUrl, type Tone } from '../components/utils';
import { Link } from '../router';
import { useAuth } from '../state/auth';
import { errorMessage } from '../state/errors';
import { useDestinations, useNow } from '../state/hooks';
import { useChat, useLiveActions, useSession, type LiveActions } from '../state/live';

export const TITLE_MAX = 140;
const FEED_LABEL: Record<Feed, string> = { landscape: 'Landscape', vertical: 'Vertical' };
const ACTIVE_PHASES: ReadonlySet<DestinationPhase> = new Set(['waiting-for-feed', 'preparing', 'connecting', 'confirming', 'live', 'retrying', 'error']);

export default function DashboardPage() {
  const session = useSession();
  const { seedSession } = useLiveActions();
  const { isAdmin } = useAuth();
  const dests = useDestinations();

  // REST fallback while the WebSocket hasn't delivered the first snapshot (mount only;
  // seedSession ignores it if the socket got there first).
  const hasSession = session !== null;
  useEffect(() => {
    if (!hasSession) api.session().then(seedSession, () => undefined);
  }, [seedSession]);

  return (
    <div className="dash">
      <div className="dash-main">
        <StatusCard session={session} />
        <FeedsRow feeds={session?.feeds ?? null} />
        <TitleCard session={session} destinations={dests.data ?? []} />
        <DestinationsSection
          destinations={dests.data}
          loading={dests.loading}
          error={dests.error}
          reload={dests.reload}
          states={session?.destinations ?? []}
          isAdmin={isAdmin}
          onUpdated={(d) => dests.setData((list) => list?.map((x) => (x.id === d.id ? d : x)))}
        />
      </div>
      <aside className="dash-aside">
        <ChatPanel />
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status + controls
// ---------------------------------------------------------------------------

const STATUS_TEXT: Record<SessionState['status'], { label: string; tone: Tone; pulse: boolean }> = {
  offline: { label: 'Offline', tone: 'neutral', pulse: false },
  starting: { label: 'Starting…', tone: 'warn', pulse: true },
  live: { label: 'LIVE', tone: 'live', pulse: true },
  stopping: { label: 'Stopping…', tone: 'warn', pulse: true },
};

export function statusSubtitle(session: SessionState): string {
  const active = session.destinations.filter((d) => ACTIVE_PHASES.has(d.phase));
  const live = active.filter((d) => d.phase === 'live').length;
  switch (session.status) {
    case 'offline':
      if (!session.autoGoLive) return 'Press "Go live" when you are ready.';
      // Auto go-live only reacts to a feed coming online, so after a manual stop with OBS still
      // streaming nothing starts by itself.
      return session.feeds.some((f) => f.online)
        ? 'OBS is streaming. Press "Go live" to start; auto go-live triggers the next time OBS starts streaming.'
        : 'Waiting for OBS. The stream starts automatically when OBS starts streaming.';
    case 'starting':
      return active.length ? `Preparing destinations… ${live} of ${active.length} live` : 'Preparing destinations…';
    case 'live':
      return active.length ? `${live} of ${plural(active.length, 'destination')} live` : 'No active destinations';
    case 'stopping':
      return 'Ending the stream on every platform…';
  }
}

type SessionAction = 'start' | 'stop' | 'auto';

/**
 * Push a start / stop / auto-toggle response into the live store. Start and stop answer once the
 * operation is done, so their snapshot is current. The auto toggle answers before the auto start it
 * may trigger has run, so its snapshot can be older than WebSocket 'session' messages that already
 * arrived ('live'): only merge the flag.
 */
export function applySessionResult(
  kind: SessionAction,
  res: SessionState,
  actions: Pick<LiveActions, 'applySession' | 'patchSession'>,
): void {
  if (kind === 'auto') actions.patchSession({ autoGoLive: res.autoGoLive });
  else actions.applySession(res);
}

function StatusCard({ session }: { session: SessionState | null }) {
  const actions = useLiveActions();
  const [busy, setBusy] = useState<SessionAction | null>(null);
  const live = session?.status === 'live';
  const now = useNow(live ? 1000 : null);

  if (!session) {
    return (
      <Card>
        <div className="row muted">
          <Spinner size="sm" /> Loading stream status…
        </div>
      </Card>
    );
  }

  const run = async (kind: SessionAction, fn: () => Promise<SessionState>) => {
    setBusy(kind);
    try {
      applySessionResult(kind, await fn(), actions);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const ui = STATUS_TEXT[session.status];
  return (
    <Card className={cx('status-card', `is-${session.status}`)} aria-label="Stream status">
      <div className="status-row">
        <div className="status-main">
          <StatusDot tone={ui.tone} pulse={ui.pulse} />
          <div>
            <div className="status-label" role="status">
              {ui.label}
              {live && <span className="status-elapsed">{formatDuration(elapsedSeconds(session.startedAt, now))}</span>}
            </div>
            <p className="status-sub">{statusSubtitle(session)}</p>
          </div>
        </div>
        <div className="status-actions">
          {session.status === 'offline' ? (
            <Button
              variant="primary"
              size="lg"
              icon={<BroadcastIcon width={18} height={18} />}
              loading={busy === 'start'}
              onClick={() => void run('start', api.startSession)}
            >
              Go live
            </Button>
          ) : (
            <ConfirmButton
              variant="danger"
              size="lg"
              confirmLabel="Tap again to end"
              disabled={session.status === 'stopping'}
              loading={busy === 'stop'}
              onConfirm={() => run('stop', api.stopSession)}
            >
              {session.status === 'starting' ? 'Cancel' : 'End stream'}
            </ConfirmButton>
          )}
        </div>
      </div>
      <div className="status-auto">
        <Field label="Auto go-live" help="Start automatically when OBS starts streaming" inline>
          <Toggle
            checked={session.autoGoLive}
            busy={busy === 'auto'}
            onChange={(v) => void run('auto', () => api.setAutoGoLive(v))}
          />
        </Field>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

const FEED_HINT: Record<Feed, string> = {
  landscape: 'Start streaming in OBS (main output).',
  vertical: 'Start the vertical output in OBS (Aitum Vertical).',
};

function FeedsRow({ feeds }: { feeds: FeedState[] | null }) {
  return (
    <div className="feeds">
      {FEEDS.map((feed) => (
        <FeedCard key={feed} feed={feed} state={feeds?.find((f) => f.feed === feed) ?? null} loading={!feeds} />
      ))}
    </div>
  );
}

function FeedCard({ feed, state, loading }: { feed: Feed; state: FeedState | null; loading: boolean }) {
  const online = !!state?.online;
  const Icon = feed === 'landscape' ? LandscapeIcon : VerticalIcon;
  return (
    <Card>
      <div className="feed-head">
        <span className="feed-icon">
          <Icon />
        </span>
        <h2 className="card-title">{FEED_LABEL[feed]} feed</h2>
        <span className="spacer" />
        {loading ? (
          <Spinner size="sm" />
        ) : (
          <Badge tone={online ? 'success' : 'neutral'} dot pulse={online}>
            {online ? 'Online' : 'Offline'}
          </Badge>
        )}
      </div>
      {online && state ? (
        <dl className="kv">
          <dt>Resolution</dt>
          <dd>{formatResolution(state.video?.width, state.video?.height)}</dd>
          <dt>Frame rate</dt>
          <dd>{formatFps(state.video?.fps)}</dd>
          <dt>Video</dt>
          <dd>{state.video?.codec?.toUpperCase() || '—'}</dd>
          <dt>Audio</dt>
          <dd>{formatAudio(state.audio)}</dd>
          <dt>Bitrate</dt>
          <dd>{formatBitrate(state.bitrateKbps)}</dd>
          {state.since && (
            <>
              <dt>Since</dt>
              <dd>{formatClock(state.since)}</dd>
            </>
          )}
        </dl>
      ) : (
        !loading && <p className="muted small" style={{ marginTop: 10 }}>{FEED_HINT[feed]}</p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

function TitleCard({ session, destinations }: { session: SessionState | null; destinations: Destination[] }) {
  const { patchSession } = useLiveActions();
  const serverTitle = session?.title ?? '';
  const [draft, setDraft] = useState(serverTitle);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<TitleResult[] | null>(null);

  // Follow title changes made elsewhere unless the user is editing.
  useEffect(() => {
    if (!dirty) setDraft(serverTitle);
  }, [serverTitle, dirty]);

  const trimmed = draft.trim();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const res = await api.setTitle(trimmed);
      patchSession({ title: res.title });
      setDraft(res.title);
      setDirty(false);
      setResults(res.results);
      const failed = res.results.filter((r) => !r.ok && !r.skipped).length;
      if (failed) toast.warn(`Title saved, but ${plural(failed, 'platform')} failed to update.`);
      else toast.success('Title updated.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Stream title" subtitle="One title on every platform. The category is never changed.">
      <form onSubmit={(e) => void submit(e)}>
        <Field label="Stream title" hideLabel>
          <div className="title-row">
            <TextInput
              value={draft}
              maxLength={TITLE_MAX}
              placeholder="What are you streaming today?"
              onValueChange={(v) => {
                setDraft(v);
                setDirty(true);
              }}
              disabled={!session}
            />
            <Button type="submit" variant="primary" loading={saving} disabled={!trimmed || !session}>
              Update title
            </Button>
          </div>
        </Field>
        <div className="title-meta">
          {dirty && trimmed !== serverTitle && <span>Unsaved changes</span>}
          <span className={cx('counter', draft.length > TITLE_MAX - 15 && 'is-warn')} aria-live="polite">
            {draft.length}/{TITLE_MAX}
          </span>
        </div>
      </form>
      {results && <TitleResults results={results} destinations={destinations} onDismiss={() => setResults(null)} />}
    </Card>
  );
}

function TitleResults({ results, destinations, onDismiss }: { results: TitleResult[]; destinations: Destination[]; onDismiss: () => void }) {
  const byId = useMemo(() => new Map(destinations.map((d) => [d.id, d])), [destinations]);
  if (results.length === 0) {
    return (
      <div className="row-between" style={{ marginTop: 12 }}>
        <span className="muted small">Saved. It will be used when the stream starts.</span>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 4 }}>
      <ul className="result-list" aria-label="Title update results">
        {results.map((r) => {
          const dest = byId.get(r.destinationId);
          return (
            <li key={r.destinationId}>
              {dest && <PlatformBadge platform={dest.platform} size="sm" />}
              <span className="result-name">
                <span className="truncate">{dest?.name ?? 'Removed destination'}</span>
                {!r.ok && r.error && <span className="result-error">{r.error}</span>}
                {r.skipped && r.error && (
                  <span className="muted" style={{ display: 'block', fontSize: '0.83rem' }}>
                    {r.error}
                  </span>
                )}
              </span>
              {r.skipped ? (
                <Badge tone="neutral">Skipped</Badge>
              ) : r.ok ? (
                <Badge tone="success">Updated</Badge>
              ) : (
                <Badge tone="danger">Failed</Badge>
              )}
            </li>
          );
        })}
      </ul>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

interface DestinationsSectionProps {
  destinations: Destination[] | undefined;
  loading: boolean;
  error: string | null;
  reload: () => void;
  states: DestinationState[];
  isAdmin: boolean;
  onUpdated: (d: Destination) => void;
}

function DestinationsSection({ destinations, loading, error, reload, states, isAdmin, onUpdated }: DestinationsSectionProps) {
  const stateById = useMemo(() => new Map(states.map((s) => [s.destinationId, s])), [states]);

  let body;
  if (!destinations) {
    body = error ? (
      <Card>
        <EmptyState
          title="Couldn't load destinations"
          description={error}
          action={
            <Button onClick={reload} loading={loading}>
              Try again
            </Button>
          }
        />
      </Card>
    ) : (
      <Card>
        <div className="row muted">
          <Spinner size="sm" /> Loading destinations…
        </div>
      </Card>
    );
  } else if (destinations.length === 0) {
    body = (
      <Card>
        <EmptyState
          icon={<BroadcastIcon />}
          title="No destinations yet"
          description={
            isAdmin
              ? 'Add the platforms you want to stream to (Twitch, YouTube, Kick, …) and pick which feed each one gets.'
              : 'Ask an admin to add destinations.'
          }
          action={
            isAdmin ? (
              <Link to="/destinations" className={buttonClass('primary')}>
                Add a destination
              </Link>
            ) : undefined
          }
        />
      </Card>
    );
  } else {
    body = (
      <div className="dest-grid">
        {destinations.map((d) => (
          <DestinationCard key={d.id} dest={d} state={stateById.get(d.id) ?? null} onUpdated={onUpdated} />
        ))}
      </div>
    );
  }

  return (
    <section aria-labelledby="dest-heading">
      <div className="section-head">
        <h2 id="dest-heading">
          Destinations {destinations && destinations.length > 0 && <span className="muted">({destinations.length})</span>}
        </h2>
        {isAdmin && destinations && destinations.length > 0 && (
          <Link to="/destinations" className={buttonClass('ghost', 'sm')}>
            Manage
          </Link>
        )}
      </div>
      {body}
    </section>
  );
}

function DestinationCard({ dest, state, onUpdated }: { dest: Destination; state: DestinationState | null; onUpdated: (d: Destination) => void }) {
  const [toggling, setToggling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const phase: DestinationPhase = state?.phase ?? (dest.enabled ? 'idle' : 'disabled');
  const watchUrl = safeHttpUrl(state?.watchUrl);
  const stats = state?.stats ?? null;
  const canRetry = phase === 'error' || phase === 'retrying';

  const toggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      onUpdated(await api.setDestinationEnabled(dest.id, enabled));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setToggling(false);
    }
  };

  const retry = async () => {
    setRetrying(true);
    try {
      await api.retryDestination(dest.id);
      toast.info(`Retrying ${dest.name}…`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <section
      className={cx('card dest-card', !dest.enabled && 'is-disabled', phase === 'live' && 'is-live', phase === 'error' && 'is-error')}
      aria-label={`${dest.name} (${platformName(dest.platform)})`}
    >
      <div className="stack-sm" style={{ gap: 10 }}>
        <div className="dest-head">
          <PlatformBadge platform={dest.platform} />
          <span className="dest-name truncate" title={dest.name}>
            {dest.name}
          </span>
          <Toggle
            size="sm"
            checked={dest.enabled}
            busy={toggling}
            aria-label={`${dest.enabled ? 'Disable' : 'Enable'} ${dest.name}`}
            onChange={(v) => void toggle(v)}
          />
        </div>
        <div className="dest-meta">
          <PhaseBadge phase={phase} />
          <Badge tone="neutral">{FEED_LABEL[dest.feed]}</Badge>
          {state && state.retries > 0 && phase !== 'live' && <span className="faint small">attempt {state.retries + 1}</span>}
        </div>
        {state?.message && <p className={cx('dest-message', phase === 'error' && 'is-error')}>{state.message}</p>}
        {stats && (phase === 'live' || phase === 'connecting' || phase === 'confirming') && (
          <div className="dest-stats">
            <span>
              <b>{formatBitrate(stats.bitrateKbps)}</b>
            </span>
            <span>
              <b>{formatFps(stats.fps)}</b>
            </span>
            <span>
              up <b>{formatDuration(stats.uptimeSec)}</b>
            </span>
            {stats.speed > 0 && Math.abs(stats.speed - 1) > 0.05 && (
              <span className={stats.speed < 0.95 ? 'text-warn' : undefined}>
                speed <b>{stats.speed.toFixed(2)}x</b>
              </span>
            )}
          </div>
        )}
      </div>
      <div className="dest-foot">
        {watchUrl ? (
          <a href={watchUrl} target="_blank" rel="noopener noreferrer" className={buttonClass('ghost', 'sm')}>
            <ExternalIcon width={14} height={14} /> Watch
          </a>
        ) : (
          <span className="faint small">{platformName(dest.platform)}</span>
        )}
        <span className="spacer" />
        {canRetry && (
          <Button size="sm" icon={<RetryIcon width={14} height={14} />} loading={retrying} onClick={() => void retry()}>
            Retry
          </Button>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Chat panel
// ---------------------------------------------------------------------------

function ChatPanel() {
  const chat = useChat();
  const recent = useMemo(() => chat.slice(-150), [chat]);
  return (
    <Card
      className="chat-panel"
      title="Chat"
      actions={
        <Link to="/chat" className={buttonClass('ghost', 'sm')}>
          Open full chat
        </Link>
      }
      flush
    >
      <ChatLog messages={recent} compact emptyText="Chat from every platform shows up here while you're live." />
    </Card>
  );
}
