import type { Ref, SelectHTMLAttributes } from 'react';
import { useFieldControl } from './Field';
import { cx } from './utils';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  options: readonly SelectOption[];
  /** Adds a first, empty option with this label (value ''). */
  placeholder?: string;
  invalid?: boolean;
  /** Convenience: called with the selected value (alongside the native onChange). */
  onValueChange?: (value: string) => void;
  ref?: Ref<HTMLSelectElement>;
}

export function Select({ options, placeholder, invalid, onValueChange, onChange, className, id, ...rest }: SelectProps) {
  const field = useFieldControl();
  return (
    <div className={cx('select-wrap', className)}>
      <select
        {...rest}
        id={id ?? field?.id}
        aria-describedby={rest['aria-describedby'] ?? field?.describedBy}
        aria-invalid={invalid || field?.invalid || undefined}
        className="select"
        onChange={(e) => {
          onChange?.(e);
          onValueChange?.(e.target.value);
        }}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
