import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { Account, OpenPaymentItem, Page, PartnerSummary, Payment, PaymentDirection, PaymentMeans, PaymentSummary } from '@nec/contracts';
import { Banner, Button, FormWindow, LinkArrow, StatusBadge } from '@nec/ui';
import { errorMessage } from '../api';
import type { ApiResult } from '../erp';
import { formatAmount, fromMinor, toMinor, today } from '../format';
import type { ApiCall } from '../screens/Shell';
import { useRecordToolbar } from '../toolbar';

interface InvoiceDraft extends OpenPaymentItem {
  selected: boolean;
  payment: string;
}

const MEANS_LABELS: Record<PaymentMeans, string> = { cash: 'Cash', bank_transfer: 'Bank Transfer', cheque: 'Check' };

const DIRECTIONS = {
  outgoing: {
    title: 'Outgoing Payment',
    windowTitle: 'Outgoing Payments',
    partner: 'Vendor',
    partnerType: 'supplier',
    partnerField: 'vendorId',
    path: '/v1/bank/outgoing-payments',
    openPath: (id: string) => `/v1/bank/open-invoices?vendorId=${id}`,
    openSection: 'Open A/P Invoices',
    empty: 'This vendor has no open A/P invoices or opening balances.',
    reference: 'Vendor Ref.',
    note: 'The payment debits the vendor through the payables control account and credits the chosen cash or bank account. Any amount not applied to invoices stays on account and can be allocated later.',
  },
  incoming: {
    title: 'Incoming Payment',
    windowTitle: 'Incoming Payments',
    partner: 'Customer',
    partnerType: 'customer',
    partnerField: 'customerId',
    path: '/v1/bank/incoming-payments',
    openPath: (id: string) => `/v1/bank/open-receivables?customerId=${id}`,
    openSection: 'Open A/R Invoices and Items',
    empty: 'This customer has no open receivables or opening balances.',
    reference: 'Customer Ref.',
    note: 'The payment debits the chosen cash or bank account and credits the customer through the receivables control account. Any amount not applied to open items stays on account and can be allocated later.',
  },
} as const;

function trim(value: string | null): string {
  if (!value) return '';
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

const clean = (value: string) => value.replace(/,/g, '').trim();
const rowKey = (row: OpenPaymentItem) => (row.invoiceId ?? row.openingLineId) as string;
const target = (row: OpenPaymentItem) =>
  row.documentType === 'ar_invoice' ? { arInvoiceId: row.invoiceId as string } : row.invoiceId ? { invoiceId: row.invoiceId } : { openingLineId: row.openingLineId as string };
const minor = (value: string) => toMinor(clean(value) || '0') ?? 0n;

function ReadField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="ui-field">
      <span>{label}</span>
      <span className="form-value">{value}</span>
    </div>
  );
}

