import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PlatformAppStatus } from '@shared/api';
import type { Account, ConnectMethod, PlatformInfo } from '@shared/types';
import { api } from '../../api';
import { Badge } from '../../components/Badge';
import { Button, buttonClass } from '../../components/Button';
import { DynamicForm } from '../../components/DynamicForm';
import { cleanValues, initialValues, validateValues, type FormErrors, type FormValues } from '../../components/dynamic-form';
import { Field } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { PlatformBadge } from '../../components/PlatformBadge';
import { Spinner } from '../../components/Spinner';
import { TextInput } from '../../components/TextInput';
import { Link } from '../../router';
import { errorMessage, isApiError } from '../../state/errors';
import { PlatformPicker } from '../destinations/PlatformPicker';
import { fieldForMessage, hasErrors } from '../settings/settings-helpers';
import { connectablePlatforms, connectMethodFor, developerAppBadge, needsDeveloperApp } from './connect-flow';

export const MAX_ACCOUNT_LABEL = 100;

const NEXT_STEP: Record<ConnectMethod, (name: string) => string> = {
  'device-code': (name) => `Next you'll get a short code to enter on ${name}'s website.`,
  'oauth-paste': (name) => `Next you'll log in to ${name} in a new tab and approve access.`,
  'token-paste': (name) => `Next you'll paste a token from ${name}.`,
  browser: (name) => `Next you'll log in to ${name} in a browser shown right here.`,
  none: () => '',
};

export interface AddAccountModalProps {
  open: boolean;
  platforms: readonly PlatformInfo[] | undefined;
  apps: readonly PlatformAppStatus[] | undefined;
  /** Preselect this platform (e.g. from /accounts?add=twitch). */
  initialPlatform: string | null;
  onClose: () => void;
  /** The account was created; the caller starts the connect flow. */
  onCreated: (account: Account) => void;
}

export function AddAccountModal({ open, onClose, ...rest }: AddAccountModalProps) {
  const [title, setTitle] = useState('Add an account');
  return (
    <Modal open={open} onClose={onClose} title={title} size="lg">
      <AddAccountContent {...rest} onClose={onClose} setTitle={setTitle} />
    </Modal>
  );
}

function AddAccountContent({
  platforms,
  apps,
  initialPlatform,
  onClose,
  onCreated,
  setTitle,
}: Omit<AddAccountModalProps, 'open'> & { setTitle: (t: string) => void }) {
  const connectable = connectablePlatforms(platforms ?? []);
  const [info, setInfo] = useState<PlatformInfo | null>(null);
  const appliedInitial = useRef(false);

  // Preselect the requested platform once the list is available.
  useEffect(() => {
    if (appliedInitial.current || !platforms) return;
    appliedInitial.current = true;
    const match = platforms.find((p) => p.id === initialPlatform && p.connectMethod !== 'none');
    if (match) setInfo(match);
  }, [platforms, initialPlatform]);

  useEffect(() => {
    setTitle(info ? `Add a ${info.name} account` : 'Add an account');
  }, [info, setTitle]);

  if (!platforms) {
    return (
      <div className="row muted">
        <Spinner size="sm" /> Loading platforms…
      </div>
    );
  }

  if (!info) {
    if (connectable.length === 0) return <p className="muted">None of the platforms on this server use accounts.</p>;
    return (
      <div className="stack">
        <p className="muted small">Choose the platform. You'll connect the account right after this step.</p>
        <PlatformPicker
          platforms={connectable}
          onPick={setInfo}
          showFeeds={false}
          extra={(p) => {
            const badge = developerAppBadge(p, apps);
            return badge ? <Badge tone="warn">{badge}</Badge> : null;
          }}
        />
      </div>
    );
  }

  // Every account type of this platform needs the app: nothing to fill in before it is set up.
  // (Platforms where some account types work without it decide in the form, once the type is picked.)
  if (needsDeveloperApp(info, apps)) {
    return (
      <div className="stack">
        <div className="form-header">
          <PlatformBadge platform={info.id} withName />
          <button type="button" className="inline-link-button small" onClick={() => setInfo(null)}>
            Change platform
          </button>
        </div>
        <DeveloperAppAlert name={info.name} />
        <div className="form-actions is-end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <SetUpAppLink />
        </div>
      </div>
    );
  }

  return <AccountForm key={info.id} info={info} apps={apps} onBack={() => setInfo(null)} onCancel={onClose} onCreated={onCreated} />;
}

