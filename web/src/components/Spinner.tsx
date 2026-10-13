import { cx } from './utils';

export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  /** Accessible label; pass null when a parent already announces the busy state. */
  label?: string | null;
  className?: string;
}

export function Spinner({ size = 'md', label = 'Loading', className }: SpinnerProps) {
  return (
    <span
      className={cx('spinner', size !== 'md' && `spinner-${size}`, className)}
      role={label ? 'status' : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
    />
  );
}
