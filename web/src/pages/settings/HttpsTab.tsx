import type { TlsStatus } from '@shared/types';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { formatDateTime } from '../../components/format';
import { toast } from '../../components/Toast';
import { copyText } from '../../components/utils';
import { useNow } from '../../state/hooks';
import { expiryTone, relativeTime, TLS_MODE_LABEL, TLS_SOURCE_INFO } from './settings-helpers';

export interface HttpsTabProps {
  tls: TlsStatus;
  onRefresh: () => void;
  refreshing: boolean;
}

export function HttpsTab({ tls, onRefresh, refreshing }: HttpsTabProps) {
  const now = useNow(60_000);
  const source = TLS_SOURCE_INFO[tls.source];
  return (
    <>
      <Card
        title="HTTPS certificate"
        subtitle="What this app serves to browsers right now."
        actions={
          <Button size="sm" variant="ghost" onClick={onRefresh} loading={refreshing}>
            Refresh
          </Button>
        }
      >
        <div className="stack">
          <dl className="kv kv-start">
            <dt>Serving</dt>
            <dd>
              <Badge tone={source.tone} dot>
                {source.label}
              </Badge>
            </dd>
            <dt>Mode</dt>
            <dd>
              {TLS_MODE_LABEL[tls.mode]} <span className="faint small">(TLS_MODE={tls.mode})</span>
            </dd>
            {tls.subject && (
              <>
                <dt>Issued for</dt>
                <dd className="mono">{tls.subject}</dd>
              </>
            )}
            {tls.notAfter && (
              <>
                <dt>Expires</dt>
                <dd>
                  <Badge tone={expiryTone(tls.notAfter, now)}>{relativeTime(tls.notAfter, now)}</Badge>{' '}
                  <span className="muted small">{formatDateTime(tls.notAfter)}</span>
                </dd>
              </>
            )}
            {tls.nextRenewalAt && (
              <>
                <dt>Next renewal</dt>
                <dd>
                  {relativeTime(tls.nextRenewalAt, now)} <span className="muted small">{formatDateTime(tls.nextRenewalAt)}</span>
                </dd>
              </>
            )}
            {tls.publicIp && (
              <>
                <dt>Public IP</dt>
                <dd className="mono">{tls.publicIp}</dd>
              </>
            )}
          </dl>
          {tls.fingerprint256 && <Fingerprint value={tls.fingerprint256} />}
          {tls.lastError && (
            <div className="alert alert-danger" role="alert">
              <strong>Last certificate error:</strong> {tls.lastError}
            </div>
          )}
          <SourceGuidance tls={tls} />
        </div>
      </Card>

      <div className="settings-grid">
        <Card title="Port forwarding" subtitle="So the app is reachable from the internet with a valid certificate.">
          <ol className="steps">
            <li>
              On your router, forward <strong>TCP 443</strong> to this server's port 443 (the web UI, HTTPS).
            </li>
            <li>
              Forward <strong>TCP 80</strong> to this server's port 80. Let's Encrypt checks it to issue and renew the certificate;
              everything else on it redirects to HTTPS.
            </li>
            <li>
              <strong>Never forward 1935.</strong> RTMP from OBS stays on your local network.
            </li>
          </ol>
        </Card>
        <Card title="Your own domain or reverse proxy" subtitle="Optional. Set these in the container environment, then restart it.">
          <ul className="steps">
            <li>
              <strong>Domain:</strong> point a DNS record at your public IP and set <code>PUBLIC_HOST=stream.example.com</code>. Let's
              Encrypt then issues the certificate for the domain.
            </li>
            <li>
              <strong>Reverse proxy</strong> (Caddy, Traefik, Nginx Proxy Manager…): set <code>TLS_MODE=off</code> and{' '}
              <code>TRUST_PROXY=true</code>, and proxy your HTTPS site to this container's web port with WebSocket support enabled.
            </li>
            <li>
              <strong>Your own certificate files:</strong> <code>TLS_MODE=manual</code> with <code>TLS_CERT_FILE</code> and{' '}
              <code>TLS_KEY_FILE</code>.
            </li>
          </ul>
        </Card>
      </div>
    </>
  );
}

/** Shown in full (wrapped), since people compare it by eye with the browser's certificate viewer. */
function Fingerprint({ value }: { value: string }) {
  const copy = async () => {
    if (await copyText(value)) toast.success('Fingerprint copied.');
    else toast.error('Copy failed. Select the text and copy it manually.');
  };
  return (
    <div className="stack-sm">
      <div className="row-between">
        <span className="field-label">SHA-256 fingerprint</span>
        <Button size="sm" onClick={() => void copy()}>
          Copy
        </Button>
      </div>
      <code className="fingerprint">{value}</code>
      <p className="field-help">
        Compare it with the fingerprint your browser shows for this site (click the icon next to the address, then the
        certificate details).
      </p>
    </div>
  );
}

function SourceGuidance({ tls }: { tls: TlsStatus }) {
  switch (tls.source) {
    case 'self-signed':
      return (
        <div className="alert alert-warn">
          This is a self-signed certificate, so your browser will warn that the connection isn't private. That's expected:
          compare the fingerprint above with the one your browser shows before you continue. For a trusted certificate without a
          domain, forward ports 443 and 80 (below) and keep <code>TLS_MODE=auto</code>.
        </div>
      );
    case 'letsencrypt-ip':
      return (
        <div className="alert alert-success">
          A free Let's Encrypt certificate for your public IP address. These certificates are short-lived (about 6 days) and
          renew automatically every few days. Keep ports 443 and 80 forwarded so renewals keep working. If your public IP
          changes, a new certificate is issued for it.
        </div>
      );
    case 'letsencrypt-domain':
      return (
        <div className="alert alert-success">
          A Let's Encrypt certificate for your domain. It renews automatically; keep port 80 forwarded so renewals keep working.
        </div>
      );
    case 'manual':
      return (
        <div className="alert">
          Your own certificate files (<code>TLS_CERT_FILE</code> / <code>TLS_KEY_FILE</code>). Replace them before they expire
          and restart the container.
        </div>
      );
    case 'none':
      return (
        <div className="alert alert-warn">
          HTTPS is off. Only run like this behind your own HTTPS reverse proxy (with <code>TRUST_PROXY=true</code>), never with
          the web port forwarded directly to the internet.
        </div>
      );
    default:
      return null;
  }
}
