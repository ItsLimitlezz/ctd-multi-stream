import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { AuthLayout } from '../components/AuthLayout';
import { Button } from '../components/Button';
import { Field } from '../components/Field';
import { TextInput } from '../components/TextInput';
import { MIN_PASSWORD, useAuth } from '../state/auth';
import { isApiError, setupErrorMessage } from '../state/errors';

interface Errors {
  setupCode?: string;
  username?: string;
  password?: string;
  confirm?: string;
}

export function validateSetup(v: { setupCode: string; username: string; password: string; confirm: string }): Errors {
  const errors: Errors = {};
  if (!v.setupCode.trim()) errors.setupCode = 'Enter the setup code from the container logs.';
  if (!v.username.trim()) errors.username = 'Choose a username.';
  if (v.password.length < MIN_PASSWORD) errors.password = `Use at least ${MIN_PASSWORD} characters.`;
  if (v.confirm !== v.password) errors.confirm = "Passwords don't match.";
  return errors;
}

export default function SetupPage() {
  const { signedIn, retry } = useAuth();
  const [setupCode, setSetupCode] = useState('');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<string | null>(null);
  const [alreadySetUp, setAlreadySetUp] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const v = validateSetup({ setupCode, username, password, confirm });
    setErrors(v);
    setError(null);
    if (Object.keys(v).length > 0) return;
    setBusy(true);
    try {
      const me = await api.setup({ setupCode: setupCode.trim(), username: username.trim(), password });
      signedIn(me);
    } catch (err) {
      setAlreadySetUp(isApiError(err, 409));
      setError(setupErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Create the admin account" subtitle="First-run setup">
      <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
        <div className="stack-sm">
          <p className="muted small">
            To prove you own this server, enter the one-time <strong>setup code</strong> printed in the container logs.
          </p>
          <ol className="auth-steps">
            <li>
              TrueNAS: <strong>Apps → CTD Multi-Stream → Logs</strong>. Docker: <code>docker compose logs</code> (or <code>docker logs &lt;container&gt;</code>).
            </li>
            <li>
              Find the line <code>Setup code: XXXX-XXXX-XXXX</code>. A new code is printed each time the app restarts.
            </li>
          </ol>
        </div>
        {error && (
          <div className="alert alert-danger" role="alert">
            {error}
            {alreadySetUp && (
              <div style={{ marginTop: 8 }}>
                <Button size="sm" onClick={retry}>
                  Go to sign in
                </Button>
              </div>
            )}
          </div>
        )}
        <Field label="Setup code" error={errors.setupCode} required>
          <TextInput
            className="code-input"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            placeholder="XXXX-XXXX-XXXX"
            autoFocus
            value={setupCode}
            onValueChange={setSetupCode}
          />
        </Field>
        <Field label="Admin username" error={errors.username} required>
          <TextInput
            name="username"
            autoComplete="username"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={username}
            onValueChange={setUsername}
          />
        </Field>
        <Field label="Password" error={errors.password} help={`At least ${MIN_PASSWORD} characters. A passphrase works well.`} required>
          <TextInput type="password" name="new-password" autoComplete="new-password" value={password} onValueChange={setPassword} />
        </Field>
        <Field label="Confirm password" error={errors.confirm} required>
          <TextInput type="password" name="confirm-password" autoComplete="new-password" value={confirm} onValueChange={setConfirm} />
        </Field>
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          Create admin account
        </Button>
      </form>
    </AuthLayout>
  );
}
