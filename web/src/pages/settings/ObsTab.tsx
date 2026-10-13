import { useState } from 'react';
import type { IngestInfo } from '@shared/api';
import type { Feed } from '@shared/types';
import { api } from '../../api';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ConfirmButton } from '../../components/ConfirmButton';
import { CopyField } from '../../components/CopyField';
import { EmptyState } from '../../components/EmptyState';
import { Spinner } from '../../components/Spinner';
import { toast } from '../../components/Toast';
import { errorMessage } from '../../state/errors';
import { useApi } from '../../state/hooks';
import { FEED_LABEL } from '../destinations/destination-form';

/** Recommended OBS encoder settings per feed (the app relays without re-encoding). */
export const ENCODER_ROWS: { setting: string; landscape: string; vertical: string }[] = [
  { setting: 'Resolution', landscape: '1920×1080 or 1280×720', vertical: '1080×1920 or 720×1280' },
  { setting: 'Frame rate', landscape: '60 or 30 fps', vertical: '30 fps' },
  { setting: 'Video', landscape: 'H.264, CBR, 6000 kbps or less', vertical: 'H.264, CBR, about 4000 kbps' },
  { setting: 'Keyframe interval', landscape: '2 s', vertical: '2 s' },
  { setting: 'Audio', landscape: 'AAC 160 kbps, 48 kHz', vertical: 'AAC 160 kbps, 48 kHz' },
];

export function ObsTab() {
  const ingest = useApi(() => api.ingest(), []);
  const [rotating, setRotating] = useState<Feed | null>(null);

  const rotate = async (feed: Feed) => {
    setRotating(feed);
    try {
      ingest.setData(await api.rotateIngestKey(feed));
      toast.warn(`New ${FEED_LABEL[feed].toLowerCase()} stream key. Paste it into OBS before you stream again.`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRotating(null);
    }
  };

  if (!ingest.data) {
    return (
      <Card>
        {ingest.error ? (
          <EmptyState
            title="Couldn't load the OBS settings"
            description={ingest.error}
            action={
              <Button onClick={ingest.reload} loading={ingest.loading}>
                Try again
              </Button>
            }
          />
        ) : (
          <div className="row muted">
            <Spinner size="sm" /> Loading…
          </div>
        )}
      </Card>
    );
  }

  return (
    <>
      <IngestCard info={ingest.data} rotating={rotating} onRotate={rotate} />
      <div className="settings-grid">
        <Card title="Main output (landscape)" subtitle="OBS → Settings → Stream">
          <ol className="steps">
            <li>
              Service: <strong>Custom…</strong>
            </li>
            <li>Server: the server URL above.</li>
            <li>
              Stream Key: the <strong>landscape</strong> key above. Leave "Use authentication" off.
            </li>
            <li>
              Settings → Output (Advanced) → Streaming: H.264 encoder, <strong>CBR</strong>, keyframe interval <strong>2 s</strong>.
            </li>
          </ol>
        </Card>
        <Card title="Vertical (Aitum Vertical)" subtitle="The free Aitum Vertical plugin for OBS">
          <ol className="steps">
            <li>Install Aitum Vertical and restart OBS. It adds a vertical canvas with its own docks.</li>
            <li>Open the Vertical dock's settings (gear icon) and add a stream output.</li>
            <li>
              Server: the server URL above. Stream key: the <strong>vertical</strong> key above.
            </li>
            <li>Start it with the Vertical dock's stream button (or let it start with the main output).</li>
          </ol>
        </Card>
      </div>
      <Card title="Recommended encoder settings" subtitle="Video and audio are relayed as-is, so each output must suit every platform on that feed." flush>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Setting</th>
                <th scope="col">Landscape (main output)</th>
                <th scope="col">Vertical (Aitum)</th>
              </tr>
            </thead>
            <tbody>
              {ENCODER_ROWS.map((r) => (
                <tr key={r.setting}>
                  <th scope="row">{r.setting}</th>
                  <td>{r.landscape}</td>
                  <td>{r.vertical}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function IngestCard({ info, rotating, onRotate }: { info: IngestInfo; rotating: Feed | null; onRotate: (feed: Feed) => Promise<void> }) {
  return (
    <Card title="Stream to this server" subtitle="Copy these into OBS. Each feed has its own key; treat the keys like passwords.">
      <div className="stack">
        <CopyField label="Server" value={info.serverUrl} help="Use the server's LAN address. If it shows your public address, set Settings → General → Ingest host." />
        {info.feeds.map((f) => (
          <div key={f.feed} className="stack-sm">
            <CopyField label={`Stream key (${FEED_LABEL[f.feed].toLowerCase()})`} value={f.streamKey} secret />
            <div>
              <ConfirmButton
                size="sm"
                variant="ghost"
                confirmLabel="Rotate? OBS must be updated"
                loading={rotating === f.feed}
                onConfirm={() => onRotate(f.feed)}
              >
                Rotate {FEED_LABEL[f.feed].toLowerCase()} key
              </ConfirmButton>
            </div>
          </div>
        ))}
        <div className="alert alert-warn">
          <strong>Never port-forward 1935.</strong> RTMP from OBS is meant for your local network only (or a VPN). Only the web
          port belongs on the internet.
        </div>
      </div>
    </Card>
  );
}
