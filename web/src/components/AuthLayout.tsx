import type { ReactNode } from 'react';
import { Card } from './Card';

/** Centered card with the brand, used by the sign-in and setup pages. */
export function AuthLayout({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <img src="/favicon.svg" alt="" width={40} height={40} />
          <div>
            <div className="auth-brand-name">CTD Multi-Stream</div>
            <div className="muted small">Self-hosted multistreaming</div>
          </div>
        </div>
        <Card title={title} subtitle={subtitle}>
          {children}
        </Card>
      </div>
    </main>
  );
}
