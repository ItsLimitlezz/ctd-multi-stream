import { createContext, useContext, useId, type ReactNode } from 'react';
import { cx } from './utils';

/** Wiring a <Field> gives to the control inside it (TextInput, Select, Toggle pick it up). */
export interface FieldControl {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldControl | null>(null);

export function useFieldControl(): FieldControl | null {
  return useContext(FieldContext);
}

export interface FieldProps {
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  /** Control id; generated when omitted. */
  id?: string;
  required?: boolean;
  /** Label and control on one row (toggles). */
  inline?: boolean;
  /** Visually hide the label (still read by screen readers). */
  hideLabel?: boolean;
  className?: string;
  children: ReactNode;
}

export function Field({ label, help, error, id, required = false, inline = false, hideLabel = false, className, children }: FieldProps) {
  const autoId = useId();
  const controlId = id ?? `f${autoId}`;
  const hasError = error !== undefined && error !== null && error !== false && error !== '';
  const helpId = help ? `${controlId}-help` : undefined;
  const errorId = hasError ? `${controlId}-error` : undefined;
  const describedBy = [errorId, helpId].filter(Boolean).join(' ') || undefined;

  const labelEl = (
    <label htmlFor={controlId} className={cx('field-label', hideLabel && 'sr-only')}>
      {label}
      {required && (
        <span className="field-required" aria-hidden="true">
          *
        </span>
      )}
    </label>
  );

  return (
    <FieldContext.Provider value={{ id: controlId, describedBy, invalid: hasError, required }}>
      <div className={cx('field', inline && 'field-inline', className)}>
        {inline ? (
          <div className="field-inline-row">
            {labelEl}
            {children}
          </div>
        ) : (
          <>
            {labelEl}
            {children}
          </>
        )}
        {hasError && (
          <p id={errorId} className="field-error">
            {error}
          </p>
        )}
        {help && (
          <p id={helpId} className="field-help">
            {help}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}
