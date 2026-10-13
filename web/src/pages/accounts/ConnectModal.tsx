import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import type { ConnectPoll, ConnectStart } from '@shared/api';
import type { Account, PlatformInfo } from '@shared/types';
import { api } from '../../api';
import { BrowserViewer } from '../../components/BrowserViewer';
import { Button, buttonClass } from '../../components/Button';
import { DynamicForm } from '../../components/DynamicForm';
import { cleanValues, initialValues, validateValues, type FormErrors, type FormValues } from '../../components/dynamic-form';
import { Field } from '../../components/Field';
import { ExternalIcon } from '../../components/icons';
import { Modal } from '../../components/Modal';
import { platformName } from '../../components/PlatformBadge';
import { Spinner } from '../../components/Spinner';
import { TextInput } from '../../components/TextInput';
import { toast } from '../../components/Toast';
import { copyText, safeHttpUrl } from '../../components/utils';
import { Link } from '../../router';
import { useNow } from '../../state/hooks';
import { errorMessage } from '../../state/errors';
import { useLiveEvent } from '../../state/live';
import { hasErrors, instructionLines } from '../settings/settings-helpers';
import {
  checkPastedUrl,
  displayUrl,
  formatCountdown,
  isFatalPollError,
  pollBackoffMs,
  pollIntervalMs,
  remainingSeconds,
  verificationLink,
} from './connect-flow';
import '../settings/admin.css';

export type ConnectState =
  | { phase: 'starting' }
  | { phase: 'ready'; start: ConnectStart }
  | { phase: 'failed'; message: string; misconfigured: boolean };

export interface ConnectModalProps {
  account: Account;
  info: PlatformInfo | undefined;
  state: ConnectState;
  /** Start the connection again (new device code, new login link...). */
  onRestart: () => void;
  onConnected: (account: Account) => void;
  onClose: () => void;
}

type CancelFn = () => Promise<void>;

