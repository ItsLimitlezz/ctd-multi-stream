import type { DestinationPhase } from '@shared/types';
import { Badge } from './Badge';
import type { Tone } from './utils';

export interface PhaseMeta {
  label: string;
  tone: Tone;
  /** Animated dot (in progress / live). */
  pulse: boolean;
}

export const PHASE_META: Readonly<Record<DestinationPhase, PhaseMeta>> = {
  idle: { label: 'Idle', tone: 'neutral', pulse: false },
  disabled: { label: 'Disabled', tone: 'neutral', pulse: false },
  'waiting-for-feed': { label: 'Waiting for feed', tone: 'warn', pulse: false },
  preparing: { label: 'Preparing', tone: 'info', pulse: true },
  connecting: { label: 'Connecting', tone: 'info', pulse: true },
  confirming: { label: 'Going live', tone: 'info', pulse: true },
  live: { label: 'Live', tone: 'live', pulse: true },
  retrying: { label: 'Retrying', tone: 'warn', pulse: true },
  // The platform ended the live (e.g. a copyright takedown) and a fresh one is being created.
  recovering: { label: 'Recovering', tone: 'warn', pulse: true },
  ending: { label: 'Ending', tone: 'neutral', pulse: true },
  error: { label: 'Error', tone: 'danger', pulse: false },
};

export function phaseMeta(phase: string): PhaseMeta {
  return (PHASE_META as Record<string, PhaseMeta | undefined>)[phase] ?? { label: phase, tone: 'neutral', pulse: false };
}

export interface PhaseBadgeProps {
  phase: DestinationPhase;
  className?: string;
}

/** DestinationPhase as a colored badge. */
export function PhaseBadge({ phase, className }: PhaseBadgeProps) {
  const meta = phaseMeta(phase);
  return (
    <Badge tone={meta.tone} dot pulse={meta.pulse} className={className}>
      {meta.label}
    </Badge>
  );
}
