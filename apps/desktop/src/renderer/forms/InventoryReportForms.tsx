import { Fragment, useEffect, useState, type FormEvent } from 'react';
import type { InventoryStatusReport, InventoryValuationReport, ItemGroup, Warehouse } from '@nec/contracts';
import { Banner, Button, FormWindow } from '@nec/ui';
import { errorMessage } from '../api';
import { formatAmount, today } from '../format';
import type { ApiCall } from '../screens/Shell';
import { BYTE_ORDER_MARK, csvCell } from './ReportForms';

const trim = (value: string) => (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value);
const csv = (rows: (string | number)[][]) => `${BYTE_ORDER_MARK}${rows.map((row) => row.join(',')).join('\r\n')}\r\n`;

function useFilters(call: ApiCall) {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [groups, setGroups] = useState<ItemGroup[]>([]);
  useEffect(() => {
    void Promise.all([call<Warehouse[]>('GET', '/v1/inv/warehouses'), call<ItemGroup[]>('GET', '/v1/inv/item-groups')]).then(([w, g]) => {
      if (w.ok) setWarehouses(w.body);
      if (g.ok) setGroups(g.body);
    });
  }, [call]);
  return { warehouses, groups };
}

function FilterSelects({
  warehouses,
  groups,
  warehouseId,
  groupId,
  onWarehouse,
  onGroup,
}: {
  warehouses: Warehouse[];
  groups: ItemGroup[];
  warehouseId: string;
  groupId: string;
  onWarehouse: (value: string) => void;
  onGroup: (value: string) => void;
}) {
  return (
    <>
      <label className="ui-field">
        <span>Warehouse</span>
        <select className="grid-input" aria-label="Warehouse" value={warehouseId} onChange={(e) => onWarehouse(e.target.value)}>
          <option value="">All warehouses</option>
          {warehouses.map((warehouse) => (
            <option key={warehouse.id} value={warehouse.id}>
              {warehouse.code} - {warehouse.name}
            </option>
          ))}
        </select>
      </label>
      <label className="ui-field">
        <span>Item Group</span>
        <select className="grid-input" aria-label="Item group" value={groupId} onChange={(e) => onGroup(e.target.value)}>
          <option value="">All groups</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.code} - {group.name}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

export function InventoryStatusForm({ call, initialBelowOnly = false, onClose }: { call: ApiCall; initialBelowOnly?: boolean; onClose: () => void }) {
  const { warehouses, groups } = useFilters(call);
  const [warehouseId, setWarehouseId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [search, setSearch] = useState('');
  const [belowOnly, setBelowOnly] = useState(initialBelowOnly);
  const [report, setReport] = useState<InventoryStatusReport | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (event?: FormEvent) => {
    event?.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    const params = new URLSearchParams();
    if (warehouseId) params.set('warehouseId', warehouseId);
    if (groupId) params.set('itemGroupId', groupId);
    if (search.trim()) params.set('search', search.trim());
    if (belowOnly) params.set('belowReorderPoint', 'true');
    const query = params.toString();
    const result = await call<InventoryStatusReport>('GET', `/v1/inv/reports/inventory-status${query ? `?${query}` : ''}`);
    setBusy(false);
    if (result.ok) {
      setReport(result.body);
      setExpanded(new Set());
    } else setError(errorMessage(result));
  };

  const exportCsv = async () => {
    if (!report) return;
    const rows: (string | number)[][] = [
      ['Company', csvCell(report.tenantName)],
      ['Generated', report.generatedAt],
      [],
      ['Item', 'Description', 'Warehouse', 'In Stock', 'Committed', 'Ordered', 'Available', 'Reorder Point', 'Below Reorder Point'],
    ];
    for (const item of report.items) {
      rows.push([csvCell(item.itemCode), csvCell(item.itemName), 'All', item.onHand, item.committed, item.ordered, item.available, item.reorderPoint ?? '', item.belowReorderPoint ? 'Yes' : 'No']);
      for (const warehouse of item.warehouses) rows.push([csvCell(item.itemCode), '', csvCell(warehouse.warehouseCode), warehouse.onHand, warehouse.committed, warehouse.ordered, warehouse.available, '', '']);
    }
    const result = await window.erp.saveTextFile(`Inventory Status ${today()}.csv`, csv(rows));
    if (result.saved) setNotice('Report exported.');
  };

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  useEffect(() => {
    if (initialBelowOnly) void run();
  }, [initialBelowOnly]);

  return (
    <FormWindow
      title="Inventory Status"
      width={980}
      onClose={onClose}
      footerLeft={
        <Button type="button" variant="primary" onClick={onClose}>
          OK
        </Button>
      }
      footerRight={
        report ? (
          <Button type="button" onClick={() => void exportCsv()}>
            Export to CSV
          </Button>
        ) : null
      }
    >
      <form onSubmit={run} className="inline-fields" noValidate>
        <FilterSelects warehouses={warehouses} groups={groups} warehouseId={warehouseId} groupId={groupId} onWarehouse={setWarehouseId} onGroup={setGroupId} />
        <label className="ui-field">
          <span>Item</span>
          <input className="grid-input" aria-label="Item search" value={search} maxLength={100} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label className="flag-row">
          <input type="checkbox" checked={belowOnly} onChange={(e) => setBelowOnly(e.target.checked)} /> At or below reorder point only
        </label>
        <Button type="submit" variant="primary" busy={busy}>
          Run
        </Button>
      </form>
      {error ? <Banner>{error}</Banner> : null}
      {notice ? <Banner tone="info">{notice}</Banner> : null}
      {report ? (
        <>
          <p className="ui-muted">
            {report.tenantName} · generated {new Date(report.generatedAt).toLocaleString()} · Available = In Stock − Committed + Ordered
          </p>
          <div className="ui-table-wrap">
            <table className="ui-table" aria-label="Inventory Status">
              <thead>
                <tr>
                  <th>Item No.</th>
                  <th>Description</th>
                  <th>Group</th>
                  <th className="numeric">In Stock</th>
                  <th className="numeric">Committed</th>
                  <th className="numeric">Ordered</th>
                  <th className="numeric">Available</th>
                  <th className="numeric">Reorder Point</th>
                </tr>
              </thead>
              <tbody>
                {report.items.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="ui-muted">
                      No inventory items match these filters.
                    </td>
                  </tr>
                ) : null}
                {report.items.map((item) => (
                  <Fragment key={item.itemId}>
                    <tr className={item.belowReorderPoint ? 'group-row row-warning' : 'group-row'}>
                      <td>
                        <Button type="button" variant="ghost" aria-expanded={expanded.has(item.itemId)} aria-label={`Show warehouses for ${item.itemCode}`} onClick={() => toggle(item.itemId)}>
                          {expanded.has(item.itemId) ? '−' : '+'}
                        </Button>{' '}
                        {item.itemCode}
                      </td>
                      <td>{item.itemName}</td>
                      <td>{item.itemGroupCode}</td>
                      <td className="numeric">
                        {trim(item.onHand)} {item.uomCode}
                      </td>
                      <td className="numeric">{trim(item.committed)}</td>
                      <td className="numeric">{trim(item.ordered)}</td>
                      <td className="numeric">{trim(item.available)}</td>
                      <td className="numeric">
                        {item.reorderPoint === null ? '' : trim(item.reorderPoint)}
                        {item.belowReorderPoint ? ' ⚠' : ''}
                      </td>
                    </tr>
                    {expanded.has(item.itemId)
                      ? item.warehouses.map((warehouse) => (
                          <tr key={`${item.itemId}-${warehouse.warehouseId}`}>
                            <td className="indent-cell">Warehouse {warehouse.warehouseCode}</td>
                            <td colSpan={2} />
                            <td className="numeric">{trim(warehouse.onHand)}</td>
                            <td className="numeric">{trim(warehouse.committed)}</td>
                            <td className="numeric">{trim(warehouse.ordered)}</td>
                            <td className="numeric">{trim(warehouse.available)}</td>
                            <td />
                          </tr>
                        ))
                      : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </FormWindow>
  );
}

export function InventoryValuationForm({ call, onClose }: { call: ApiCall; onClose: () => void }) {
  const { warehouses, groups } = useFilters(call);
  const [asOf, setAsOf] = useState(today());
  const [warehouseId, setWarehouseId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [report, setReport] = useState<InventoryValuationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (event?: FormEvent) => {
    event?.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    const params = new URLSearchParams({ asOf });
    if (warehouseId) params.set('warehouseId', warehouseId);
    if (groupId) params.set('itemGroupId', groupId);
    const result = await call<InventoryValuationReport>('GET', `/v1/inv/reports/inventory-valuation?${params.toString()}`);
    setBusy(false);
    if (result.ok) setReport(result.body);
    else setError(errorMessage(result));
  };

  const exportCsv = async () => {
    if (!report) return;
    const rows: (string | number)[][] = [
      ['Company', csvCell(report.tenantName)],
      ['As of', report.asOf],
      ['Currency', report.currency],
      ['Generated', report.generatedAt],
      [],
      ['Item', 'Description', 'Warehouse', 'Inventory Account', 'Quantity', 'Value', 'Average Cost'],
      ...report.rows.map((row) => [csvCell(row.itemCode), csvCell(row.itemName), csvCell(row.warehouseCode), csvCell(row.accountCode), row.quantity, row.value, row.averageCost]),
      ['Total', '', '', '', report.totalQuantity, report.totalValue, ''],
    ];
    if (report.accounts.length > 0) {
      rows.push([], ['Account', 'Name', 'Stock Value', 'Ledger Balance', 'Difference'], ...report.accounts.map((account) => [csvCell(account.accountCode), csvCell(account.accountName), account.stockValue, account.ledgerBalance, account.difference]));
    }
    const result = await window.erp.saveTextFile(`Inventory Valuation ${report.asOf}.csv`, csv(rows));
    if (result.saved) setNotice('Report exported.');
  };

  return (
    <FormWindow
      title="Inventory Valuation"
      width={980}
      onClose={onClose}
      footerLeft={
        <Button type="button" variant="primary" onClick={onClose}>
          OK
        </Button>
      }
      footerRight={
        report ? (
          <Button type="button" onClick={() => void exportCsv()}>
            Export to CSV
          </Button>
        ) : null
      }
    >
      <form onSubmit={run} className="inline-fields" noValidate>
        <label className="ui-field">
          <span>As of Date</span>
          <input className="grid-input" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>
        <FilterSelects warehouses={warehouses} groups={groups} warehouseId={warehouseId} groupId={groupId} onWarehouse={setWarehouseId} onGroup={setGroupId} />
        <Button type="submit" variant="primary" busy={busy}>
          Run
        </Button>
      </form>
      {error ? <Banner>{error}</Banner> : null}
      {notice ? <Banner tone="info">{notice}</Banner> : null}
      {report ? (
        <>
          <p className="ui-muted">
            {report.tenantName} · as of {report.asOf} · {report.currency} · moving average · generated {new Date(report.generatedAt).toLocaleString()}
          </p>
          <div className="ui-table-wrap">
            <table className="ui-table" aria-label="Inventory Valuation">
              <thead>
                <tr>
                  <th>Item No.</th>
                  <th>Description</th>
                  <th>Whse</th>
                  <th>Inventory Account</th>
                  <th className="numeric">Quantity</th>
                  <th className="numeric">Value</th>
                  <th className="numeric">Average Cost</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="ui-muted">
                      No stock on this date.
                    </td>
                  </tr>
                ) : null}
                {report.rows.map((row) => (
                  <tr key={`${row.itemId}-${row.warehouseCode}`}>
                    <td>{row.itemCode}</td>
                    <td>{row.itemName}</td>
                    <td>{row.warehouseCode}</td>
                    <td>{row.accountCode}</td>
                    <td className="numeric">{trim(row.quantity)}</td>
                    <td className="numeric">{formatAmount(row.value)}</td>
                    <td className="numeric">{trim(row.averageCost)}</td>
                  </tr>
                ))}
                <tr className="totals-row">
                  <td colSpan={4}>Total</td>
                  <td className="numeric">{trim(report.totalQuantity)}</td>
                  <td className="numeric">{formatAmount(report.totalValue)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
          {report.filtered ? (
            <p className="ui-muted">The general ledger reconciliation is shown only when the report is not filtered by warehouse or item group.</p>
          ) : (
            <>
              <div className="form-section">Reconciliation with the General Ledger</div>
              <div className="ui-table-wrap">
                <table className="ui-table" aria-label="Inventory account reconciliation">
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Name</th>
                      <th className="numeric">Stock Value</th>
                      <th className="numeric">Ledger Balance</th>
                      <th className="numeric">Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.accounts.map((account) => (
                      <tr key={account.accountId} className={account.difference !== '0.0000' ? 'row-warning' : undefined}>
                        <td>{account.accountCode}</td>
                        <td>{account.accountName}</td>
                        <td className="numeric">{formatAmount(account.stockValue)}</td>
                        <td className="numeric">{formatAmount(account.ledgerBalance)}</td>
                        <td className="numeric">{formatAmount(account.difference)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="ui-muted">
                A difference means the inventory account received postings that are not stock movements, such as manual journal entries, or that account mappings changed after posting.
              </p>
            </>
          )}
        </>
      ) : null}
    </FormWindow>
  );
}
