import { useState, type FormEvent } from 'react';
import type { Role, User } from '@shared/types';
import { api } from '../../api';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ConfirmButton } from '../../components/ConfirmButton';
import { EmptyState } from '../../components/EmptyState';
import { Field } from '../../components/Field';
import { formatDateTime } from '../../components/format';
import { Modal } from '../../components/Modal';
import { Select } from '../../components/Select';
import { Spinner } from '../../components/Spinner';
import { TextInput } from '../../components/TextInput';
import { toast } from '../../components/Toast';
import { useAuth } from '../../state/auth';
import { errorMessage } from '../../state/errors';
import { useApi } from '../../state/hooks';
import { hasErrors, PASSWORD_MAX, PASSWORD_MIN, validateNewUser, validatePassword } from './settings-helpers';

export const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'operator', label: 'Operator' },
];

const ROLE_HELP = 'Admins manage everything. Operators can go live, change the title, toggle destinations and read chat.';

export function UsersTab() {
  const { user: me, refresh } = useAuth();
  const users = useApi(() => api.users(), []);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const replace = (u: User) => users.setData((list) => list?.map((x) => (x.id === u.id ? u : x)));

  const changeRole = async (u: User, role: Role) => {
    if (role === u.role) return;
    setBusy(u.id);
    try {
      replace(await api.updateUser(u.id, { role }));
      toast.success(`${u.username} is now ${role === 'admin' ? 'an admin' : 'an operator'}.`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const resetTotp = async (u: User) => {
    try {
      replace(await api.updateUser(u.id, { resetTotp: true }));
      toast.success(`Two-factor authentication turned off for ${u.username}.`);
      if (u.id === me?.id) await refresh().catch(() => undefined);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const remove = async (u: User) => {
    try {
      await api.deleteUser(u.id);
      users.setData((list) => list?.filter((x) => x.id !== u.id));
      toast.success(`${u.username} deleted.`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  let body;
  if (!users.data) {
    body = users.error ? (
      <EmptyState
        title="Couldn't load users"
        description={users.error}
        action={
          <Button onClick={users.reload} loading={users.loading}>
            Try again
          </Button>
        }
      />
    ) : (
      <div className="row muted list-empty">
        <Spinner size="sm" /> Loading users…
      </div>
    );
  } else {
    body = (
      <ul className="item-list">
        {users.data.map((u) => {
          const isMe = u.id === me?.id;
          return (
            <li key={u.id} className="item-row">
              <div className="item-main">
                <span className="user-avatar" aria-hidden="true">
                  {u.username.charAt(0)}
                </span>
                <div className="item-text">
                  <div className="item-title">
                    <span>{u.username}</span>
                    {isMe && <Badge tone="accent">You</Badge>}
                    <Badge tone={u.totpEnabled ? 'success' : 'neutral'}>{u.totpEnabled ? '2FA on' : '2FA off'}</Badge>
                  </div>
                  <div className="item-sub">
                    <span>Last sign-in: {formatDateTime(u.lastLoginAt)}</span>
                  </div>
                </div>
              </div>
              <div className="item-actions">
                <Select
                  className="role-select"
                  aria-label={`Role of ${u.username}`}
                  title={isMe ? "You can't change your own role" : undefined}
                  options={ROLE_OPTIONS}
                  value={u.role}
                  onValueChange={(v) => void changeRole(u, v === 'admin' ? 'admin' : 'operator')}
                  disabled={isMe || busy === u.id}
                />
                <Button size="sm" onClick={() => setResetting(u)}>
                  Reset password
                </Button>
                {u.totpEnabled && (
                  <ConfirmButton size="sm" variant="ghost" confirmLabel="Turn off 2FA?" onConfirm={() => resetTotp(u)}>
                    Reset 2FA
                  </ConfirmButton>
                )}
                <ConfirmButton
                  size="sm"
                  variant="ghost"
                  confirmLabel="Delete user?"
                  onConfirm={() => remove(u)}
                  disabled={isMe}
                  title={isMe ? "You can't delete your own account" : undefined}
                >
                  Delete
                </ConfirmButton>
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <Card
      title="Users"
      subtitle={ROLE_HELP}
      actions={
        <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
          Add user
        </Button>
      }
      flush
    >
      <div style={{ marginTop: 10 }}>{body}</div>
      <Modal open={creating} onClose={() => setCreating(false)} title="Add a user" size="sm">
        <CreateUserForm
          onClose={() => setCreating(false)}
          onCreated={(u) => {
            users.setData((list) => [...(list ?? []), u]);
            setCreating(false);
            toast.success(`${u.username} added.`);
          }}
        />
      </Modal>
      <Modal open={resetting !== null} onClose={() => setResetting(null)} title={`Reset password${resetting ? ` for ${resetting.username}` : ''}`} size="sm">
        {resetting && <ResetPasswordForm user={resetting} isMe={resetting.id === me?.id} onClose={() => setResetting(null)} />}
      </Modal>
    </Card>
  );
}

function CreateUserForm({ onClose, onCreated }: { onClose: () => void; onCreated: (u: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [role, setRole] = useState<Role>('operator');
  const [errors, setErrors] = useState<{ username?: string; password?: string; confirm?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const v = validateNewUser({ username, password, confirm });
    setErrors(v);
    setFormError(null);
    if (hasErrors(v)) return;
    setBusy(true);
    try {
      onCreated(await api.createUser({ username: username.trim(), password, role }));
    } catch (err) {
      setFormError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
      <Field label="Username" error={errors.username} required>
        <TextInput value={username} autoFocus autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={32} onValueChange={setUsername} />
      </Field>
      <Field label="Password" error={errors.password} required help={`At least ${PASSWORD_MIN} characters. Share it with the person securely.`}>
        <TextInput type="password" autoComplete="new-password" maxLength={PASSWORD_MAX} value={password} onValueChange={setPassword} />
      </Field>
      <Field label="Confirm password" error={errors.confirm} required>
        <TextInput type="password" autoComplete="new-password" maxLength={PASSWORD_MAX} value={confirm} onValueChange={setConfirm} />
      </Field>
      <Field label="Role" help={ROLE_HELP}>
        <Select options={ROLE_OPTIONS} value={role} onValueChange={(v) => setRole(v === 'admin' ? 'admin' : 'operator')} />
      </Field>
      {formError && (
        <div className="alert alert-danger" role="alert">
          {formError}
        </div>
      )}
      <div className="form-actions is-end">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy}>
          Add user
        </Button>
      </div>
    </form>
  );
}

function ResetPasswordForm({ user, isMe, onClose }: { user: User; isMe: boolean; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const v = validatePassword(password, confirm);
    setErrors(v);
    setFormError(null);
    if (hasErrors(v)) return;
    setBusy(true);
    try {
      await api.updateUser(user.id, { password });
      toast.success(isMe ? 'Password changed. Your other sessions were signed out.' : `Password reset. ${user.username} was signed out everywhere.`);
      onClose();
    } catch (err) {
      setFormError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
      {/* Lets password managers attach the new password to the right user. */}
      <input type="text" name="username" autoComplete="username" value={user.username} readOnly hidden />
      <p className="muted small">This also clears a sign-in lockout and signs {isMe ? 'your other sessions' : 'the user'} out everywhere.</p>
      <Field label="New password" error={errors.password} help={`At least ${PASSWORD_MIN} characters.`}>
        <TextInput type="password" autoComplete="new-password" autoFocus maxLength={PASSWORD_MAX} value={password} onValueChange={setPassword} />
      </Field>
      <Field label="Confirm new password" error={errors.confirm}>
        <TextInput type="password" autoComplete="new-password" maxLength={PASSWORD_MAX} value={confirm} onValueChange={setConfirm} />
      </Field>
      {formError && (
        <div className="alert alert-danger" role="alert">
          {formError}
        </div>
      )}
      <div className="form-actions is-end">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy}>
          Reset password
        </Button>
      </div>
    </form>
  );
}
