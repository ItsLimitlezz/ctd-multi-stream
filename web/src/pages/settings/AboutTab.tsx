import { Card } from '../../components/Card';

/** Docs in the repository (shown as plain paths: the app has no fixed public docs URL). */
export const DOC_LINKS: { path: string; label: string }[] = [
  { path: 'README.md', label: 'Overview and quick start' },
  { path: 'docs/INSTALL-TRUENAS.md', label: 'Installing on TrueNAS' },
  { path: 'docs/OBS-SETUP.md', label: 'OBS setup (landscape + Aitum Vertical)' },
  { path: 'docs/PLATFORMS.md', label: 'Platform notes and developer apps' },
  { path: 'docs/SECURITY.md', label: 'Security, HTTPS and port forwarding' },
  { path: 'docs/ARCHITECTURE.md', label: 'How it works' },
];

export function AboutTab({ version }: { version: string | null }) {
  return (
    <Card title="CTD Multi-Stream" subtitle="Self-hosted multistreaming: one OBS, every platform.">
      <div className="stack">
        <dl className="kv kv-start">
          <dt>Version</dt>
          <dd className="mono">{version ?? '—'}</dd>
          <dt>License</dt>
          <dd>AGPL-3.0</dd>
        </dl>
        <div className="stack-sm">
          <h3>Documentation</h3>
          <p className="muted small">In the project's repository:</p>
          <ul className="steps">
            {DOC_LINKS.map((d) => (
              <li key={d.path}>
                <code>{d.path}</code> <span className="muted">— {d.label}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}