function OpenInvoiceGrid({
  rows,
  onChange,
  label,
  direction,
}: {
  rows: InvoiceDraft[];
  onChange: (id: string, patch: Partial<InvoiceDraft>) => void;
  label: string;
  direction: PaymentDirection;
}) {
  if (rows.length === 0) return <p className="ui-muted">{DIRECTIONS[direction].empty}</p>;
  return (
    <div className="ui-table-wrap">
      <table className="ui-table" aria-label={label}>
        <thead>
          <tr>
            <th />
            <th>Document No.</th>
            <th>{DIRECTIONS[direction].reference}</th>
            <th>Posting Date</th>
            <th>Due Date</th>
            <th className="numeric">Total</th>
            <th className="numeric">Balance Due</th>
            <th className="numeric">Total Payment</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              <td>
                <input type="checkbox" aria-label={`Pay ${row.documentNumber}`} checked={row.selected} onChange={(e) => onChange(rowKey(row), { selected: e.target.checked })} />
              </td>
              <td>{row.documentNumber}</td>
              <td>{row.vendorReference ?? ''}</td>
              <td>{row.postingDate}</td>
              <td>{row.dueDate}</td>
              <td className="numeric">{formatAmount(row.total)}</td>
              <td className="numeric">{formatAmount(row.openAmount)}</td>
              <td>
                <input
                  className="grid-input grid-input--number"
                  inputMode="decimal"
                  aria-label={`${row.documentNumber} payment amount`}
                  value={row.payment}
                  disabled={!row.selected}
                  onChange={(e) => onChange(rowKey(row), { payment: e.target.value })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PaymentForm({
  call,
  direction,
  canPost,
  canCancel,
  canUnallocate,
  currency,
  onClose,
}: {
  call: ApiCall;
  direction: PaymentDirection;
  canPost: boolean;
  canCancel: boolean;
  canUnallocate: boolean;
  currency: string;
  onClose: () => void;
}) {
  const config = DIRECTIONS[direction];
  const [mode, setMode] = useState<'add' | 'view'>(canPost ? 'add' : 'view');
  const [payment, setPayment] = useState<Payment | null>(null);
  const [vendors, setVendors] = useState<PartnerSummary[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [vendorId, setVendorId] = useState('');
  const [invoices, setInvoices] = useState<InvoiceDraft[]>([]);
  const [postingDate, setPostingDate] = useState(today());
  const [documentDate, setDocumentDate] = useState(today());
  const [reference, setReference] = useState('');
  const [remarks, setRemarks] = useState('');
  const [means, setMeans] = useState<PaymentMeans>('bank_transfer');
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [amountEdited, setAmountEdited] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<'none' | 'cancel' | 'allocate'>('none');
  const [actionDate, setActionDate] = useState(today());
  const [cancelReason, setCancelReason] = useState('');
  const [actionKey, setActionKey] = useState(() => crypto.randomUUID());
  const [allocateRows, setAllocateRows] = useState<InvoiceDraft[]>([]);
  const [choices, setChoices] = useState<PaymentSummary[] | null>(null);

  useEffect(() => {
    void Promise.all([
      call<Page<PartnerSummary>>('GET', `/v1/bp/partners?partnerType=${config.partnerType}&status=active&limit=200`),
      call<Account[]>('GET', '/v1/fin/accounts'),
    ]).then(([v, a]) => {
      if (v.ok) setVendors(v.body.items);
      if (a.ok) setAccounts(a.body.filter((row) => row.accountType === 'asset' && !row.isTitle && row.status === 'active' && !row.controlKind));
    });
  }, [call, config]);

  const openInvoices = useCallback(
    async (id: string): Promise<InvoiceDraft[]> => {
      const result = await call<OpenPaymentItem[]>('GET', config.openPath(id));
      if (!result.ok) {
        setError(errorMessage(result));
        return [];
      }
      return result.body.map((row) => ({ ...row, selected: false, payment: trim(row.openAmount) }));
    },
    [call, config],
  );

  useEffect(() => {
    if (!vendorId || mode !== 'add') {
      setInvoices([]);
      return;
    }
    void openInvoices(vendorId).then(setInvoices);
  }, [mode, openInvoices, vendorId]);

  const allocated = useMemo(() => invoices.filter((row) => row.selected).reduce((sum, row) => sum + minor(row.payment), 0n), [invoices]);
  const paymentAmount = amountEdited ? minor(amount) : allocated;
  const onAccount = paymentAmount > allocated ? paymentAmount - allocated : 0n;
  const dirty = mode === 'add' && (allocated > 0n || (amountEdited && minor(amount) > 0n));

  const load = useCallback(
    async (id: string) => {
      const result = await call<Payment>('GET', `${config.path}/${id}`);
      if (!result.ok) {
        setError(errorMessage(result));
        return;
      }
      setPayment(result.body);
      setMode('view');
      setPanel('none');
    },
    [call, config],
  );

  const reset = () => {
    setPayment(null);
    setMode('add');
    setVendorId('');
    setReference('');
    setRemarks('');
    setAmount('');
    setAmountEdited(false);
    setAccountId('');
    setError(null);
    setNotice(null);
    setIdempotencyKey(crypto.randomUUID());
  };

  useRecordToolbar({
    find: () =>
      void call<Page<PaymentSummary>>('GET', `${config.path}?limit=200`).then((result) => {
        if (result.ok) setChoices(result.body.items);
        else setError(errorMessage(result));
      }),
    add: canPost
      ? () => {
          if (dirty && !window.confirm(`Discard this ${config.title.toLowerCase()}?`)) return;
          reset();
        }
      : undefined,
  });

  const setInvoice = (id: string, patch: Partial<InvoiceDraft>) => setInvoices((current) => current.map((row) => (rowKey(row) === id ? { ...row, ...patch } : row)));
  const setAllocateRow = (id: string, patch: Partial<InvoiceDraft>) => setAllocateRows((current) => current.map((row) => (rowKey(row) === id ? { ...row, ...patch } : row)));

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    if (mode === 'view') {
      onClose();
      return;
    }
    setError(null);
    if (!vendorId) {
      setError(`Choose a ${config.partner.toLowerCase()}.`);
      return;
    }
    if (paymentAmount <= 0n) {
      setError('Select invoices to pay or enter a payment amount.');
      return;
    }
    if (paymentAmount < allocated) {
      setError('The payment amount is less than the total applied to invoices.');
      return;
    }
    if (onAccount > 0n && !window.confirm(`${formatAmount(fromMinor(onAccount))} ${currency} will remain on account for this ${config.partner.toLowerCase()}. Continue?`)) return;
    setBusy(true);
    const result = await call<Payment>('POST', config.path, {
      idempotencyKey,
      [config.partnerField]: vendorId,
      postingDate,
      documentDate,
      paymentMeans: means,
      accountId: accountId || undefined,
      amount: fromMinor(paymentAmount),
      reference,
      remarks,
      allocations: invoices.filter((row) => row.selected).map((row) => ({ ...target(row), amount: clean(row.payment) })),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.status === 0 ? `${errorMessage(result)} Choosing Add again safely retries the same payment.` : errorMessage(result));
      return;
    }
    setNotice(`${config.title} ${result.body.documentNumber} posted with journal entry ${result.body.journalNumber}.`);
    setPayment(result.body);
    setMode('view');
    setIdempotencyKey(crypto.randomUUID());
  };

  const togglePanel = async (next: 'cancel' | 'allocate') => {
    setError(null);
    if (panel === next) {
      setPanel('none');
      return;
    }
    if (next === 'allocate' && payment) setAllocateRows(await openInvoices(payment.partnerId));
    setActionKey(crypto.randomUUID());
    setPanel(next);
  };

  const finishAction = async (result: ApiResult, message: string) => {
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setActionKey(crypto.randomUUID());
    setNotice(message);
    if (payment) await load(payment.id);
  };

  const cancelPayment = async () => {
    if (!payment || busy) return;
    if (!cancelReason.trim()) {
      setError('Enter a reason for the cancellation.');
      return;
    }
    const active = payment.allocations.filter((row) => row.active).length;
    if (!window.confirm(`Cancel ${config.title.toLowerCase()} ${payment.documentNumber}? The payment journal will be reversed${active ? ` and ${active} invoice allocation(s) undone` : ''}.`)) return;
    setBusy(true);
    setError(null);
    const result = await call<Payment>('POST', `${config.path}/${payment.id}/cancel`, { idempotencyKey: actionKey, postingDate: actionDate, reason: cancelReason.trim() });
    await finishAction(result, result.ok ? `Cancellation ${result.body.documentNumber} posted.` : '');
  };

  const allocate = async () => {
    if (!payment || busy) return;
    const rows = allocateRows.filter((row) => row.selected);
    if (rows.length === 0) {
      setError('Select at least one invoice.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await call<Payment>('POST', `${config.path}/${payment.id}/allocations`, {
      idempotencyKey: actionKey,
      allocationDate: actionDate,
      allocations: rows.map((row) => ({ ...target(row), amount: clean(row.payment) })),
    });
    await finishAction(result, 'Allocation posted.');
  };

  const unallocate = async (allocationId: string, invoiceNumber: string) => {
    if (!payment || busy) return;
    const reason = window.prompt(`Reason for unallocating ${invoiceNumber}:`);
    if (!reason?.trim()) return;
    setBusy(true);
    setError(null);
    const result = await call<Payment>('POST', `${config.path}/${payment.id}/allocations/${allocationId}/unallocate`, {
      idempotencyKey: crypto.randomUUID(),
      unallocationDate: actionDate,
      reason: reason.trim(),
    });
    await finishAction(result, `Allocation to ${invoiceNumber} unallocated. The payment journal is unchanged.`);
  };

  const closeForm = () => {
    if (dirty && !window.confirm(`Discard this ${config.title.toLowerCase()}?`)) return;
    onClose();
  };

  const open = payment && payment.status === 'posted' && !payment.isCancellation;

  return (
    <form onSubmit={submit} noValidate>
      <FormWindow
        title={mode === 'view' && payment ? `${config.title} ${payment.documentNumber}${payment.isCancellation ? ' (Cancellation)' : ''}` : `${config.windowTitle} - Add`}
        onClose={closeForm}
        footerLeft={
          <>
            <Button type="submit" variant="primary" busy={busy && panel === 'none'}>
              {mode === 'add' ? 'Add' : 'OK'}
            </Button>
            <Button type="button" onClick={closeForm}>
              Cancel
            </Button>
          </>
        }
        footerRight={
          mode === 'view' && open ? (
            <>
              {canPost && payment.unappliedAmount !== '0.0000' ? (
                <Button type="button" onClick={() => void togglePanel('allocate')}>
                  Allocate Unapplied
                </Button>
              ) : null}
              {canCancel ? (
                <Button type="button" onClick={() => void togglePanel('cancel')}>
                  Cancel Payment
                </Button>
              ) : null}
            </>
          ) : null
        }
      >
        {error ? <Banner>{error}</Banner> : null}
        {notice ? <Banner tone="info">{notice}</Banner> : null}
        {mode === 'view' && payment ? (
          <PaymentView
            payment={payment}
            direction={direction}
            canUnallocate={canUnallocate && Boolean(open)}
            busy={busy}
            onOpen={(id) => void load(id)}
            onUnallocate={(id, number) => void unallocate(id, number)}
          />
        ) : mode === 'add' ? (
          <>
            <div className="form-columns">
              <div>
                <label className="ui-field">
                  <span>{config.partner}</span>
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
                  <span>Reference</span>
                  <input className="grid-input" value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} />
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
              </div>
            </div>
            {!vendorId ? (
              <p className="ui-muted">Choose a {config.partner.toLowerCase()} to continue.</p>
            ) : (
              <>
                <div className="form-section">{config.openSection}</div>
                <OpenInvoiceGrid rows={invoices} onChange={setInvoice} label={config.openSection} direction={direction} />
                <div className="form-section">Payment Means</div>
                <div className="form-columns">
                  <div>
                    <label className="ui-field">
                      <span>Means</span>
                      <select className="grid-input" value={means} onChange={(e) => setMeans(e.target.value as PaymentMeans)}>
                        {(Object.keys(MEANS_LABELS) as PaymentMeans[]).map((key) => (
                          <option key={key} value={key}>
                            {MEANS_LABELS[key]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="ui-field">
                      <span>G/L Account</span>
                      <select className="grid-input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                        <option value="">{means === 'cash' ? 'Default cash account' : 'Default bank account'}</option>
                        {accounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.code} - {account.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div>
                    <label className="ui-field">
                      <span>Amount</span>
                      <input
                        className="grid-input grid-input--number"
                        inputMode="decimal"
                        value={amountEdited ? amount : trim(fromMinor(allocated))}
                        onChange={(e) => {
                          setAmountEdited(true);
                          setAmount(e.target.value);
                        }}
                      />
                    </label>
                  </div>
                </div>
              </>
            )}
            <div className="totals-block">
              <ReadField label="Applied to Invoices" value={`${formatAmount(fromMinor(allocated))} ${currency}`} />
              <ReadField label="Payment on Account" value={`${formatAmount(fromMinor(onAccount))} ${currency}`} />
              <ReadField label="Total Amount Due" value={<strong>{`${formatAmount(fromMinor(paymentAmount))} ${currency}`}</strong>} />
            </div>
            <p className="ui-muted">
              {config.note}
            </p>
          </>
        ) : (
          <p className="ui-muted">Use Find to open an {config.title.toLowerCase()}.</p>
        )}
        {panel === 'allocate' && payment ? (
          <div className="reverse-panel">
            <div className="form-section">Allocate Unapplied Amount ({formatAmount(payment.unappliedAmount)} {payment.currency})</div>
            <OpenInvoiceGrid rows={allocateRows} onChange={setAllocateRow} label="Documents to allocate" direction={direction} />
            <div className="inline-fields">
              <label className="ui-field">
                <span>Allocation Date</span>
                <input className="grid-input" type="date" value={actionDate} onChange={(e) => setActionDate(e.target.value)} />
              </label>
              <Button type="button" variant="primary" busy={busy} onClick={() => void allocate()}>
                Post Allocation
              </Button>
            </div>
          </div>
        ) : null}
        {panel === 'cancel' && payment ? (
          <div className="reverse-panel">
            <div className="form-section">Cancel {config.title}</div>
            <div className="inline-fields">
              <label className="ui-field">
                <span>Cancellation Date</span>
                <input className="grid-input" type="date" value={actionDate} onChange={(e) => setActionDate(e.target.value)} />
              </label>
              <label className="ui-field">
                <span>Reason</span>
                <input className="grid-input" value={cancelReason} maxLength={500} onChange={(e) => setCancelReason(e.target.value)} />
              </label>
              <Button type="button" variant="primary" busy={busy} onClick={() => void cancelPayment()}>
                Post Cancellation
              </Button>
            </div>
            <p className="ui-muted">For an erroneous payment only. Reverses the payment journal and undoes its remaining invoice allocations in one step. A real refund needs its own document.</p>
          </div>
        ) : null}
      </FormWindow>
      {choices ? (
        <div className="modal-backdrop" role="presentation">
          <FormWindow
            title={`List of ${config.windowTitle}`}
            width={760}
            onClose={() => setChoices(null)}
            footerLeft={
              <Button type="button" onClick={() => setChoices(null)}>
                Cancel
              </Button>
            }
          >
            {choices.length === 0 ? (
              <p className="ui-muted">No {config.windowTitle.toLowerCase()} yet.</p>
            ) : (
              <div className="ui-table-wrap">
                <table className="ui-table company-grid">
                  <thead>
                    <tr>
                      <th>No.</th>
                      <th>{config.partner}</th>
                      <th>Posting Date</th>
                      <th>Means</th>
                      <th>Reference</th>
                      <th className="numeric">Amount</th>
                      <th className="numeric">Unapplied</th>
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
                        <td>{row.partnerName}</td>
                        <td>{row.postingDate}</td>
                        <td>{MEANS_LABELS[row.paymentMeans]}</td>
                        <td>{row.reference ?? ''}</td>
                        <td className="numeric">{formatAmount(row.amount)}</td>
                        <td className="numeric">{formatAmount(row.unappliedAmount)}</td>
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

function PaymentView({
  payment,
  direction,
  canUnallocate,
  busy,
  onOpen,
  onUnallocate,
}: {
  payment: Payment;
  direction: PaymentDirection;
  canUnallocate: boolean;
  busy: boolean;
  onOpen: (id: string) => void;
  onUnallocate: (allocationId: string, invoiceNumber: string) => void;
}) {
  return (
    <>
      <div className="form-columns">
        <div>
          <ReadField label={DIRECTIONS[direction].partner} value={`${payment.partnerCode} - ${payment.partnerName}`} />
          <ReadField label="Means" value={MEANS_LABELS[payment.paymentMeans]} />
          <ReadField label="G/L Account" value={`${payment.accountCode} - ${payment.accountName}`} />
          <ReadField label="Reference" value={payment.reference ?? ''} />
          <ReadField label="Journal Entry" value={payment.journalNumber} />
        </div>
        <div>
          <ReadField label="No." value={payment.documentNumber} />
          <ReadField label="Status" value={<StatusBadge status={payment.status === 'posted' ? 'active' : 'cancelled'} />} />
          <ReadField label="Posting Date" value={payment.postingDate} />
          <ReadField label="Document Date" value={payment.documentDate} />
        </div>
      </div>
      {payment.cancellationReason ? <p className="ui-muted">Cancellation reason: {payment.cancellationReason}</p> : null}
      {payment.cancelledById || payment.cancellationOfId ? (
        <p className="pager">
          <LinkArrow label="Open linked document" onClick={() => onOpen(payment.cancelledById ?? payment.cancellationOfId ?? '')} />
          {payment.cancelledById ? 'Cancelled by a cancellation document' : 'Cancels the original payment'}
        </p>
      ) : null}
      <div className="form-section">Invoice Allocations</div>
      {payment.allocations.length === 0 ? (
        <p className="ui-muted">{payment.isCancellation ? 'Allocations are recorded on the original payment.' : 'No allocations.'}</p>
      ) : (
        <div className="ui-table-wrap journal-grid">
          <table className="ui-table">
            <thead>
              <tr>
                <th className="ui-table__row-number">#</th>
                <th>Invoice</th>
                <th>{DIRECTIONS[direction].reference}</th>
                <th>Allocated On</th>
                <th className="numeric">Amount ({payment.currency})</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {payment.allocations.map((row, index) => (
                <tr key={row.id}>
                  <td className="ui-table__row-number">{index + 1}</td>
                  <td>{row.invoiceNumber}</td>
                  <td>{row.reference ?? ''}</td>
                  <td>{row.allocationDate}</td>
                  <td className="numeric">{formatAmount(row.amount)}</td>
                  <td>{row.active ? 'Active' : `Unallocated ${row.unallocationDate ?? ''}: ${row.unallocationReason ?? ''}`}</td>
                  <td>
                    {row.active && canUnallocate ? (
                      <Button type="button" variant="ghost" disabled={busy} onClick={() => onUnallocate(row.id, row.invoiceNumber)}>
                        Unallocate
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="totals-block">
        <ReadField label="Total Amount" value={`${formatAmount(payment.amount)} ${payment.currency}`} />
        <ReadField label="Applied to Invoices" value={`${formatAmount(payment.allocatedAmount)} ${payment.currency}`} />
        <ReadField label="Unapplied (on Account)" value={<strong>{`${formatAmount(payment.unappliedAmount)} ${payment.currency}`}</strong>} />
      </div>
    </>
  );
}
