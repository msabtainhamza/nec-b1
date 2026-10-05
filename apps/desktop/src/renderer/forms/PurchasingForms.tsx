import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type {
  ApprovalSubmitted,
  Branch,
  GoodsReceipt,
  GoodsReceiptSummary,
  ItemSummary,
  Page,
  PartnerSummary,
  PurchaseOrder,
  PurchaseOrderSummary,
  Warehouse,
} from '@nec/contracts';
import { Banner, Button, FormWindow, LinkArrow, StatusBadge } from '@nec/ui';
import { errorMessage, fieldErrors } from '../api';
import { formatAmount, fromMinor, toMinor, today } from '../format';
import type { ApiCall } from '../screens/Shell';
import { useRecordToolbar } from '../toolbar';

let keySeed = 0;
const nextKey = () => `po-line-${++keySeed}`;

interface OrderLineDraft {
  key: string;
  itemId: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  warehouseId: string;
}

const emptyLine = (): OrderLineDraft => ({ key: nextKey(), itemId: '', quantity: '', unitPrice: '', discountPercent: '', warehouseId: '' });

function lineTotal(line: OrderLineDraft): bigint {
  const quantity = toMinor(line.quantity || '0') ?? 0n;
  const price = toMinor(line.unitPrice || '0') ?? 0n;
  const discount = toMinor(line.discountPercent || '0') ?? 0n;
  const net = (price * (1_000_000n - discount) * 2n + 1_000_000n) / 2_000_000n;
  return (quantity * net * 2n + 10000n) / 20000n;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="ui-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function ReadField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="ui-field">
      <span>{label}</span>
      <span className="form-value">{value}</span>
    </div>
  );
}

