import { useEffect, useState, type FormEvent } from 'react';
import type { ItemStock, ItemSummary, Page, StockMovement } from '@nec/contracts';
import { Banner, Button, DataTable, FormWindow } from '@nec/ui';
import { errorMessage } from '../api';
import { formatAmount } from '../format';
import type { ApiCall } from '../screens/Shell';

const SOURCE_LABELS: Record<string, string> = {
  goods_receipt: 'Goods Receipt PO',
  goods_receipt_cancellation: 'Goods Receipt Cancellation',
  ap_invoice: 'A/P Invoice',
  ap_invoice_cancellation: 'A/P Invoice Cancellation',
  stock_transfer: 'Inventory Transfer',
  stock_transfer_cancellation: 'Inventory Transfer Cancellation',
  inventory_adjustment: 'Goods Receipt / Issue',
  inventory_adjustment_cancellation: 'Goods Receipt / Issue Cancellation',
  inventory_opening_balance: 'Inventory Opening Balance',
  delivery: 'Delivery',
  delivery_cancellation: 'Delivery Cancellation',
  inventory_opening_balance_cancellation: 'Inventory Opening Balance Cancellation',
};

function quantity(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

export function InventoryAuditForm({ call, onClose }: { call: ApiCall; onClose: () => void }) {
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [itemId, setItemId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState<Page<StockMovement> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void call<Page<ItemSummary>>('GET', '/v1/inv/items?itemType=inventory&limit=200').then((result) => {
      if (result.ok) setItems(result.body.items);
    });
  }, [call]);

  const run = async (event?: FormEvent) => {
    event?.preventDefault();
    const query = new URLSearchParams({ limit: '500' });
    if (itemId) query.set('itemId', itemId);
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    const result = await call<Page<StockMovement>>('GET', `/v1/inv/stock-movements?${query.toString()}`);
    if (result.ok) {
      setPage(result.body);
      setError(null);
    } else {
      setError(errorMessage(result));
    }
  };

  return (
    <FormWindow title="Inventory Audit Report" onClose={onClose} footerLeft={<Button type="button" variant="primary" onClick={onClose}>OK</Button>}>
      <form onSubmit={run} className="inline-fields inline-fields--four" noValidate>
        <label className="ui-field">
          <span>Item</span>
          <select className="grid-input" value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">All items</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.code} - {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="ui-field">
          <span>From</span>
          <input className="grid-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="ui-field">
          <span>To</span>
          <input className="grid-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <Button type="submit" variant="primary">
          Run
        </Button>
      </form>
      {error ? <Banner>{error}</Banner> : null}
      {page ? (
        <DataTable
          rowNumbers
          rows={page.items}
          rowKey={(row) => row.id}
          empty="No stock movements."
          columns={[
            { key: 'date', header: 'Posting Date', render: (row) => row.postingDate },
            { key: 'doc', header: 'Document', render: (row) => `${SOURCE_LABELS[row.sourceType] ?? row.sourceType} ${row.sourceNumber ?? ''}` },
            { key: 'item', header: 'Item', render: (row) => `${row.itemCode} - ${row.itemName}` },
            { key: 'whse', header: 'Whse', render: (row) => row.warehouseCode },
            { key: 'qty', header: 'Quantity', render: (row) => <span className="numeric">{quantity(row.quantity)}</span> },
            { key: 'cost', header: 'Unit Cost', render: (row) => <span className="numeric">{formatAmount(row.unitCost)}</span> },
            { key: 'value', header: 'Value', render: (row) => <span className="numeric">{formatAmount(row.value)}</span> },
          ]}
        />
      ) : (
        <p className="ui-muted">Choose filters and select Run. Movements are permanent; corrections appear as separate reversing movements.</p>
      )}
    </FormWindow>
  );
}

export function ItemStockPanel({ call, itemId }: { call: ApiCall; itemId: string }) {
  const [stock, setStock] = useState<ItemStock | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void call<ItemStock>('GET', `/v1/inv/items/${itemId}/stock`).then((result) => {
      if (result.ok) setStock(result.body);
      else setError(errorMessage(result));
    });
  }, [call, itemId]);

  if (error) return <Banner>{error}</Banner>;
  if (!stock) return <p className="ui-muted">Loading stock…</p>;
  return (
    <>
      <div className="ui-table-wrap">
        <table className="ui-table">
          <thead>
            <tr>
              <th>Whse Code</th>
              <th>Whse Name</th>
              <th className="numeric">In Stock</th>
              <th className="numeric">Committed</th>
              <th className="numeric">Ordered</th>
            </tr>
          </thead>
          <tbody>
            {stock.warehouses.map((row) => (
              <tr key={row.warehouseId}>
                <td>{row.warehouseCode}</td>
                <td>{row.warehouseName}</td>
                <td className="numeric">{quantity(row.onHand)}</td>
                <td className="numeric">0</td>
                <td className="numeric">{quantity(row.onOrder)}</td>
              </tr>
            ))}
            <tr className="totals-row">
              <td colSpan={2}>Total</td>
              <td className="numeric">{quantity(stock.onHand)}</td>
              <td className="numeric">{quantity(stock.committed)}</td>
              <td className="numeric">{quantity(stock.onOrder)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="ui-muted">
        Available {quantity(stock.available)} · Moving average cost {formatAmount(stock.averageCost)} · Stock value {formatAmount(stock.totalValue)}. Committed quantities appear once sales orders exist.
      </p>
    </>
  );
}
