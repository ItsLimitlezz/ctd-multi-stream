import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { AuthLayout } from '../components/AuthLayout';
import { Button } from '../components/Button';
import { Field } from '../components/Field';
import { TextInput } from '../components/TextInput';
import { useAuth } from '../state/auth';
import { isApiError, loginErrorMessage } from '../state/errors';

const TOTP_RE = /^\d{6}$/;

export default function LoginPage() {
  const { signedIn, retry } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const totpRef = useRef<HTMLInputElement>(null);
  const userRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (needTotp) totpRef.current?.focus();
  }, [needTotp]);

  // We can land here after the session dropped; if the instance was reset meanwhile, go to setup.
  useEffect(() => {
    let active = true;
    api.setupStatus().then(
      (s) => {
        if (active && s.needsSetup) retry();
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [retry]);

  const reset = () => {
    setNeedTotp(false);
    setTotp('');
    setPassword('');
    setError(null);
    userRef.current?.focus();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!username.trim() || !password) {
      setError('Enter your username and password.');
      return;
    }
    if (needTotp && !TOTP_RE.test(totp)) {
      setError('Enter the 6-digit code from your authenticator app.');
      totpRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const me = await api.login({ username: username.trim(), password, ...(needTotp ? { totp } : {}) });
      signedIn(me);
    } catch (err) {
      if (isApiError(err, undefined, 'totp_required')) {
        if (needTotp) {
          setTotp('');
          totpRef.current?.focus();
        }
        setNeedTotp(true);
      }
      setError(loginErrorMessage(err, needTotp) || null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Sign in" subtitle={needTotp ? 'Two-factor authentication is on for this account.' : undefined}>
      <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
        {error && (
          <div className="alert alert-danger" role="alert">
            {error}
          </div>
        )}
        <Field label="Username">
          <TextInput
            ref={userRef}
            name="username"
            autoComplete="username"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            value={username}
            onValueChange={setUsername}
            readOnly={needTotp}
          />
        </Field>
        <Field label="Password">
          <TextInput
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onValueChange={setPassword}
            readOnly={needTotp}
          />
        </Field>
        {needTotp && (
          <Field label="Authentication code" help="Open your authenticator app and enter the current 6-digit code.">
            <TextInput
              ref={totpRef}
              name="totp"
              className="totp-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              value={totp}
              onValueChange={(v) => setTotp(v.replace(/\D/g, '').slice(0, 6))}
            />
          </Field>
        )}
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          {needTotp ? 'Verify and sign in' : 'Sign in'}
        </Button>
        {needTotp && (
          <Button variant="ghost" block onClick={reset}>
            Use a different account
          </Button>
        )}
      </form>
    </AuthLayout>
  );
}
