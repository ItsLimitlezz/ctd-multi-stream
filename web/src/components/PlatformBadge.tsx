import type { PlatformId } from '@shared/types';
import { cx } from './utils';

export interface PlatformMeta {
  name: string;
  /** Brand color (circle background). */
  color: string;
  /** Text color on top of `color`. */
  fg: string;
}

export const PLATFORM_META: Readonly<Record<PlatformId, PlatformMeta>> = {
  twitch: { name: 'Twitch', color: '#9146FF', fg: '#ffffff' },
  youtube: { name: 'YouTube', color: '#FF0000', fg: '#ffffff' },
  kick: { name: 'Kick', color: '#53FC18', fg: '#0b0e0a' },
  facebook: { name: 'Facebook', color: '#1877F2', fg: '#ffffff' },
  x: { name: 'X', color: '#000000', fg: '#ffffff' },
  instagram: { name: 'Instagram', color: '#E1306C', fg: '#ffffff' },
  tiktok: { name: 'TikTok', color: '#00F2EA', fg: '#000000' },
  custom: { name: 'Custom RTMP', color: '#888888', fg: '#ffffff' },
};

/** Meta for a platform id (unknown ids fall back to "custom" styling with the raw id as name). */
export function platformMeta(id: string): PlatformMeta {
  return (PLATFORM_META as Record<string, PlatformMeta | undefined>)[id] ?? { ...PLATFORM_META.custom, name: id };
}

export function platformName(id: string): string {
  return platformMeta(id).name;
}

export interface PlatformBadgeProps {
  platform: PlatformId;
  size?: 'sm' | 'md' | 'lg';
  /** Show the platform name next to the circle. */
  withName?: boolean;
  className?: string;
}

/** Colored circle with the platform's initial (no logos). */
export function PlatformBadge({ platform, size = 'md', withName = false, className }: PlatformBadgeProps) {
  const meta = platformMeta(platform);
  return (
    <span className={cx('platform-badge', `pb-${size}`, className)} title={withName ? undefined : meta.name}>
      <span
        className="platform-circle"
        style={{ background: meta.color, color: meta.fg }}
        role={withName ? undefined : 'img'}
        aria-label={withName ? undefined : meta.name}
        aria-hidden={withName ? true : undefined}
      >
        {meta.name.charAt(0).toUpperCase()}
      </span>
      {withName && <span className="platform-name">{meta.name}</span>}
    </span>
  );
}
