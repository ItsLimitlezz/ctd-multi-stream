import { useEffect, useRef, type ReactNode } from 'react';
import type { LinkItem } from '@shared/types';
import { LINK_TITLE_MAX, LINKS_MAX } from '@shared/types';
import { Button } from './Button';
import { addLinkRow, isBlankLink, LINK_URL_MAX, linkRowErrors, moveLinkRow, removeLinkRow, updateLinkRow } from './dynamic-form';
import { ChevronDownIcon, ChevronUpIcon, PlusIcon, TrashIcon } from './icons';
import { TextInput } from './TextInput';
import { cx } from './utils';

export interface LinksEditorProps {
  /** Base id: rows use `${id}-<n>-title` / `${id}-<n>-url`. */
  id: string;
  label: ReactNode;
  help?: ReactNode;
  /** Field-level error. While set, rows with a problem are highlighted with their own message. */
  error?: string;
  required?: boolean;
  value: readonly LinkItem[];
  onChange: (next: LinkItem[]) => void;
  disabled?: boolean;
}

type Part = 'title' | 'url' | 'up' | 'down' | 'remove' | 'add';

/**
 * Ordered list of { title, url } rows: add, remove, move up / down. Blank rows are allowed while
 * editing (they're dropped on save by cleanValues). At most LINKS_MAX rows.
 */
export function LinksEditor({ id, label, help, error, required = false, value, onChange, disabled = false }: LinksEditorProps) {
  // Stable row keys so focus and DOM nodes follow a row when it moves.
  const keys = useRef<number[]>([]);
  const seq = useRef(0);
  if (keys.current.length !== value.length) {
    const next = keys.current.slice(0, value.length);
    while (next.length < value.length) next.push(seq.current++);
    keys.current = next;
  }

  const nodes = useRef(new Map<string, HTMLElement>());
  const pendingFocus = useRef<string | null>(null);
  const nodeRef = (name: string) => (el: HTMLElement | null) => {
    if (el) nodes.current.set(name, el);
    else nodes.current.delete(name);
  };
  useEffect(() => {
    const name = pendingFocus.current;
    if (!name) return;
    pendingFocus.current = null;
    nodes.current.get(name)?.focus();
  });
  const focusLater = (key: number | 'add', part: Part) => {
    pendingFocus.current = key === 'add' ? 'add' : `${key}:${part}`;
  };

  const showRowErrors = !!error;
  const count = value.filter((l) => !isBlankLink(l)).length;
  const full = value.length >= LINKS_MAX;
  const labelId = `${id}-label`;
  const errorId = error ? `${id}-error` : undefined;
  const helpId = help ? `${id}-help` : undefined;
  const describedBy = [errorId, helpId].filter(Boolean).join(' ') || undefined;

  const add = () => {
    if (full) return;
    const key = seq.current++;
    keys.current = [...keys.current, key];
    focusLater(key, 'title');
    onChange(addLinkRow(value));
  };

  const remove = (i: number) => {
    const nextKeys = keys.current.filter((_, k) => k !== i);
    keys.current = nextKeys;
    const neighbour = nextKeys[i] ?? nextKeys[i - 1];
    focusLater(neighbour ?? 'add', 'title');
    onChange(removeLinkRow(value, i));
  };

  const move = (i: number, delta: number) => {
    const to = i + delta;
    const nextKeys = [...keys.current];
    const key = nextKeys[i];
    if (key === undefined || to < 0 || to >= value.length) return;
    nextKeys.splice(i, 1);
    nextKeys.splice(to, 0, key);
    keys.current = nextKeys;
    // Keep focus on the same arrow unless the row reached that end of the list.
    const atEnd = delta < 0 ? to === 0 : to === value.length - 1;
    focusLater(key, (delta < 0) !== atEnd ? 'up' : 'down');
    onChange(moveLinkRow(value, i, delta));
  };

  return (
    <div className="field links-field" role="group" aria-labelledby={labelId} aria-describedby={describedBy}>
      <span id={labelId} className="field-label">
        {label}
        {required && (
          <span className="field-required" aria-hidden="true">
            *
          </span>
        )}
      </span>
      {value.length === 0 ? (
        <p className="links-empty">No links yet.</p>
      ) : (
        <ol className="links-list">
          {value.map((row, i) => {
            const key = keys.current[i] ?? i;
            const n = i + 1;
            const rowErr = showRowErrors ? linkRowErrors(row) : {};
            const titleErrId = rowErr.title ? `${id}-${n}-title-error` : undefined;
            const urlErrId = rowErr.url ? `${id}-${n}-url-error` : undefined;
            return (
              <li key={key} className={cx('link-row', (rowErr.title || rowErr.url) && 'is-invalid')}>
                <span className="link-index" aria-hidden="true">
                  {n}
                </span>
                <div className="link-inputs">
                  <TextInput
                    ref={nodeRef(`${key}:title`)}
                    id={`${id}-${n}-title`}
                    aria-label={`Link ${n} title`}
                    aria-describedby={titleErrId}
                    invalid={!!rowErr.title}
                    autoComplete="off"
                    maxLength={LINK_TITLE_MAX}
                    placeholder="Title, e.g. Kick - Live Stream"
                    value={row.title}
                    onValueChange={(title) => onChange(updateLinkRow(value, i, { title }))}
                    disabled={disabled}
                  />
                  {rowErr.title && (
                    <p id={titleErrId} className="field-error">
                      {rowErr.title}
                    </p>
                  )}
                  <TextInput
                    ref={nodeRef(`${key}:url`)}
                    id={`${id}-${n}-url`}
                    type="url"
                    inputMode="url"
                    mono
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    autoComplete="off"
                    aria-label={`Link ${n} URL`}
                    aria-describedby={urlErrId}
                    invalid={!!rowErr.url}
                    maxLength={LINK_URL_MAX}
                    placeholder="https://…"
                    value={row.url}
                    onValueChange={(url) => onChange(updateLinkRow(value, i, { url }))}
                    disabled={disabled}
                  />
                  {rowErr.url && (
                    <p id={urlErrId} className="field-error">
                      {rowErr.url}
                    </p>
                  )}
                </div>
                <div className="link-actions">
                  <button
                    type="button"
                    ref={nodeRef(`${key}:up`)}
                    className="icon-btn"
                    aria-label={`Move link ${n} up`}
                    title="Move up"
                    disabled={disabled || i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ChevronUpIcon />
                  </button>
                  <button
                    type="button"
                    ref={nodeRef(`${key}:down`)}
                    className="icon-btn"
                    aria-label={`Move link ${n} down`}
                    title="Move down"
                    disabled={disabled || i === value.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ChevronDownIcon />
                  </button>
                  <button
                    type="button"
                    ref={nodeRef(`${key}:remove`)}
                    className="icon-btn is-danger"
                    aria-label={`Remove link ${n}`}
                    title="Remove"
                    disabled={disabled}
                    onClick={() => remove(i)}
                  >
                    <TrashIcon />
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <div className="links-foot">
        <Button ref={nodeRef('add')} size="sm" icon={<PlusIcon width={16} height={16} />} onClick={add} disabled={disabled || full}>
          Add link
        </Button>
        <span className="faint small">
          {full ? `Maximum of ${LINKS_MAX} links` : `${count} of ${LINKS_MAX}`}
        </span>
      </div>
      {error && (
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
  );
}
