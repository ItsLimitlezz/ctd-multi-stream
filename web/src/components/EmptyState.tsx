import type { ReactNode } from 'react';
import { cx } from './utils';

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  /** Button or link below the text. */
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, action, icon, className }: EmptyStateProps) {
  return (
    <div className={cx('empty', className)}>
      {icon && <div className="empty-icon">{icon}</div>}
      <h3 className="empty-title">{title}</h3>
      {description && <p className="empty-desc">{description}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
