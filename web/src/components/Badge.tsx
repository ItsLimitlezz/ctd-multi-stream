import type { ReactNode } from 'react';
import { StatusDot } from './StatusDot';
import { cx, type Tone } from './utils';

export interface BadgeProps {
  tone?: Tone;
  /** Leading status dot. */
  dot?: boolean;
  /** Pulse the dot (live / in progress). */
  pulse?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}

export function Badge({ tone = 'neutral', dot = false, pulse = false, title, className, children }: BadgeProps) {
  return (
    <span className={cx('badge', `tone-${tone}`, className)} title={title}>
      {dot && <StatusDot tone={tone} pulse={pulse} />}
      {children}
    </span>
  );
}
