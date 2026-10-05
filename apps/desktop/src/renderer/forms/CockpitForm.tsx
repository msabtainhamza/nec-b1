import { useCallback, useEffect, useState } from 'react';
import type { Dashboard, DashboardCount } from '@nec/contracts';
import { Banner, Button, FormWindow } from '@nec/ui';
import { errorMessage } from '../api';
import { formatAmount } from '../format';
import type { ApiCall } from '../screens/Shell';

export type CockpitTarget = 'so' | 'po' | 'araging' | 'apaging' | 'lowstock' | 'approvals';

function Tile({ title, value, detail, warning, onOpen }: { title: string; value: string; detail?: string; warning?: boolean; onOpen: () => void }) {
  return (
    <button type="button" className={warning ? 'cockpit-tile cockpit-tile--warning' : 'cockpit-tile'} onClick={onOpen}>
      <span className="cockpit-tile__title">{title}</span>
      <strong className="cockpit-tile__value">{value}</strong>
      {detail ? <span className="cockpit-tile__detail">{detail}</span> : null}
    </button>
  );
}

export function CockpitForm({ call, onOpen, onClose }: { call: ApiCall; onOpen: (target: CockpitTarget) => void; onClose: () => void }) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const result = await call<Dashboard>('GET', '/v1/tenant/dashboard');
    if (result.ok) setDashboard(result.body);
    else setError(errorMessage(result));
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const money = (count: DashboardCount) => `${formatAmount(count.amount)} ${dashboard?.currency ?? ''}`;
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const hasPeriods = dashboard?.periods.some((period) => period.sales !== null || period.purchases !== null) ?? false;
  const max = Math.max(1, ...(dashboard?.periods.flatMap((period) => [Number(period.sales ?? 0), Number(period.purchases ?? 0)]) ?? [1]));

  return (
    <FormWindow
      title="Cockpit"
      width={900}
      onClose={onClose}
      footerLeft={
        <Button type="button" variant="primary" onClick={onClose}>
          OK
        </Button>
      }
      footerRight={
        <Button type="button" onClick={() => void load()}>
          Refresh
        </Button>
      }
    >
      {error ? <Banner>{error}</Banner> : null}
      {!dashboard ? <p className="ui-muted">Loading…</p> : null}
      {dashboard ? (
        <>
          <p className="ui-muted">As of {dashboard.asOf}. Choose a figure to open the related records.</p>
          <div className="cockpit-grid">
            {dashboard.openSalesOrders ? <Tile title="Open Sales Orders" value={plural(dashboard.openSalesOrders.count, 'order')} detail={`${money(dashboard.openSalesOrders)} still to deliver or invoice`} onOpen={() => onOpen('so')} /> : null}
            {dashboard.openPurchaseOrders ? <Tile title="Open Purchase Orders" value={plural(dashboard.openPurchaseOrders.count, 'order')} detail={`${money(dashboard.openPurchaseOrders)} still to receive`} onOpen={() => onOpen('po')} /> : null}
            {dashboard.overdueReceivables ? (
              <Tile title="Overdue Customer Invoices" value={plural(dashboard.overdueReceivables.count, 'invoice')} detail={money(dashboard.overdueReceivables)} warning={dashboard.overdueReceivables.count > 0} onOpen={() => onOpen('araging')} />
            ) : null}
            {dashboard.overduePayables ? (
              <Tile title="Overdue Vendor Invoices" value={plural(dashboard.overduePayables.count, 'invoice')} detail={money(dashboard.overduePayables)} warning={dashboard.overduePayables.count > 0} onOpen={() => onOpen('apaging')} />
            ) : null}
            {dashboard.pendingApprovals !== null ? (
              <Tile title="Pending Approvals" value={plural(dashboard.pendingApprovals, 'request')} detail="waiting for your decision" warning={dashboard.pendingApprovals > 0} onOpen={() => onOpen('approvals')} />
            ) : null}
            {dashboard.lowStockItems !== null ? (
              <Tile title="Low Stock" value={plural(dashboard.lowStockItems, 'item')} detail="at or below the reorder point" warning={dashboard.lowStockItems > 0} onOpen={() => onOpen('lowstock')} />
            ) : null}
          </div>
          {hasPeriods ? (
            <>
              <div className="form-section">Sales and Purchases by Month (before tax)</div>
              <div className="ui-table-wrap">
                <table className="ui-table" aria-label="Sales and purchases by month">
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th className="numeric">Sales ({dashboard.currency})</th>
                      <th className="numeric">Purchases ({dashboard.currency})</th>
                      <th aria-hidden="true" />
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.periods.map((period) => (
                      <tr key={period.month}>
                        <td>{period.month}</td>
                        <td className="numeric">{period.sales === null ? '' : formatAmount(period.sales)}</td>
                        <td className="numeric">{period.purchases === null ? '' : formatAmount(period.purchases)}</td>
                        <td aria-hidden="true" className="cockpit-bars">
                          {period.sales !== null ? <span className="cockpit-bar cockpit-bar--sales" style={{ width: `${(Number(period.sales) / max) * 100}%` }} /> : null}
                          {period.purchases !== null ? <span className="cockpit-bar cockpit-bar--purchases" style={{ width: `${(Number(period.purchases) / max) * 100}%` }} /> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </FormWindow>
  );
}
