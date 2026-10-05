import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { Account, OpeningBalance, OpeningBalanceKind, OpeningBalanceSummary, Page, PartnerSummary } from '@nec/contracts';
import { Banner, Button, FormWindow, LinkArrow, StatusBadge } from '@nec/ui';
import { errorMessage } from '../api';
import { formatAmount, fromMinor, toMinor, today } from '../format';
import type { ApiCall } from '../screens/Shell';
import { useRecordToolbar } from '../toolbar';
import { OpeningImportPanel } from './OpeningImportPanel';

interface LineDraft {
  key: string;
  targetId: string;
  reference: string;
  documentDate: string;
  dueDate: string;
  debit: string;
  credit: string;
}

const LABELS: Record<OpeningBalanceKind, string> = { account: 'G/L Accounts Opening Balance', partner: 'Business Partners Opening Balance' };

let keySeed = 0;
const emptyLine = (): LineDraft => ({ key: `ob-${++keySeed}`, targetId: '', reference: '', documentDate: '', dueDate: '', debit: '', credit: '' });
const clean = (value: string) => value.replace(/,/g, '').trim();
const minor = (value: string) => toMinor(clean(value) || '0') ?? 0n;

function ReadField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="ui-field">
      <span>{label}</span>
      <span className="form-value">{value}</span>
    </div>
  );
}

function amountCell(value: string): string {
  return value === '0.0000' ? '' : formatAmount(value);
}

