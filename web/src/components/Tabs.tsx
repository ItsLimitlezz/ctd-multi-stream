import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './utils';

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Small trailing element (count, badge). */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  tabs: readonly TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** Prefix for tab/panel ids; pair with <TabPanel idPrefix=...>. */
  idPrefix?: string;
  'aria-label'?: string;
  className?: string;
}

export const tabId = (prefix: string, id: string) => `${prefix}-tab-${id}`;
export const panelId = (prefix: string, id: string) => `${prefix}-panel-${id}`;

/** Accessible tab list (arrow keys / Home / End move between tabs). Render panels yourself. */
export function Tabs({ tabs, value, onChange, idPrefix = 'tabs', className, ...aria }: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const enabled = tabs.filter((t) => !t.disabled);
    const i = enabled.findIndex((t) => t.id === value);
    let next: TabItem | undefined;
    if (e.key === 'ArrowRight') next = enabled[(i + 1) % enabled.length];
    else if (e.key === 'ArrowLeft') next = enabled[(i - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault();
    onChange(next.id);
    listRef.current?.querySelector<HTMLButtonElement>(`#${CSS.escape(tabId(idPrefix, next.id))}`)?.focus();
  };

  return (
    <div ref={listRef} role="tablist" aria-label={aria['aria-label']} className={cx('tabs', className)} onKeyDown={onKeyDown}>
      {tabs.map((t) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={tabId(idPrefix, t.id)}
            aria-selected={selected}
            aria-controls={panelId(idPrefix, t.id)}
            tabIndex={selected ? 0 : -1}
            disabled={t.disabled}
            className="tab"
            onClick={() => onChange(t.id)}
          >
            {t.label}
            {t.badge}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  idPrefix?: string;
  id: string;
  className?: string;
  children: ReactNode;
}

export function TabPanel({ idPrefix = 'tabs', id, className, children }: TabPanelProps) {
  return (
    <div role="tabpanel" id={panelId(idPrefix, id)} aria-labelledby={tabId(idPrefix, id)} className={className}>
      {children}
    </div>
  );
}
