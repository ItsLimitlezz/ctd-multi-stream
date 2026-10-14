import { useId, type ReactNode } from 'react';
import { useFieldControl } from './Field';
import { cx } from './utils';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Text next to the switch (clicking it toggles too). */
  label?: ReactNode;
  disabled?: boolean;
  /** Request in flight: disabled with a subtle animation. */
  busy?: boolean;
  size?: 'sm' | 'md';
  id?: string;
  'aria-label'?: string;
  /** Id(s) of the element(s) naming the switch (default: the `label` text, when given). */
  'aria-labelledby'?: string;
  /** Id(s) of help text (default: the surrounding Field's help/error). */
  'aria-describedby'?: string;
  className?: string;
}

/** On/off switch (role="switch"). */
export function Toggle({ checked, onChange, label, disabled, busy, size = 'md', id, className, ...aria }: ToggleProps) {
  const field = useFieldControl();
  const labelId = useId();
  // A switch inside a <label> doesn't reliably take its name from it: point at the text explicitly.
  const labelledBy = aria['aria-labelledby'] ?? (label && !aria['aria-label'] ? labelId : undefined);
  const button = (
    <button
      type="button"
      role="switch"
      id={id ?? field?.id}
      aria-checked={checked}
      aria-label={aria['aria-label']}
      aria-labelledby={labelledBy}
      aria-describedby={aria['aria-describedby'] ?? field?.describedBy}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      className={cx('toggle', size === 'sm' && 'toggle-sm', !label && className)}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-thumb" />
    </button>
  );
  if (!label) return button;
  return (
    <label className={cx('toggle-label', className)}>
      {button}
      <span id={labelId}>{label}</span>
    </label>
  );
}
