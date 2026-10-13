import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Account, PlatformInfo } from '@shared/types';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ConfirmButton } from '../components/ConfirmButton';
import { EmptyState } from '../components/EmptyState';
import { Field } from '../components/Field';
import { plural } from '../components/format';
import { ShieldIcon } from '../components/icons';
import { Modal } from '../components/Modal';
import { PlatformBadge, platformName } from '../components/PlatformBadge';
import { Spinner } from '../components/Spinner';
import { TextInput } from '../components/TextInput';
import { toast } from '../components/Toast';
import { Link, setQuery, useQuery } from '../router';
import { errorMessage } from '../state/errors';
import { useApi, useDestinations } from '../state/hooks';
import { useAccountsVersion } from '../state/live';
import { AddAccountModal, MAX_ACCOUNT_LABEL } from './accounts/AddAccountModal';
import { ConnectModal, type ConnectState } from './accounts/ConnectModal';
import {
  ACCOUNT_STATUS_META,
  connectLabel,
  deleteConfirmLabel,
  destinationsUsing,
  isMisconfigured,
  needsDeveloperApp,
  readAccountsQuery,
} from './accounts/connect-flow';
import { sortAccounts } from './destinations/destination-form';
import './settings/admin.css';

interface Flow {
  account: Account;
  state: ConnectState;
}