function ChooserWindow({ title, rows, onPick, onClose }: { title: string; rows: OpeningBalanceSummary[]; onPick: (id: string) => void; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <FormWindow
        title={title}
        width={760}
        onClose={onClose}
        footerLeft={
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
        }
      >
        {rows.length === 0 ? (
          <p className="ui-muted">No opening balances yet.</p>
        ) : (
          <div className="ui-table-wrap">
            <table className="ui-table company-grid">
              <thead>
                <tr>
                  <th>No.</th>
                  <th>Posting Date</th>
                  <th>Reason</th>
                  <th className="numeric">Debit</th>
                  <th className="numeric">Credit</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} onDoubleClick={() => onPick(row.id)}>
                    <td>
                      <LinkArrow label={`Open ${row.documentNumber}`} onClick={() => onPick(row.id)} />
                      {row.documentNumber}
                    </td>
                    <td>{row.postingDate}</td>
                    <td>{row.reason}</td>
                    <td className="numeric">{amountCell(row.totalDebit)}</td>
                    <td className="numeric">{amountCell(row.totalCredit)}</td>
                    <td>{row.isCancellation ? 'cancellation' : row.status}</td>
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

export function OpeningBalanceForm({
  call,
  kind,
  canPost,
  canCancel,
  currency,
  onClose,
}: {
  call: ApiCall;
  kind: OpeningBalanceKind;
  canPost: boolean;
  canCancel: boolean;
  currency: string;
  onClose: () => void;
}) {
  const label = LABELS[kind];
  const partnerKind = kind === 'partner';
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [partners, setPartners] = useState<PartnerSummary[]>([]);
  const [mode, setMode] = useState<'add' | 'view'>(canPost ? 'add' : 'view');
  const [document, setDocument] = useState<OpeningBalance | null>(null);
  const [postingDate, setPostingDate] = useState(today());
  const [offsetAccountId, setOffsetAccountId] = useState('');
  const [reason, setReason] = useState('');
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelDate, setCancelDate] = useState(today());
  const [cancelReason, setCancelReason] = useState('');
  const [choices, setChoices] = useState<OpeningBalanceSummary[] | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    void call<Account[]>('GET', '/v1/fin/accounts').then((result) => {
      if (result.ok) setAccounts(result.body.filter((row) => !row.isTitle && row.status === 'active' && !row.controlKind));
    });
    if (partnerKind) {
      void call<Page<PartnerSummary>>('GET', '/v1/bp/partners?status=active&limit=200').then((result) => {
        if (result.ok) setPartners(result.body.items.filter((row) => row.partnerType !== 'lead'));
      });
    }
  }, [call, partnerKind]);

  const load = useCallback(
    async (id: string) => {
      const result = await call<OpeningBalance>('GET', `/v1/fin/opening-balances/${id}`);
      if (!result.ok) {
        setError(errorMessage(result));
        return;
      }
      setDocument(result.body);
      setMode('view');
      setCancelling(false);
      setImporting(false);
    },
    [call],
  );

  const filled = lines.filter((line) => line.targetId);
  const dirty = mode === 'add' && filled.length > 0;
  const totalDebit = filled.reduce((sum, line) => sum + minor(line.debit), 0n);
  const totalCredit = filled.reduce((sum, line) => sum + minor(line.credit), 0n);
  const difference = totalDebit - totalCredit;

  const reset = () => {
    setDocument(null);
    setMode('add');
    setReason('');
    setRemarks('');
    setLines([emptyLine()]);
    setError(null);
    setNotice(null);
    setIdempotencyKey(crypto.randomUUID());
  };

  useRecordToolbar({
    find: () =>
      void call<Page<OpeningBalanceSummary>>('GET', `/v1/fin/opening-balances?kind=${kind}&limit=200`).then((result) => {
        if (result.ok) setChoices(result.body.items);
        else setError(errorMessage(result));
      }),
    add: canPost
      ? () => {
          if (dirty && !window.confirm(`Discard this ${label.toLowerCase()}?`)) return;
          reset();
        }
      : undefined,
  });

  const setLine = (key: string, patch: Partial<LineDraft>) => setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    if (mode === 'view') {
      onClose();
      return;
    }
    setError(null);
    if (filled.length === 0 || !reason.trim()) {
      setError('Enter a reason and at least one line.');
      return;
    }
    setBusy(true);
    const result = await call<OpeningBalance>('POST', `/v1/fin/opening-balances/${partnerKind ? 'partners' : 'accounts'}`, {
      idempotencyKey,
      postingDate,
      offsetAccountId: offsetAccountId || undefined,
      reason: reason.trim(),
      remarks,
      lines: filled.map((line) => ({
        ...(partnerKind
          ? {
              partnerId: line.targetId,
              reference: line.reference,
              ...(line.documentDate ? { documentDate: line.documentDate } : {}),
              ...(line.dueDate ? { dueDate: line.dueDate } : {}),
            }
          : { accountId: line.targetId }),
        debit: clean(line.debit) || '0',
        credit: clean(line.credit) || '0',
      })),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.status === 0 ? `${errorMessage(result)} Choosing Add again safely retries the same document.` : errorMessage(result));
      return;
    }
    setNotice(`Opening balance ${result.body.documentNumber} posted with journal entry ${result.body.journalNumber}.`);
    setDocument(result.body);
    setMode('view');
    setIdempotencyKey(crypto.randomUUID());
  };

  const cancelDocument = async () => {
    if (!document || busy) return;
    if (!cancelReason.trim()) {
      setError('Enter a reason for the cancellation.');
      return;
    }
    if (!window.confirm(`Cancel opening balance ${document.documentNumber}? Its journal entry will be reversed.`)) return;
    setBusy(true);
    setError(null);
    const result = await call<OpeningBalance>('POST', `/v1/fin/opening-balances/${document.id}/cancel`, {
      idempotencyKey: crypto.randomUUID(),
      postingDate: cancelDate,
      reason: cancelReason.trim(),
    });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setNotice(`Cancellation ${result.body.documentNumber} posted.`);
    setCancelReason('');
    await load(document.id);
  };

  const closeForm = () => {
    if (dirty && !window.confirm(`Discard this ${label.toLowerCase()}?`)) return;
    onClose();
  };

  const offsetCell = (debit: bigint, credit: bigint) => (
    <tr className="totals-row">
      <td colSpan={partnerKind ? 5 : 2}>Offset to opening balance account</td>
      <td className="numeric">{debit > 0n ? formatAmount(fromMinor(debit)) : ''}</td>
      <td className="numeric">{credit > 0n ? formatAmount(fromMinor(credit)) : ''}</td>
      {mode === 'add' ? <td /> : partnerKind ? <td colSpan={2} /> : null}
    </tr>
  );

  return (
    <form onSubmit={submit} noValidate>
      <FormWindow
        title={mode === 'view' && document ? `${label} ${document.documentNumber}${document.isCancellation ? ' (Cancellation)' : ''}` : `${label} - Add`}
        width={partnerKind ? 980 : 760}
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
          mode === 'view' && document && canCancel && !document.isCancellation && document.status === 'posted' ? (
            <Button type="button" onClick={() => setCancelling((value) => !value)}>
              Cancel Document
            </Button>
          ) : mode === 'add' && canPost ? (
            <Button type="button" onClick={() => setImporting((value) => !value)}>
              Import from File
            </Button>
          ) : null
        }
      >
        {error ? <Banner>{error}</Banner> : null}
        {notice ? <Banner tone="info">{notice}</Banner> : null}
        {mode === 'view' && document ? (
          <>
            <div className="form-columns">
              <div>
                <ReadField label="Reason" value={document.reason} />
                <ReadField label="Offset Account" value={`${document.offsetAccountCode} - ${document.offsetAccountName}`} />
                <ReadField label="Remarks" value={document.remarks ?? ''} />
                <ReadField label="Journal Entry" value={document.journalNumber} />
              </div>
              <div>
                <ReadField label="No." value={document.documentNumber} />
                <ReadField label="Status" value={<StatusBadge status={document.status === 'posted' ? 'active' : 'cancelled'} />} />
                <ReadField label="Posting Date" value={document.postingDate} />
              </div>
            </div>
            {document.cancellationReason ? <p className="ui-muted">Cancellation reason: {document.cancellationReason}</p> : null}
            {document.cancelledById || document.cancellationOfId ? (
              <p className="pager">
                <LinkArrow label="Open linked document" onClick={() => void load(document.cancelledById ?? document.cancellationOfId ?? '')} />
                {document.cancelledById ? 'Cancelled by a cancellation document' : 'Cancels the original document'}
              </p>
            ) : null}
            <div className="ui-table-wrap journal-grid">
              <table className="ui-table">
                <thead>
                  <tr>
                    <th className="ui-table__row-number">#</th>
                    {partnerKind ? (
                      <>
                        <th>BP Code</th>
                        <th>Reference</th>
                        <th>Document Date</th>
                        <th>Due Date</th>
                      </>
                    ) : (
                      <th>G/L Account</th>
                    )}
                    <th className="numeric">Debit ({currency})</th>
                    <th className="numeric">Credit ({currency})</th>
                    {partnerKind ? (
                      <>
                        <th className="numeric">Paid</th>
                        <th className="numeric">Open</th>
                      </>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {document.lines.map((line) => (
                    <tr key={line.id}>
                      <td className="ui-table__row-number">{line.lineNo}</td>
                      {partnerKind ? (
                        <>
                          <td>
                            {line.partnerCode} - {line.partnerName}
                          </td>
                          <td>{line.reference ?? ''}</td>
                          <td>{line.documentDate}</td>
                          <td>{line.dueDate}</td>
                        </>
                      ) : (
                        <td>
                          {line.accountCode} - {line.accountName}
                        </td>
                      )}
                      <td className="numeric">{amountCell(line.debit)}</td>
                      <td className="numeric">{amountCell(line.credit)}</td>
                      {partnerKind ? (
                        <>
                          <td className="numeric">{amountCell(line.paidAmount)}</td>
                          <td className="numeric">{amountCell(line.openAmount)}</td>
                        </>
                      ) : null}
                    </tr>
                  ))}
                  {offsetCell(toMinor(document.offsetDebit) ?? 0n, toMinor(document.offsetCredit) ?? 0n)}
                </tbody>
              </table>
            </div>
          </>
        ) : mode === 'add' ? (
          <>
            <div className="form-columns">
              <div>
                <label className="ui-field">
                  <span>Reason</span>
                  <input className="grid-input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
                </label>
                <label className="ui-field">
                  <span>Offset Account</span>
                  <select className="grid-input" value={offsetAccountId} onChange={(e) => setOffsetAccountId(e.target.value)}>
                    <option value="">Opening balance offset (default)</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} - {account.name}
                      </option>
                    ))}
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
              </div>
            </div>
            <div className="ui-table-wrap">
              <table className="ui-table">
                <thead>
                  <tr>
                    <th className="ui-table__row-number">#</th>
                    {partnerKind ? (
                      <>
                        <th>BP Code</th>
                        <th>Reference</th>
                        <th>Document Date</th>
                        <th>Due Date</th>
                      </>
                    ) : (
                      <th>G/L Account</th>
                    )}
                    <th className="numeric">Debit</th>
                    <th className="numeric">Credit</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, index) => (
                    <tr key={line.key}>
                      <td className="ui-table__row-number">{index + 1}</td>
                      <td>
                        <select className="grid-input" aria-label={`Line ${index + 1} ${partnerKind ? 'business partner' : 'account'}`} value={line.targetId} onChange={(e) => setLine(line.key, { targetId: e.target.value })}>
                          <option value="" />
                          {partnerKind
                            ? partners.map((row) => (
                                <option key={row.id} value={row.id}>
                                  {row.code} - {row.name} ({row.partnerType === 'supplier' ? 'Vendor' : 'Customer'})
                                </option>
                              ))
                            : accounts.map((row) => (
                                <option key={row.id} value={row.id}>
                                  {row.code} - {row.name}
                                </option>
                              ))}
                        </select>
                      </td>
                      {partnerKind ? (
                        <>
                          <td>
                            <input className="grid-input" aria-label={`Line ${index + 1} reference`} maxLength={60} value={line.reference} onChange={(e) => setLine(line.key, { reference: e.target.value })} />
                          </td>
                          <td>
                            <input className="grid-input" type="date" aria-label={`Line ${index + 1} document date`} value={line.documentDate} onChange={(e) => setLine(line.key, { documentDate: e.target.value })} />
                          </td>
                          <td>
                            <input className="grid-input" type="date" aria-label={`Line ${index + 1} due date`} value={line.dueDate} onChange={(e) => setLine(line.key, { dueDate: e.target.value })} />
                          </td>
                        </>
                      ) : null}
                      <td>
                        <input className="grid-input grid-input--number" inputMode="decimal" aria-label={`Line ${index + 1} debit`} value={line.debit} onChange={(e) => setLine(line.key, { debit: e.target.value })} />
                      </td>
                      <td>
                        <input className="grid-input grid-input--number" inputMode="decimal" aria-label={`Line ${index + 1} credit`} value={line.credit} onChange={(e) => setLine(line.key, { credit: e.target.value })} />
                      </td>
                      <td>
                        {lines.length > 1 ? (
                          <Button type="button" variant="ghost" aria-label={`Remove line ${index + 1}`} onClick={() => setLines((current) => current.filter((row) => row.key !== line.key))}>
                            ×
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {offsetCell(difference < 0n ? -difference : 0n, difference > 0n ? difference : 0n)}
                </tbody>
              </table>
            </div>
            <p className="pager">
              <Button type="button" onClick={() => setLines((current) => [...current, emptyLine()])}>
                Add Line
              </Button>
              <span className="ui-muted">
                {partnerKind
                  ? 'Enter each open legacy invoice or credit separately. Vendor amounts owed are credits and customer amounts receivable are debits. The document date defaults to the posting date and the due date to the partner payment terms.'
                  : 'Control accounts take their balances from Business Partners Opening Balance and inventory accounts from Inventory Opening Balance.'}
              </span>
            </p>
          </>
        ) : (
          <p className="ui-muted">Use Find to open an opening balance.</p>
        )}
        {importing && mode === 'add' ? (
          <OpeningImportPanel
            call={call}
            kind={kind}
            currency={currency}
            onCommitted={(id, number) => {
              void load(id).then(() => setNotice(`Opening balance ${number} imported.`));
            }}
          />
        ) : null}
        {cancelling && document ? (
          <div className="reverse-panel">
            <div className="form-section">Cancel Opening Balance</div>
            <div className="inline-fields">
              <label className="ui-field">
                <span>Cancellation Date</span>
                <input className="grid-input" type="date" value={cancelDate} onChange={(e) => setCancelDate(e.target.value)} />
              </label>
              <label className="ui-field">
                <span>Reason</span>
                <input className="grid-input" value={cancelReason} maxLength={500} onChange={(e) => setCancelReason(e.target.value)} />
              </label>
              <Button type="button" variant="primary" busy={busy} onClick={() => void cancelDocument()}>
                Post Cancellation
              </Button>
            </div>
            <p className="ui-muted">Reverses the journal entry. Payments applied to vendor lines must be unallocated first.</p>
          </div>
        ) : null}
      </FormWindow>
      {choices ? (
        <ChooserWindow
          title={`List of ${label}s`}
          rows={choices}
          onClose={() => setChoices(null)}
          onPick={(id) => {
            setChoices(null);
            void load(id);
          }}
        />
      ) : null}
    </form>
  );
}
