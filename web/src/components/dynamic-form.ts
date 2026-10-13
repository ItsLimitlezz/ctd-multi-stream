// Pure helpers for DynamicForm: initial values, validation, coercion, destination mapping.

import type { Destination, FieldSpec, FieldTarget } from '@shared/types';

export type FormValues = Record<string, unknown>;
export type FormErrors = Record<string, string>;

const URL_PROTOCOLS = new Set(['http:', 'https:', 'rtmp:', 'rtmps:', 'srt:']);

/** http(s), rtmp(s) or srt URL with a host. */
export function isValidUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return URL_PROTOCOLS.has(u.protocol) && u.host !== '';
  } catch {
    return false;
  }
}

export function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/**
 * Starting values: existing values first, then each field's default. Booleans default to
 * false. Secrets are never prefilled (an absent secret key means "keep the stored one").
 */
export function initialValues(fields: readonly FieldSpec[], existing: FormValues = {}): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
    if (f.type === 'secret') continue;
    const v = existing[f.key];
    if (v !== undefined && v !== null) out[f.key] = v;
    else if (f.default !== undefined) out[f.key] = f.default;
    else if (f.type === 'boolean') out[f.key] = false;
  }
  return out;
}

/** Convert a raw <input> string for a number field ('' -> undefined, invalid stays a string). */
export function coerceNumber(raw: string): number | string | undefined {
  const s = raw.trim();
  if (s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : raw;
}

/**
 * Validate values against field specs. A required secret is satisfied when `secretsSet[key]`
 * is true (a value is already stored server-side).
 */
export function validateValues(
  fields: readonly FieldSpec[],
  values: FormValues,
  secretsSet: Readonly<Record<string, boolean>> = {},
): FormErrors {
  const errors: FormErrors = {};
  for (const f of fields) {
    const v = values[f.key];
    if (isEmptyValue(v)) {
      if (f.required && f.type !== 'boolean' && !(f.type === 'secret' && secretsSet[f.key])) {
        errors[f.key] = `${f.label} is required`;
      }
      continue;
    }
    switch (f.type) {
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) errors[f.key] = `${f.label} must be a number`;
        break;
      case 'url':
        if (typeof v !== 'string' || !isValidUrl(v)) errors[f.key] = `${f.label} must be a valid URL (e.g. rtmps://…)`;
        break;
      case 'select':
        if (f.options && !f.options.some((o) => o.value === v)) errors[f.key] = `Choose a valid ${f.label.toLowerCase()}`;
        break;
      case 'boolean':
        if (typeof v !== 'boolean') errors[f.key] = `${f.label} must be on or off`;
        break;
      default:
        if (typeof v !== 'string') errors[f.key] = `${f.label} must be text`;
    }
  }
  return errors;
}

/** Trim strings and drop empty optional values before sending. Secrets left empty are dropped (= keep). */
export function cleanValues(fields: readonly FieldSpec[], values: FormValues): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
    const v = values[f.key];
    if (isEmptyValue(v)) continue;
    out[f.key] = typeof v === 'string' && f.type !== 'secret' ? v.trim() : v;
  }
  return out;
}

const targetOf = (f: FieldSpec): FieldTarget => f.target ?? 'option';

/** Form values for editing an existing destination (stream keys are never available). */
export function destinationFormValues(fields: readonly FieldSpec[], dest: Destination): FormValues {
  const existing: FormValues = {};
  for (const f of fields) {
    const target = targetOf(f);
    if (target === 'option') existing[f.key] = dest.options[f.key];
    else if (target === 'ingestUrl') existing[f.key] = dest.ingestUrl ?? undefined;
  }
  return initialValues(fields, existing);
}

/** Which secret destination fields already have a stored value. */
export function destinationSecretsSet(fields: readonly FieldSpec[], dest: Destination | null): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of fields) if (targetOf(f) === 'streamKey') out[f.key] = !!dest?.hasStreamKey;
  return out;
}

/**
 * Split form values into the destination request shape. `streamKey` is only present when the
 * user typed a new key (undefined = keep the stored one).
 */
export function splitDestinationValues(
  fields: readonly FieldSpec[],
  values: FormValues,
): { options: Record<string, unknown>; ingestUrl?: string | null; streamKey?: string } {
  const clean = cleanValues(fields, values);
  const out: { options: Record<string, unknown>; ingestUrl?: string | null; streamKey?: string } = { options: {} };
  for (const f of fields) {
    const v = clean[f.key];
    switch (targetOf(f)) {
      case 'option':
        if (v !== undefined) out.options[f.key] = v;
        break;
      case 'ingestUrl':
        out.ingestUrl = typeof v === 'string' ? v : null;
        break;
      case 'streamKey':
        if (typeof v === 'string') out.streamKey = v;
        break;
    }
  }
  return out;
}
