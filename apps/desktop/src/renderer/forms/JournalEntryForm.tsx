import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Account, JournalEntry, JournalSummary, Page, PartnerSummary } from '@nec/contracts';
import { Banner, Button, FormWindow, LinkArrow, StatusBadge } from '@nec/ui';
import { errorMessage, fieldErrors } from '../api';
import { formatAmount, fromMinor, toMinor, today } from '../format';
import type { ApiCall } from '../screens/Shell';
import { useRecordToolbar } from '../toolbar';

type Mode = 'add' | 'view';

interface LineDraft {
  key: string;
  target: string;
  debit: string;
  credit: string;
  memo: string;
}

let keySeed = 0;
const nextKey = () => `line-${++keySeed}`;
const emptyLine = (): LineDraft => ({ key: nextKey(), target: '', debit: '', credit: '', memo: '' });

export function JournalEntryForm({
  call,
  canPost,
  canReverse,
  currency,
  onClose,
}: {
  call: ApiCall;
  canPost: boolean;
  canReverse: boolean;
  currency: string;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>(canPost ? 'add' : 'view');
  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [partners, setPartners] = useState<PartnerSummary[]>([]);
  const [postingDate, setPostingDate] = useState(today());
  const [dueDate, setDueDate] = useState('');
  const [memo, setMemo] = useState('');
  const [reference, setReference] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(), emptyLine()]);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [reversing, setReversing] = useState(false);
  const [reverseDate, setReverseDate] = useState(today());
  const [reverseReason, setReverseReason] = useState('');
  const [reverseKey, setReverseKey] = useState(() => crypto.randomUUID());
  const [choices, setChoices] = useState<JournalSummary[] | null>(null);

  useEffect(() => {
    void Promise.all([
      call<Account[]>('GET', '/v1/fin/accounts'),
      call<Page<PartnerSummary>>('GET', '/v1/bp/partners?status=active&limit=200'),
    ]).then(([accountResult, partnerResult]) => {
      if (accountResult.ok) setAccounts(accountResult.body);
      if (partnerResult.ok) setPartners(partnerResult.body.items.filter((partner) => partner.partnerType !== 'lead'));
    });
  }, [call]);

  const postable = useMemo(
    () => accounts.filter((account) => !account.isTitle && account.status === 'active' && account.controlKind === null),
    [accounts],
  );

  const totals = useMemo(() => {
    let debit = 0n;
    let credit = 0n;
    for (const line of lines) {
      debit += toMinor(line.debit || '0') ?? 0n;
      credit += toMinor(line.credit || '0') ?? 0n;
    }
    return { debit, credit, difference: debit - credit };
  }, [lines]);

  const dirty = mode === 'add' && lines.some((line) => line.target || line.debit || line.credit);

  const resetMessages = () => {
    setError(null);
    setNotice(null);
    setFields({});
  };

  const load = useCallback(
    async (id: string) => {
      const result = await call<JournalEntry>('GET', `/v1/fin/journal-entries/${id}`);
      if (!result.ok) {
        setError(errorMessage(result));
        return;
      }
      setEntry(result.body);
      setMode('view');
      setReversing(false);
    },
    [call],
  );

  const startAdd = useCallback(() => {
    if (!canPost || (dirty && !window.confirm('Discard this unposted journal entry?'))) return;
    resetMessages();
    setEntry(null);
    setMode('add');
    setPostingDate(today());
    setDueDate('');
    setMemo('');
    setReference('');
    setLines([emptyLine(), emptyLine()]);
    setIdempotencyKey(crypto.randomUUID());
  }, [canPost, dirty]);

  const navigate = useCallback(
    async (direction: 'first' | 'previous' | 'next' | 'last') => {
      if (dirty && !window.confirm('Discard this unposted journal entry?')) return;
      resetMessages();
      const result = await call<Page<JournalSummary>>('GET', '/v1/fin/journal-entries?limit=200');
      if (!result.ok) {
        setError(errorMessage(result));
        return;
      }
      const items = [...result.body.items].reverse();
      if (items.length === 0) {
        setNotice('No journal entries have been posted.');
        return;
      }
      const index = entry ? items.findIndex((item) => item.id === entry.id) : -1;
      const target =
        direction === 'first'
          ? items[0]
          : direction === 'last'
            ? items[items.length - 1]
            : direction === 'next'
              ? items[index < 0 ? 0 : Math.min(index + 1, items.length - 1)]
              : items[index < 0 ? items.length - 1 : Math.max(index - 1, 0)];
      if (target) await load(target.id);
    },
    [call, dirty, entry, load],
  );

  const find = useCallback(async () => {
    if (dirty && !window.confirm('Discard this unposted journal entry?')) return;
    resetMessages();
    const result = await call<Page<JournalSummary>>('GET', '/v1/fin/journal-entries?limit=200');
    if (result.ok) {
      setChoices(result.body.items);
    } else {
      setError(errorMessage(result));
    }
  }, [call, dirty]);

  useRecordToolbar({
    find: () => void find(),
    add: canPost ? startAdd : undefined,
    first: () => void navigate('first'),
    previous: () => void navigate('previous'),
    next: () => void navigate('next'),
    last: () => void navigate('last'),
  });

  const setLine = (key: string, patch: Partial<LineDraft>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    if (mode === 'view') {
      onClose();
      return;
    }
    resetMessages();
    const used = lines.filter((line) => line.target || line.debit || line.credit);
    for (const [index, line] of used.entries()) {
      if (!line.target) {
        setError(`Line ${index + 1}: choose an account or business partner.`);
        return;
      }
      if ((line.debit && toMinor(line.debit) === null) || (line.credit && toMinor(line.credit) === null)) {
        setError(`Line ${index + 1}: enter amounts with up to 4 decimal places.`);
        return;
      }
    }
    if (totals.difference !== 0n) {
      setError(`The entry is out of balance by ${formatAmount(fromMinor(totals.difference < 0n ? -totals.difference : totals.difference))} ${currency}.`);
      return;
    }
    setBusy(true);
    const result = await call<JournalEntry>('POST', '/v1/fin/journal-entries', {
      idempotencyKey,
      postingDate,
      dueDate: dueDate || undefined,
      memo: memo || undefined,
      reference: reference || undefined,
      lines: used.map((line) => {
        const [kind, id] = line.target.split(':');
        return {
          accountId: kind === 'account' ? id : null,
          partnerId: kind === 'partner' ? id : null,
          debit: line.debit.replace(/,/g, '') || '0',
          credit: line.credit.replace(/,/g, '') || '0',
          memo: line.memo || undefined,
        };
      }),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.status === 0 ? `${errorMessage(result)} Choosing Add again safely retries the same posting.` : errorMessage(result));
      setFields(fieldErrors(result));
      return;
    }
    setNotice(`Journal entry ${result.body.documentNumber} posted.`);
    setEntry(result.body);
    setMode('view');
    setIdempotencyKey(crypto.randomUUID());
  };

  const reverse = async () => {
    if (!entry || busy) return;
    if (!reverseReason.trim()) {
      setError('Enter a reason for the reversal.');
      return;
    }
    if (!window.confirm(`Post a reversal of ${entry.documentNumber} dated ${reverseDate}? This cannot be undone.`)) return;
    resetMessages();
    setBusy(true);
    const result = await call<JournalEntry>('POST', `/v1/fin/journal-entries/${entry.id}/reverse`, {
      idempotencyKey: reverseKey,
      postingDate: reverseDate,
      reason: reverseReason.trim(),
    });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setReverseKey(crypto.randomUUID());
    setReverseReason('');
    setNotice(`Reversal ${result.body.documentNumber} posted.`);
    await load(entry.id);
  };

  const cancel = () => {
    if (dirty && !window.confirm('Discard this unposted journal entry?')) return;
    onClose();
  };

  const viewing = mode === 'view' && entry;

  return (
    <form onSubmit={submit} noValidate>
      <FormWindow
        title={viewing ? `Journal Entry ${entry.documentNumber}` : 'Journal Entry - Add'}
        onClose={cancel}
        footerLeft={
          <>
            <Button type="submit" variant="primary" busy={busy && !reversing} disabled={mode === 'add' && !canPost}>
              {mode === 'add' ? 'Add' : 'OK'}
            </Button>
            <Button type="button" onClick={cancel}>
              Cancel
            </Button>
          </>
        }
        footerRight={
          viewing && canReverse && entry.sourceType === 'manual' && !entry.reversedById ? (
            <Button type="button" onClick={() => setReversing((value) => !value)}>
              Reverse
            </Button>
          ) : null
        }
      >
        {error ? <Banner>{error}</Banner> : null}
        {notice ? <Banner tone="info">{notice}</Banner> : null}
        {viewing ? (
          <>
            <div className="form-columns">
              <div>
                <Field label="Number" value={`${entry.documentNumber} (${entry.seriesName})`} />
                <Field label="Posting Date" value={entry.postingDate} />
                <Field label="Due Date" value={entry.dueDate} />
                <Field label="Period" value={entry.periodCode} />
              </div>
              <div>
                <Field label="Remarks" value={entry.memo ?? ''} />
                <Field label="Ref. 1" value={entry.reference ?? ''} />
                <Field label="Origin" value={entry.sourceType === 'manual' ? 'Manual journal entry' : entry.sourceType === 'reversal' ? 'Reversal' : entry.sourceType} />
                <div className="ui-field">
                  <span>Status</span>
                  <span>
                    <StatusBadge status={entry.reversedById ? 'cancelled' : 'active'} />
                    {entry.reversedById ? (
                      <>
                        {' '}
                        <LinkArrow label="Open reversal" onClick={() => void load(entry.reversedById ?? '')} />
                        reversed
                      </>
                    ) : null}
                    {entry.reversalOfId ? (
                      <>
                        {' '}
                        <LinkArrow label="Open original entry" onClick={() => void load(entry.reversalOfId ?? '')} />
                        reverses original
                      </>
                    ) : null}
                  </span>
                </div>
              </div>
            </div>
            {entry.reversalReason ? <p className="ui-muted">Reversal reason: {entry.reversalReason}</p> : null}
            <div className="ui-table-wrap journal-grid">
              <table className="ui-table">
                <thead>
                  <tr>
                    <th className="ui-table__row-number">#</th>
                    <th>G/L Acct/BP Code</th>
                    <th>G/L Acct/BP Name</th>
                    <th className="numeric">Debit</th>
                    <th className="numeric">Credit</th>
                    <th>Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.lines.map((line) => (
                    <tr key={line.lineNo}>
                      <td className="ui-table__row-number">{line.lineNo}</td>
                      <td>{line.partnerCode ?? line.accountCode}</td>
                      <td>{line.partnerCode ? `${line.accountName} (control)` : line.accountName}</td>
                      <td className="numeric">{line.debit !== '0.0000' ? formatAmount(line.debit) : ''}</td>
                      <td className="numeric">{line.credit !== '0.0000' ? formatAmount(line.credit) : ''}</td>
                      <td>{line.memo ?? ''}</td>
                    </tr>
                  ))}
                  <tr className="totals-row">
                    <td />
                    <td colSpan={2}>Total ({entry.currency})</td>
                    <td className="numeric">{formatAmount(entry.totalDebit)}</td>
                    <td className="numeric">{formatAmount(entry.totalCredit)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
            {reversing ? (
              <div className="reverse-panel">
                <div className="form-section">Reverse Journal Entry</div>
                <div className="inline-fields">
                  <label className="ui-field">
                    <span>Reversal Date</span>
                    <input className="grid-input" type="date" value={reverseDate} onChange={(e) => setReverseDate(e.target.value)} />
                  </label>
                  <label className="ui-field">
                    <span>Reason</span>
                    <input className="grid-input" value={reverseReason} maxLength={500} onChange={(e) => setReverseReason(e.target.value)} />
                  </label>
                  <Button type="button" variant="primary" busy={busy} onClick={() => void reverse()}>
                    Post Reversal
                  </Button>
                </div>
                <p className="ui-muted">The reversal posts the same accounts with debit and credit swapped. The original stays visible.</p>
              </div>
            ) : null}
          </>
        ) : mode === 'add' ? (
          <>
            <div className="form-columns">
              <div>
                <label className="ui-field">
                  <span>Posting Date</span>
                  <input className="grid-input" type="date" value={postingDate} onChange={(e) => setPostingDate(e.target.value)} aria-invalid={fields.postingDate ? true : undefined} />
                </label>
                <label className="ui-field">
                  <span>Due Date</span>
                  <input className="grid-input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                </label>
              </div>
              <div>
                <label className="ui-field">
                  <span>Remarks</span>
                  <input className="grid-input" value={memo} maxLength={200} onChange={(e) => setMemo(e.target.value)} />
                </label>
                <label className="ui-field">
                  <span>Ref. 1</span>
                  <input className="grid-input" value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} />
                </label>
              </div>
            </div>
            <div className="ui-table-wrap journal-grid">
              <table className="ui-table">
                <thead>
                  <tr>
                    <th className="ui-table__row-number">#</th>
                    <th>G/L Acct/BP Code</th>
                    <th className="numeric">Debit</th>
                    <th className="numeric">Credit</th>
                    <th>Remarks</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, index) => (
                    <tr key={line.key}>
                      <td className="ui-table__row-number">{index + 1}</td>
                      <td>
                        <select className="grid-input" aria-label={`Line ${index + 1} account`} value={line.target} onChange={(e) => setLine(line.key, { target: e.target.value })}>
                          <option value="" />
                          <optgroup label="G/L Accounts">
                            {postable.map((account) => (
                              <option key={account.id} value={`account:${account.id}`}>
                                {account.code} - {account.name}
                              </option>
                            ))}
                          </optgroup>
                          <optgroup label="Business Partners">
                            {partners.map((partner) => (
                              <option key={partner.id} value={`partner:${partner.id}`}>
                                {partner.code} - {partner.name}
                              </option>
                            ))}
                          </optgroup>
                        </select>
                      </td>
                      <td>
                        <input
                          className="grid-input grid-input--number"
                          inputMode="decimal"
                          aria-label={`Line ${index + 1} debit`}
                          value={line.debit}
                          onChange={(e) => setLine(line.key, { debit: e.target.value, credit: e.target.value ? '' : line.credit })}
                        />
                      </td>
                      <td>
                        <input
                          className="grid-input grid-input--number"
                          inputMode="decimal"
                          aria-label={`Line ${index + 1} credit`}
                          value={line.credit}
                          onChange={(e) => setLine(line.key, { credit: e.target.value, debit: e.target.value ? '' : line.debit })}
                        />
                      </td>
                      <td>
                        <input className="grid-input" aria-label={`Line ${index + 1} remarks`} value={line.memo} maxLength={200} onChange={(e) => setLine(line.key, { memo: e.target.value })} />
                      </td>
                      <td>
                        {lines.length > 2 ? (
                          <Button type="button" variant="ghost" aria-label={`Remove line ${index + 1}`} onClick={() => setLines((current) => current.filter((row) => row.key !== line.key))}>
                            ×
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  <tr className="totals-row">
                    <td />
                    <td>Total ({currency})</td>
                    <td className="numeric">{formatAmount(fromMinor(totals.debit))}</td>
                    <td className="numeric">{formatAmount(fromMinor(totals.credit))}</td>
                    <td colSpan={2} className={totals.difference === 0n ? 'balance-ok' : 'balance-off'}>
                      {totals.difference === 0n ? (totals.debit > 0n ? 'Balanced' : '') : `Out of balance: ${formatAmount(fromMinor(totals.difference))}`}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="pager">
              <Button type="button" onClick={() => setLines((current) => [...current, emptyLine()])}>
                Add Line
              </Button>
              <span className="ui-muted">Choosing a business partner posts to its receivable or payable control account.</span>
            </p>
          </>
        ) : (
          <p className="ui-muted">Use Find or the record arrows to open a journal entry.</p>
        )}
      </FormWindow>
      {choices ? (
        <div className="modal-backdrop" role="presentation">
          <FormWindow
            title="List of Journal Entries"
            width={680}
            onClose={() => setChoices(null)}
            footerLeft={
              <Button type="button" onClick={() => setChoices(null)}>
                Cancel
              </Button>
            }
          >
            {choices.length === 0 ? (
              <p className="ui-muted">No journal entries have been posted.</p>
            ) : (
              <div className="ui-table-wrap">
                <table className="ui-table company-grid">
                  <thead>
                    <tr>
                      <th>Number</th>
                      <th>Posting Date</th>
                      <th>Origin</th>
                      <th>Remarks</th>
                      <th className="numeric">Amount</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {choices.map((item) => (
                      <tr
                        key={item.id}
                        onDoubleClick={() => {
                          setChoices(null);
                          void load(item.id);
                        }}
                      >
                        <td>
                          <LinkArrow
                            label={`Open ${item.documentNumber}`}
                            onClick={() => {
                              setChoices(null);
                              void load(item.id);
                            }}
                          />
                          {item.documentNumber}
                        </td>
                        <td>{item.postingDate}</td>
                        <td>{item.sourceType}</td>
                        <td>{item.memo ?? ''}</td>
                        <td className="numeric">{formatAmount(item.totalDebit)}</td>
                        <td>{item.reversed ? <StatusBadge status="cancelled" /> : null}</td>
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

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="ui-field">
      <span>{label}</span>
      <span className="form-value">{value}</span>
    </div>
  );
}
