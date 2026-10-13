import type { ReactNode } from 'react';
import type { PlatformInfo } from '@shared/types';
import { Badge } from '../../components/Badge';
import { PlatformBadge } from '../../components/PlatformBadge';
import { FEED_LABEL, sortPlatforms } from './destination-form';
import '../settings/admin.css';

export interface PlatformPickerProps {
  platforms: readonly PlatformInfo[];
  onPick: (info: PlatformInfo) => void;
  /** Extra content per platform card (e.g. a "needs developer app" badge). */
  extra?: (info: PlatformInfo) => ReactNode;
  /** Show which feeds each platform accepts (default true). */
  showFeeds?: boolean;
  /** Disable a card (with the reason as tooltip). */
  disabledReason?: (info: PlatformInfo) => string | null;
  'aria-label'?: string;
}

/** Grid of platform cards (name, feeds, experimental flag, notes) driven by PlatformInfo. */
export function PlatformPicker({ platforms, onPick, extra, showFeeds = true, disabledReason, ...aria }: PlatformPickerProps) {
  if (platforms.length === 0) {
    return <p className="muted">No platforms are available on this server.</p>;
  }
  return (
    <div className="platform-grid" role="list" aria-label={aria['aria-label'] ?? 'Platforms'}>
      {sortPlatforms(platforms).map((info) => {
        const reason = disabledReason?.(info) ?? null;
        return (
          <div role="listitem" key={info.id} style={{ display: 'flex' }}>
            <button
              type="button"
              className="platform-card"
              style={{ flex: 1 }}
              onClick={() => onPick(info)}
              disabled={reason !== null}
              title={reason ?? undefined}
            >
              <PlatformBadge platform={info.id} size="lg" withName />
              <span className="row">
                {showFeeds &&
                  info.feeds.map((f) => (
                    <Badge key={f} tone={info.feeds.length === 1 && f === 'vertical' ? 'accent' : 'neutral'}>
                      {info.feeds.length === 1 ? `${FEED_LABEL[f]} only` : FEED_LABEL[f]}
                    </Badge>
                  ))}
                {info.experimental && (
                  <Badge tone="warn" title="This platform's support is new and may break when the platform changes its site">
                    Experimental
                  </Badge>
                )}
                {extra?.(info)}
              </span>
              {info.notes && <span className="platform-card-notes">{info.notes}</span>}
            </button>
          </div>
        );
      })}
    </div>
  );
}
