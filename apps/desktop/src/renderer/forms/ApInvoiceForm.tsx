import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { Account, ApInvoice, ApInvoiceSummary, InvoiceableReceiptLine, ItemSummary, Page, PartnerSummary, TaxCode, Warehouse } from '@nec/contracts';
import { Banner, Button, FormWindow, LinkArrow, StatusBadge } from '@nec/ui';
import { errorMessage } from '../api';
import { formatAmount, fromMinor, toMinor, today } from '../format';
import type { ApiCall } from '../screens/Shell';
import { useRecordToolbar } from '../toolbar';

interface ReceiptDraft extends InvoiceableReceiptLine {
  selected: boolean;
  quantity: string;
  unitPrice: string;
  taxCodeId: string;
}

interface DirectDraft {
  key: string;
  itemId: string;
  quantity: string;
  unitPrice: string;
  warehouseId: string;
  taxCodeId: string;
}

interface AccountDraft {
  key: string;
  accountId: string;
  description: string;
  amount: string;
  taxCodeId: string;
}

let keySeed = 0;
const nextKey = () => `ap-${++keySeed}`;
const emptyDirect = (): DirectDraft => ({ key: nextKey(), itemId: '', quantity: '', unitPrice: '', warehouseId: '', taxCodeId: '' });
const emptyAccount = (): AccountDraft => ({ key: nextKey(), accountId: '', description: '', amount: '', taxCodeId: '' });

function trim(value: string | null): string {
  if (!value) return '';
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

function ReadField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="ui-field">
      <span>{label}</span>
      <span className="form-value">{value}</span>
    </div>
  );
}

function multiply(quantity: string, price: string): bigint {
  const q = toMinor(quantity || '0') ?? 0n;
  const p = toMinor(price || '0') ?? 0n;
  return (q * p * 2n + 10000n) / 20000n;
}

function taxOf(amount: bigint, rate: bigint): bigint {
  return (amount * rate * 2n + 1_000_000n) / 2_000_000n;
}

function rateOn(code: TaxCode | undefined, date: string): bigint {
  if (!code) return 0n;
  const rate = code.rates.find((row) => row.validFrom <= date);
  return rate ? (toMinor(rate.rate) ?? 0n) : 0n;
}

function TaxSelect({ codes, value, onChange, label, disabled }: { codes: TaxCode[]; value: string; onChange: (value: string) => void; label: string; disabled?: boolean }) {
  return (
    <select className="grid-input" aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">No tax code</option>
      {codes.map((code) => (
        <option key={code.id} value={code.id}>
          {code.code} ({trim(code.currentRate) || '0'}%)
        </option>
      ))}
    </select>
  );
}

