import { useEffect, useState } from 'react';
import type { AuditEvent, Page } from '@nec/contracts';
import { Banner, Button, DataTable, FormWindow, StatusBadge } from '@nec/ui';
import { errorMessage } from '../api';
import type { ApiCall } from '../screens/Shell';

const PAGE_SIZE = 25;

export function AuditLogForm({ call, onClose }: { call: ApiCall; onClose: () => void }) {
  const [page, setPage] = useState<Page<AuditEvent> | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void call<Page<AuditEvent>>('GET', `/v1/tenant/audit-events?limit=${PAGE_SIZE}&offset=${offset}`).then((result) => {
      if (result.ok) {
        setPage(result.body);
      } else {
        setError(errorMessage(result));
      }
    });
  }, [call, offset]);

  const last = page ? Math.max(0, Math.floor((page.total - 1) / PAGE_SIZE) * PAGE_SIZE) : 0;

  return (
    <FormWindow
      title="Audit Log"
      onClose={onClose}
      footerLeft={
        <Button variant="primary" onClick={onClose}>
          OK
        </Button>
      }
      footerRight={
        <div className="pager">
          <Button disabled={offset === 0} onClick={() => setOffset(0)} aria-label="First page">
            |◀
          </Button>
          <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} aria-label="Previous page">
            ◀
          </Button>
          <span className="ui-muted">
            {page ? `${page.total === 0 ? 0 : offset + 1}–${Math.min(offset + PAGE_SIZE, page.total)} of ${page.total}` : ''}
          </span>
          <Button disabled={!page || offset >= last} onClick={() => setOffset(offset + PAGE_SIZE)} aria-label="Next page">
            ▶
          </Button>
          <Button disabled={!page || offset >= last} onClick={() => setOffset(last)} aria-label="Last page">
            ▶|
          </Button>
        </div>
      }
    >
      {error ? <Banner>{error}</Banner> : null}
      <DataTable
        rowNumbers
        loading={!page && !error}
        rows={page?.items ?? []}
        rowKey={(row) => row.id}
        empty="No audit events."
        columns={[
          { key: 'time', header: 'Date and Time', render: (row) => new Date(row.occurredAt).toLocaleString() },
          { key: 'action', header: 'Action', render: (row) => row.action },
          { key: 'entity', header: 'Object', render: (row) => row.entityType },
          { key: 'actor', header: 'Performed By', render: (row) => row.actorType },
          { key: 'outcome', header: 'Outcome', render: (row) => <StatusBadge status={row.outcome} /> },
        ]}
      />
    </FormWindow>
  );
}