function trim(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

export function PurchaseOrderForm({
  call,
  canCreate,
  canEdit,
  canReceive,
  currency,
  onCopyToReceipt,
  onClose,
}: {
  call: ApiCall;
  canCreate: boolean;
  canEdit: boolean;
  canReceive: boolean;
  currency: string;
  onCopyToReceipt: (orderId: string) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'add' | 'view'>(canCreate ? 'add' : 'view');
  const [order, setOrder] = useState<PurchaseOrder | null>(null);
  const [vendors, setVendors] = useState<PartnerSummary[]>([]);
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [vendorId, setVendorId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [postingDate, setPostingDate] = useState(today());
  const [deliveryDate, setDeliveryDate] = useState(today());
  const [vendorReference, setVendorReference] = useState('');
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<OrderLineDraft[]>([emptyLine()]);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<PurchaseOrderSummary[] | null>(null);

  useEffect(() => {
    void Promise.all([
      call<Page<PartnerSummary>>('GET', '/v1/bp/partners?partnerType=supplier&status=active&limit=200'),
      call<Page<ItemSummary>>('GET', '/v1/inv/items?status=active&limit=200'),
      call<Warehouse[]>('GET', '/v1/inv/warehouses'),
      call<Branch[]>('GET', '/v1/tenant/branches'),
    ]).then(([v, i, w, b]) => {
      if (v.ok) setVendors(v.body.items);
      if (i.ok) setItems(i.body.items);
      if (w.ok) setWarehouses(w.body.filter((row) => row.status === 'active'));
      if (b.ok) setBranches(b.body.filter((row) => row.status === 'active'));
    });
  }, [call]);

  const total = useMemo(() => lines.reduce((sum, line) => sum + lineTotal(line), 0n), [lines]);
  const dirty = mode === 'add' && (vendorId !== '' || lines.some((line) => line.itemId));

  const load = useCallback(
    async (id: string) => {
      const result = await call<PurchaseOrder>('GET', `/v1/pur/orders/${id}`);
      if (!result.ok) {
        setError(errorMessage(result));
        return;
      }
      setOrder(result.body);
      setMode('view');
    },
    [call],
  );

  const startAdd = useCallback(() => {
    if (!canCreate || (dirty && !window.confirm('Discard this purchase order?'))) return;
    setError(null);
    setNotice(null);
    setOrder(null);
    setMode('add');
    setVendorId('');
    setVendorReference('');
    setRemarks('');
    setLines([emptyLine()]);
    setIdempotencyKey(crypto.randomUUID());
  }, [canCreate, dirty]);

  const navigate = useCallback(
    async (direction: 'first' | 'previous' | 'next' | 'last') => {
      if (dirty && !window.confirm('Discard this purchase order?')) return;
      const result = await call<Page<PurchaseOrderSummary>>('GET', '/v1/pur/orders?limit=200');
      if (!result.ok) {
        setError(errorMessage(result));
        return;
      }
      const list = [...result.body.items].reverse();
      if (list.length === 0) {
        setNotice('No purchase orders yet.');
        return;
      }
      const index = order ? list.findIndex((row) => row.id === order.id) : -1;
      const target =
        direction === 'first'
          ? list[0]
          : direction === 'last'
            ? list[list.length - 1]
            : direction === 'next'
              ? list[index < 0 ? 0 : Math.min(index + 1, list.length - 1)]
              : list[index < 0 ? list.length - 1 : Math.max(index - 1, 0)];
      if (target) await load(target.id);
    },
    [call, dirty, load, order],
  );

  useRecordToolbar({
    find: () =>
      void call<Page<PurchaseOrderSummary>>('GET', '/v1/pur/orders?limit=200').then((result) => {
        if (result.ok) setChoices(result.body.items);
        else setError(errorMessage(result));
      }),
    add: canCreate ? startAdd : undefined,
    first: () => void navigate('first'),
    previous: () => void navigate('previous'),
    next: () => void navigate('next'),
    last: () => void navigate('last'),
  });

  const setLine = (key: string, patch: Partial<OrderLineDraft>) => setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    if (mode === 'view') {
      onClose();
      return;
    }
    setError(null);
    const used = lines.filter((line) => line.itemId);
    if (!vendorId || used.length === 0) {
      setError('Choose a vendor and at least one item.');
      return;
    }
    setBusy(true);
    const result = await call<PurchaseOrder | ApprovalSubmitted>('POST', '/v1/pur/orders', {
      idempotencyKey,
      vendorId,
      branchId: branchId || undefined,
      postingDate,
      deliveryDate,
      vendorReference,
      remarks,
      lines: used.map((line) => ({
        itemId: line.itemId,
        quantity: line.quantity.replace(/,/g, '') || '0',
        unitPrice: line.unitPrice.replace(/,/g, '') || '0',
        discountPercent: line.discountPercent || '0',
        warehouseId: line.warehouseId || null,
      })),
    });
    setBusy(false);
    if (!result.ok) {
      const details = fieldErrors(result);
      setError([errorMessage(result), ...Object.values(details).filter((message) => message !== errorMessage(result))].join(' '));
      return;
    }
    if ('approvalRequired' in result.body) {
      setNotice(`The purchase order (${result.body.request.total}) needs approval under template ${result.body.request.templateName}. Follow it under Administration > Approval Procedures > Approvals and add it once approved.`);
      setIdempotencyKey(crypto.randomUUID());
      return;
    }
    setNotice(`Purchase order ${result.body.documentNumber} added.`);
    setOrder(result.body);
    setMode('view');
    setIdempotencyKey(crypto.randomUUID());
  };

  const changeStatus = async (status: 'closed' | 'cancelled') => {
    if (!order) return;
    if (!window.confirm(`${status === 'closed' ? 'Close' : 'Cancel'} purchase order ${order.documentNumber}? This cannot be undone.`)) return;
    const result = await call<PurchaseOrder>('PATCH', `/v1/pur/orders/${order.id}/status`, { status, version: order.version });
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setOrder(result.body);
    setNotice(`Purchase order ${result.body.documentNumber} is ${result.body.status}.`);
  };

  const cancelForm = () => {
    if (dirty && !window.confirm('Discard this purchase order?')) return;
    onClose();
  };

  return (
    <form onSubmit={submit} noValidate>
      <FormWindow
        title={mode === 'view' && order ? `Purchase Order ${order.documentNumber}` : 'Purchase Order - Add'}
        onClose={cancelForm}
        footerLeft={
          <>
            <Button type="submit" variant="primary" busy={busy}>
              {mode === 'add' ? 'Add' : 'OK'}
            </Button>
            <Button type="button" onClick={cancelForm}>
              Cancel
            </Button>
          </>
        }
        footerRight={
          mode === 'view' && order && order.status === 'open' ? (
            <>
              {canReceive ? (
                <Button type="button" onClick={() => onCopyToReceipt(order.id)}>
                  Copy To Goods Receipt PO
                </Button>
              ) : null}
              {canEdit ? (
                <>
                  <Button type="button" onClick={() => void changeStatus('closed')}>
                    Close
                  </Button>
                  <Button type="button" variant="danger" onClick={() => void changeStatus('cancelled')}>
                    Cancel Order
                  </Button>
                </>
              ) : null}
            </>
          ) : null
        }
      >
        {error ? <Banner>{error}</Banner> : null}
        {notice ? <Banner tone="info">{notice}</Banner> : null}
        {mode === 'view' && order ? (
          <>
            <div className="form-columns">
              <div>
                <ReadField label="Vendor" value={`${order.vendorCode} - ${order.vendorName}`} />
                <ReadField label="Vendor Ref. No." value={order.vendorReference ?? ''} />
                <ReadField label="Branch" value={order.branchCode} />
              </div>
              <div>
                <ReadField label="No." value={order.documentNumber} />
                <ReadField
                  label="Status"
                  value={
                    <>
                      <StatusBadge status={order.status === 'open' ? 'active' : order.status} /> {order.closedReason === 'fully_received' ? 'fully received' : order.closedReason ?? ''}
                    </>
                  }
                />
                <ReadField label="Posting Date" value={order.postingDate} />
                <ReadField label="Delivery Date" value={order.deliveryDate} />
              </div>
            </div>
            <div className="ui-table-wrap journal-grid">
              <table className="ui-table">
                <thead>
                  <tr>
                    <th className="ui-table__row-number">#</th>
                    <th>Item No.</th>
                    <th>Description</th>
                    <th>Whse</th>
                    <th className="numeric">Quantity</th>
                    <th className="numeric">Received</th>
                    <th className="numeric">Open</th>
                    <th>UoM</th>
                    <th className="numeric">Unit Price</th>
                    <th className="numeric">Disc. %</th>
                    <th className="numeric">Total ({order.currency})</th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((line) => (
                    <tr key={line.id}>
                      <td className="ui-table__row-number">{line.lineNo}</td>
                      <td>{line.itemCode}</td>
                      <td>{line.description}</td>
                      <td>{line.warehouseCode ?? ''}</td>
                      <td className="numeric">{trim(line.quantity)}</td>
                      <td className="numeric">{trim(line.receivedQuantity)}</td>
                      <td className="numeric">{trim(line.openQuantity)}</td>
                      <td>{line.uomCode}</td>
                      <td className="numeric">{formatAmount(line.unitPrice)}</td>
                      <td className="numeric">{trim(line.discountPercent)}</td>
                      <td className="numeric">{formatAmount(line.lineTotal)}</td>
                    </tr>
                  ))}
                  <tr className="totals-row">
                    <td colSpan={10}>Total Before Tax</td>
                    <td className="numeric">{formatAmount(order.total)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {order.receipts.length > 0 ? (
              <>
                <div className="form-section">Related Goods Receipts</div>
                <ul className="related-list">
                  {order.receipts.map((receipt) => (
                    <li key={receipt.id}>
                      {receipt.documentNumber} · {receipt.postingDate} · {receipt.isCancellation ? 'cancellation' : receipt.status}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <p className="ui-muted">Tax is not calculated in this release; totals are before tax.</p>
          </>
        ) : mode === 'add' ? (
          <>
            <div className="form-columns">
              <div>
                <Field label="Vendor">
                  <select className="grid-input" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                    <option value="" />
                    {vendors.map((vendor) => (
                      <option key={vendor.id} value={vendor.id}>
                        {vendor.code} - {vendor.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Vendor Ref. No.">
                  <input className="grid-input" value={vendorReference} maxLength={60} onChange={(e) => setVendorReference(e.target.value)} />
                </Field>
                <Field label="Branch">
                  <select className="grid-input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                    <option value="">Company default</option>
                    {branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.code} - {branch.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div>
                <Field label="Posting Date">
                  <input className="grid-input" type="date" value={postingDate} onChange={(e) => setPostingDate(e.target.value)} />
                </Field>
                <Field label="Delivery Date">
                  <input className="grid-input" type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
                </Field>
                <Field label="Remarks">
                  <input className="grid-input" value={remarks} maxLength={500} onChange={(e) => setRemarks(e.target.value)} />
                </Field>
              </div>
            </div>
            <div className="ui-table-wrap journal-grid">
              <table className="ui-table">
                <thead>
                  <tr>
                    <th className="ui-table__row-number">#</th>
                    <th>Item No.</th>
                    <th className="numeric">Quantity</th>
                    <th className="numeric">Unit Price</th>
                    <th className="numeric">Disc. %</th>
                    <th>Whse</th>
                    <th className="numeric">Total ({currency})</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, index) => {
                    const item = items.find((row) => row.id === line.itemId);
                    return (
                      <tr key={line.key}>
                        <td className="ui-table__row-number">{index + 1}</td>
                        <td>
                          <select className="grid-input" aria-label={`Line ${index + 1} item`} value={line.itemId} onChange={(e) => setLine(line.key, { itemId: e.target.value })}>
                            <option value="" />
                            {items.map((row) => (
                              <option key={row.id} value={row.id}>
                                {row.code} - {row.name} ({row.uomCode})
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input className="grid-input grid-input--number" inputMode="decimal" aria-label={`Line ${index + 1} quantity`} value={line.quantity} onChange={(e) => setLine(line.key, { quantity: e.target.value })} />
                        </td>
                        <td>
                          <input className="grid-input grid-input--number" inputMode="decimal" aria-label={`Line ${index + 1} price`} value={line.unitPrice} onChange={(e) => setLine(line.key, { unitPrice: e.target.value })} />
                        </td>
                        <td>
                          <input className="grid-input grid-input--number" inputMode="decimal" aria-label={`Line ${index + 1} discount`} value={line.discountPercent} onChange={(e) => setLine(line.key, { discountPercent: e.target.value })} />
                        </td>
                        <td>
                          <select
                            className="grid-input"
                            aria-label={`Line ${index + 1} warehouse`}
                            value={line.warehouseId}
                            disabled={item ? item.itemType !== 'inventory' : false}
                            onChange={(e) => setLine(line.key, { warehouseId: e.target.value })}
                          >
                            <option value="">{item && item.itemType !== 'inventory' ? 'Not stocked' : 'Item default'}</option>
                            {warehouses.map((warehouse) => (
                              <option key={warehouse.id} value={warehouse.id}>
                                {warehouse.code}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="numeric">{formatAmount(fromMinor(lineTotal(line)))}</td>
                        <td>
                          {lines.length > 1 ? (
                            <Button type="button" variant="ghost" aria-label={`Remove line ${index + 1}`} onClick={() => setLines((current) => current.filter((row) => row.key !== line.key))}>
                              ×
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="totals-row">
                    <td colSpan={6}>Total Before Tax</td>
                    <td className="numeric">{formatAmount(fromMinor(total))}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="pager">
              <Button type="button" onClick={() => setLines((current) => [...current, emptyLine()])}>
                Add Line
              </Button>
              <span className="ui-muted">Tax is not calculated in this release.</span>
            </p>
          </>
        ) : (
          <p className="ui-muted">Use Find or the record arrows to open a purchase order.</p>
        )}
      </FormWindow>
      {choices ? (
        <DocumentChooser
          title="List of Purchase Orders"
          rows={choices.map((row) => ({ id: row.id, cells: [row.documentNumber, row.vendorName, row.postingDate, formatAmount(row.total), row.status] }))}
          headers={['No.', 'Vendor', 'Posting Date', 'Total', 'Status']}
          onChoose={(id) => {
            setChoices(null);
            void load(id);
          }}
          onCancel={() => setChoices(null)}
        />
      ) : null}
    </form>
  );
}

interface ReceiptLineDraft {
  orderLineId: string;
  itemCode: string;
  description: string;
  uomCode: string;
  stocked: boolean;
  open: string;
  quantity: string;
  warehouseId: string;
  netPrice: string;
}

export function GoodsReceiptForm({
  call,
  canPost,
  canCancel,
  initialOrderId,
  canInvoice,
  onCopyToInvoice,
  onClose,
}: {
  call: ApiCall;
  canPost: boolean;
  canCancel: boolean;
  initialOrderId: string | null;
  canInvoice: boolean;
  onCopyToInvoice: (vendorId: string) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'add' | 'view'>(canPost ? 'add' : 'view');
  const [receipt, setReceipt] = useState<GoodsReceipt | null>(null);
  const [orders, setOrders] = useState<PurchaseOrderSummary[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [orderId, setOrderId] = useState(initialOrderId ?? '');
  const [order, setOrder] = useState<PurchaseOrder | null>(null);
  const [lines, setLines] = useState<ReceiptLineDraft[]>([]);
  const [postingDate, setPostingDate] = useState(today());
  const [remarks, setRemarks] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelDate, setCancelDate] = useState(today());
  const [cancelReason, setCancelReason] = useState('');
  const [cancelKey, setCancelKey] = useState(() => crypto.randomUUID());
  const [choices, setChoices] = useState<GoodsReceiptSummary[] | null>(null);

  useEffect(() => {
    void Promise.all([call<Page<PurchaseOrderSummary>>('GET', '/v1/pur/orders?status=open&limit=200'), call<Warehouse[]>('GET', '/v1/inv/warehouses')]).then(([o, w]) => {
      if (o.ok) setOrders(o.body.items);
      if (w.ok) setWarehouses(w.body.filter((row) => row.status === 'active'));
    });
  }, [call]);

  useEffect(() => {
    if (!orderId || mode !== 'add') {
      setOrder(null);
      setLines([]);
      return;
    }
    void call<PurchaseOrder>('GET', `/v1/pur/orders/${orderId}`).then((result) => {
      if (!result.ok) {
        setError(errorMessage(result));
        return;
      }
      setOrder(result.body);
      setLines(
        result.body.lines
          .filter((line) => toMinor(line.openQuantity) !== 0n)
          .map((line) => ({
            orderLineId: line.id,
            itemCode: line.itemCode,
            description: line.description,
            uomCode: line.uomCode,
            stocked: line.itemType === 'inventory',
            open: trim(line.openQuantity),
            quantity: trim(line.openQuantity),
            warehouseId: line.warehouseId ?? '',
            netPrice: line.netPrice,
          })),
      );
    });
  }, [call, mode, orderId]);

  const load = useCallback(
    async (id: string) => {
      const result = await call<GoodsReceipt>('GET', `/v1/pur/receipts/${id}`);
      if (!result.ok) {
        setError(errorMessage(result));
        return;
      }
      setReceipt(result.body);
      setMode('view');
      setCancelling(false);
    },
    [call],
  );

  const dirty = mode === 'add' && orderId !== '';

  useRecordToolbar({
    find: () =>
      void call<Page<GoodsReceiptSummary>>('GET', '/v1/pur/receipts?limit=200').then((result) => {
        if (result.ok) setChoices(result.body.items);
        else setError(errorMessage(result));
      }),
    add: canPost
      ? () => {
          if (dirty && !window.confirm('Discard this goods receipt?')) return;
          setReceipt(null);
          setMode('add');
          setOrderId('');
          setError(null);
          setNotice(null);
          setIdempotencyKey(crypto.randomUUID());
        }
      : undefined,
  });

  const total = lines.reduce((sum, line) => {
    const quantity = toMinor(line.quantity || '0') ?? 0n;
    const price = toMinor(line.netPrice) ?? 0n;
    return sum + (quantity * price * 2n + 10000n) / 20000n;
  }, 0n);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    if (mode === 'view') {
      onClose();
      return;
    }
    setError(null);
    const used = lines.filter((line) => line.quantity.trim() !== '' && toMinor(line.quantity) !== 0n);
    if (!order || used.length === 0) {
      setError('Choose a purchase order and enter at least one quantity.');
      return;
    }
    setBusy(true);
    const result = await call<GoodsReceipt>('POST', '/v1/pur/receipts', {
      idempotencyKey,
      orderId: order.id,
      postingDate,
      remarks,
      lines: used.map((line) => ({ orderLineId: line.orderLineId, quantity: line.quantity.replace(/,/g, ''), warehouseId: line.stocked ? line.warehouseId || null : null })),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.status === 0 ? `${errorMessage(result)} Choosing Add again safely retries the same receipt.` : errorMessage(result));
      return;
    }
    setNotice(`Goods receipt ${result.body.documentNumber} posted${result.body.journalNumber ? ` with journal entry ${result.body.journalNumber}` : ''}.`);
    setReceipt(result.body);
    setMode('view');
    setIdempotencyKey(crypto.randomUUID());
  };

  const cancelReceipt = async () => {
    if (!receipt || busy) return;
    if (!cancelReason.trim()) {
      setError('Enter a reason for the cancellation.');
      return;
    }
    if (!window.confirm(`Cancel goods receipt ${receipt.documentNumber}? A cancellation document will reverse its stock and journal.`)) return;
    setBusy(true);
    setError(null);
    const result = await call<GoodsReceipt>('POST', `/v1/pur/receipts/${receipt.id}/cancel`, { idempotencyKey: cancelKey, postingDate: cancelDate, reason: cancelReason.trim() });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setCancelKey(crypto.randomUUID());
    setNotice(`Cancellation ${result.body.documentNumber} posted.`);
    await load(receipt.id);
  };

  const closeForm = () => {
    if (dirty && !window.confirm('Discard this goods receipt?')) return;
    onClose();
  };

  return (
    <form onSubmit={submit} noValidate>
      <FormWindow
        title={mode === 'view' && receipt ? `Goods Receipt PO ${receipt.documentNumber}${receipt.isCancellation ? ' (Cancellation)' : ''}` : 'Goods Receipt PO - Add'}
        onClose={closeForm}
        footerLeft={
          <>
            <Button type="submit" variant="primary" busy={busy && !cancelling}>
              {mode === 'add' ? 'Add' : 'OK'}
            </Button>
            <Button type="button" onClick={closeForm}>
              Cancel
            </Button>
          </>
        }
        footerRight={
          mode === 'view' && receipt && !receipt.isCancellation && receipt.status === 'posted' ? (
            <>
              {canInvoice ? (
                <Button type="button" onClick={() => onCopyToInvoice(receipt.vendorId)}>
                  Copy To A/P Invoice
                </Button>
              ) : null}
              {canCancel ? (
                <Button type="button" onClick={() => setCancelling((value) => !value)}>
                  Cancel Document
                </Button>
              ) : null}
            </>
          ) : null
        }
      >
        {error ? <Banner>{error}</Banner> : null}
        {notice ? <Banner tone="info">{notice}</Banner> : null}
        {mode === 'view' && receipt ? (
          <>
            <div className="form-columns">
              <div>
                <ReadField label="Vendor" value={`${receipt.vendorCode} - ${receipt.vendorName}`} />
                <ReadField label="Base Document" value={`Purchase Order ${receipt.orderNumber}`} />
                <ReadField label="Branch" value={receipt.branchCode} />
              </div>
              <div>
                <ReadField label="No." value={receipt.documentNumber} />
                <ReadField label="Status" value={<StatusBadge status={receipt.status === 'posted' ? 'active' : 'cancelled'} />} />
                <ReadField label="Posting Date" value={receipt.postingDate} />
                <ReadField label="Journal Entry" value={receipt.journalNumber ?? 'None (no stocked lines)'} />
              </div>
            </div>
            {receipt.cancellationReason ? <p className="ui-muted">Cancellation reason: {receipt.cancellationReason}</p> : null}
            {receipt.cancelledById || receipt.cancellationOfId ? (
              <p className="pager">
                <LinkArrow label="Open linked document" onClick={() => void load(receipt.cancelledById ?? receipt.cancellationOfId ?? '')} />
                {receipt.cancelledById ? 'Cancelled by a cancellation document' : 'Cancels the original receipt'}
              </p>
            ) : null}
            <div className="ui-table-wrap journal-grid">
              <table className="ui-table">
                <thead>
                  <tr>
                    <th className="ui-table__row-number">#</th>
                    <th>Item No.</th>
                    <th>Description</th>
                    <th>Whse</th>
                    <th className="numeric">Quantity</th>
                    <th>UoM</th>
                    <th className="numeric">Price</th>
                    <th className="numeric">Total ({receipt.currency})</th>
                  </tr>
                </thead>
                <tbody>
                  {receipt.lines.map((line) => (
                    <tr key={line.id}>
                      <td className="ui-table__row-number">{line.lineNo}</td>
                      <td>{line.itemCode}</td>
                      <td>{line.description}</td>
                      <td>{line.warehouseCode ?? 'Not stocked'}</td>
                      <td className="numeric">{trim(line.quantity)}</td>
                      <td>{line.uomCode}</td>
                      <td className="numeric">{formatAmount(line.netPrice)}</td>
                      <td className="numeric">{formatAmount(line.lineTotal)}</td>
                    </tr>
                  ))}
                  <tr className="totals-row">
                    <td colSpan={7}>Total Before Tax</td>
                    <td className="numeric">{formatAmount(receipt.total)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {cancelling ? (
              <div className="reverse-panel">
                <div className="form-section">Cancel Goods Receipt</div>
                <div className="inline-fields">
                  <label className="ui-field">
                    <span>Cancellation Date</span>
                    <input className="grid-input" type="date" value={cancelDate} onChange={(e) => setCancelDate(e.target.value)} />
                  </label>
                  <label className="ui-field">
                    <span>Reason</span>
                    <input className="grid-input" value={cancelReason} maxLength={500} onChange={(e) => setCancelReason(e.target.value)} />
                  </label>
                  <Button type="button" variant="primary" busy={busy} onClick={() => void cancelReceipt()}>
                    Post Cancellation
                  </Button>
                </div>
                <p className="ui-muted">Reverses the received stock and its journal. Blocked when later stock transactions would require recosting.</p>
              </div>
            ) : null}
          </>
        ) : mode === 'add' ? (
          <>
            <div className="form-columns">
              <div>
                <Field label="Copy From Purchase Order">
                  <select className="grid-input" value={orderId} onChange={(e) => setOrderId(e.target.value)}>
                    <option value="" />
                    {orders.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.documentNumber} - {row.vendorName} ({row.postingDate})
                      </option>
                    ))}
                  </select>
                </Field>
                {order ? <ReadField label="Vendor" value={`${order.vendorCode} - ${order.vendorName}`} /> : null}
              </div>
              <div>
                <Field label="Posting Date">
                  <input className="grid-input" type="date" value={postingDate} onChange={(e) => setPostingDate(e.target.value)} />
                </Field>
                <Field label="Remarks">
                  <input className="grid-input" value={remarks} maxLength={500} onChange={(e) => setRemarks(e.target.value)} />
                </Field>
              </div>
            </div>
            {order ? (
              <div className="ui-table-wrap journal-grid">
                <table className="ui-table">
                  <thead>
                    <tr>
                      <th className="ui-table__row-number">#</th>
                      <th>Item No.</th>
                      <th>Description</th>
                      <th className="numeric">Open Qty</th>
                      <th className="numeric">Quantity</th>
                      <th>UoM</th>
                      <th>Whse</th>
                      <th className="numeric">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, index) => (
                      <tr key={line.orderLineId}>
                        <td className="ui-table__row-number">{index + 1}</td>
                        <td>{line.itemCode}</td>
                        <td>{line.description}</td>
                        <td className="numeric">{line.open}</td>
                        <td>
                          <input
                            className="grid-input grid-input--number"
                            inputMode="decimal"
                            aria-label={`Line ${index + 1} quantity`}
                            value={line.quantity}
                            onChange={(e) => setLines((current) => current.map((row) => (row.orderLineId === line.orderLineId ? { ...row, quantity: e.target.value } : row)))}
                          />
                        </td>
                        <td>{line.uomCode}</td>
                        <td>
                          {line.stocked ? (
                            <select
                              className="grid-input"
                              aria-label={`Line ${index + 1} warehouse`}
                              value={line.warehouseId}
                              onChange={(e) => setLines((current) => current.map((row) => (row.orderLineId === line.orderLineId ? { ...row, warehouseId: e.target.value } : row)))}
                            >
                              {warehouses.map((warehouse) => (
                                <option key={warehouse.id} value={warehouse.id}>
                                  {warehouse.code}
                                </option>
                              ))}
                            </select>
                          ) : (
                            'Not stocked'
                          )}
                        </td>
                        <td className="numeric">{formatAmount(line.netPrice)}</td>
                      </tr>
                    ))}
                    <tr className="totals-row">
                      <td colSpan={7}>Total Before Tax</td>
                      <td className="numeric">{formatAmount(fromMinor(total))}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="ui-muted">Choose an open purchase order to copy its open lines. Set a quantity to 0 or clear it to skip a line.</p>
            )}
          </>
        ) : (
          <p className="ui-muted">Use Find to open a goods receipt.</p>
        )}
      </FormWindow>
      {choices ? (
        <DocumentChooser
          title="List of Goods Receipt PO"
          rows={choices.map((row) => ({
            id: row.id,
            cells: [row.documentNumber, row.orderNumber, row.vendorName, row.postingDate, formatAmount(row.total), row.isCancellation ? 'cancellation' : row.status],
          }))}
          headers={['No.', 'Purchase Order', 'Vendor', 'Posting Date', 'Total', 'Status']}
          onChoose={(id) => {
            setChoices(null);
            void load(id);
          }}
          onCancel={() => setChoices(null)}
        />
      ) : null}
    </form>
  );
}

export function DocumentChooser({
  title,
  headers,
  rows,
  onChoose,
  onCancel,
}: {
  title: string;
  headers: string[];
  rows: { id: string; cells: string[] }[];
  onChoose: (id: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <FormWindow
        title={title}
        width={700}
        onClose={onCancel}
        footerLeft={
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
        }
      >
        {rows.length === 0 ? (
          <p className="ui-muted">No documents yet.</p>
        ) : (
          <div className="ui-table-wrap">
            <table className="ui-table company-grid">
              <thead>
                <tr>
                  {headers.map((header) => (
                    <th key={header}>{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} onDoubleClick={() => onChoose(row.id)}>
                    {row.cells.map((cell, index) => (
                      <td key={index}>
                        {index === 0 ? <LinkArrow label={`Open ${cell}`} onClick={() => onChoose(row.id)} /> : null}
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </FormWindow>
    </div>
  );
}
