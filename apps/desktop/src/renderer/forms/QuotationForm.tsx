import { useEffect, useState } from 'react';
import type { Branch, ItemSummary, Page, PartnerSummary, QuotationSummary, SalesOrder, SalesQuotation, Warehouse } from '@nec/contracts';
import { Banner, Button, FormWindow } from '@nec/ui';
import { errorMessage } from '../api';
import { formatAmount, today } from '../format';
import type { ApiCall } from '../screens/Shell';
import { useRecordToolbar } from '../toolbar';
import { useCreditSubmission } from './CreditControls';
import { DocumentChooser } from './PurchasingForms';
import { listPrice } from './SalesForms';

interface Line { itemId: string; quantity: string; unitPrice: string; discountPercent: string; warehouseId: string; description?: string }
const emptyLine = (): Line => ({ itemId: '', quantity: '1', unitPrice: '', discountPercent: '0', warehouseId: '' });

export function QuotationForm({ call, canCreate, canEdit, canConvert, onOrder, onClose }: {
  call: ApiCall; canCreate: boolean; canEdit: boolean; canConvert: boolean; onOrder: (id: string) => void; onClose: () => void;
}) {
  const [quotation, setQuotation] = useState<SalesQuotation | null>(null);
  const [editing, setEditing] = useState(canCreate);
  const [customers, setCustomers] = useState<PartnerSummary[]>([]);
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [postingDate, setPostingDate] = useState(today());
  const [validUntil, setValidUntil] = useState(today());
  const [reference, setReference] = useState('');
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [conversionKey, setConversionKey] = useState(() => crypto.randomUUID());
  const [orderDate, setOrderDate] = useState(today());
  const [deliveryDate, setDeliveryDate] = useState(today());
  const [converting, setConverting] = useState(false);
  const [busy, setBusy] = useState(false);
  const credit = useCreditSubmission(call);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<QuotationSummary[] | null>(null);

  useEffect(() => {
    void Promise.all([
      call<Page<PartnerSummary>>('GET', '/v1/bp/partners?partnerType=customer&status=active&limit=200'),
      call<Page<ItemSummary>>('GET', '/v1/inv/items?status=active&limit=200'),
      call<Warehouse[]>('GET', '/v1/inv/warehouses'), call<Branch[]>('GET', '/v1/tenant/branches'),
    ]).then(([c, i, w, b]) => {
      if (c.ok) setCustomers(c.body.items);
      if (i.ok) setItems(i.body.items);
      if (w.ok) setWarehouses(w.body.filter((row) => row.status === 'active'));
      if (b.ok) setBranches(b.body.filter((row) => row.status === 'active'));
    });
  }, [call]);

  const discard = () => !editing || window.confirm('Discard unsaved quotation changes?');
  const close = () => { if (!busy && discard()) onClose(); };
  const show = (value: SalesQuotation) => { setQuotation(value); setEditing(false); setConverting(false); setError(null); };
  const load = async (id: string) => {
    const result = await call<SalesQuotation>('GET', `/v1/sal/quotations/${id}`);
    if (result.ok) show(result.body); else setError(errorMessage(result));
  };
  const add = () => {
    if (busy || !discard()) return;
    setQuotation(null); setEditing(true); setConverting(false); setCustomerId(''); setBranchId('');
    setPostingDate(today()); setValidUntil(today()); setReference(''); setRemarks(''); setLines([emptyLine()]);
    setKey(crypto.randomUUID()); setError(null);
  };
  useRecordToolbar({
    add: canCreate ? add : undefined,
    find: () => {
      if (busy || !discard()) return;
      void call<Page<QuotationSummary>>('GET', '/v1/sal/quotations?limit=200').then((result) => {
        if (result.ok) setChoices(result.body.items); else setError(errorMessage(result));
      });
    },
  });
  const edit = () => {
    if (!quotation) return;
    setCustomerId(quotation.customerId); setBranchId(quotation.branchId); setPostingDate(quotation.postingDate);
    setValidUntil(quotation.validUntil); setReference(quotation.customerReference ?? ''); setRemarks(quotation.remarks ?? '');
    setLines(quotation.lines.map((line) => ({ itemId: line.itemId, description: line.description, quantity: line.quantity, unitPrice: line.unitPrice, discountPercent: line.discountPercent, warehouseId: line.warehouseId ?? '' })));
    setEditing(true); setError(null);
  };
  const save = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    const payload = {
      idempotencyKey: key, version: quotation?.version, customerId, branchId: branchId || undefined, postingDate, validUntil,
      customerReference: reference, remarks, lines: lines.map((line) => ({ ...line, unitPrice: line.unitPrice.trim() || undefined, warehouseId: line.warehouseId || null })),
    };
    const result = await call<SalesQuotation>(quotation ? 'PATCH' : 'POST', `/v1/sal/quotations${quotation ? `/${quotation.id}` : ''}`, payload);
    setBusy(false);
    if (result.ok) show(result.body); else setError(errorMessage(result));
  };
  const status = async (value: 'issued' | 'closed' | 'cancelled') => {
    if (!quotation || busy || !window.confirm(`Set ${quotation.documentNumber} to ${value}?`)) return;
    setBusy(true); setError(null);
    const result = await call<SalesQuotation>('PATCH', `/v1/sal/quotations/${quotation.id}/status`, { status: value, version: quotation.version });
    setBusy(false);
    if (result.ok) show(result.body); else setError(errorMessage(result));
  };
  const convert = async () => {
    if (!quotation || busy) return;
    setBusy(true); setError(null);
    const result = await credit.post<SalesOrder>(`/v1/sal/quotations/${quotation.id}/convert`, { idempotencyKey: conversionKey, version: quotation.version, postingDate: orderDate, deliveryDate });
    setBusy(false);
    if (result.ok) onOrder(result.body.id); else setError(errorMessage(result));
  };
  const setLine = (index: number, patch: Partial<Line>) => setLines((current) => current.map((line, n) => n === index ? { ...line, ...patch } : line));
  const chooseItem = async (index: number, itemId: string) => {
    setLine(index, { itemId, warehouseId: '', description: undefined, unitPrice: '' });
    if (!itemId) return;
    const price = await listPrice(call, postingDate, itemId);
    if (price !== null) setLines((current) => current.map((line, n) => (n === index && line.itemId === itemId && line.unitPrice === '' ? { ...line, unitPrice: price } : line)));
  };
  const mutable = quotation && ['draft', 'issued', 'expired'].includes(quotation.status);

  return <FormWindow title={`Sales Quotation${quotation ? ` ${quotation.documentNumber}` : ' - Add'}`} width={900} onClose={close}
    footerLeft={<><Button variant="primary" busy={busy} onClick={() => editing ? void save() : close()}>{editing ? 'Save Draft' : 'OK'}</Button><Button onClick={close}>Cancel</Button></>}
    footerRight={!editing && quotation ? <>
      {canEdit && quotation.status === 'draft' ? <><Button disabled={busy} onClick={edit}>Edit Draft</Button><Button disabled={busy} onClick={() => void status('issued')}>Issue</Button></> : null}
      {canConvert && quotation.status === 'issued' ? <Button disabled={busy} onClick={() => { setConverting(true); setConversionKey(crypto.randomUUID()); }}>Copy To Sales Order</Button> : null}
      {canEdit && mutable ? <><Button disabled={busy} onClick={() => void status('closed')}>Close</Button><Button disabled={busy} onClick={() => void status('cancelled')}>Cancel Quotation</Button></> : null}
      {quotation.orderId ? <Button onClick={() => onOrder(quotation.orderId!)}>Open {quotation.orderNumber}</Button> : null}
    </> : null}>
    {credit.panel}
    {error ? <Banner>{error}</Banner> : null}
    {editing ? <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
      <div className="form-columns"><div>
        <label className="ui-field"><span>Customer</span><select className="grid-input" value={customerId} onChange={(e) => setCustomerId(e.target.value)}><option value="" />{customers.map((c) => <option key={c.id} value={c.id}>{c.code} - {c.name}</option>)}</select></label>
        <label className="ui-field"><span>Branch</span><select className="grid-input" value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">Company default</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}</select></label>
        <label className="ui-field"><span>Customer Ref. No.</span><input className="grid-input" maxLength={60} value={reference} onChange={(e) => setReference(e.target.value)} /></label>
      </div><div>
        <label className="ui-field"><span>Quotation Date</span><input className="grid-input" type="date" value={postingDate} onChange={(e) => setPostingDate(e.target.value)} /></label>
        <label className="ui-field"><span>Valid Until</span><input className="grid-input" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></label>
        <label className="ui-field"><span>Remarks</span><input className="grid-input" maxLength={500} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></label>
      </div></div>
      <div className="ui-table-wrap"><table className="ui-table"><thead><tr><th>Item</th><th>Quantity</th><th>Unit Price</th><th>Disc. %</th><th>Warehouse</th><th /></tr></thead><tbody>
        {lines.map((line, index) => <tr key={index}>
          <td><select className="grid-input" aria-label={`Line ${index + 1} item`} value={line.itemId} onChange={(e) => void chooseItem(index, e.target.value)}><option value="" />{items.map((i) => <option key={i.id} value={i.id}>{i.code} - {i.name}</option>)}</select></td>
          {(['quantity', 'unitPrice', 'discountPercent'] as const).map((field) => <td key={field}><input className="grid-input grid-input--number" inputMode="decimal" aria-label={`Line ${index + 1} ${field}`} value={line[field]} onChange={(e) => setLine(index, { [field]: e.target.value })} /></td>)}
          <td><select className="grid-input" aria-label={`Line ${index + 1} warehouse`} disabled={items.find((i) => i.id === line.itemId)?.itemType !== 'inventory'} value={line.warehouseId} onChange={(e) => setLine(index, { warehouseId: e.target.value })}><option value="">Default</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</select></td>
          <td><Button disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((_, n) => n !== index))}>Remove</Button></td>
        </tr>)}
      </tbody></table></div><p><Button onClick={() => setLines((current) => [...current, emptyLine()])}>Add Line</Button></p>
    </fieldset> : quotation ? <>
      <div className="form-columns"><div><p>{quotation.customerCode} - {quotation.customerName}</p><p>Branch: {quotation.branchCode}</p><p>Customer reference: {quotation.customerReference}</p></div><div><p>Status: {quotation.status}</p><p>Quotation date: {quotation.postingDate}</p><p>Valid until: {quotation.validUntil}</p></div></div>
      <div className="ui-table-wrap"><table className="ui-table"><thead><tr><th>Item</th><th>Description</th><th>Warehouse</th><th>Quantity</th><th>Unit Price</th><th>Disc. %</th><th>Total</th></tr></thead><tbody>
        {quotation.lines.map((line) => <tr key={line.id}><td>{line.itemCode}</td><td>{line.description}</td><td>{line.warehouseCode}</td><td>{line.quantity} {line.uomCode}</td><td>{formatAmount(line.unitPrice)}</td><td>{line.discountPercent}</td><td>{formatAmount(line.lineTotal)}</td></tr>)}
        <tr className="totals-row"><td colSpan={6}>Total Before Tax ({quotation.currency})</td><td>{formatAmount(quotation.total)}</td></tr>
      </tbody></table></div><p>{quotation.remarks}</p>
    </> : <p>Use Find to open a quotation.</p>}
    <p className="ui-muted">Quotations do not commit stock or post to the ledger. Issue a draft to confirm its prices and validity; Copy To creates one order for all lines.</p>
    {converting ? <div className="reverse-panel"><div className="form-section">Copy To Sales Order</div><div className="inline-fields">
      <label className="ui-field"><span>Order Date</span><input type="date" value={orderDate} disabled={busy} onChange={(e) => setOrderDate(e.target.value)} /></label>
      <label className="ui-field"><span>Delivery Date</span><input type="date" value={deliveryDate} disabled={busy} onChange={(e) => setDeliveryDate(e.target.value)} /></label>
      <Button busy={busy} onClick={() => void convert()}>Create Sales Order</Button>
    </div></div> : null}
    {choices ? <DocumentChooser title="List of Sales Quotations" headers={['No.', 'Customer', 'Valid Until', 'Total', 'Status']} rows={choices.map((q) => ({ id: q.id, cells: [q.documentNumber, q.customerName, q.validUntil, formatAmount(q.total), q.status] }))} onChoose={(id) => { setChoices(null); void load(id); }} onCancel={() => setChoices(null)} /> : null}
  </FormWindow>;
}