export default function AccountsPage() {
  const version = useAccountsVersion();
  const accounts = useApi(() => api.accounts(), [version]);
  const platforms = useApi(() => api.platforms(), []);
  const apps = useApi(() => api.platformApps(), []);
  const dests = useDestinations();
  const [adding, setAdding] = useState<{ platform: string | null } | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [renaming, setRenaming] = useState<Account | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [connectedNotice, setConnectedNotice] = useState<string | null>(null);
  const connectSeq = useRef(0);

  const infoById = useMemo(() => new Map((platforms.data ?? []).map((p) => [p.id as string, p])), [platforms.data]);
  const sorted = useMemo(() => sortAccounts(accounts.data ?? []), [accounts.data]);

  const upsert = useCallback(
    (acc: Account) =>
      accounts.setData((list) => {
        if (!list) return [acc];
        return list.some((a) => a.id === acc.id) ? list.map((a) => (a.id === acc.id ? acc : a)) : [...list, acc];
      }),
    [accounts.setData],
  );

  // ?connected=<id> / ?error=<msg> (OAuth redirect landing) and ?add=<platform> (deep link).
  const query = useQuery();
  const handledQuery = useRef('');
  useEffect(() => {
    const key = query.toString();
    if (!key || handledQuery.current === key) return;
    const q = readAccountsQuery(query);
    if (!q.connected && !q.error && !q.add) return;
    handledQuery.current = key;
    if (q.connected) setConnectedNotice(q.connected);
    if (q.error) toast.error(q.error);
    if (q.add) setAdding({ platform: q.add });
    setQuery({ connected: null, error: null, add: null });
  }, [query]);

  // Announce the OAuth landing once we know the account's name.
  useEffect(() => {
    if (!connectedNotice || (!accounts.data && accounts.loading)) return;
    const acc = accounts.data?.find((a) => a.id === connectedNotice);
    toast.success(acc ? `${acc.label} connected.` : 'Account connected.');
    setConnectedNotice(null);
  }, [connectedNotice, accounts.data, accounts.loading]);

  const beginConnect = useCallback(async (account: Account) => {
    const seq = ++connectSeq.current;
    setFlow({ account, state: { phase: 'starting' } });
    let browserOpened = false;
    try {
      const start = await api.connectAccount(account.id);
      if (start.method === 'browser') {
        await api.browserOpen(account.id, start.startUrl || undefined);
        browserOpened = true;
      }
      if (seq !== connectSeq.current) {
        // Closed (or restarted) while starting: don't leave a browser open for nobody.
        if (browserOpened) void api.browserClose(account.id, false).catch(() => undefined);
        return;
      }
      if (start.method === 'none') {
        setFlow(null);
        toast.info(`${platformName(account.platform)} doesn't need an account connection.`);
        return;
      }
      setFlow({ account, state: { phase: 'ready', start } });
    } catch (err) {
      if (seq !== connectSeq.current) return;
      setFlow({ account, state: { phase: 'failed', message: errorMessage(err), misconfigured: isMisconfigured(err) } });
    }
  }, []);

  const closeFlow = useCallback(() => {
    connectSeq.current++;
    setFlow(null);
  }, []);

  const connected = useCallback(
    (acc: Account) => {
      connectSeq.current++;
      setFlow(null);
      upsert(acc);
      toast.success(`${acc.label} connected.`);
    },
    [upsert],
  );

  const check = async (acc: Account) => {
    setChecking(acc.id);
    try {
      const updated = await api.checkAccount(acc.id);
      upsert(updated);
      const meta = ACCOUNT_STATUS_META[updated.status];
      if (updated.status === 'connected') toast.success(`${updated.label} is connected and working.`);
      else toast.warn(`${updated.label}: ${updated.statusMessage || meta.label}`);
    } catch (err) {
      toast.error(errorMessage(err));
      accounts.reload();
    } finally {
      setChecking(null);
    }
  };

  const remove = async (acc: Account) => {
    try {
      await api.deleteAccount(acc.id);
      accounts.setData((list) => list?.filter((a) => a.id !== acc.id));
      toast.success(`${acc.label} deleted.`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const addButton = (
    <Button variant="primary" onClick={() => setAdding({ platform: null })} disabled={!platforms.data}>
      Add account
    </Button>
  );

  let body;
  if (!accounts.data) {
    body = accounts.error ? (
      <Card>
        <EmptyState
          title="Couldn't load accounts"
          description={accounts.error}
          action={
            <Button onClick={accounts.reload} loading={accounts.loading}>
              Try again
            </Button>
          }
        />
      </Card>
    ) : (
      <Card>
        <div className="row muted">
          <Spinner size="sm" /> Loading accounts…
        </div>
      </Card>
    );
  } else if (sorted.length === 0) {
    body = (
      <Card>
        <EmptyState
          icon={<ShieldIcon />}
          title="No accounts connected"
          description="Connect the accounts you stream to. The app then gets stream keys, keeps the title in sync, reads chat and presses Go Live where a platform has no API."
          action={addButton}
        />
      </Card>
    );
  } else {
    body = (
      <Card flush>
        <ul className="item-list">
          {sorted.map((acc) => {
            const info = infoById.get(acc.platform);
            return (
              <AccountRow
                key={acc.id}
                account={acc}
                info={info}
                appMissing={needsDeveloperApp(info, apps.data, acc.options)}
                linked={destinationsUsing(dests.data, acc.id)}
                connecting={flow?.account.id === acc.id && flow.state.phase === 'starting'}
                checking={checking === acc.id}
                onConnect={() => void beginConnect(acc)}
                onCheck={() => void check(acc)}
                onRename={() => setRenaming(acc)}
                onDelete={() => remove(acc)}
              />
            );
          })}
        </ul>
      </Card>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Accounts</h1>
          <p>Platform logins the app uses for stream keys, titles, chat and going live.</p>
        </div>
        {accounts.data && sorted.length > 0 && addButton}
      </div>

      {platforms.error && !platforms.data && (
        <div className="alert alert-warn row-between" role="alert">
          <span>Couldn't load the platform list: {platforms.error}</span>
          <Button size="sm" onClick={platforms.reload} loading={platforms.loading}>
            Retry
          </Button>
        </div>
      )}

      {body}

      <AddAccountModal
        open={adding !== null}
        platforms={platforms.data}
        apps={apps.data}
        initialPlatform={adding?.platform ?? null}
        onClose={() => setAdding(null)}
        onCreated={(acc) => {
          setAdding(null);
          upsert(acc);
          void beginConnect(acc);
        }}
      />

      {flow && (
        <ConnectModal
          key={flow.account.id}
          account={flow.account}
          info={infoById.get(flow.account.platform)}
          state={flow.state}
          onRestart={() => void beginConnect(flow.account)}
          onConnected={connected}
          onClose={closeFlow}
        />
      )}

      <RenameModal account={renaming} onClose={() => setRenaming(null)} onSaved={upsert} />
    </div>
  );
}

interface AccountRowProps {
  account: Account;
  info: PlatformInfo | undefined;
  appMissing: boolean;
  linked: number;
  connecting: boolean;
  checking: boolean;
  onConnect: () => void;
  onCheck: () => void;
  onRename: () => void;
  onDelete: () => Promise<void>;
}

function AccountRow({ account, info, appMissing, linked, connecting, checking, onConnect, onCheck, onRename, onDelete }: AccountRowProps) {
  const meta = ACCOUNT_STATUS_META[account.status];
  const canConnect = !!info && info.connectMethod !== 'none';
  const messageClass = account.status === 'error' ? 'item-error' : account.status === 'needs-login' ? 'item-warn' : undefined;
  return (
    <li className="item-row">
      <div className="item-main">
        <PlatformBadge platform={account.platform} />
        <div className="item-text">
          <div className="item-title">
            <span>{account.label}</span>
            <Badge tone={meta.tone} dot>
              {meta.label}
            </Badge>
            {info?.experimental && <Badge tone="warn">Experimental</Badge>}
          </div>
          <div className="item-sub">
            <span>{info?.name ?? platformName(account.platform)}</span>
            {linked > 0 && <span>Used by {plural(linked, 'destination')}</span>}
            {account.statusMessage && <span className={messageClass}>{account.statusMessage}</span>}
            {!info && <span className="item-warn">Platform not available on this server</span>}
            {appMissing && (
              <span className="item-warn">
                Developer app not set up: <Link to="/settings?tab=apps">set it up</Link>
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="item-actions">
        <Button size="sm" variant={account.status === 'connected' ? 'secondary' : 'primary'} loading={connecting} onClick={onConnect} disabled={!canConnect}>
          {connectLabel(account.status)}
        </Button>
        <Button size="sm" loading={checking} onClick={onCheck} disabled={!info} title="Check that the login still works">
          Check
        </Button>
        <Button size="sm" variant="ghost" onClick={onRename}>
          Rename
        </Button>
        <ConfirmButton
          size="sm"
          variant="ghost"
          confirmLabel={deleteConfirmLabel(linked)}
          title={linked > 0 ? `Deleting this account unlinks ${plural(linked, 'destination')}` : undefined}
          onConfirm={onDelete}
        >
          Delete
        </ConfirmButton>
      </div>
    </li>
  );
}

function RenameModal({ account, onClose, onSaved }: { account: Account | null; onClose: () => void; onSaved: (a: Account) => void }) {
  return (
    <Modal open={account !== null} onClose={onClose} title="Rename account" size="sm">
      {account && <RenameForm account={account} onClose={onClose} onSaved={onSaved} />}
    </Modal>
  );
}

function RenameForm({ account, onClose, onSaved }: { account: Account; onClose: () => void; onSaved: (a: Account) => void }) {
  const [label, setLabel] = useState(account.label);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const trimmed = label.trim();
    if (!trimmed) return setError('Enter a name.');
    if (trimmed.length > MAX_ACCOUNT_LABEL) return setError(`Use at most ${MAX_ACCOUNT_LABEL} characters.`);
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.updateAccount(account.id, { label: trimmed }));
      toast.success('Account renamed.');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
      <Field label="Name" error={error ?? undefined}>
        <TextInput value={label} maxLength={MAX_ACCOUNT_LABEL} autoFocus autoComplete="off" onValueChange={setLabel} />
      </Field>
      <div className="form-actions is-end">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy}>
          Save
        </Button>
      </div>
    </form>
  );
}
