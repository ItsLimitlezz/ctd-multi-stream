import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './utils';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Rendered at the right of the header (buttons, links, badges). */
  actions?: ReactNode;
  /** Remove body padding (lists, chat logs). */
  flush?: boolean;
}

export function Card({ title, subtitle, actions, flush = false, className, children, ...rest }: CardProps) {
  const hasHeader = title !== undefined || subtitle !== undefined || actions !== undefined;
  return (
    <section {...rest} className={cx('card', className)}>
      {hasHeader && (
        <header className="card-header">
          <div className="card-header-text">
            {title !== undefined && <h2 className="card-title">{title}</h2>}
            {subtitle !== undefined && <p className="card-subtitle">{subtitle}</p>}
          </div>
          {actions !== undefined && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className={cx('card-body', flush && 'is-flush')}>{children}</div>
    </section>
  );
}