export function ApInvoiceForm({
  call,
  canPost,
  canCancel,
  canOverride,
  currency,
  initialVendorId,
  onClose,
}: {
  call: ApiCall;
  canPost: boolean;
  canCancel: boolean;
  canOverride: boolean;
  currency: string;
  initialVendorId: string | null;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'add' | 'view'>(canPost ? 'add' : 'view');
  const [documentType, setDocumentType] = useState<'item' | 'service'>('item');
  const [invoice, setInvoice] = useState<ApInvoice | null>(null);
  const [vendors, setVendors] = useState<PartnerSummary[]>([]);
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [taxCodes, setTaxCodes] = useState<TaxCode[]>([]);
  const [vendorId, setVendorId] = useState(initialVendorId ?? '');
  const [receiptLines, setReceiptLines] = useState<ReceiptDraft[]>([]);
  const [directLines, setDirectLines] = useState<DirectDraft[]>([]);
  const [accountLines, setAccountLines] = useState<AccountDraft[]>([emptyAccount()]);
  const [postingDate, setPostingDate] = useState(today());
  const [documentDate, setDocumentDate] = useState(today());
  const [dueDate, setDueDate] = useState('');
  const [vendorReference, setVendorReference] = useState('');
  const [remarks, setRemarks] = useState('');
  const [priceOverride, setPriceOverride] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelDate, setCancelDate] = useState(today());
  const [cancelReason, setCancelReason] = useState('');
  const [cancelKey, setCancelKey] = useState(() => crypto.randomUUID());
  const [choices, setChoices] = useState<ApInvoiceSummary[] | null>(null);

  useEffect(() => {
    void Promise.all([
      call<Page<PartnerSummary>>('GET', '/v1/bp/partners?partnerType=supplier&status=active&limit=200'),
      call<Page<ItemSummary>>('GET', '/v1/inv/items?status=active&limit=200'),
      call<Warehouse[]>('GET', '/v1/inv/warehouses'),
      call<Account[]>('GET', '/v1/fin/accounts'),
      call<TaxCode[]>('GET', '/v1/fin/tax-codes'),
    ]).then(([v, i, w, a, t]) => {
      if (v.ok) setVendors(v.body.items);
      if (i.ok) setItems(i.body.items);
      if (w.ok) setWarehouses(w.body.filter((row) => row.status === 'active'));
      if (a.ok) setAccounts(a.body.filter((row) => !row.isTitle && row.status === 'active' && !row.controlKind));
      if (t.ok) setTaxCodes(t.body.filter((row) => row.status === 'active' && row.purpose !== 'sales'));
    });
  }, [call]);

  useEffect(() => {
    if (!vendorId || mode !== 'add' || documentType !== 'item') {
      setReceiptLines([]);
      return;
    }
    void call<InvoiceableReceiptLine[]>('GET', `/v1/pur/invoiceable?vendorId=${vendorId}`).then((result) => {
      if (!result.ok) {
        setError(errorMessage(result));
        return;
      }
      setReceiptLines(result.body.map((line) => ({ ...line, selected: false, quantity: trim(line.openQuantity), unitPrice: trim(line.receiptPrice), taxCodeId: '' })));
    });
  }, [call, documentType, mode, vendorId]);

  const load = useCallback(
    async (id: string) => {
      const result = await call<ApInvoice>('GET', `/v1/pur/invoices/${id}`);
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

  const codeById = useCallback((id: string) => taxCodes.find((code) => code.id === id), [taxCodes]);
  const totals = useMemo(() => {
    const rows: { amount: bigint; taxCodeId: string }[] =
      documentType === 'service'
        ? accountLines.filter((line) => line.accountId).map((line) => ({ amount: toMinor(line.amount || '0') ?? 0n, taxCodeId: line.taxCodeId }))
        : [
            ...receiptLines.filter((line) => line.selected).map((line) => ({ amount: multiply(line.quantity, line.unitPrice), taxCodeId: line.taxCodeId })),
            ...directLines.filter((line) => line.itemId).map((line) => ({ amount: multiply(line.quantity, line.unitPrice), taxCodeId: line.taxCodeId })),
          ];
    const subtotal = rows.reduce((sum, row) => sum + row.amount, 0n);
    const tax = rows.reduce((sum, row) => sum + taxOf(row.amount, rateOn(codeById(row.taxCodeId), postingDate)), 0n);
    return { subtotal, tax, total: subtotal + tax, count: rows.length };
  }, [accountLines, codeById, directLines, documentType, postingDate, receiptLines]);

  const dirty = mode === 'add' && totals.count > 0;

  const reset = () => {
    setInvoice(null);
    setMode('add');
    setVendorId('');
    setVendorReference('');
    setRemarks('');
    setPriceOverride(false);
    setDirectLines([]);
    setAccountLines([emptyAccount()]);
    setError(null);
    setNotice(null);
    setIdempotencyKey(crypto.randomUUID());
  };

  useRecordToolbar({
    find: () =>
      void call<Page<ApInvoiceSummary>>('GET', '/v1/pur/invoices?limit=200').then((result) => {
        if (result.ok) setChoices(result.body.items);
        else setError(errorMessage(result));
      }),
    add: canPost
      ? () => {
          if (dirty && !window.confirm('Discard this A/P invoice?')) return;
          reset();
        }
      : undefined,
  });

  const setReceipt = (id: string, patch: Partial<ReceiptDraft>) => setReceiptLines((current) => current.map((line) => (line.receiptLineId === id ? { ...line, ...patch } : line)));
  const setDirect = (key: string, patch: Partial<DirectDraft>) => setDirectLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const setAccountLine = (key: string, patch: Partial<AccountDraft>) => setAccountLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    if (mode === 'view') {
      onClose();
      return;
    }
    setError(null);
    if (!vendorId || totals.count === 0) {
      setError(documentType === 'service' ? 'Choose a vendor and enter at least one G/L account line.' : 'Choose a vendor and select a goods receipt line or add an item line.');
      return;
    }
    const clean = (value: string) => value.replace(/,/g, '').trim();
    const lines =
      documentType === 'service'
        ? accountLines
            .filter((line) => line.accountId)
            .map((line) => ({ kind: 'account', accountId: line.accountId, description: line.description || 'Service', amount: clean(line.amount) || '0', taxCodeId: line.taxCodeId || null }))
        : [
            ...receiptLines
              .filter((line) => line.selected)
              .map((line) => ({ kind: 'receipt', receiptLineId: line.receiptLineId, quantity: clean(line.quantity), unitPrice: clean(line.unitPrice), taxCodeId: line.taxCodeId || null })),
            ...directLines
              .filter((line) => line.itemId)
              .map((line) => ({
                kind: 'item',
                itemId: line.itemId,
                quantity: clean(line.quantity),
                unitPrice: clean(line.unitPrice) || '0',
                warehouseId: line.warehouseId || null,
                taxCodeId: line.taxCodeId || null,
              })),
          ];
    setBusy(true);
    const result = await call<ApInvoice>('POST', '/v1/pur/invoices', {
      idempotencyKey,
      documentType,
      vendorId,
      postingDate,
      documentDate,
      dueDate: dueDate || undefined,
      vendorReference,
      remarks,
      priceOverride,
      lines,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.status === 0 ? `${errorMessage(result)} Choosing Add again safely retries the same invoice.` : errorMessage(result));
      return;
    }
    setNotice(`A/P invoice ${result.body.documentNumber} posted${result.body.journalNumber ? ` with journal entry ${result.body.journalNumber}` : ''}.`);
    setInvoice(result.body);
    setMode('view');
    setIdempotencyKey(crypto.randomUUID());
  };

  const cancelInvoice = async () => {
    if (!invoice || busy) return;
    if (!cancelReason.trim()) {
      setError('Enter a reason for the cancellation.');
      return;
    }
    if (!window.confirm(`Cancel A/P invoice ${invoice.documentNumber}? A cancellation document will reverse its journal and stock effects.`)) return;
    setBusy(true);
    setError(null);
    const result = await call<ApInvoice>('POST', `/v1/pur/invoices/${invoice.id}/cancel`, { idempotencyKey: cancelKey, postingDate: cancelDate, reason: cancelReason.trim() });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setCancelKey(crypto.randomUUID());
    setNotice(`Cancellation ${result.body.documentNumber} posted.`);
    await load(invoice.id);
  };

  const closeForm = () => {
    if (dirty && !window.confirm('Discard this A/P invoice?')) return;
    onClose();
  };

  return (
    <form onSubmit={submit} noValidate>
      <FormWindow
        title={mode === 'view' && invoice ? `A/P Invoice ${invoice.documentNumber}${invoice.isCancellation ? ' (Cancellation)' : ''}` : 'A/P Invoice - Add'}
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
          mode === 'view' && invoice && canCancel && !invoice.isCancellation && invoice.status === 'posted' ? (
            <Button type="button" onClick={() => setCancelling((value) => !value)}>
              Cancel Document
            </Button>
          ) : null
        }
      >
        {error ? <Banner>{error}</Banner> : null}
        {notice ? <Banner tone="info">{notice}</Banner> : null}
        {mode === 'view' && invoice ? (
          <InvoiceView invoice={invoice} onOpen={(id) => void load(id)} />
        ) : mode === 'add' ? (
          <>
            <div className="form-columns">
              <div>
                <label className="ui-field">
                  <span>Vendor</span>
                  <select className="grid-input" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                    <option value="" />
                    {vendors.map((vendor) => (
                      <option key={vendor.id} value={vendor.id}>
                        {vendor.code} - {vendor.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="ui-field">
                  <span>Vendor Ref. No.</span>
                  <input className="grid-input" value={vendorReference} maxLength={60} onChange={(e) => setVendorReference(e.target.value)} />
                </label>
                <label className="ui-field">
                  <span>Item/Service Type</span>
                  <select className="grid-input" value={documentType} onChange={(e) => setDocumentType(e.target.value as 'item' | 'service')}>
                    <option value="item">Item</option>
                    <option value="service">Service</option>
                  </select>
                </label>
                <label className="ui-field">
                  <span>Remarks</span>
                  <input className="grid-input" value={remarks} maxLength={500} onChange={(e) => setRemarks(e.target.value)} />
                </label>
              </div>
              <div>
                <label className="ui-field">
                  <span>Posting Date</span>
                  <input className="grid-input" type="date" value={postingDate} onChange={(e) => setPostingDate(e.target.value)} />
                </label>
                <label className="ui-field">
                  <span>Document Date</span>
                  <input className="grid-input" type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
                </label>
                <label className="ui-field">
                  <span>Due Date</span>
                  <input className="grid-input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                </label>
              </div>
            </div>
            {!vendorId ? (
              <p className="ui-muted">Choose a vendor to continue.</p>
            ) : documentType === 'service' ? (
              <>
                <div className="form-section">G/L Account Lines</div>
                <div className="ui-table-wrap">
                  <table className="ui-table">
                    <thead>
                      <tr>
                        <th className="ui-table__row-number">#</th>
                        <th>G/L Account</th>
                        <th>Description</th>
                        <th className="numeric">Amount</th>
                        <th>Tax Code</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {accountLines.map((line, index) => (
                        <tr key={line.key}>
                          <td className="ui-table__row-number">{index + 1}</td>
                          <td>
                            <select className="grid-input" aria-label={`Line ${index + 1} account`} value={line.accountId} onChange={(e) => setAccountLine(line.key, { accountId: e.target.value })}>
                              <option value="" />
                              {accounts.map((account) => (
                                <option key={account.id} value={account.id}>
                                  {account.code} - {account.name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <input className="grid-input" aria-label={`Line ${index + 1} description`} value={line.description} maxLength={200} onChange={(e) => setAccountLine(line.key, { description: e.target.value })} />
                          </td>
                          <td>
                            <input className="grid-input grid-input--number" inputMode="decimal" aria-label={`Line ${index + 1} amount`} value={line.amount} onChange={(e) => setAccountLine(line.key, { amount: e.target.value })} />
                          </td>
                          <td>
                            <TaxSelect codes={taxCodes} value={line.taxCodeId} label={`Line ${index + 1} tax code`} onChange={(value) => setAccountLine(line.key, { taxCodeId: value })} />
                          </td>
                          <td>
                            {accountLines.length > 1 ? (
                              <Button type="button" variant="ghost" aria-label={`Remove line ${index + 1}`} onClick={() => setAccountLines((current) => current.filter((row) => row.key !== line.key))}>
                                ×
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="pager">
                  <Button type="button" onClick={() => setAccountLines((current) => [...current, emptyAccount()])}>
                    Add Line
                  </Button>
                </p>
              </>
            ) : (
              <>
                <div className="form-section">Copy From Goods Receipt PO</div>
                {receiptLines.length === 0 ? (
                  <p className="ui-muted">This vendor has no goods receipts left to invoice.</p>
                ) : (
                  <div className="ui-table-wrap">
                    <table className="ui-table">
                      <thead>
                        <tr>
                          <th />
                          <th>Goods Receipt</th>
                          <th>PO</th>
                          <th>Item No.</th>
                          <th className="numeric">Open</th>
                          <th className="numeric">Quantity</th>
                          <th className="numeric">Receipt Price</th>
                          <th className="numeric">Invoice Price</th>
                          <th>Tax Code</th>
                          <th className="numeric">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {receiptLines.map((line) => (
                          <tr key={line.receiptLineId}>
                            <td>
                              <input type="checkbox" aria-label={`Invoice ${line.receiptNumber} ${line.itemCode}`} checked={line.selected} onChange={(e) => setReceipt(line.receiptLineId, { selected: e.target.checked })} />
                            </td>
                            <td>{line.receiptNumber}</td>
                            <td>{line.orderNumber}</td>
                            <td>{line.itemCode}</td>
                            <td className="numeric">{trim(line.openQuantity)}</td>
                            <td>
                              <input className="grid-input grid-input--number" inputMode="decimal" aria-label={`${line.itemCode} quantity`} value={line.quantity} disabled={!line.selected} onChange={(e) => setReceipt(line.receiptLineId, { quantity: e.target.value })} />
                            </td>
                            <td className="numeric">{formatAmount(line.receiptPrice)}</td>
                            <td>
                              <input
                                className={`grid-input grid-input--number${line.unitPrice !== trim(line.receiptPrice) ? ' grid-input--changed' : ''}`}
                                inputMode="decimal"
                                aria-label={`${line.itemCode} invoice price`}
                                value={line.unitPrice}
                                disabled={!line.selected}
                                onChange={(e) => setReceipt(line.receiptLineId, { unitPrice: e.target.value })}
                              />
                            </td>
                            <td>
                              <TaxSelect codes={taxCodes} value={line.taxCodeId} disabled={!line.selected} label={`${line.itemCode} tax code`} onChange={(value) => setReceipt(line.receiptLineId, { taxCodeId: value })} />
                            </td>
                            <td className="numeric">{line.selected ? formatAmount(fromMinor(multiply(line.quantity, line.unitPrice))) : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="form-section">Items Without Goods Receipt</div>
                {directLines.length > 0 ? (
                  <div className="ui-table-wrap">
                    <table className="ui-table">
                      <thead>
                        <tr>
                          <th className="ui-table__row-number">#</th>
                          <th>Item No.</th>
                          <th className="numeric">Quantity</th>
                          <th className="numeric">Unit Price</th>
                          <th>Whse</th>
                          <th>Tax Code</th>
                          <th className="numeric">Total</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {directLines.map((line, index) => {
                          const item = items.find((row) => row.id === line.itemId);
                          return (
                            <tr key={line.key}>
                              <td className="ui-table__row-number">{index + 1}</td>
                              <td>
                                <select className="grid-input" aria-label={`Direct line ${index + 1} item`} value={line.itemId} onChange={(e) => setDirect(line.key, { itemId: e.target.value })}>
                                  <option value="" />
                                  {items.map((row) => (
                                    <option key={row.id} value={row.id}>
                                      {row.code} - {row.name}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                <input className="grid-input grid-input--number" inputMode="decimal" aria-label={`Direct line ${index + 1} quantity`} value={line.quantity} onChange={(e) => setDirect(line.key, { quantity: e.target.value })} />
                              </td>
                              <td>
                                <input className="grid-input grid-input--number" inputMode="decimal" aria-label={`Direct line ${index + 1} price`} value={line.unitPrice} onChange={(e) => setDirect(line.key, { unitPrice: e.target.value })} />
                              </td>
                              <td>
                                <select
                                  className="grid-input"
                                  aria-label={`Direct line ${index + 1} warehouse`}
                                  value={line.warehouseId}
                                  disabled={item ? item.itemType !== 'inventory' : false}
                                  onChange={(e) => setDirect(line.key, { warehouseId: e.target.value })}
                                >
                                  <option value="">{item && item.itemType !== 'inventory' ? 'Not stocked' : 'Item default'}</option>
                                  {warehouses.map((warehouse) => (
                                    <option key={warehouse.id} value={warehouse.id}>
                                      {warehouse.code}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                <TaxSelect codes={taxCodes} value={line.taxCodeId} label={`Direct line ${index + 1} tax code`} onChange={(value) => setDirect(line.key, { taxCodeId: value })} />
                              </td>
                              <td className="numeric">{formatAmount(fromMinor(multiply(line.quantity, line.unitPrice)))}</td>
                              <td>
                                <Button type="button" variant="ghost" aria-label={`Remove direct line ${index + 1}`} onClick={() => setDirectLines((current) => current.filter((row) => row.key !== line.key))}>
                                  ×
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                <p className="pager">
                  <Button type="button" onClick={() => setDirectLines((current) => [...current, emptyDirect()])}>
                    Add Item Line
                  </Button>
                  <span className="ui-muted">Stocked items on these lines are received into the warehouse by the invoice itself.</span>
                </p>
              </>
            )}
            <div className="totals-block">
              <ReadField label="Total Before Tax" value={`${formatAmount(fromMinor(totals.subtotal))} ${currency}`} />
              <ReadField label="Tax" value={`${formatAmount(fromMinor(totals.tax))} ${currency}`} />
              <ReadField label="Total Payment Due" value={<strong>{`${formatAmount(fromMinor(totals.total))} ${currency}`}</strong>} />
            </div>
            {canOverride && documentType === 'item' ? (
              <label className="flag-row">
                <input type="checkbox" checked={priceOverride} onChange={(e) => setPriceOverride(e.target.checked)} /> Allow price differences beyond the purchasing tolerance
              </label>
            ) : null}
            <p className="ui-muted">
              Due date defaults from the vendor's payment terms. Price differences on stocked items revalue stock still on hand; any remainder goes to the price difference account. Tax is calculated by the server
              from the tax code rate valid on the posting date.
            </p>
          </>
        ) : (
          <p className="ui-muted">Use Find to open an A/P invoice.</p>
        )}
        {cancelling && invoice ? (
          <div className="reverse-panel">
            <div className="form-section">Cancel A/P Invoice</div>
            <div className="inline-fields">
              <label className="ui-field">
                <span>Cancellation Date</span>
                <input className="grid-input" type="date" value={cancelDate} onChange={(e) => setCancelDate(e.target.value)} />
              </label>
              <label className="ui-field">
                <span>Reason</span>
                <input className="grid-input" value={cancelReason} maxLength={500} onChange={(e) => setCancelReason(e.target.value)} />
              </label>
              <Button type="button" variant="primary" busy={busy} onClick={() => void cancelInvoice()}>
                Post Cancellation
              </Button>
            </div>
            <p className="ui-muted">Reverses the payable, tax, stock received and stock revaluation. Blocked when later stock transactions would require recosting.</p>
          </div>
        ) : null}
      </FormWindow>
      {choices ? (
        <div className="modal-backdrop" role="presentation">
          <FormWindow
            title="List of A/P Invoices"
            width={760}
            onClose={() => setChoices(null)}
            footerLeft={
              <Button type="button" onClick={() => setChoices(null)}>
                Cancel
              </Button>
            }
          >
            {choices.length === 0 ? (
              <p className="ui-muted">No A/P invoices yet.</p>
            ) : (
              <div className="ui-table-wrap">
                <table className="ui-table company-grid">
                  <thead>
                    <tr>
                      <th>No.</th>
                      <th>Vendor</th>
                      <th>Vendor Ref.</th>
                      <th>Posting Date</th>
                      <th>Due Date</th>
                      <th className="numeric">Total</th>
                      <th className="numeric">Balance Due</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {choices.map((row) => (
                      <tr
                        key={row.id}
                        onDoubleClick={() => {
                          setChoices(null);
                          void load(row.id);
                        }}
                      >
                        <td>
                          <LinkArrow
                            label={`Open ${row.documentNumber}`}
                            onClick={() => {
                              setChoices(null);
                              void load(row.id);
                            }}
                          />
                          {row.documentNumber}
                        </td>
                        <td>{row.vendorName}</td>
                        <td>{row.vendorReference ?? ''}</td>
                        <td>{row.postingDate}</td>
                        <td>{row.dueDate}</td>
                        <td className="numeric">{formatAmount(row.total)}</td>
                        <td className="numeric">{formatAmount(row.openAmount)}</td>
                        <td>{row.isCancellation ? 'cancellation' : row.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </FormWindow>
        </div>
      ) : null}
    </form>
  );
}

function InvoiceView({ invoice, onOpen }: { invoice: ApInvoice; onOpen: (id: string) => void }) {
  return (
    <>
      <div className="form-columns">
        <div>
          <ReadField label="Vendor" value={`${invoice.vendorCode} - ${invoice.vendorName}`} />
          <ReadField label="Vendor Ref. No." value={invoice.vendorReference ?? ''} />
          <ReadField label="Item/Service Type" value={invoice.documentType === 'service' ? 'Service' : 'Item'} />
          <ReadField label="Journal Entry" value={invoice.journalNumber ?? 'None'} />
        </div>
        <div>
          <ReadField label="No." value={invoice.documentNumber} />
          <ReadField label="Status" value={<StatusBadge status={invoice.status === 'posted' ? 'active' : 'cancelled'} />} />
          <ReadField label="Posting Date" value={invoice.postingDate} />
          <ReadField label="Document Date" value={invoice.documentDate} />
          <ReadField label="Due Date" value={invoice.dueDate} />
        </div>
      </div>
      {invoice.priceOverride ? <Banner tone="warning">Posted with a price override: invoice prices differ from the goods receipts beyond tolerance.</Banner> : null}
      {invoice.cancellationReason ? <p className="ui-muted">Cancellation reason: {invoice.cancellationReason}</p> : null}
      {invoice.cancelledById || invoice.cancellationOfId ? (
        <p className="pager">
          <LinkArrow label="Open linked document" onClick={() => onOpen(invoice.cancelledById ?? invoice.cancellationOfId ?? '')} />
          {invoice.cancelledById ? 'Cancelled by a cancellation document' : 'Cancels the original invoice'}
        </p>
      ) : null}
      <div className="ui-table-wrap journal-grid">
        <table className="ui-table">
          <thead>
            <tr>
              <th className="ui-table__row-number">#</th>
              <th>Base</th>
              <th>Item / Account</th>
              <th>Description</th>
              <th className="numeric">Quantity</th>
              <th className="numeric">Receipt Price</th>
              <th className="numeric">Price</th>
              <th>Tax Code</th>
              <th className="numeric">Tax</th>
              <th className="numeric">Stock Reval.</th>
              <th className="numeric">Price Diff.</th>
              <th className="numeric">Total ({invoice.currency})</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((line) => (
              <tr key={line.id}>
                <td className="ui-table__row-number">{line.lineNo}</td>
                <td>{line.receiptNumber ?? (line.lineKind === 'account' ? 'G/L' : 'Direct')}</td>
                <td>{line.itemCode ?? line.accountCode ?? ''}</td>
                <td>{line.description}</td>
                <td className="numeric">{trim(line.quantity)}</td>
                <td className="numeric">{line.receiptPrice ? formatAmount(line.receiptPrice) : ''}</td>
                <td className={line.receiptPrice && line.unitPrice !== line.receiptPrice ? 'numeric balance-off' : 'numeric'}>{formatAmount(line.unitPrice)}</td>
                <td>{line.taxCode ?? ''}</td>
                <td className="numeric">{formatAmount(line.taxAmount)}</td>
                <td className="numeric">{line.stockRevaluation !== '0.0000' ? formatAmount(line.stockRevaluation) : ''}</td>
                <td className="numeric">{line.priceDifference !== '0.0000' ? formatAmount(line.priceDifference) : ''}</td>
                <td className="numeric">{formatAmount(line.lineTotal)}</td>
              </tr>
            ))}
            <tr className="totals-row">
              <td colSpan={11}>Total Before Tax</td>
              <td className="numeric">{formatAmount(invoice.subtotal)}</td>
            </tr>
            <tr className="totals-row">
              <td colSpan={11}>Tax</td>
              <td className="numeric">{formatAmount(invoice.taxTotal)}</td>
            </tr>
            <tr className="totals-row">
              <td colSpan={11}>Total Payment Due</td>
              <td className="numeric">{formatAmount(invoice.total)}</td>
            </tr>
            <tr className="totals-row">
              <td colSpan={11}>Balance Due</td>
              <td className="numeric">{formatAmount(invoice.openAmount)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
