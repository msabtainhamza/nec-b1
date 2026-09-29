import { useState, type KeyboardEvent } from 'react';
import type { SessionUser, TenantSummary } from '@nec/contracts';
import { Banner, Button, FormWindow, StatusBadge } from '@nec/ui';
import { errorMessage } from '../api';

export function TenantChooser({
  user,
  tenants,
  onSelected,
  onLogout,
}: {
  user: SessionUser;
  tenants: TenantSummary[];
  onSelected: (tenant: TenantSummary) => void;
  onLogout: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(tenants[0]?.tenantId ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (tenantId: string | null) => {
    if (busy || !tenantId) {
      return;
    }
    setBusy(true);
    setError(null);
    const result = await window.erp.selectTenant(tenantId);
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    onSelected(result.body);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTableSectionElement>) => {
    const index = tenants.findIndex((tenant) => tenant.tenantId === selectedId);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedId(tenants[Math.min(index + 1, tenants.length - 1)]?.tenantId ?? selectedId);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedId(tenants[Math.max(index - 1, 0)]?.tenantId ?? selectedId);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void choose(selectedId);
    }
  };

  return (
    <main className="dialog-layout">
      <FormWindow
        title="Choose Company"
        width={620}
        footerLeft={
          <>
            <Button variant="primary" busy={busy} disabled={!selectedId} onClick={() => choose(selectedId)}>
              OK
            </Button>
            <Button onClick={onLogout}>Cancel</Button>
          </>
        }
      >
        <div className="dialog-product">
          <span>
            Current user: <strong>{user.displayName}</strong>
          </span>
          <span className="ui-muted">{user.email}</span>
        </div>
        {error ? <Banner>{error}</Banner> : null}
        {tenants.length === 0 ? (
          <Banner tone="info">You are not an active member of any company. Ask an administrator for an invitation.</Banner>
        ) : (
          <div className="ui-table-wrap">
            <table className="ui-table company-grid" aria-label="Companies">
              <thead>
                <tr>
                  <th scope="col">Company Name</th>
                  <th scope="col">Company Code</th>
                  <th scope="col">Subscription</th>
                  <th scope="col">Access</th>
                </tr>
              </thead>
              <tbody tabIndex={0} onKeyDown={onKeyDown}>
                {tenants.map((tenant) => (
                  <tr
                    key={tenant.tenantId}
                    aria-selected={tenant.tenantId === selectedId}
                    onClick={() => setSelectedId(tenant.tenantId)}
                    onDoubleClick={() => choose(tenant.tenantId)}
                  >
                    <td>{tenant.displayName}</td>
                    <td>{tenant.code}</td>
                    <td>
                      <StatusBadge status={tenant.subscriptionState} />
                    </td>
                    <td>{tenant.accessMode === 'restricted_export' ? 'Read-only' : 'Full'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="ui-muted">Double-click a company, or use the arrow keys and Enter.</p>
      </FormWindow>
    </main>
  );
}
