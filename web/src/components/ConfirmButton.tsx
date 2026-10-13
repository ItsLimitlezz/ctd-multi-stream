import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, type ButtonProps } from './Button';
import { cx } from './utils';

export interface ConfirmButtonProps extends Omit<ButtonProps, 'onClick' | 'loading'> {
  /** Runs on the second click. If it returns a promise the button shows a spinner until it settles. */
  onConfirm: () => void | Promise<unknown>;
  /** Label while armed (default "Click again to confirm"). */
  confirmLabel?: ReactNode;
  /** Variant while armed (default 'danger'). */
  confirmVariant?: ButtonProps['variant'];
  /** Disarm after this long (default 4 s). */
  timeoutMs?: number;
  /** External busy state. */
  loading?: boolean;
}

/** Two-step button: the first click arms it, the second click within `timeoutMs` confirms. */
export function ConfirmButton({
  onConfirm,
  confirmLabel = 'Click again to confirm',
  confirmVariant = 'danger',
  timeoutMs = 4000,
  variant = 'secondary',
  loading = false,
  children,
  className,
  onKeyDown,
  ...rest
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const disarm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setArmed(false);
  };

  const handleClick = () => {
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(disarm, timeoutMs);
      return;
    }
    disarm();
    let result: void | Promise<unknown>;
    try {
      result = onConfirm();
    } catch (err) {
      console.error('ConfirmButton onConfirm failed', err);
      return;
    }
    if (result instanceof Promise) {
      setBusy(true);
      result
        .catch((err: unknown) => console.error('ConfirmButton onConfirm failed', err))
        .finally(() => {
          if (mounted.current) setBusy(false);
        });
    }
  };

  return (
    <Button
      {...rest}
      variant={armed ? confirmVariant : variant}
      loading={loading || busy}
      className={cx(armed && 'is-armed', className)}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && armed) disarm();
        onKeyDown?.(e);
      }}
    >
      <span aria-live="polite">{armed ? confirmLabel : children}</span>
    </Button>
  );
}
