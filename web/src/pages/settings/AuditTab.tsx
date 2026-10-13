import { useState } from 'react';
import type { AuditEntry } from '@shared/types';
import { api } from '../../api';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { formatDateTime } from '../../components/format';
import { Spinner } from '../../components/Spinner';
import { toast } from '../../components/Toast';
import { errorMessage } from '../../state/errors';
import { useApi } from '../../state/hooks';
import { appendAudit, AUDIT_PAGE_SIZE, auditCursor } from './settings-helpers';

export function AuditTab() {
  const first = useApi(() => api.audit(AUDIT_PAGE_SIZE), []);
  const [older, setOlder] = useState<AuditEntry[]>([]);
  const [hasMore, setHasMore] = useState<boolean | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const entries = first.data ? appendAudit(first.data, older) : [];
  const more = hasMore ?? (first.data ? first.data.length >= AUDIT_PAGE_SIZE : false);

  const refresh = () => {
    setOlder([]);
    setHasMore(null);
    first.reload();
  };

  const loadMore = async () => {
    const before = auditCursor(entries);
    if (before === undefined || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.audit(AUDIT_PAGE_SIZE, before);
      setOlder((prev) => appendAudit(prev, page));
      setHasMore(page.length >= AUDIT_PAGE_SIZE);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  let body;
  if (!first.data) {
    body = first.error ? (
      <EmptyState
        title="Couldn't load the audit log"
        description={first.error}
        action={
          <Button onClick={first.reload} loading={first.loading}>
            Try again
          </Button>
        }
      />
    ) : (
      <div className="row muted list-empty">
        <Spinner size="sm" /> Loading…
      </div>
    );
  } else if (entries.length === 0) {
    body = <p className="list-empty">Nothing recorded yet.</p>;
  } else {
    body = (
      <>
        <div className="table-wrap">
          <table className="data-table is-stacked">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">User</th>
                <th scope="col">Action</th>
                <th scope="col">Detail</th>
                <th scope="col">IP</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{formatDateTime(e.ts, '—')}</td>
                  <td data-label="User">{e.username ?? <span className="faint">system</span>}</td>
                  <td data-label="Action" className="cell-mono">
                    {e.action}
                  </td>
                  <td data-label="Detail" className="cell-wrap">
                    {e.detail ?? ''}
                  </td>
                  <td data-label="IP" className="cell-mono">
                    {e.ip ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {more && (
          <div className="row" style={{ justifyContent: 'center', padding: 14 }}>
            <Button onClick={() => void loadMore()} loading={loadingMore}>
              Load more
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <Card
      title="Audit log"
      subtitle="Sign-ins, account and destination changes, go-live actions and settings changes. Newest first."
      actions={
        <Button size="sm" variant="ghost" onClick={refresh} loading={first.loading && !!first.data}>
          Refresh
        </Button>
      }
      flush
    >
      <div style={{ marginTop: 10 }}>{body}</div>
    </Card>
  );
}