/** Connect-flow dialog driven by the ConnectStart the server returned. */
export function ConnectModal({ account, info, state, onRestart, onConnected, onClose }: ConnectModalProps) {
  const name = info?.name ?? platformName(account.platform);
  const done = useRef(false);
  const cancelRef = useRef<CancelFn | null>(null);
  const [closing, setClosing] = useState(false);
  const method = state.phase === 'ready' ? state.start.method : null;

  const finish = useCallback(
    (acc: Account) => {
      if (done.current) return;
      done.current = true;
      onConnected(acc);
    },
    [onConnected],
  );

  // The OAuth redirect may land in another tab, and a device code may be approved between polls:
  // the server's account update tells us either way. (The browser flow finishes on its own.)
  useLiveEvent('account', (m) => {
    if (m.account.id !== account.id || m.account.status !== 'connected') return;
    if (method === 'device-code' || method === 'oauth-paste') finish(m.account);
  });

  const close = async () => {
    if (closing) return;
    const cancel = cancelRef.current;
    if (cancel) {
      setClosing(true);
      try {
        await cancel();
      } finally {
        setClosing(false);
      }
    }
    onClose();
  };

  let body;
  if (state.phase === 'starting') {
    body = (
      <div className="waiting-line">
        <Spinner size="sm" label={null} /> Contacting {name}…
      </div>
    );
  } else if (state.phase === 'failed') {
    body = <FailedStep name={name} message={state.message} misconfigured={state.misconfigured} onRestart={onRestart} />;
  } else {
    const start = state.start;
    switch (start.method) {
      case 'device-code':
        body = <DeviceCodeStep account={account} start={start} name={name} onConnected={finish} onRestart={onRestart} />;
        break;
      case 'oauth-paste':
        body = <OAuthPasteStep account={account} start={start} name={name} onConnected={finish} onRestart={onRestart} />;
        break;
      case 'token-paste':
        body = <TokenPasteStep account={account} start={start} name={name} onConnected={finish} onRestart={onRestart} />;
        break;
      case 'browser':
        body = (
          <BrowserStep
            account={account}
            start={start}
            name={name}
            cancelRef={cancelRef}
            closing={closing}
            onConnected={finish}
            onCancel={() => void close()}
          />
        );
        break;
      default:
        body = <p className="muted">{name} doesn't need an account connection.</p>;
    }
  }

  return (
    <Modal
      open
      onClose={() => void close()}
      title={`Connect ${account.label === name ? name : `${account.label} (${name})`}`}
      size={method === 'browser' ? 'lg' : 'md'}
      dismissible={method !== 'browser' && !closing}
    >
      {body}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** Driver-provided instructions: a numbered list for several lines, a paragraph for one. */
export function Instructions({ text }: { text: string | null | undefined }) {
  const lines = instructionLines(text);
  if (lines.length === 0) return null;
  if (lines.length === 1) return <p className="small">{lines[0]}</p>;
  return (
    <ol className="steps">
      {lines.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ol>
  );
}

interface StepProps<M extends ConnectStart['method']> {
  account: Account;
  start: Extract<ConnectStart, { method: M }>;
  name: string;
  onConnected: (account: Account) => void;
  onRestart: () => void;
}

/** Outcome of complete/poll for the paste flows: a message to show, or null when connected. */
function pollOutcome(res: ConnectPoll, name: string, onConnected: (a: Account) => void): { message: string; expired: boolean } | null {
  switch (res.status) {
    case 'connected':
      onConnected(res.account);
      return null;
    case 'error':
      return { message: res.message || 'The connection failed.', expired: false };
    case 'expired':
      return { message: 'This login expired. Start again to get a fresh one.', expired: true };
    default:
      return { message: `${name} hasn't confirmed the connection yet. Finish the steps and try again.`, expired: false };
  }
}

function FailedStep({ name, message, misconfigured, onRestart }: { name: string; message: string; misconfigured: boolean; onRestart: () => void }) {
  return (
    <div className="stack">
      <div className="alert alert-danger" role="alert">
        {message}
      </div>
      {misconfigured && (
        <p className="small">
          {name} needs a developer app before accounts can be connected. Set it up under Settings → Developer apps, then try again.
        </p>
      )}
      <div className="form-actions is-end">
        {misconfigured && (
          <Link to="/settings?tab=apps" className={buttonClass('secondary')}>
            Developer apps
          </Link>
        )}
        <Button variant="primary" onClick={onRestart}>
          Try again
        </Button>
      </div>
    </div>
  );
}

function ExternalButton({ href, children, primary = true }: { href: string | null; children: string; primary?: boolean }) {
  if (!href) return <p className="small text-danger">The server sent an invalid link. Try again.</p>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={buttonClass(primary ? 'primary' : 'secondary')}>
      <ExternalIcon width={16} height={16} /> {children}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Device code
// ---------------------------------------------------------------------------

function DeviceCodeStep({ account, start, name, onConnected, onRestart }: StepProps<'device-code'>) {
  const [status, setStatus] = useState<'waiting' | 'expired' | 'error'>('waiting');
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [expiresAt] = useState(() => Date.now() + Math.max(0, start.expiresIn) * 1000);
  const now = useNow(status === 'waiting' ? 1000 : null);
  const remaining = remainingSeconds(expiresAt, now);
  const expired = status === 'expired' || (status === 'waiting' && start.expiresIn > 0 && remaining <= 0);
  const link = verificationLink(start);
  const connectedRef = useRef(onConnected);
  useEffect(() => {
    connectedRef.current = onConnected;
  });

  // Poll every `interval` seconds until connected / expired / error / unmount. Transient
  // failures (network, 5xx, 429) back off and keep polling; slow_down is handled server-side.
  useEffect(() => {
    if (status !== 'waiting') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = pollIntervalMs(start.interval);
    const tick = async () => {
      if (cancelled) return;
      if (start.expiresIn > 0 && Date.now() >= expiresAt) {
        setStatus('expired');
        return;
      }
      try {
        const res = await api.pollConnect(account.id);
        if (cancelled) return;
        setWarning(null);
        delay = pollIntervalMs(start.interval);
        if (res.status === 'connected') return connectedRef.current(res.account);
        if (res.status === 'expired') return setStatus('expired');
        if (res.status === 'error') {
          setError(res.message || 'The connection failed.');
          return setStatus('error');
        }
      } catch (err) {
        if (cancelled) return;
        if (isFatalPollError(err)) {
          setError(errorMessage(err));
          return setStatus('error');
        }
        setWarning(`${errorMessage(err)} Still trying…`);
        delay = pollBackoffMs(delay);
      }
      if (!cancelled) timer = setTimeout(() => void tick(), delay);
    };
    timer = setTimeout(() => void tick(), delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [status, account.id, start, expiresAt]);

  const copy = async () => {
    if (await copyText(start.userCode)) toast.success('Code copied.');
    else toast.error('Copy failed. Type the code in manually.');
  };

  if (expired) {
    return (
      <div className="stack">
        <div className="alert alert-warn">The code expired before it was used.</div>
        <div className="form-actions is-end">
          <Button variant="primary" onClick={onRestart}>
            Get a new code
          </Button>
        </div>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="stack">
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
        <div className="form-actions is-end">
          <Button variant="primary" onClick={onRestart}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <ol className="steps">
        <li>
          Open <strong>{displayUrl(start.verificationUri)}</strong> and sign in to {name} with the account you stream from.
        </li>
        <li>Enter this code{start.verificationUriComplete ? ' (it may already be filled in)' : ''} and approve access:</li>
      </ol>
      <div className="device-code" aria-label="Your code">
        {start.userCode}
      </div>
      <div className="row" style={{ justifyContent: 'center' }}>
        <ExternalButton href={link}>{`Open ${displayUrl(start.verificationUri)}`}</ExternalButton>
        <Button onClick={() => void copy()}>Copy code</Button>
      </div>
      <div className="waiting-line" role="status">
        <Spinner size="sm" label={null} />
        <span>
          Waiting for you to approve…
          {start.expiresIn > 0 && (
            <>
              {' '}
              The code expires in <span className="countdown">{formatCountdown(remaining)}</span>.
            </>
          )}
        </span>
      </div>
      {warning && <p className="small item-warn">{warning}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OAuth with paste-back
// ---------------------------------------------------------------------------

function OAuthPasteStep({ account, start, name, onConnected, onRestart }: StepProps<'oauth-paste'>) {
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const check = checkPastedUrl(pasted);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const outcome = pollOutcome(await api.completeConnect(account.id, { pastedUrl: check.url }), name, onConnected);
      if (outcome) {
        setError(outcome.message);
        setExpired(outcome.expired);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Instructions text={start.instructions} />
      <ol className="steps">
        <li>
          Open the {name} login page in a new tab and approve access.
          <div style={{ marginTop: 8 }}>
            <ExternalButton href={safeHttpUrl(start.authorizeUrl)}>{`Open ${name} login`}</ExternalButton>
          </div>
        </li>
        <li>
          {name} then sends that tab to <code className="cell-wrap">{start.redirectUri}</code>. If this app is reachable at that
          address, the connection completes by itself and that tab opens this Accounts page.
        </li>
        <li>If that tab shows an error page instead, copy the full address from its address bar and paste it here:</li>
      </ol>
      <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
        <Field label="Address you landed on" error={error ?? undefined}>
          <TextInput
            mono
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
            placeholder={`${start.redirectUri}?code=…`}
            value={pasted}
            onValueChange={(v) => {
              setPasted(v);
              if (error) setError(null);
            }}
            disabled={busy}
          />
        </Field>
        <div className="form-actions is-end">
          {expired && (
            <Button onClick={onRestart} disabled={busy}>
              Start again
            </Button>
          )}
          <Button type="submit" variant="primary" loading={busy} disabled={!pasted.trim()}>
            Connect
          </Button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Token paste
// ---------------------------------------------------------------------------

function TokenPasteStep({ account, start, name, onConnected, onRestart }: StepProps<'token-paste'>) {
  const [values, setValues] = useState<FormValues>(() => initialValues(start.fields));
  const [errors, setErrors] = useState<FormErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const v = validateValues(start.fields, values);
    setErrors(v);
    setError(null);
    if (hasErrors(v)) return;
    const fields: Record<string, string> = {};
    for (const [k, val] of Object.entries(cleanValues(start.fields, values))) fields[k] = String(val);
    setBusy(true);
    try {
      const outcome = pollOutcome(await api.completeConnect(account.id, { fields }), name, onConnected);
      if (outcome) {
        setError(outcome.message);
        setExpired(outcome.expired);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
      <Instructions text={start.instructions} />
      <DynamicForm fields={start.fields} values={values} onChange={setValues} errors={errors} disabled={busy} idPrefix={`connect-${account.id}`} />
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}
      <div className="form-actions is-end">
        {expired && (
          <Button onClick={onRestart} disabled={busy}>
            Start again
          </Button>
        )}
        <Button type="submit" variant="primary" loading={busy}>
          Connect
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Browser login
// ---------------------------------------------------------------------------

interface BrowserStepProps {
  account: Account;
  start: Extract<ConnectStart, { method: 'browser' }>;
  name: string;
  /** Set to this step's cancel function (closes the browser without saving). */
  cancelRef: RefObject<CancelFn | null>;
  closing: boolean;
  onConnected: (account: Account) => void;
  onCancel: () => void;
}

function BrowserStep({ account, start, name, cancelRef, closing, onConnected, onCancel }: BrowserStepProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The browser was closed on purpose (saved or discarded). */
  const settled = useRef(false);
  const alive = useRef(true);
  const accountId = account.id;

  useEffect(() => {
    alive.current = true;
    cancelRef.current = async () => {
      if (settled.current) return;
      settled.current = true;
      await api.browserClose(accountId, false).catch(() => undefined);
    };
    return () => {
      alive.current = false;
      cancelRef.current = null;
      // Left without "I'm logged in" or "Cancel" (e.g. navigated away): discard the half-done login.
      // Deferred so React StrictMode's simulated unmount/remount doesn't close the live browser.
      setTimeout(() => {
        if (alive.current || settled.current) return;
        settled.current = true;
        void api.browserClose(accountId, false).catch(() => undefined);
      }, 0);
    };
  }, [accountId, cancelRef]);

  const confirm = async () => {
    if (busy || closing) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.completeConnect(accountId, {});
      if (res.status === 'connected') {
        settled.current = true;
        try {
          await api.browserClose(accountId, true);
        } catch (err) {
          toast.warn(`Connected, but closing the browser failed: ${errorMessage(err)}`);
        }
        onConnected(res.account);
        return;
      }
      setError(
        res.status === 'error'
          ? res.message || 'The connection failed.'
          : res.status === 'expired'
            ? 'The login session expired. Cancel and start again.'
            : res.message || `It doesn't look like you're logged in to ${name} yet. Finish logging in below, then try again.`,
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Instructions text={start.instructions} />
      <p className="small muted">
        Log in below as you would in a normal browser, including any two-factor prompt or captcha. Your password goes straight to{' '}
        {name}; this app never stores it, only the resulting login session (encrypted).
      </p>
      <BrowserViewer accountId={accountId} label={`${name} login page`} />
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}
      <div className="form-actions is-end">
        <Button variant="ghost" onClick={onCancel} loading={closing} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void confirm()} loading={busy} disabled={closing}>
          I'm logged in
        </Button>
      </div>
    </div>
  );
}
