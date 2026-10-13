import { useMemo, useState, type FormEvent } from 'react';
import type { PlatformAppStatus } from '@shared/api';
import type { PlatformInfo } from '@shared/types';
import { api } from '../../api';
import { Badge } from '../../components/Badge';
import { Button, buttonClass } from '../../components/Button';
import { Card } from '../../components/Card';
import { CopyField } from '../../components/CopyField';
import { DynamicForm } from '../../components/DynamicForm';
import { validateValues, type FormErrors, type FormValues } from '../../components/dynamic-form';
import { EmptyState } from '../../components/EmptyState';
import { ExternalIcon } from '../../components/icons';
import { PlatformBadge, platformName } from '../../components/PlatformBadge';
import { Spinner } from '../../components/Spinner';
import { toast } from '../../components/Toast';
import { safeHttpUrl } from '../../components/utils';
import { Link } from '../../router';
import { errorMessage, isApiError } from '../../state/errors';
import { useApi } from '../../state/hooks';
import { sortPlatforms } from '../destinations/destination-form';
import { appFormValues, appSubmitValues, fieldForMessage, hasErrors, instructionLines } from './settings-helpers';

export function DeveloperAppsTab() {
  const apps = useApi(() => api.platformApps(), []);
  const platforms = useApi(() => api.platforms(), []);
  const infoById = useMemo(() => new Map((platforms.data ?? []).map((p) => [p.id as string, p])), [platforms.data]);
  const ordered = useMemo(() => sortPlatforms((apps.data ?? []).map((a) => ({ ...a, id: a.platform }))), [apps.data]);

  const error = apps.error ?? platforms.error;
  if (!apps.data || !platforms.data) {
    return (
      <Card>
        {error ? (
          <EmptyState
            title="Couldn't load the developer apps"
            description={error}
            action={
              <Button
                onClick={() => {
                  apps.reload();
                  platforms.reload();
                }}
                loading={apps.loading || platforms.loading}
              >
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

  if (ordered.length === 0) {
    return (
      <Card>
        <EmptyState title="Nothing to set up" description="None of the platforms on this server need a developer app." />
      </Card>
    );
  }

  return (
    <>
      <p className="muted small">
        Self-hosted apps can't ship shared API keys, so some platforms need a free developer app registered under your own
        account. You do this once per platform; then connect your accounts on the <Link to="/accounts">Accounts</Link> page.
      </p>
      {ordered.map((status) => {
        const info = infoById.get(status.platform);
        return info?.developerApp ? (
          <DeveloperAppCard
            key={status.platform}
            status={status}
            info={info}
            onSaved={(next) => apps.setData((list) => list?.map((a) => (a.platform === next.platform ? next : a)))}
          />
        ) : null;
      })}
    </>
  );
}

interface DeveloperAppCardProps {
  status: PlatformAppStatus;
  info: PlatformInfo;
  onSaved: (status: PlatformAppStatus) => void;
}

function DeveloperAppCard({ status, info, onSaved }: DeveloperAppCardProps) {
  const spec = info.developerApp;
  const fields = spec?.fields ?? [];
  const [values, setValues] = useState<FormValues>(() => appFormValues(fields, status));
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSteps] = useState(() => !status.configured);
  if (!spec) return null;
  const consoleUrl = safeHttpUrl(spec.consoleUrl);
  const steps = instructionLines(spec.instructions);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const v = validateValues(fields, values, status.secretsSet);
    setErrors(v);
    setFormError(null);
    if (hasErrors(v)) return;
    setBusy(true);
    try {
      const next = await api.putPlatformApp(info.id, appSubmitValues(fields, values));
      onSaved(next);
      setValues(appFormValues(fields, next));
      toast.success(next.configured ? `${info.name} developer app saved.` : `${info.name} saved, but some required fields are still empty.`);
    } catch (err) {
      const msg = errorMessage(err);
      const labels = Object.fromEntries(fields.map((f) => [f.key, f.label]));
      const field = isApiError(err, 400) ? fieldForMessage(msg, labels) : null;
      if (field) setErrors({ [field]: msg });
      else setFormError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={<PlatformBadge platform={info.id} withName />}
      actions={
        status.configured ? (
          <Badge tone="success" dot>
            Configured
          </Badge>
        ) : (
          <Badge tone="warn" dot>
            Not set up
          </Badge>
        )
      }
      aria-label={`${platformName(info.id)} developer app`}
    >
      <div className="stack">
        {consoleUrl && (
          <div>
            <a href={consoleUrl} target="_blank" rel="noopener noreferrer" className={buttonClass('secondary', 'sm')}>
              <ExternalIcon width={14} height={14} /> Open the {info.name} developer console
            </a>
          </div>
        )}
        {steps.length > 0 && (
          <details className="details-toggle" open={showSteps}>
            <summary>Setup steps</summary>
            <ol className="steps">
              {steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </details>
        )}
        {status.redirectUri && (
          <CopyField
            label="Redirect URI"
            value={status.redirectUri}
            help="Paste this exactly into the app's OAuth redirect URL setting. It must match the address you open this app with."
          />
        )}
        <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
          <DynamicForm
            fields={fields}
            values={values}
            onChange={setValues}
            secretsSet={status.secretsSet}
            errors={errors}
            disabled={busy}
            idPrefix={`app-${info.id}`}
          />
          {formError && (
            <div className="alert alert-danger" role="alert">
              {formError}
            </div>
          )}
          <div className="form-actions">
            <Button type="submit" variant="primary" loading={busy}>
              Save
            </Button>
          </div>
        </form>
      </div>
    </Card>
  );
}
