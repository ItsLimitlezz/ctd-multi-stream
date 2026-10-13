import { cx, type Tone } from './utils';

export interface StatusDotProps {
  tone?: Tone;
  pulse?: boolean;
  /** Accessible label; without it the dot is decorative. */
  label?: string;
  className?: string;
}

export function StatusDot({ tone = 'neutral', pulse = false, label, className }: StatusDotProps) {
  return (
    <span
      className={cx('dot', `tone-${tone}`, pulse && 'dot-pulse', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={label}
    />
  );
}
