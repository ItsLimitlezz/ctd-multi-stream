// Pure helpers for DynamicForm: initial values, validation, coercion, destination mapping.

import type { Destination, FieldSpec, FieldTarget, LinkItem } from '@shared/types';
import { LINK_TITLE_MAX, LINKS_MAX } from '@shared/types';

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

/** Absolute http(s) URL with a host (the only kind a 'links' item may hold). */
export function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.host !== '';
  } catch {
    return false;
  }
}

export function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
}

// ---------------------------------------------------------------------------
// 'links' fields: an ordered LinkItem[] ({ title, url }).
// ---------------------------------------------------------------------------

/** Same limit as the server. */
export const LINK_URL_MAX = 2048;

/**
 * Editable rows from an option value: anything that isn't an array becomes [], entries that
 * aren't objects are dropped, and a missing or non-string title / url becomes ''.
 */
export function toLinkItems(v: unknown): LinkItem[] {
  if (!Array.isArray(v)) return [];
  const out: LinkItem[] = [];
  for (const item of v) {
    if (typeof item !== 'object' || item === null) continue;
    const { title, url } = item as Record<string, unknown>;
    out.push({ title: typeof title === 'string' ? title : '', url: typeof url === 'string' ? url : '' });
  }
  return out;
}

/** A row with neither a title nor a URL (dropped on save). */
export function isBlankLink(item: LinkItem): boolean {
  return item.title.trim() === '' && item.url.trim() === '';
}

/** Trimmed rows with blank ones dropped: the value sent to the server. */
export function cleanLinks(v: unknown): LinkItem[] {
  return toLinkItems(v)
    .filter((l) => !isBlankLink(l))
    .map((l) => ({ title: l.title.trim(), url: l.url.trim() }));
}

export interface LinkRowErrors {
  title?: string;
  url?: string;
}

/** Problems with one row ({} when it's fine or blank: blank rows are dropped on save). */
export function linkRowErrors(item: LinkItem): LinkRowErrors {
  if (isBlankLink(item)) return {};
  const errors: LinkRowErrors = {};
  const title = item.title.trim();
  const url = item.url.trim();
  if (!title) errors.title = 'Title is required';
  else if (title.length > LINK_TITLE_MAX) errors.title = `Title must be at most ${LINK_TITLE_MAX} characters`;
  if (!url) errors.url = 'URL is required';
  else if (url.length > LINK_URL_MAX) errors.url = `URL must be at most ${LINK_URL_MAX} characters`;
  else if (!isHttpUrl(url)) errors.url = 'URL must start with http:// or https://';
  return errors;
}

/**
 * One message for a links field (the first problem, rows numbered as shown), or null when valid.
 * Undefined / null count as an empty list.
 */
export function validateLinks(field: Pick<FieldSpec, 'label' | 'required'>, v: unknown): string | null {
  if (v !== undefined && v !== null && !Array.isArray(v)) return `${field.label} must be a list of links`;
  const rows = toLinkItems(v);
  for (const [i, row] of rows.entries()) {
    const e = linkRowErrors(row);
    const msg = e.title ?? e.url;
    if (msg) return `Link ${i + 1}: ${msg}`;
  }
  const count = rows.filter((l) => !isBlankLink(l)).length;
  if (count > LINKS_MAX) return `Use at most ${LINKS_MAX} links`;
  if (count === 0 && field.required) return `${field.label} is required`;
  return null;
}

/** List with an empty row appended (unchanged at LINKS_MAX rows). */
export function addLinkRow(list: readonly LinkItem[]): LinkItem[] {
  return list.length >= LINKS_MAX ? [...list] : [...list, { title: '', url: '' }];
}

export function removeLinkRow(list: readonly LinkItem[], index: number): LinkItem[] {
  return list.filter((_, i) => i !== index);
}

/** Row `index` moved by `delta` (-1 = up, +1 = down); unchanged when it would leave the list. */
export function moveLinkRow(list: readonly LinkItem[], index: number, delta: number): LinkItem[] {
  const to = index + delta;
  const out = [...list];
  const item = out[index];
  if (item === undefined || to < 0 || to >= out.length) return out;
  out.splice(index, 1);
  out.splice(to, 0, item);
  return out;
}

export function updateLinkRow(list: readonly LinkItem[], index: number, patch: Partial<LinkItem>): LinkItem[] {
  return list.map((l, i) => (i === index ? { ...l, ...patch } : l));
}

/**
 * Starting values: existing values first, then each field's default. Booleans default to
 * false and links to []. Secrets are never prefilled (an absent secret key means "keep the
 * stored one").
 */
export function initialValues(fields: readonly FieldSpec[], existing: FormValues = {}): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
    if (f.type === 'secret') continue;
    const v = existing[f.key];
    if (f.type === 'links') out[f.key] = toLinkItems(v);
    else if (v !== undefined && v !== null) out[f.key] = v;
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
    if (f.type === 'links') {
      const msg = validateLinks(f, v);
      if (msg) errors[f.key] = msg;
      continue;
    }
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

/**
 * Trim strings and drop empty optional values before sending. Secrets left empty are dropped
 * (= keep). Links fields always send their whole list (blank rows dropped, possibly []), so
 * removing every link clears the stored list.
 */
export function cleanValues(fields: readonly FieldSpec[], values: FormValues): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
    const v = values[f.key];
    if (f.type === 'links') {
      out[f.key] = cleanLinks(v);
      continue;
    }
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
