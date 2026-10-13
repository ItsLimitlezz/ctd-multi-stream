import { useState } from 'react';
import { api } from '../../api';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ConfirmButton } from '../../components/ConfirmButton';
import { CopyField } from '../../components/CopyField';
import { EmptyState } from '../../components/EmptyState';
import { Field } from '../../components/Field';
import { Spinner } from '../../components/Spinner';
import { TextInput } from '../../components/TextInput';
import { toast } from '../../components/Toast';
import { errorMessage } from '../../state/errors';
import { useApi } from '../../state/hooks';
import { OVERLAY_DEFAULT_MAX, OVERLAY_FADE_MAX, OVERLAY_MAX_LIMIT, overlayUrlWithParams, parseWholeNumber } from './settings-helpers';

export function OverlayTab() {
  const overlay = useApi(() => api.overlay(), []);
  const [fade, setFade] = useState('');
  const [max, setMax] = useState('');

  const fadeNum = parseWholeNumber(fade);
  const maxNum = parseWholeNumber(max);
  const fadeError =
    fadeNum !== null && (Number.isNaN(fadeNum) || fadeNum > OVERLAY_FADE_MAX) ? `Use 0–${OVERLAY_FADE_MAX} seconds.` : undefined;
  const maxError =
    maxNum !== null && (Number.isNaN(maxNum) || maxNum < 1 || maxNum > OVERLAY_MAX_LIMIT) ? `Use 1–${OVERLAY_MAX_LIMIT} messages.` : undefined;

  const rotate = async () => {
    try {
      overlay.setData(await api.rotateOverlay());
      toast.warn('New overlay URL. Update the browser source in OBS; the old URL stopped working.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  if (!overlay.data) {
    return (
      <Card>
        {overlay.error ? (
          <EmptyState
            title="Couldn't load the overlay URL"
            description={overlay.error}
            action={
              <Button onClick={overlay.reload} loading={overlay.loading}>
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

  const url = overlayUrlWithParams(overlay.data.url, {
    fade: fadeError ? null : fadeNum,
    max: maxError ? null : maxNum,
  });

  return (
    <>
      <Card title="Chat overlay" subtitle="Combined chat from every platform as a transparent OBS browser source.">
        <div className="stack">
          <CopyField
            label="Overlay URL"
            value={url}
            secret
            help="Anyone with this link can read your chat, so keep it private. Rotate it if it leaks."
          />
          <div className="settings-grid" style={{ gap: 12 }}>
            <Field label="Fade messages after (seconds)" error={fadeError} help="Empty or 0 keeps messages on screen.">
              <TextInput className="number-input" inputMode="numeric" placeholder="0" value={fade} onValueChange={(v) => setFade(v.replace(/[^\d]/g, '').slice(0, 4))} />
            </Field>
            <Field label="Messages shown at once" error={maxError} help={`Default ${OVERLAY_DEFAULT_MAX}.`}>
              <TextInput
                className="number-input"
                inputMode="numeric"
                placeholder={String(OVERLAY_DEFAULT_MAX)}
                value={max}
                onValueChange={(v) => setMax(v.replace(/[^\d]/g, '').slice(0, 3))}
              />
            </Field>
          </div>
          <div>
            <ConfirmButton size="sm" variant="ghost" confirmLabel="Rotate? OBS must be updated" onConfirm={rotate}>
              Rotate overlay URL
            </ConfirmButton>
          </div>
        </div>
      </Card>
      <Card title="Add it to OBS">
        <ol className="steps">
          <li>
            In OBS, add a source: <strong>+</strong> → <strong>Browser</strong>.
          </li>
          <li>Paste the overlay URL above into the URL field.</li>
          <li>
            Set the width to <strong>400–600</strong> and the height to <strong>600–1000</strong>, then position it on your scene.
          </li>
          <li>
            Options can also be added to the URL by hand: <code>&amp;fade=30</code> fades each message after 30 seconds,{' '}
            <code>&amp;max=15</code> limits how many are visible.
          </li>
        </ol>
      </Card>
    </>
  );
}
