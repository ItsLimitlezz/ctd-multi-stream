import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { Spinner } from './Spinner';
import { cx } from './utils';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  /** Icon rendered before the label. */
  icon?: ReactNode;
  /** Full width. */
  block?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/** Class names for button-styled elements (e.g. a <Link> that looks like a button). */
export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', block = false): string {
  return cx('btn', `btn-${variant}`, size !== 'md' && `btn-${size}`, block && 'btn-block');
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  block = false,
  type = 'button',
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(buttonClass(variant, size, block), className)}
    >
      {loading ? <Spinner size="sm" label={null} /> : icon}
      {children}
    </button>
  );
}
