import type { InputHTMLAttributes, Ref } from 'react';
import { useFieldControl } from './Field';
import { cx } from './utils';

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  invalid?: boolean;
  /** Convenience: called with the new string value (alongside the native onChange). */
  onValueChange?: (value: string) => void;
  /** Monospace font (keys, codes, URLs). */
  mono?: boolean;
  ref?: Ref<HTMLInputElement>;
}

export function TextInput({ invalid, onValueChange, onChange, mono = false, className, id, ...rest }: TextInputProps) {
  const field = useFieldControl();
  return (
    <input
      {...rest}
      id={id ?? field?.id}
      aria-describedby={rest['aria-describedby'] ?? field?.describedBy}
      aria-invalid={invalid || field?.invalid || undefined}
      aria-required={rest.required || field?.required || undefined}
      className={cx('input', mono && 'mono', className)}
      onChange={(e) => {
        onChange?.(e);
        onValueChange?.(e.target.value);
      }}
    />
  );
}