function DeveloperAppAlert({ name, accountType }: { name: string; accountType?: boolean }) {
  return (
    <div className="alert alert-warn">
      {accountType ? `This type of ${name} account` : name} needs a free developer app before you can connect
      {accountType ? ' it' : ' an account'}. You register it once on {name}'s developer site; Settings → Developer apps walks
      you through it.
    </div>
  );
}

function SetUpAppLink() {
  return (
    <Link to="/settings?tab=apps" className={buttonClass('primary')}>
      Set up the developer app
    </Link>
  );
}

export interface AccountFormProps {
  info: PlatformInfo;
  apps: readonly PlatformAppStatus[] | undefined;
  onBack: () => void;
  onCancel: () => void;
  onCreated: (account: Account) => void;
}

/** Exported for tests. */
export function AccountForm({ info, apps, onBack, onCancel, onCreated }: AccountFormProps) {
  const [label, setLabel] = useState(info.name);
  const [values, setValues] = useState<FormValues>(() => initialValues(info.accountFields));
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // E.g. Facebook: a Page account needs the Meta app, a profile account doesn't.
  const appNeeded = needsDeveloperApp(info, apps, values);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || appNeeded) return;
    const v: FormErrors = { ...validateValues(info.accountFields, values) };
    if (label.trim().length > MAX_ACCOUNT_LABEL) v.label = `Use at most ${MAX_ACCOUNT_LABEL} characters.`;
    setErrors(v);
    setFormError(null);
    if (hasErrors(v)) return;
    setBusy(true);
    try {
      const account = await api.createAccount({
        platform: info.id,
        label: label.trim() || undefined,
        options: cleanValues(info.accountFields, values),
      });
      setBusy(false);
      onCreated(account);
    } catch (err) {
      const msg = errorMessage(err);
      const labels: Record<string, string> = { label: 'Label' };
      for (const f of info.accountFields) labels[f.key] = f.label;
      const field = isApiError(err, 400) ? fieldForMessage(msg, labels) : null;
      if (field) setErrors({ [field]: msg });
      else setFormError(msg);
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
      <div className="form-header">
        <span className="row">
          <PlatformBadge platform={info.id} withName />
          {info.experimental && <Badge tone="warn">Experimental</Badge>}
        </span>
        <button type="button" className="inline-link-button small" onClick={onBack} disabled={busy}>
          Change platform
        </button>
      </div>
      {info.notes && <p className="muted small">{info.notes}</p>}
      <Field label="Label" error={errors.label} help="A name for this account in the app, e.g. your channel name. It may be replaced by the channel name once connected.">
        <TextInput value={label} maxLength={MAX_ACCOUNT_LABEL} autoComplete="off" onValueChange={setLabel} disabled={busy} />
      </Field>
      {info.accountFields.length > 0 && (
        <DynamicForm fields={info.accountFields} values={values} onChange={setValues} errors={errors} disabled={busy} idPrefix={`acct-${info.id}`} />
      )}
      {appNeeded ? (
        <DeveloperAppAlert name={info.name} accountType />
      ) : (
        <p className="small muted">{NEXT_STEP[connectMethodFor(info, values)](info.name)}</p>
      )}
      {formError && (
        <div className="alert alert-danger" role="alert">
          {formError}
        </div>
      )}
      <div className="form-actions is-end">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {appNeeded ? (
          <SetUpAppLink />
        ) : (
          <Button type="submit" variant="primary" loading={busy}>
            Continue
          </Button>
        )}
      </div>
    </form>
  );
}
