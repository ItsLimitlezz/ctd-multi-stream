import { useEffect, useState, type FormEvent } from 'react';
import type { SettingsResponse } from '@shared/api';
import { api } from '../../api';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Field } from '../../components/Field';
import { TextInput } from '../../components/TextInput';
import { toast } from '../../components/Toast';
import { errorMessage, isApiError } from '../../state/errors';
import {
  fieldForMessage,
  generalChanges,
  generalDraft,
  GRACE_MAX,
  hasErrors,
  validateGeneral,
  type GeneralDraft,
} from './settings-helpers';

type Errors = Partial<Record<keyof GeneralDraft, string>>;

const SERVER_LABELS: Record<keyof GeneralDraft, string> = {
  publicBaseUrl: 'Public base URL',
  ingestHost: 'Ingest host',
  disconnectGraceSec: 'disconnectGraceSec',
};

export function GeneralTab({ data, onSaved }: { data: SettingsResponse; onSaved: (res: SettingsResponse) => void }) {
  const [draft, setDraft] = useState<GeneralDraft>(() => generalDraft(data.settings));
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Follow server values (e.g. after a reload) until the user starts editing.
  useEffect(() => {
    if (!dirty) setDraft(generalDraft(data.settings));
  }, [data.settings, dirty]);

  const set = (patch: Partial<GeneralDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };

  const changes = hasErrors(validateGeneral(draft)) ? null : generalChanges(draft, data.settings);
  const unchanged = changes !== null && Object.keys(changes).length === 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const v = validateGeneral(draft);
    setErrors(v);
    setFormError(null);
    if (hasErrors(v)) return;
    const body = generalChanges(draft, data.settings);
    if (Object.keys(body).length === 0) {
      setDirty(false);
      return;
    }
    setBusy(true);
    try {
      const res = await api.putSettings(body);
      onSaved(res);
      setDraft(generalDraft(res.settings));
      setDirty(false);
      toast.success('Settings saved.');
    } catch (err) {
      const msg = errorMessage(err);
      const field = isApiError(err, 400) ? fieldForMessage(msg, SERVER_LABELS) : null;
      if (field) setErrors({ [field]: msg });
      else setFormError(msg);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setDraft(generalDraft(data.settings));
    setErrors({});
    setFormError(null);
    setDirty(false);
  };

  return (
    <Card title="General" subtitle="Addresses and timing. Changes apply right away.">
      <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
        <Field
          label="Public base URL"
          error={errors.publicBaseUrl}
          help="The address you use to open this app from the internet, e.g. https://203.0.113.7. Used for OAuth redirect URIs and the chat overlay link. Leave empty to use the detected public address."
        >
          <TextInput
            type="url"
            inputMode="url"
            mono
            autoComplete="off"
            spellCheck={false}
            placeholder="https://203.0.113.7"
            value={draft.publicBaseUrl}
            onValueChange={(publicBaseUrl) => set({ publicBaseUrl })}
            disabled={busy}
          />
        </Field>
        <Field
          label="Ingest host"
          error={errors.ingestHost}
          help="Host OBS uses in the RTMP server URL. Set it to this server's LAN IP (e.g. 192.168.1.20) if you open this page through your public address. Leave empty to use the address in your browser's address bar."
        >
          <TextInput
            mono
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            placeholder="192.168.1.20"
            value={draft.ingestHost}
            onValueChange={(ingestHost) => set({ ingestHost })}
            disabled={busy}
          />
        </Field>
        <Field
          label="Disconnect grace (seconds)"
          error={errors.disconnectGraceSec}
          help={`How long to wait after OBS disconnects before ending the stream everywhere. Covers short OBS reconnects. 0–${GRACE_MAX}; 15 is a good default.`}
        >
          <TextInput
            className="number-input"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            value={draft.disconnectGraceSec}
            onValueChange={(v) => set({ disconnectGraceSec: v.replace(/[^\d]/g, '').slice(0, 4) })}
            disabled={busy}
          />
        </Field>
        {formError && (
          <div className="alert alert-danger" role="alert">
            {formError}
          </div>
        )}
        <div className="form-actions">
          <Button type="submit" variant="primary" loading={busy} disabled={!dirty || unchanged}>
            Save
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={reset} disabled={busy}>
              Discard changes
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}
