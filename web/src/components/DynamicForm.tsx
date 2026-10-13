import { useId, useState } from 'react';
import type { FieldSpec } from '@shared/types';
import { Button } from './Button';
import { coerceNumber, type FormValues } from './dynamic-form';
import { Field } from './Field';
import { Select } from './Select';
import { TextInput } from './TextInput';
import { Toggle } from './Toggle';

export interface DynamicFormProps {
  fields: readonly FieldSpec[];
  /** Controlled values by field key. A secret key that is absent means "keep the stored value". */
  values: FormValues;
  onChange: (values: FormValues) => void;
  /** Secret fields that already have a value stored server-side (shows "•••• set" + Change). */
  secretsSet?: Readonly<Record<string, boolean>>;
  /** Error message per field key. */
  errors?: Readonly<Record<string, string | undefined>>;
  disabled?: boolean;
  /** Prefix for input ids (defaults to a generated one). */
  idPrefix?: string;
}

/** Renders FieldSpec[] (text / secret / url / select / boolean / number) as a controlled form. */
export function DynamicForm({ fields, values, onChange, secretsSet = {}, errors = {}, disabled = false, idPrefix }: DynamicFormProps) {
  const autoId = useId();
  const prefix = idPrefix ?? `df${autoId}`;
  const setValue = (key: string, v: unknown) => {
    const next = { ...values };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };
  return (
    <div className="stack">
      {fields.map((f) => (
        <DynamicField
          key={f.key}
          field={f}
          id={`${prefix}-${f.key}`}
          value={values[f.key]}
          onValue={(v) => setValue(f.key, v)}
          secretSet={!!secretsSet[f.key]}
          error={errors[f.key]}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

interface DynamicFieldProps {
  field: FieldSpec;
  id: string;
  value: unknown;
  onValue: (v: unknown) => void;
  secretSet: boolean;
  error: string | undefined;
  disabled: boolean;
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

function DynamicField({ field: f, id, value, onValue, secretSet, error, disabled }: DynamicFieldProps) {
  const common = { label: f.label, help: f.help, error, id, required: !!f.required };
  switch (f.type) {
    case 'boolean':
      return (
        <Field {...common} inline>
          <Toggle checked={value === true} onChange={(v) => onValue(v)} disabled={disabled} />
        </Field>
      );
    case 'select':
      return (
        <Field {...common}>
          <Select
            options={f.options ?? []}
            placeholder={f.required && f.default !== undefined ? undefined : f.placeholder ?? 'Select…'}
            value={asString(value)}
            onValueChange={(v) => onValue(v === '' ? undefined : v)}
            disabled={disabled}
          />
        </Field>
      );
    case 'number':
      return (
        <Field {...common}>
          <TextInput
            type="text"
            inputMode="decimal"
            value={asString(value)}
            placeholder={f.placeholder}
            onValueChange={(raw) => onValue(coerceNumber(raw))}
            disabled={disabled}
          />
        </Field>
      );
    case 'secret':
      return (
        <Field {...common}>
          <SecretInput
            value={typeof value === 'string' ? value : undefined}
            onValue={onValue}
            secretSet={secretSet}
            placeholder={f.placeholder}
            disabled={disabled}
            label={f.label}
          />
        </Field>
      );
    case 'url':
      return (
        <Field {...common}>
          <TextInput
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            mono
            value={asString(value)}
            placeholder={f.placeholder}
            onValueChange={(v) => onValue(v)}
            disabled={disabled}
          />
        </Field>
      );
    default:
      return (
        <Field {...common}>
          <TextInput
            type="text"
            autoComplete="off"
            value={asString(value)}
            placeholder={f.placeholder}
            onValueChange={(v) => onValue(v)}
            disabled={disabled}
          />
        </Field>
      );
  }
}

interface SecretInputProps {
  value: string | undefined;
  onValue: (v: unknown) => void;
  secretSet: boolean;
  placeholder?: string;
  disabled: boolean;
  label: string;
}

// Keep password managers away from stream keys / client secrets.
const NO_AUTOFILL = {
  autoComplete: 'new-password',
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const;

function SecretInput({ value, onValue, secretSet, placeholder, disabled, label }: SecretInputProps) {
  const [editing, setEditing] = useState(false);
  const [reveal, setReveal] = useState(false);

  if (secretSet && !editing && value === undefined) {
    return (
      <div className="secret-set">
        <span className="secret-set-value" aria-label={`${label} is set`}>
          •••• set
        </span>
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={disabled}>
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="input-with-actions">
      <TextInput
        {...NO_AUTOFILL}
        type={reveal ? 'text' : 'password'}
        mono
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        value={value ?? ''}
        placeholder={secretSet ? 'Enter a new value' : placeholder}
        onValueChange={(v) => onValue(v === '' ? undefined : v)}
        disabled={disabled}
        autoFocus={editing}
      />
      <Button size="sm" variant="ghost" onClick={() => setReveal((r) => !r)} aria-pressed={reveal} disabled={disabled}>
        {reveal ? 'Hide' : 'Show'}
      </Button>
      {secretSet && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setEditing(false);
            setReveal(false);
            onValue(undefined);
          }}
          disabled={disabled}
        >
          Cancel
        </Button>
      )}
    </div>
  );
}
