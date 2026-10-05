import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type {
  ApprovalSubmitted,
  ArInvoice,
  ArInvoiceSummary,
  Branch,
  BusinessPartner,
  Delivery,
  DeliverySummary,
  InvoiceableSalesLine,
  ItemSummary,
  Page,
  OrderAddress,
  PartnerSummary,
  PaymentTerms,
  PriceList,
  SalesOrder,
  SalesOrderSummary,
  SalesPrices,
  TaxCode,
  Warehouse,
} from '@nec/contracts';
import { Banner, Button, FormWindow, StatusBadge } from '@nec/ui';
import { errorMessage } from '../api';
import { formatAmount, fromMinor, toMinor, today } from '../format';
import type { ApiCall } from '../screens/Shell';
import { useRecordToolbar } from '../toolbar';
import { useCreditSubmission } from './CreditControls';
import { DocumentChooser } from './PurchasingForms';

let keySeed = 0;
const nextKey = () => `so-line-${++keySeed}`;
const clean = (value: string) => value.replace(/,/g, '').trim();
const minor = (value: string) => toMinor(clean(value) || '0') ?? 0n;

function trim(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
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

function CancelPanel({ label, busy, onPost, note }: { label: string; busy: boolean; onPost: (date: string, reason: string) => void; note: string }) {
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState('');
  return (
    <div className="reverse-panel">
      <div className="form-section">Cancel {label}</div>
      <div className="inline-fields">
        <Field label="Cancellation Date">
          <input className="grid-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Reason">
          <input className="grid-input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Button type="button" variant="primary" busy={busy} onClick={() => onPost(date, reason.trim())}>
          Post Cancellation
        </Button>
      </div>
      <p className="ui-muted">{note}</p>
    </div>
  );
}

function useCustomers(call: ApiCall) {
  const [customers, setCustomers] = useState<PartnerSummary[]>([]);
  useEffect(() => {
    void call<Page<PartnerSummary>>('GET', '/v1/bp/partners?partnerType=customer&status=active&limit=200').then((result) => {
      if (result.ok) setCustomers(result.body.items);
    });
  }, [call]);
  return customers;
}

export function formatAddress(address: OrderAddress | null): string {
  if (!address) return '';
  return [address.addressName, address.street, [address.city, address.state, address.zipCode].filter(Boolean).join(' '), address.country].filter(Boolean).join(', ');
}

export function stockWarningText(warnings: SalesOrder['stockWarnings']): string {
  return warnings.map((warning) => `line ${warning.lineNo} ${warning.itemCode} in ${warning.warehouseCode}: ${trim(warning.openQuantity)} open, ${trim(warning.available)} available`).join('; ');
}

export async function listPrice(call: ApiCall, postingDate: string, itemId: string, priceListId?: string): Promise<string | null> {
  const query = `postingDate=${postingDate}&itemIds=${itemId}${priceListId ? `&priceListId=${priceListId}` : ''}`;
  const result = await call<SalesPrices>('GET', `/v1/sal/prices?${query}`);
  if (!result.ok) return null;
  const price = result.body.prices.find((row) => row.itemId === itemId)?.price;
  return price === undefined ? null : trim(price);
}

function CustomerSelect({ customers, value, onChange }: { customers: PartnerSummary[]; value: string; onChange: (value: string) => void }) {
  return (
    <select className="grid-input" aria-label="Customer" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="" />
      {customers.map((customer) => (
        <option key={customer.id} value={customer.id}>
          {customer.code} - {customer.name}
        </option>
      ))}
    </select>
  );
}

interface OrderLineDraft {
  key: string;
  itemId: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  warehouseId: string;
}

const emptyOrderLine = (): OrderLineDraft => ({ key: nextKey(), itemId: '', quantity: '', unitPrice: '', discountPercent: '', warehouseId: '' });

function orderLineTotal(line: OrderLineDraft): bigint {
  const price = minor(line.unitPrice);
  const discount = minor(line.discountPercent);
  const net = (price * (1_000_000n - discount) * 2n + 1_000_000n) / 2_000_000n;
  return (minor(line.quantity) * net * 2n + 10000n) / 20000n;
}

export function SalesOrderForm({
  initialOrderId,
  call,
  canCreate,
  canEdit,
  canDeliver,
  canInvoice,
  currency,
  onCopyToDelivery,
  onCopyToInvoice,
  onClose,
}: {
  initialOrderId?: string | null;
  call: ApiCall;
  canCreate: boolean;
  canEdit: boolean;
  canDeliver: boolean;
  canInvoice: boolean;
  currency: string;
  onCopyToDelivery: (orderId: string) => void;
  onCopyToInvoice: (customerId: string) => void;
  onClose: () => void;
}) {
  const customers = useCustomers(call);
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [mode, setMode] = useState<'add' | 'view'>(canCreate ? 'add' : 'view');
  const [order, setOrder] = useState<SalesOrder | null>(null);
  const [customerId, setCustomerId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [postingDate, setPostingDate] = useState(today());
  const [deliveryDate, setDeliveryDate] = useState(today());
  const [customerReference, setCustomerReference] = useState('');
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<OrderLineDraft[]>([emptyOrderLine()]);
  const [priceLists, setPriceLists] = useState<PriceList[]>([]);
  const [priceListId, setPriceListId] = useState('');
  const [paymentTerms, setPaymentTerms] = useState<PaymentTerms[]>([]);
  const [paymentTermsId, setPaymentTermsId] = useState('');
  const [partner, setPartner] = useState<BusinessPartner | null>(null);
  const [billToId, setBillToId] = useState('');
  const [shipToId, setShipToId] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const credit = useCreditSubmission(call);
  const [choices, setChoices] = useState<SalesOrderSummary[] | null>(null);

  useEffect(() => {
    void Promise.all([
      call<Page<ItemSummary>>('GET', '/v1/inv/items?status=active&limit=200'),
      call<Warehouse[]>('GET', '/v1/inv/warehouses'),
      call<Branch[]>('GET', '/v1/tenant/branches'),
      call<PriceList[]>('GET', '/v1/inv/price-lists'),
      call<PaymentTerms[]>('GET', '/v1/bp/payment-terms'),
    ]).then(([i, w, b, p, t]) => {
      if (i.ok) setItems(i.body.items);
      if (w.ok) setWarehouses(w.body.filter((row) => row.status === 'active'));
      if (b.ok) setBranches(b.body.filter((row) => row.status === 'active'));
      if (p.ok) setPriceLists(p.body.filter((row) => row.purpose === 'sales' && row.status === 'active'));
      if (t.ok) setPaymentTerms(t.body);
    });
  }, [call]);

  useEffect(() => {
    setPartner(null);
    setBillToId('');
    setShipToId('');
    setPaymentTermsId('');
    if (!customerId) return;
    void call<BusinessPartner>('GET', `/v1/bp/partners/${customerId}`).then((result) => {
      if (result.ok) setPartner(result.body);
    });
  }, [call, customerId]);

  const chooseItem = async (key: string, itemId: string) => {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, itemId, unitPrice: '' } : line)));
    if (!itemId) return;
    const price = await listPrice(call, postingDate, itemId, priceListId || undefined);
    if (price !== null) setLines((current) => current.map((line) => (line.key === key && line.itemId === itemId && line.unitPrice === '' ? { ...line, unitPrice: price } : line)));
  };

  const total = useMemo(() => lines.reduce((sum, line) => sum + orderLineTotal(line), 0n), [lines]);
  const dirty = mode === 'add' && (customerId !== '' || lines.some((line) => line.itemId));

  const load = useCallback(
    async (id: string) => {
      const result = await call<SalesOrder>('GET', `/v1/sal/orders/${id}`);
      if (!result.ok) {
        setError(errorMessage(result));
        return;
      }
      setOrder(result.body);
      setMode('view');
    },
    [call],
  );

  useEffect(() => { if (initialOrderId) void load(initialOrderId); }, [initialOrderId, load]);

  useRecordToolbar({
    find: () =>
      void call<Page<SalesOrderSummary>>('GET', '/v1/sal/orders?limit=200').then((result) => {
        if (result.ok) setChoices(result.body.items);
        else setError(errorMessage(result));
      }),
    add: canCreate
      ? () => {
          if (dirty && !window.confirm('Discard this sales order?')) return;
          setOrder(null);
          setMode('add');
          setCustomerId('');
          setCustomerReference('');
          setRemarks('');
          setLines([emptyOrderLine()]);
          setError(null);
          setNotice(null);
          setIdempotencyKey(crypto.randomUUID());
        }
      : undefined,
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
    if (!customerId || used.length === 0) {
      setError('Choose a customer and at least one item.');
      return;
    }
    setBusy(true);
    const result = await credit.post<SalesOrder | ApprovalSubmitted>('/v1/sal/orders', {
      idempotencyKey,
      customerId,
      branchId: branchId || undefined,
      postingDate,
      deliveryDate,
      customerReference,
      remarks,
      priceListId: priceListId || undefined,
      paymentTermsId: paymentTermsId || undefined,
      billToAddressId: billToId || undefined,
      shipToAddressId: shipToId || undefined,
      lines: used.map((line) => ({
        itemId: line.itemId,
        quantity: clean(line.quantity) || '0',
        unitPrice: clean(line.unitPrice) || undefined,
        discountPercent: clean(line.discountPercent) || '0',
        warehouseId: line.warehouseId || null,
      })),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.status === 0 ? `${errorMessage(result)} Choosing Add again safely retries the same order.` : errorMessage(result));
      return;
    }
    if ('approvalRequired' in result.body) {
      setNotice(`The sales order (${result.body.request.total}) needs approval under template ${result.body.request.templateName}. Follow it under Administration > Approval Procedures > Approvals and add it once approved.`);
      setIdempotencyKey(crypto.randomUUID());
      return;
    }
    setNotice(`Sales order ${result.body.documentNumber} added.`);
    setOrder(result.body);
    setMode('view');
    setIdempotencyKey(crypto.randomUUID());
  };

  const changeStatus = async (status: 'closed' | 'cancelled') => {
    if (!order || !window.confirm(`${status === 'closed' ? 'Close' : 'Cancel'} sales order ${order.documentNumber}? This cannot be undone.`)) return;
    const result = await call<SalesOrder>('PATCH', `/v1/sal/orders/${order.id}/status`, { status, version: order.version });
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setOrder(result.body);
    setNotice(`Sales order ${result.body.documentNumber} is ${result.body.status}.`);
  };

  const cancelForm = () => {
    if (dirty && !window.confirm('Discard this sales order?')) return;
    onClose();
  };

  const hasService = order?.lines.some((line) => !line.stocked && parseFloat(line.openQuantity) > 0) ?? false;
  const hasStock = order?.lines.some((line) => line.stocked && parseFloat(line.openQuantity) > 0) ?? false;

  return (
    <form onSubmit={submit} noValidate>
      <FormWindow
        title={mode === 'view' && order ? `Sales Order ${order.documentNumber}` : 'Sales Order - Add'}
        width={900}
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
              {canDeliver && hasStock ? (
                <Button type="button" onClick={() => onCopyToDelivery(order.id)}>
                  Copy To Delivery
                </Button>
              ) : null}
              {canInvoice && hasService ? (
                <Button type="button" onClick={() => onCopyToInvoice(order.customerId)}>
                  Copy To A/R Invoice
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
        {credit.panel}
        {error ? <Banner>{error}</Banner> : null}
        {notice ? <Banner tone="info">{notice}</Banner> : null}
        {mode === 'view' && order ? (
          <>
            {order.stockWarnings.length > 0 ? <Banner tone="warning">Open quantities exceed available stock: {stockWarningText(order.stockWarnings)}. Deliveries beyond stock on hand are refused.</Banner> : null}
            <div className="form-columns">
              <div>
                <ReadField label="Customer" value={`${order.customerCode} - ${order.customerName}`} />
                <ReadField label="Customer Ref. No." value={order.customerReference ?? ''} />
                {order.quotationId ? <ReadField label="Source Quotation" value={order.quotationNumber} /> : null}
                <ReadField label="Branch" value={order.branchCode} />
                <ReadField label="Bill To" value={formatAddress(order.billTo)} />
                <ReadField label="Ship To" value={formatAddress(order.shipTo)} />
              </div>
              <div>
                <ReadField label="No." value={order.documentNumber} />
                <ReadField
                  label="Status"
                  value={
                    <>
                      <StatusBadge status={order.status === 'open' ? 'active' : order.status} /> {order.closedReason ?? ''}
                    </>
                  }
                />
                <ReadField label="Posting Date" value={order.postingDate} />
                <ReadField label="Delivery Date" value={order.deliveryDate} />
                <ReadField label="Payment Terms" value={order.paymentTermsCode ?? ''} />
                <ReadField label="Price List" value={order.priceListCode ?? ''} />
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
                    <th className="numeric">Delivered</th>
                    <th className="numeric">Invoiced</th>
                    <th className="numeric">Open</th>
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
                      <td>{line.warehouseCode ?? 'Not stocked'}</td>
                      <td className="numeric">
                        {trim(line.quantity)} {line.uomCode}
                      </td>
                      <td className="numeric">{line.stocked ? trim(line.deliveredQuantity) : ''}</td>
                      <td className="numeric">{trim(line.invoicedQuantity)}</td>
                      <td className="numeric">{trim(line.openQuantity)}</td>
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
            {order.deliveries.length > 0 ? (
              <>
                <div className="form-section">Related Deliveries</div>
                <ul className="related-list">
                  {order.deliveries.map((delivery) => (
                    <li key={delivery.id}>
                      {delivery.documentNumber} · {delivery.postingDate} · {delivery.isCancellation ? 'cancellation' : delivery.status}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <p className="ui-muted">Stock items are delivered, then invoiced from the delivery. Services and non-stock items are invoiced directly from the order. Tax is applied on the A/R invoice.</p>
          </>
        ) : mode === 'add' ? (
          <>
            <div className="form-columns">
              <div>
                <Field label="Customer">
                  <CustomerSelect customers={customers} value={customerId} onChange={setCustomerId} />
                </Field>
                <Field label="Customer Ref. No.">
                  <input className="grid-input" value={customerReference} maxLength={60} onChange={(e) => setCustomerReference(e.target.value)} />
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
                {(['bill_to', 'ship_to'] as const).map((type) => (
                  <Field key={type} label={type === 'bill_to' ? 'Bill To' : 'Ship To'}>
                    <select
                      className="grid-input"
                      aria-label={type === 'bill_to' ? 'Bill to address' : 'Ship to address'}
                      value={type === 'bill_to' ? billToId : shipToId}
                      disabled={!partner}
                      onChange={(e) => (type === 'bill_to' ? setBillToId(e.target.value) : setShipToId(e.target.value))}
                    >
                      <option value="">Customer default</option>
                      {(partner?.addresses ?? [])
                        .filter((address) => address.addressType === type)
                        .map((address) => (
                          <option key={address.id} value={address.id}>
                            {formatAddress(address)}
                          </option>
                        ))}
                    </select>
                  </Field>
                ))}
              </div>
              <div>
                <Field label="Posting Date">
                  <input className="grid-input" type="date" value={postingDate} onChange={(e) => setPostingDate(e.target.value)} />
                </Field>
                <Field label="Delivery Date">
                  <input className="grid-input" type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
                </Field>
                <Field label="Payment Terms">
                  <select className="grid-input" aria-label="Payment terms" value={paymentTermsId} onChange={(e) => setPaymentTermsId(e.target.value)}>
                    <option value="">Customer default</option>
                    {paymentTerms.map((terms) => (
                      <option key={terms.id} value={terms.id}>
                        {terms.code} - {terms.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Price List">
                  <select className="grid-input" aria-label="Price list" value={priceListId} onChange={(e) => setPriceListId(e.target.value)}>
                    <option value="">Company default</option>
                    {priceLists.map((list) => (
                      <option key={list.id} value={list.id}>
                        {list.code} - {list.name}
                      </option>
                    ))}
                  </select>
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
                          <select className="grid-input" aria-label={`Line ${index + 1} item`} value={line.itemId} onChange={(e) => void chooseItem(line.key, e.target.value)}>
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
                          <input className="grid-input grid-input--number" inputMode="decimal" aria-label={`Line ${index + 1} price`} placeholder={line.itemId ? 'Enter price' : ''} value={line.unitPrice} onChange={(e) => setLine(line.key, { unitPrice: e.target.value })} />
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
                        <td className="numeric">{formatAmount(fromMinor(orderLineTotal(line)))}</td>
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
              <Button type="button" onClick={() => setLines((current) => [...current, emptyOrderLine()])}>
                Add Line
              </Button>
              <span className="ui-muted">Prices default from the price list. Stock is committed by open orders and issued when the delivery is posted.</span>
            </p>
          </>
        ) : (
          <p className="ui-muted">Use Find to open a sales order.</p>
        )}
      </FormWindow>
      {choices ? (
        <DocumentChooser
          title="List of Sales Orders"
          headers={['No.', 'Customer', 'Posting Date', 'Total', 'Status']}
          rows={choices.map((row) => ({ id: row.id, cells: [row.documentNumber, row.customerName, row.postingDate, formatAmount(row.total), row.status] }))}
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

interface DeliveryLineDraft {
  orderLineId: string;
  itemCode: string;
  description: string;
  uomCode: string;
  open: string;
  quantity: string;
  warehouseId: string;
  netPrice: string;
}

export function DeliveryForm({
  call,
  canPost,
  canCancel,
  canInvoice,
  initialOrderId,
  onCopyToInvoice,
  onClose,
}: {
  call: ApiCall;
  canPost: boolean;
  canCancel: boolean;
  canInvoice: boolean;
  initialOrderId: string | null;
  onCopyToInvoice: (customerId: string) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'add' | 'view'>(canPost ? 'add' : 'view');
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [openOrders, setOpenOrders] = useState<SalesOrderSummary[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [orderId, setOrderId] = useState(initialOrderId ?? '');
  const [order, setOrder] = useState<SalesOrder | null>(null);
  const [lines, setLines] = useState<DeliveryLineDraft[]>([]);
  const [postingDate, setPostingDate] = useState(today());
  const [remarks, setRemarks] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const credit = useCreditSubmission(call);
  const [cancelling, setCancelling] = useState(false);
  const [choices, setChoices] = useState<DeliverySummary[] | null>(null);

  useEffect(() => {
    void Promise.all([call<Page<SalesOrderSummary>>('GET', '/v1/sal/orders?status=open&limit=200'), call<Warehouse[]>('GET', '/v1/inv/warehouses')]).then(([o, w]) => {
      if (o.ok) setOpenOrders(o.body.items);
      if (w.ok) setWarehouses(w.body.filter((row) => row.status === 'active'));
    });
  }, [call]);

  useEffect(() => {
    if (!orderId || mode !== 'add') {
      setOrder(null);
      setLines([]);
      return;
    }
    void call<SalesOrder>('GET', `/v1/sal/orders/${orderId}`).then((result) => {
      if (!result.ok) {
        setError(errorMessage(result));
        return;
      }
      setOrder(result.body);
      setLines(
        result.body.lines
          .filter((line) => line.stocked && parseFloat(line.openQuantity) > 0)
          .map((line) => ({
            orderLineId: line.id,
            itemCode: line.itemCode,
            description: line.description,
            uomCode: line.uomCode,
            open: line.openQuantity,
            quantity: trim(line.openQuantity),
            warehouseId: line.warehouseId ?? '',
            netPrice: line.netPrice,
          })),
      );
    });
  }, [call, mode, orderId]);

  const load = useCallback(
    async (id: string) => {
      const result = await call<Delivery>('GET', `/v1/sal/deliveries/${id}`);
      if (!result.ok) {
        setError(errorMessage(result));
        return;
      }
      setDelivery(result.body);
      setMode('view');
      setCancelling(false);
    },
    [call],
  );

  useRecordToolbar({
    find: () =>
      void call<Page<DeliverySummary>>('GET', '/v1/sal/deliveries?limit=200').then((result) => {
        if (result.ok) setChoices(result.body.items);
        else setError(errorMessage(result));
      }),
    add: canPost
      ? () => {
          setDelivery(null);
          setMode('add');
          setOrderId('');
          setRemarks('');
          setError(null);
          setNotice(null);
          setIdempotencyKey(crypto.randomUUID());
        }
      : undefined,
  });

  const setLine = (orderLineId: string, patch: Partial<DeliveryLineDraft>) => setLines((current) => current.map((line) => (line.orderLineId === orderLineId ? { ...line, ...patch } : line)));

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    if (mode === 'view') {
      onClose();
      return;
    }
    setError(null);
    const used = lines.filter((line) => minor(line.quantity) > 0n);
    if (!orderId || used.length === 0) {
      setError('Choose a sales order and enter at least one quantity.');
      return;
    }
    setBusy(true);
    const result = await credit.post<Delivery>('/v1/sal/deliveries', {
      idempotencyKey,
      orderId,
      postingDate,
      remarks,
      lines: used.map((line) => ({ orderLineId: line.orderLineId, quantity: clean(line.quantity), warehouseId: line.warehouseId || null })),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.status === 0 ? `${errorMessage(result)} Choosing Add again safely retries the same delivery.` : errorMessage(result));
      return;
    }
    setNotice(`Delivery ${result.body.documentNumber} posted${result.body.journalNumber ? ` with journal entry ${result.body.journalNumber}` : ''}.`);
    setDelivery(result.body);
    setMode('view');
    setIdempotencyKey(crypto.randomUUID());
  };

  const cancelDocument = async (date: string, reason: string) => {
    if (!delivery || busy) return;
    if (!reason) {
      setError('Enter a reason for the cancellation.');
      return;
    }
    if (!window.confirm(`Cancel delivery ${delivery.documentNumber}? The stock returns to the warehouse and the cost journal is reversed.`)) return;
    setBusy(true);
    const result = await call<Delivery>('POST', `/v1/sal/deliveries/${delivery.id}/cancel`, { idempotencyKey: crypto.randomUUID(), postingDate: date, reason });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setNotice(`Cancellation ${result.body.documentNumber} posted.`);
    await load(delivery.id);
  };

  return (
    <form onSubmit={submit} noValidate>
      <FormWindow
        title={mode === 'view' && delivery ? `Delivery ${delivery.documentNumber}${delivery.isCancellation ? ' (Cancellation)' : ''}` : 'Delivery - Add'}
        width={900}
        onClose={onClose}
        footerLeft={
          <>
            <Button type="submit" variant="primary" busy={busy && !cancelling}>
              {mode === 'add' ? 'Add' : 'OK'}
            </Button>
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
          </>
        }
        footerRight={
          mode === 'view' && delivery && delivery.status === 'posted' && !delivery.isCancellation ? (
            <>
              {canInvoice ? (
                <Button type="button" onClick={() => onCopyToInvoice(delivery.customerId)}>
                  Copy To A/R Invoice
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
        {credit.panel}
        {error ? <Banner>{error}</Banner> : null}
        {notice ? <Banner tone="info">{notice}</Banner> : null}
        {mode === 'view' && delivery ? (
          <>
            <div className="form-columns">
              <div>
                <ReadField label="Customer" value={`${delivery.customerCode} - ${delivery.customerName}`} />
                <ReadField label="Sales Order" value={delivery.orderNumber} />
                <ReadField label="Journal Entry" value={delivery.journalNumber ?? 'None'} />
              </div>
              <div>
                <ReadField label="No." value={delivery.documentNumber} />
                <ReadField label="Status" value={<StatusBadge status={delivery.status === 'posted' ? 'active' : 'cancelled'} />} />
                <ReadField label="Posting Date" value={delivery.postingDate} />
              </div>
            </div>
            {delivery.cancellationReason ? <p className="ui-muted">Cancellation reason: {delivery.cancellationReason}</p> : null}
            <div className="ui-table-wrap journal-grid">
              <table className="ui-table">
                <thead>
                  <tr>
                    <th className="ui-table__row-number">#</th>
                    <th>Item No.</th>
                    <th>Description</th>
                    <th>Whse</th>
                    <th className="numeric">Quantity</th>
                    <th className="numeric">Invoiced</th>
                    <th className="numeric">Price</th>
                    <th className="numeric">Total</th>
                    <th className="numeric">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {delivery.lines.map((line) => (
                    <tr key={line.id}>
                      <td className="ui-table__row-number">{line.lineNo}</td>
                      <td>{line.itemCode}</td>
                      <td>{line.description}</td>
                      <td>{line.warehouseCode}</td>
                      <td className="numeric">
                        {trim(line.quantity)} {line.uomCode}
                      </td>
                      <td className="numeric">{trim(line.invoicedQuantity)}</td>
                      <td className="numeric">{formatAmount(line.netPrice)}</td>
                      <td className="numeric">{formatAmount(line.lineTotal)}</td>
                      <td className="numeric">{formatAmount(line.costValue)}</td>
                    </tr>
                  ))}
                  <tr className="totals-row">
                    <td colSpan={7}>Total</td>
                    <td className="numeric">{formatAmount(delivery.total)}</td>
                    <td className="numeric">{formatAmount(delivery.costTotal)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        ) : mode === 'add' ? (
          <>
            <div className="form-columns">
              <div>
                <Field label="Sales Order">
                  <select className="grid-input" aria-label="Sales order" value={orderId} onChange={(e) => setOrderId(e.target.value)}>
                    <option value="" />
                    {openOrders.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.documentNumber} - {row.customerName}
                      </option>
                    ))}
                  </select>
                </Field>
                <ReadField label="Customer" value={order ? `${order.customerCode} - ${order.customerName}` : ''} />
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
            {order && lines.length === 0 ? <p className="ui-muted">This order has no stock lines left to deliver.</p> : null}
            {lines.length > 0 ? (
              <div className="ui-table-wrap">
                <table className="ui-table">
                  <thead>
                    <tr>
                      <th>Item No.</th>
                      <th>Description</th>
                      <th className="numeric">Open</th>
                      <th className="numeric">Quantity</th>
                      <th>Whse</th>
                      <th className="numeric">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => (
                      <tr key={line.orderLineId}>
                        <td>{line.itemCode}</td>
                        <td>{line.description}</td>
                        <td className="numeric">
                          {trim(line.open)} {line.uomCode}
                        </td>
                        <td>
                          <input className="grid-input grid-input--number" inputMode="decimal" aria-label={`${line.itemCode} quantity`} value={line.quantity} onChange={(e) => setLine(line.orderLineId, { quantity: e.target.value })} />
                        </td>
                        <td>
                          <select className="grid-input" aria-label={`${line.itemCode} warehouse`} value={line.warehouseId} onChange={(e) => setLine(line.orderLineId, { warehouseId: e.target.value })}>
                            {warehouses.map((warehouse) => (
                              <option key={warehouse.id} value={warehouse.id}>
                                {warehouse.code}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="numeric">{formatAmount(line.netPrice)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <p className="ui-muted">Posting issues stock at the moving average cost (Dr Cost of Goods Sold, Cr Inventory). Deliveries beyond the stock on hand are refused.</p>
          </>
        ) : (
          <p className="ui-muted">Use Find to open a delivery.</p>
        )}
        {cancelling && delivery ? (
          <CancelPanel
            label="Delivery"
            busy={busy}
            onPost={(date, reason) => void cancelDocument(date, reason)}
            note="Returns the stock and reverses the cost journal. Blocked while an A/R invoice is based on the delivery or when later stock transactions would require recosting."
          />
        ) : null}
      </FormWindow>
      {choices ? (
        <DocumentChooser
          title="List of Deliveries"
          headers={['No.', 'Order', 'Customer', 'Posting Date', 'Total', 'Status']}
          rows={choices.map((row) => ({ id: row.id, cells: [row.documentNumber, row.orderNumber, row.customerName, row.postingDate, formatAmount(row.total), row.isCancellation ? 'cancellation' : row.status] }))}
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

interface InvoiceLineDraft extends InvoiceableSalesLine {
  key: string;
  selected: boolean;
  invoiceQuantity: string;
  price: string;
  taxCodeId: string;
}

function draftTotal(line: InvoiceLineDraft): bigint {
  return (minor(line.invoiceQuantity) * minor(line.price) * 2n + 10000n) / 20000n;
}

export function ArInvoiceForm({
  call,
  canPost,
  canCancel,
  canOverride,
  currency,
  initialCustomerId,
  onClose,
}: {
  call: ApiCall;
  canPost: boolean;
  canCancel: boolean;
  canOverride: boolean;
  currency: string;
  initialCustomerId: string | null;
  onClose: () => void;
}) {
  const customers = useCustomers(call);
  const [priceOverride, setPriceOverride] = useState(false);
  const [paymentTerms, setPaymentTerms] = useState<PaymentTerms[]>([]);
  const [invoiceTermsId, setInvoiceTermsId] = useState('');
  const [invoicePartner, setInvoicePartner] = useState<BusinessPartner | null>(null);
  const [invoiceBillToId, setInvoiceBillToId] = useState('');
  const [taxCodes, setTaxCodes] = useState<TaxCode[]>([]);
  const [mode, setMode] = useState<'add' | 'view'>(canPost ? 'add' : 'view');
  const [invoice, setInvoice] = useState<ArInvoice | null>(null);
  const [customerId, setCustomerId] = useState(initialCustomerId ?? '');
  const [lines, setLines] = useState<InvoiceLineDraft[]>([]);
  const [postingDate, setPostingDate] = useState(today());
  const [customerReference, setCustomerReference] = useState('');
  const [remarks, setRemarks] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const credit = useCreditSubmission(call);
  const [cancelling, setCancelling] = useState(false);
  const [choices, setChoices] = useState<ArInvoiceSummary[] | null>(null);

  useEffect(() => {
    void call<TaxCode[]>('GET', '/v1/fin/tax-codes').then((result) => {
      if (result.ok) setTaxCodes(result.body.filter((code) => code.status === 'active' && code.purpose !== 'purchase'));
    });
    void call<PaymentTerms[]>('GET', '/v1/bp/payment-terms').then((result) => {
      if (result.ok) setPaymentTerms(result.body);
    });
  }, [call]);

  useEffect(() => {
    setInvoicePartner(null);
    setInvoiceTermsId('');
    setInvoiceBillToId('');
    if (!customerId) return;
    void call<BusinessPartner>('GET', `/v1/bp/partners/${customerId}`).then((result) => {
      if (result.ok) setInvoicePartner(result.body);
    });
  }, [call, customerId]);

  useEffect(() => {
    if (!customerId || mode !== 'add') {
      setLines([]);
      return;
    }
    void call<InvoiceableSalesLine[]>('GET', `/v1/sal/invoiceable?customerId=${customerId}`).then((result) => {
      if (!result.ok) {
        setError(errorMessage(result));
        return;
      }
      setLines(
        result.body.map((line) => ({
          ...line,
          key: line.deliveryLineId ?? line.orderLineId,
          selected: false,
          invoiceQuantity: trim(line.openQuantity),
          price: trim(line.unitPrice),
          taxCodeId: '',
        })),
      );
    });
  }, [call, customerId, mode]);

  const load = useCallback(
    async (id: string) => {
      const result = await call<ArInvoice>('GET', `/v1/sal/invoices/${id}`);
      if (!result.ok) {
        setError(errorMessage(result));
        return;
      }
      setInvoice(result.body);
      setMode('view');
      setCancelling(false);
    },
    [call],
  );

  useRecordToolbar({
    find: () =>
      void call<Page<ArInvoiceSummary>>('GET', '/v1/sal/invoices?limit=200').then((result) => {
        if (result.ok) setChoices(result.body.items);
        else setError(errorMessage(result));
      }),
    add: canPost
      ? () => {
          setInvoice(null);
          setMode('add');
          setCustomerId('');
          setCustomerReference('');
          setRemarks('');
          setPriceOverride(false);
          setError(null);
          setNotice(null);
          setIdempotencyKey(crypto.randomUUID());
        }
      : undefined,
  });

  const setLine = (key: string, patch: Partial<InvoiceLineDraft>) => setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const selected = lines.filter((line) => line.selected);
  const subtotal = selected.reduce((sum, line) => sum + draftTotal(line), 0n);
  const taxTotal = selected.reduce((sum, line) => {
    const rate = minor(taxCodes.find((code) => code.id === line.taxCodeId)?.currentRate ?? '0');
    return sum + (draftTotal(line) * rate * 2n + 1_000_000n) / 2_000_000n;
  }, 0n);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    if (mode === 'view') {
      onClose();
      return;
    }
    setError(null);
    if (!customerId || selected.length === 0) {
      setError('Choose a customer and select at least one line.');
      return;
    }
    setBusy(true);
    const result = await credit.post<ArInvoice>('/v1/sal/invoices', {
      idempotencyKey,
      customerId,
      postingDate,
      customerReference,
      remarks,
      priceOverride,
      paymentTermsId: invoiceTermsId || undefined,
      billToAddressId: invoiceBillToId || undefined,
      lines: selected.map((line) => ({
        ...(line.kind === 'delivery' ? { kind: 'delivery', deliveryLineId: line.deliveryLineId } : { kind: 'order', orderLineId: line.orderLineId }),
        quantity: clean(line.invoiceQuantity),
        unitPrice: clean(line.price),
        taxCodeId: line.taxCodeId || null,
      })),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.status === 0 ? `${errorMessage(result)} Choosing Add again safely retries the same invoice.` : errorMessage(result));
      return;
    }
    setNotice(`A/R invoice ${result.body.documentNumber} posted${result.body.journalNumber ? ` with journal entry ${result.body.journalNumber}` : ''}.`);
    setInvoice(result.body);
    setMode('view');
    setIdempotencyKey(crypto.randomUUID());
  };

  const output = async (kind: 'pdf' | 'print') => {
    if (!invoice || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === 'pdf') {
        const result = await window.erp.saveInvoicePdf(invoice.id);
        if (result.saved) setNotice(`A/R invoice ${invoice.documentNumber} saved as PDF.`);
      } else {
        await window.erp.printInvoice(invoice.id);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'The invoice could not be printed.');
    } finally {
      setBusy(false);
    }
  };

  const cancelDocument = async (date: string, reason: string) => {
    if (!invoice || busy) return;
    if (!reason) {
      setError('Enter a reason for the cancellation.');
      return;
    }
    if (!window.confirm(`Cancel A/R invoice ${invoice.documentNumber}? Its journal entry will be reversed; the deliveries stay posted.`)) return;
    setBusy(true);
    const result = await call<ArInvoice>('POST', `/v1/sal/invoices/${invoice.id}/cancel`, { idempotencyKey: crypto.randomUUID(), postingDate: date, reason });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setNotice(`Cancellation ${result.body.documentNumber} posted.`);
    await load(invoice.id);
  };

  return (
    <form onSubmit={submit} noValidate>
      <FormWindow
        title={mode === 'view' && invoice ? `A/R Invoice ${invoice.documentNumber}${invoice.isCancellation ? ' (Cancellation)' : ''}` : 'A/R Invoice - Add'}
        width={1000}
        onClose={onClose}
        footerLeft={
          <>
            <Button type="submit" variant="primary" busy={busy && !cancelling}>
              {mode === 'add' ? 'Add' : 'OK'}
            </Button>
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
          </>
        }
        footerRight={
          mode === 'view' && invoice ? (
            <>
              <Button type="button" disabled={busy} onClick={() => void output('print')}>
                Print
              </Button>
              <Button type="button" disabled={busy} onClick={() => void output('pdf')}>
                Save as PDF
              </Button>
              {canCancel && invoice.status === 'posted' && !invoice.isCancellation ? (
                <Button type="button" onClick={() => setCancelling((value) => !value)}>
                  Cancel Document
                </Button>
              ) : null}
            </>
          ) : null
        }
      >
        {credit.panel}
        {error ? <Banner>{error}</Banner> : null}
        {notice ? <Banner tone="info">{notice}</Banner> : null}
        {mode === 'view' && invoice ? (
          <>
            <div className="form-columns">
              <div>
                <ReadField label="Customer" value={`${invoice.customerCode} - ${invoice.customerName}`} />
                <ReadField label="Customer Ref. No." value={invoice.customerReference ?? ''} />
                <ReadField label="Journal Entry" value={invoice.journalNumber ?? 'None'} />
              </div>
              <div>
                <ReadField label="No." value={invoice.documentNumber} />
                <ReadField label="Status" value={<StatusBadge status={invoice.status === 'posted' ? 'active' : 'cancelled'} />} />
                <ReadField label="Posting Date" value={invoice.postingDate} />
                <ReadField label="Due Date" value={invoice.dueDate} />
                <ReadField label="Payment Terms" value={invoice.paymentTermsCode ?? ''} />
              </div>
            </div>
            {invoice.priceOverride ? <Banner tone="warning">Posted with a price override: invoice prices differ from the order or delivery prices beyond the sales tolerance.</Banner> : null}
            {invoice.cancellationReason ? <p className="ui-muted">Cancellation reason: {invoice.cancellationReason}</p> : null}
            <div className="ui-table-wrap journal-grid">
              <table className="ui-table">
                <thead>
                  <tr>
                    <th className="ui-table__row-number">#</th>
                    <th>Base Document</th>
                    <th>Item No.</th>
                    <th>Description</th>
                    <th className="numeric">Quantity</th>
                    <th className="numeric">Price</th>
                    <th>Revenue</th>
                    <th>Tax</th>
                    <th className="numeric">Tax Amount</th>
                    <th className="numeric">Total ({invoice.currency})</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.lines.map((line) => (
                    <tr key={line.id}>
                      <td className="ui-table__row-number">{line.lineNo}</td>
                      <td>{line.deliveryNumber ?? line.orderNumber}</td>
                      <td>{line.itemCode}</td>
                      <td>{line.description}</td>
                      <td className="numeric">
                        {trim(line.quantity)} {line.uomCode}
                      </td>
                      <td className="numeric">{formatAmount(line.unitPrice)}</td>
                      <td>{line.revenueAccountCode}</td>
                      <td>{line.taxCode ?? ''}</td>
                      <td className="numeric">{formatAmount(line.taxAmount)}</td>
                      <td className="numeric">{formatAmount(line.lineTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="totals-block">
              <ReadField label="Total Before Tax" value={`${formatAmount(invoice.subtotal)} ${invoice.currency}`} />
              <ReadField label="Tax" value={`${formatAmount(invoice.taxTotal)} ${invoice.currency}`} />
              <ReadField label="Total" value={<strong>{`${formatAmount(invoice.total)} ${invoice.currency}`}</strong>} />
              <ReadField label="Paid" value={`${formatAmount(invoice.paidAmount)} ${invoice.currency}`} />
              <ReadField label="Balance Due" value={`${formatAmount(invoice.openAmount)} ${invoice.currency}`} />
            </div>
          </>
        ) : mode === 'add' ? (
          <>
            <div className="form-columns">
              <div>
                <Field label="Customer">
                  <CustomerSelect customers={customers} value={customerId} onChange={setCustomerId} />
                </Field>
                <Field label="Customer Ref. No.">
                  <input className="grid-input" value={customerReference} maxLength={60} onChange={(e) => setCustomerReference(e.target.value)} />
                </Field>
                <Field label="Bill To">
                  <select className="grid-input" aria-label="Invoice bill to address" value={invoiceBillToId} disabled={!invoicePartner} onChange={(e) => setInvoiceBillToId(e.target.value)}>
                    <option value="">From base document</option>
                    {(invoicePartner?.addresses ?? [])
                      .filter((address) => address.addressType === 'bill_to')
                      .map((address) => (
                        <option key={address.id} value={address.id}>
                          {formatAddress(address)}
                        </option>
                      ))}
                  </select>
                </Field>
              </div>
              <div>
                <Field label="Posting Date">
                  <input className="grid-input" type="date" value={postingDate} onChange={(e) => setPostingDate(e.target.value)} />
                </Field>
                <Field label="Payment Terms">
                  <select className="grid-input" aria-label="Invoice payment terms" value={invoiceTermsId} onChange={(e) => setInvoiceTermsId(e.target.value)}>
                    <option value="">From base document</option>
                    {paymentTerms.map((terms) => (
                      <option key={terms.id} value={terms.id}>
                        {terms.code} - {terms.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Remarks">
                  <input className="grid-input" value={remarks} maxLength={500} onChange={(e) => setRemarks(e.target.value)} />
                </Field>
              </div>
            </div>
            {customerId && lines.length === 0 ? <p className="ui-muted">This customer has no delivered or orderable lines left to invoice.</p> : null}
            {lines.length > 0 ? (
              <div className="ui-table-wrap">
                <table className="ui-table" aria-label="Lines to invoice">
                  <thead>
                    <tr>
                      <th />
                      <th>Base Document</th>
                      <th>Item No.</th>
                      <th className="numeric">Open</th>
                      <th className="numeric">Quantity</th>
                      <th className="numeric">Price</th>
                      <th>Tax Code</th>
                      <th className="numeric">Total ({currency})</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => (
                      <tr key={line.key}>
                        <td>
                          <input type="checkbox" aria-label={`Invoice ${line.deliveryNumber ?? line.orderNumber} ${line.itemCode}`} checked={line.selected} onChange={(e) => setLine(line.key, { selected: e.target.checked })} />
                        </td>
                        <td>{line.kind === 'delivery' ? `Delivery ${line.deliveryNumber}` : `Order ${line.orderNumber}`}</td>
                        <td>{line.itemCode}</td>
                        <td className="numeric">
                          {trim(line.openQuantity)} {line.uomCode}
                        </td>
                        <td>
                          <input className="grid-input grid-input--number" inputMode="decimal" aria-label={`${line.itemCode} quantity`} disabled={!line.selected} value={line.invoiceQuantity} onChange={(e) => setLine(line.key, { invoiceQuantity: e.target.value })} />
                        </td>
                        <td>
                          <input className="grid-input grid-input--number" inputMode="decimal" aria-label={`${line.itemCode} price`} disabled={!line.selected} value={line.price} onChange={(e) => setLine(line.key, { price: e.target.value })} />
                        </td>
                        <td>
                          <select className="grid-input" aria-label={`${line.itemCode} tax code`} disabled={!line.selected} value={line.taxCodeId} onChange={(e) => setLine(line.key, { taxCodeId: e.target.value })}>
                            <option value="">No tax</option>
                            {taxCodes.map((code) => (
                              <option key={code.id} value={code.id}>
                                {code.code} ({trim(code.currentRate ?? '0')}%)
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="numeric">{line.selected ? formatAmount(fromMinor(draftTotal(line))) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {canOverride ? (
              <label className="flag-row">
                <input type="checkbox" checked={priceOverride} onChange={(e) => setPriceOverride(e.target.checked)} /> Allow price differences beyond the sales tolerance
              </label>
            ) : null}
            <div className="totals-block">
              <ReadField label="Total Before Tax" value={`${formatAmount(fromMinor(subtotal))} ${currency}`} />
              <ReadField label="Tax" value={`${formatAmount(fromMinor(taxTotal))} ${currency}`} />
              <ReadField label="Total" value={<strong>{`${formatAmount(fromMinor(subtotal + taxTotal))} ${currency}`}</strong>} />
            </div>
            <p className="ui-muted">Posting debits the customer through the receivables control account and credits revenue and output tax. Cost of goods sold was posted by the delivery. The server recalculates tax from the rate valid on the posting date.</p>
          </>
        ) : (
          <p className="ui-muted">Use Find to open an A/R invoice.</p>
        )}
        {cancelling && invoice ? (
          <CancelPanel
            label="A/R Invoice"
            busy={busy}
            onPost={(date, reason) => void cancelDocument(date, reason)}
            note="Reverses the invoice journal and reopens its quantities for invoicing; deliveries stay posted. Blocked while incoming payments are applied to it."
          />
        ) : null}
      </FormWindow>
      {choices ? (
        <DocumentChooser
          title="List of A/R Invoices"
          headers={['No.', 'Customer', 'Posting Date', 'Due Date', 'Total', 'Open', 'Status']}
          rows={choices.map((row) => ({
            id: row.id,
            cells: [row.documentNumber, row.customerName, row.postingDate, row.dueDate, formatAmount(row.total), formatAmount(row.openAmount), row.isCancellation ? 'cancellation' : row.status],
          }))}
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
