import { useId, useReducer, useState, type FormEvent } from 'react';
import type { ApiAccessInfo, CreateApiTokenResponse } from '@shared/api';
import type { ApiScope, ApiTokenInfo } from '@shared/types';
import { API_SCOPES } from '@shared/types';
import { api } from '../../api';
import { Badge } from '../../components/Badge';
import { Button, buttonClass } from '../../components/Button';
import { Card } from '../../components/Card';
import { ConfirmButton } from '../../components/ConfirmButton';
import { CopyField } from '../../components/CopyField';
import { EmptyState } from '../../components/EmptyState';
import { Field } from '../../components/Field';
import { formatDateTime } from '../../components/format';
import { ExternalIcon, KeyIcon, PlusIcon } from '../../components/icons';
import { Modal } from '../../components/Modal';
import { Spinner } from '../../components/Spinner';
import { TextInput } from '../../components/TextInput';
import { toast } from '../../components/Toast';
import { safeHttpUrl } from '../../components/utils';
import { errorMessage } from '../../state/errors';
import { useApi, useNow } from '../../state/hooks';
import {
  API_SCOPE_INFO,
  DOCK_SCOPES,
  DOCK_TOKEN_NAME,
  dockUrl,
  hasErrors,
  orderedScopes,
  relativeTime,
  TOKEN_NAME_MAX,
  tokenModalDismissible,
  tokenModalInitial,
  tokenModalReducer,
  validateTokenForm,
} from './settings-helpers';

export const API_DOCS_URL = 'https://github.com/ItsLimitlezz/ctd-multi-stream/blob/main/docs/API.md';

