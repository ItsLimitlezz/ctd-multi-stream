import { useState, type FormEvent } from 'react';
import type { TotpSetupResponse } from '@shared/api';
import type { User } from '@shared/types';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Field } from '../components/Field';
import { formatDateTime } from '../components/format';
import { Modal } from '../components/Modal';
import { TextInput } from '../components/TextInput';
import { toast } from '../components/Toast';
import { copyText } from '../components/utils';
import { MIN_PASSWORD, useAuth } from '../state/auth';
import { errorMessage } from '../state/errors';

export default function ProfilePage() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <div className="page page-narrow">
      <div className="page-header">
        <div>
          <h1>Profile</h1>
          <p>Your account and sign-in security.</p>
        </div>
      </div>
      <AccountCard user={user} />
      <PasswordCard username={user.username} />
      <TwoFactorCard user={user} />
    </div>
  );
}

function AccountCard({ user }: { user: User }) {
  return (
    <Card title="Account">
      <dl className="kv" style={{ marginTop: 0 }}>
        <dt>Username</dt>
        <dd>{user.username}</dd>
        <dt>Role</dt>
        <dd>{user.role === 'admin' ? 'Administrator' : 'Operator'}</dd>
        <dt>Last sign-in</dt>
        <dd>{formatDateTime(user.lastLoginAt)}</dd>
        <dt>Member since</dt>
        <dd>{formatDateTime(user.createdAt)}</dd>
      </dl>
    </Card>
  );
}

interface PasswordErrors {
  current?: string;
  next?: string;
  confirm?: string;
}

export function validatePasswordChange(current: string, next: string, confirm: string): PasswordErrors {
  const e: PasswordErrors = {};
  if (!current) e.current = 'Enter your current password.';
  if (next.length < MIN_PASSWORD) e.next = `Use at least ${MIN_PASSWORD} characters.`;
  else if (next === current) e.next = 'Choose a password different from the current one.';
  if (confirm !== next) e.confirm = "Passwords don't match.";
  return e;
}

function PasswordCard({ username }: { username: string }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<PasswordErrors>({});
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const v = validatePasswordChange(current, next, confirm);
    setErrors(v);
    if (Object.keys(v).length) return;
    setBusy(true);
    try {
      await api.changePassword({ currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      toast.success('Password changed. Your other sessions were signed out.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Change password" subtitle="Changing it signs you out everywhere else.">
      <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
        {/* Lets password managers associate the new password with this account. */}
        <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
        <Field label="Current password" error={errors.current}>
          <TextInput type="password" autoComplete="current-password" value={current} onValueChange={setCurrent} />
        </Field>
        <Field label="New password" error={errors.next} help={`At least ${MIN_PASSWORD} characters.`}>
          <TextInput type="password" autoComplete="new-password" value={next} onValueChange={setNext} />
        </Field>
        <Field label="Confirm new password" error={errors.confirm}>
          <TextInput type="password" autoComplete="new-password" value={confirm} onValueChange={setConfirm} />
        </Field>
        <div className="form-actions">
          <Button type="submit" variant="primary" loading={busy}>
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** "JBSWY3DPEHPK3PXP" -> "JBSW Y3DP EHPK 3PXP" */
export function groupSecret(secret: string): string {
  return secret.replace(/\s+/g, '').match(/.{1,4}/g)?.join(' ') ?? secret;
}

async function copyKey(secret: string): Promise<void> {
  if (await copyText(secret)) toast.success('Setup key copied.');
  else toast.error('Copy failed. Type the key into your app manually.');
}

function TwoFactorCard({ user }: { user: User }) {
  const { refresh } = useAuth();
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      setSetup(await api.totpSetup());
      setCode('');
      setCodeError(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const enable = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!/^\d{6}$/.test(code)) {
      setCodeError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    setCodeError(null);
    try {
      await api.totpEnable(code);
      setSetup(null);
      await refresh().catch(() => undefined);
      toast.success('Two-factor authentication is on.');
    } catch (err) {
      setCodeError(errorMessage(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const status = user.totpEnabled ? (
    <Badge tone="success" dot>
      On
    </Badge>
  ) : (
    <Badge tone="neutral" dot>
      Off
    </Badge>
  );

  return (
    <Card title="Two-factor authentication" subtitle="Optional: also ask for a code from an authenticator app when signing in." actions={status}>
      {user.totpEnabled ? (
        <div className="row-between">
          <p className="muted small">You'll be asked for a 6-digit code each time you sign in.</p>
          <Button variant="danger" onClick={() => setDisableOpen(true)}>
            Turn off
          </Button>
        </div>
      ) : !setup ? (
        <div className="row-between">
          <p className="muted small">Works with any TOTP app (Google Authenticator, Aegis, 1Password, Bitwarden, …).</p>
          <Button variant="primary" loading={busy} onClick={() => void start()}>
            Set up
          </Button>
        </div>
      ) : (
        <div className="totp-setup">
          <img
            className="qr"
            src={'data:image/svg+xml;utf8,' + encodeURIComponent(setup.qrSvg)}
            alt="QR code to add this account to your authenticator app"
            width={200}
            height={200}
          />
          <form className="stack" onSubmit={(e) => void enable(e)} noValidate>
            <p className="small">
              <strong>1.</strong> Scan the QR code with your authenticator app, or enter this key manually:
            </p>
            <div className="row-between">
              <span className="secret-text" aria-label="Setup key">
                {groupSecret(setup.secret)}
              </span>
              <Button size="sm" onClick={() => void copyKey(setup.secret)}>
                Copy key
              </Button>
            </div>
            <p className="small">
              <strong>2.</strong> Enter the 6-digit code the app shows:
            </p>
            <Field label="Authentication code" error={codeError ?? undefined} hideLabel>
              <TextInput
                className="totp-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                autoFocus
                value={code}
                onValueChange={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
              />
            </Field>
            <div className="form-actions">
              <Button type="submit" variant="primary" loading={busy}>
                Turn on
              </Button>
              <Button variant="ghost" onClick={() => setSetup(null)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </form>
        </div>
      )}
      <DisableTotpModal open={disableOpen} onClose={() => setDisableOpen(false)} onDone={() => void refresh().catch(() => undefined)} />
    </Card>
  );
}

function DisableTotpModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setPassword('');
    setError(null);
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!password) {
      setError('Enter your password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.totpDisable(password);
      toast.success('Two-factor authentication is off.');
      close();
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} title="Turn off two-factor authentication" size="sm" dismissible={!busy}>
      <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
        <p className="muted small">Confirm with your password. You can turn it back on any time.</p>
        <Field label="Password" error={error ?? undefined}>
          <TextInput type="password" autoComplete="current-password" autoFocus value={password} onValueChange={setPassword} />
        </Field>
        <div className="form-actions" style={{ justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={busy}>
            Turn off
          </Button>
        </div>
      </form>
    </Modal>
  );
}