/** Settings → API: tokens for other apps, the OBS dock link and how to connect. [admin] */
export function ApiTab() {
  const res = useApi(() => api.apiTokens(), []);
  const now = useNow(60_000);
  const [modal, dispatchModal] = useReducer(tokenModalReducer<CreateApiTokenResponse>, undefined, tokenModalInitial<CreateApiTokenResponse>);
  const [dock, setDock] = useState<CreateApiTokenResponse | null>(null);
  const [dockBusy, setDockBusy] = useState(false);

  const addToken = (t: ApiTokenInfo) =>
    res.setData((d) => (d ? { ...d, tokens: [...d.tokens.filter((x) => x.id !== t.id), t] } : d));

  const revoke = async (t: ApiTokenInfo) => {
    try {
      await api.deleteApiToken(t.id);
      res.setData((d) => (d ? { ...d, tokens: d.tokens.filter((x) => x.id !== t.id) } : d));
      if (dock?.token.id === t.id) setDock(null);
      toast.success(`"${t.name}" revoked. Apps using it can't connect anymore.`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const createDock = async () => {
    setDockBusy(true);
    try {
      const result = await api.createApiToken({ name: DOCK_TOKEN_NAME, scopes: [...DOCK_SCOPES] });
      addToken(result.token);
      setDock(result);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDockBusy(false);
    }
  };

  // Ignored while a create request is in flight (the reducer keeps it open).
  const closeModal = () => dispatchModal({ type: 'close' });

  if (!res.data) {
    return (
      <Card>
        {res.error ? (
          <EmptyState
            title="Couldn't load the API settings"
            description={res.error}
            action={
              <Button onClick={res.reload} loading={res.loading}>
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

  const { tokens, access } = res.data;
  return (
    <>
      <TokensCard tokens={tokens} now={now} onNew={() => dispatchModal({ type: 'open' })} onRevoke={revoke} />
      <DockCard access={access} created={dock} busy={dockBusy} onCreate={() => void createDock()} />
      <AccessCard access={access} />
      {/* While creating it can't close; while the secret is on screen, only the explicit Done / close button dismisses it. */}
      <Modal
        open={modal.open}
        onClose={closeModal}
        title={modal.created ? 'Token created' : 'New API token'}
        size="sm"
        dismissible={tokenModalDismissible(modal)}
      >
        {modal.created ? (
          <TokenSecret created={modal.created} access={access} onDone={closeModal} />
        ) : (
          <NewTokenForm
            onCancel={closeModal}
            onBusyChange={(busy) => dispatchModal({ type: 'busy', busy })}
            onCreated={(result) => {
              addToken(result.token);
              dispatchModal({ type: 'created', result });
            }}
          />
        )}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export function TokensCard({
  tokens,
  now,
  onNew,
  onRevoke,
}: {
  tokens: readonly ApiTokenInfo[];
  now: number;
  onNew: () => void;
  onRevoke: (t: ApiTokenInfo) => Promise<void>;
}) {
  return (
    <Card
      title="API tokens"
      subtitle="Let other apps read your chat and stream status: CTD Overlay, the OBS dock, bots and scripts. Read-only: a token can never change the stream."
      actions={
        <Button size="sm" variant="primary" icon={<PlusIcon width={14} height={14} />} onClick={onNew}>
          New token
        </Button>
      }
      flush
    >
      <div style={{ marginTop: 10 }}>
        {tokens.length === 0 ? (
          <EmptyState icon={<KeyIcon />} title="No tokens yet" description="Create one per app, so you can revoke each on its own." />
        ) : (
          <ul className="item-list" aria-label="API tokens">
            {tokens.map((t) => (
              <TokenRow key={t.id} token={t} now={now} onRevoke={onRevoke} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function lastUsed(iso: string | null, now: number): string {
  if (!iso) return 'Never used';
  const rel = relativeTime(iso, now, '');
  return rel ? `Last used ${rel === 'now' ? 'just now' : rel}` : 'Never used';
}

function TokenRow({ token: t, now, onRevoke }: { token: ApiTokenInfo; now: number; onRevoke: (t: ApiTokenInfo) => Promise<void> }) {
  return (
    <li className="item-row">
      <div className="item-main">
        <span className="user-avatar" aria-hidden="true">
          <KeyIcon width={16} height={16} />
        </span>
        <div className="item-text">
          <div className="item-title">
            <span>{t.name}</span>
            {orderedScopes(t.scopes).map((s) => (
              <Badge key={s} tone="info" title={API_SCOPE_INFO[s].help}>
                {s}
              </Badge>
            ))}
          </div>
          <div className="item-sub">
            <code className="token-prefix" title="The start of the token, to recognise it">
              {t.prefix}…
            </code>
            <span>
              Created {formatDateTime(t.createdAt)}
              {t.createdBy ? ` by ${t.createdBy}` : ''}
            </span>
            <span>{lastUsed(t.lastUsedAt, now)}</span>
          </div>
        </div>
      </div>
      <div className="item-actions">
        <ConfirmButton size="sm" variant="ghost" confirmLabel="Revoke? Apps lose access" onConfirm={() => onRevoke(t)}>
          Revoke
        </ConfirmButton>
      </div>
    </li>
  );
}

export function NewTokenForm({
  onCreated,
  onCancel,
  onBusyChange,
}: {
  onCreated: (result: CreateApiTokenResponse) => void;
  onCancel: () => void;
  /** A create request started (true) or failed (false). On success onCreated replaces the form. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>(() => [...API_SCOPES]);
  const [errors, setErrors] = useState<{ name?: string; scopes?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scopesErrorId = useId();

  const toggleScope = (s: ApiScope, on: boolean) => setScopes((prev) => orderedScopes(on ? [...prev, s] : prev.filter((x) => x !== s)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const v = validateTokenForm(name, scopes);
    setErrors(v);
    setFormError(null);
    if (hasErrors(v)) return;
    setBusy(true);
    onBusyChange?.(true);
    let result: CreateApiTokenResponse;
    try {
      result = await api.createApiToken({ name: name.trim(), scopes: orderedScopes(scopes) });
    } catch (err) {
      setFormError(errorMessage(err));
      setBusy(false);
      onBusyChange?.(false);
      return;
    }
    onCreated(result);
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
      <Field label="Name" error={errors.name} required help="The app that will use it, e.g. CTD Overlay. Shown in the token list and the audit log.">
        <TextInput value={name} autoFocus autoComplete="off" spellCheck={false} maxLength={TOKEN_NAME_MAX} onValueChange={setName} />
      </Field>
      <fieldset className="check-group" aria-describedby={errors.scopes ? scopesErrorId : undefined}>
        <legend className="field-label">Permissions</legend>
        {API_SCOPES.map((s) => (
          <label key={s} className="check-row">
            <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => toggleScope(s, e.currentTarget.checked)} />
            <span>
              <strong>{API_SCOPE_INFO[s].label}</strong> <code className="small">{s}</code>
              <span className="check-help">{API_SCOPE_INFO[s].help}</span>
            </span>
          </label>
        ))}
        {errors.scopes && (
          <p id={scopesErrorId} className="field-error">
            {errors.scopes}
          </p>
        )}
      </fieldset>
      {formError && (
        <div className="alert alert-danger" role="alert">
          {formError}
        </div>
      )}
      <div className="form-actions is-end">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy}>
          Create token
        </Button>
      </div>
    </form>
  );
}

/** The new secret, shown once. Masked by default so it never ends up on stream; Copy works either way. */
export function TokenSecret({ created, access, onDone }: { created: CreateApiTokenResponse; access: ApiAccessInfo; onDone: () => void }) {
  return (
    <div className="stack">
      <div className="alert alert-warn" role="alert">
        <strong>Copy it now — you won't see it again.</strong> Only a hash is kept. If you lose it, revoke it and create a new one.
      </div>
      <CopyField
        label={`Token "${created.token.name}"`}
        value={created.secret}
        secret
        help="Hidden so it can't show up on stream. Copy works without showing it."
      />
      <p className="muted small">
        Apps send it as <code>Authorization: Bearer &lt;token&gt;</code> to <code className="break-all">{access.lanBaseUrl ?? access.baseUrl}</code>.
      </p>
      <div className="form-actions is-end">
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OBS dock
// ---------------------------------------------------------------------------

/** Shown when the server can't tell its LAN address (it runs in a container). */
export function LanHint() {
  return (
    <div className="alert">
      The server can't tell its LAN address (it runs in a container), so links here use the HTTPS address. For a LAN link, open
      this page through the NAS's LAN address (for example <code>https://192.168.x.x:30443</code>) or set{' '}
      <code>LAN_HTTP_HOST</code> to the NAS IP, then reload this page.
    </div>
  );
}

export function DockCard({
  access,
  created,
  busy,
  onCreate,
}: {
  access: ApiAccessInfo;
  created: CreateApiTokenResponse | null;
  busy: boolean;
  onCreate: () => void;
}) {
  const link = created ? dockUrl(access, created.secret) : null;
  return (
    <Card title="OBS dock" subtitle="Live status, bitrates, every destination, viewers and the merged chat in a panel inside OBS.">
      <div className="stack">
        {access.lanBaseUrl === null && <LanHint />}
        {created && (
          <>
            <div className="alert alert-warn" role="alert">
              <strong>Copy the dock URL now — you won't see it again.</strong> It contains a new read-only token ("{created.token.name}"):
              anyone with the URL can read your chat and stream status.
            </div>
            {link ? (
              <CopyField
                label="Dock URL"
                value={link.url}
                secret
                help={
                  link.lan
                    ? "Uses this server's LAN address: for OBS on the same network. Hidden so it can't show up on stream."
                    : "Uses the HTTPS address. With a self-signed certificate OBS may refuse it; prefer a LAN link (see above). Hidden so it can't show up on stream."
                }
              />
            ) : (
              <CopyField
                label="Dock token"
                value={created.secret}
                secret
                help="Couldn't build the URL from the server address: open this server's /dock page and add #token= followed by this token."
              />
            )}
          </>
        )}
        <ol className="steps">
          <li>
            {created ? (
              'Copy the dock URL above.'
            ) : (
              <>
                Click <strong>Create dock link</strong>. It makes a read-only token named "{DOCK_TOKEN_NAME}" (status + chat).
              </>
            )}
          </li>
          <li>
            In OBS: <strong>Docks → Custom Browser Docks…</strong> (older OBS: <strong>View → Docks → Custom Browser Docks</strong>).
          </li>
          <li>
            Dock Name: <strong>CTD Multi-Stream</strong>. URL: paste the dock URL. Click <strong>Apply</strong>.
          </li>
          <li>The dock opens as a panel; drag it next to your other docks.</li>
        </ol>
        <div>
          <Button variant={created ? 'secondary' : 'primary'} loading={busy} onClick={onCreate}>
            {created ? 'Create another dock link' : 'Create dock link'}
          </Button>
        </div>
        {created && (
          <p className="muted small">Each link has its own token. When you replace a link, revoke the old "{DOCK_TOKEN_NAME}" token above.</p>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export function AccessCard({ access }: { access: ApiAccessInfo }) {
  const openApi = safeHttpUrl(access.openApiUrl);
  return (
    <Card title="Connect an app" subtitle="Where other apps reach the read-only API (v1). Every request needs a token from the list above.">
      <div className="stack">
        {access.lanBaseUrl ? (
          <CopyField
            label="On your network (LAN)"
            value={access.lanBaseUrl}
            help="For apps on the same network as this server: CTD Overlay on the NAS, OBS, local bots."
          />
        ) : (
          <LanHint />
        )}
        <CopyField label="From anywhere (HTTPS)" value={access.baseUrl} help="For apps outside your network." />
        {access.tlsFingerprint256 && (
          <CopyField
            label="Certificate SHA-256 fingerprint"
            value={access.tlsFingerprint256}
            help="Apps that connect over HTTPS to a self-signed certificate can pin this."
          />
        )}
        <CopyField label="OpenAPI description" value={access.openApiUrl} help="Machine-readable description of every endpoint (no token needed)." />
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {openApi && (
            <a href={openApi} target="_blank" rel="noopener noreferrer" className={buttonClass('ghost', 'sm')}>
              <ExternalIcon width={14} height={14} /> Open OpenAPI
            </a>
          )}
          <a href={API_DOCS_URL} target="_blank" rel="noopener noreferrer" className={buttonClass('ghost', 'sm')}>
            <ExternalIcon width={14} height={14} /> API documentation
          </a>
        </div>
      </div>
    </Card>
  );
}
