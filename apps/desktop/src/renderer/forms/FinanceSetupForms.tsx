import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ACCOUNT_TYPES,
  type Account,
  type AccountType,
  type GlDetermination,
  type NumberingSeries,
  type PeriodCloseChecks,
  type PostingPeriod,
  type TrialBalance,
} from '@nec/contracts';
import { Banner, Button, DataTable, FormWindow, StatusBadge } from '@nec/ui';
import { errorMessage, fieldErrors } from '../api';
import { formatAmount } from '../format';
import type { ApiCall } from '../screens/Shell';

const TYPE_LABELS: Record<AccountType, string> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Capital and Reserves',
  income: 'Revenues',
  expense: 'Expenses',
};

export function ChartOfAccountsForm({ call, canAdminister, onClose }: { call: ApiCall; canAdminister: boolean; onClose: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [accountType, setAccountType] = useState<AccountType>('asset');
  const [parentId, setParentId] = useState('');
  const [isTitle, setIsTitle] = useState(false);
  const [editName, setEditName] = useState('');
  const [editStatus, setEditStatus] = useState<'active' | 'inactive'>('active');

  const load = useCallback(async () => {
    const result = await call<Account[]>('GET', '/v1/fin/accounts');
    if (result.ok) {
      setAccounts(result.body);
    } else {
      setError(errorMessage(result));
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = accounts.find((account) => account.id === selectedId) ?? null;
  useEffect(() => {
    if (selected) {
      setEditName(selected.name);
      setEditStatus(selected.status);
    }
  }, [selected]);

  const ordered = useMemo(() => {
    const children = new Map<string | null, Account[]>();
    for (const account of accounts) {
      children.set(account.parentId, [...(children.get(account.parentId) ?? []), account]);
    }
    const result: Account[] = [];
    const walk = (parent: string | null) => {
      for (const child of (children.get(parent) ?? []).sort((a, b) => a.code.localeCompare(b.code))) {
        result.push(child);
        walk(child.id);
      }
    };
    walk(null);
    return result;
  }, [accounts]);

  const titles = accounts.filter((account) => account.isTitle && account.accountType === accountType);

  const reset = () => {
    setError(null);
    setNotice(null);
    setFields({});
  };

  const create = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    reset();
    setBusy(true);
    const result = await call<Account>('POST', '/v1/fin/accounts', {
      code,
      name,
      accountType,
      parentId: parentId || null,
      isTitle,
    });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      setFields(fieldErrors(result));
      return;
    }
    setNotice(`Account ${result.body.code} added.`);
    setCode('');
    setName('');
    setAdding(false);
    setSelectedId(result.body.id);
    await load();
  };

  const update = async () => {
    if (!selected || busy) return;
    reset();
    setBusy(true);
    const result = await call<Account>('PUT', `/v1/fin/accounts/${selected.id}`, {
      version: selected.version,
      name: editName,
      parentId: selected.parentId,
      status: editStatus,
    });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setNotice('Operation completed successfully.');
    await load();
  };

  return (
    <FormWindow
      title="Chart of Accounts"
      onClose={onClose}
      footerLeft={
        <>
          <Button type="button" variant="primary" onClick={onClose}>
            OK
          </Button>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
      footerRight={
        canAdminister ? (
          <Button type="button" onClick={() => setAdding((value) => !value)}>
            {adding ? 'Close New Account' : 'New Account'}
          </Button>
        ) : null
      }
    >
      {error ? <Banner>{error}</Banner> : null}
      {notice ? <Banner tone="info">{notice}</Banner> : null}
      <div className="coa-layout">
        <div className="ui-table-wrap coa-tree">
          <table className="ui-table company-grid">
            <thead>
              <tr>
                <th>Account</th>
                <th>Name</th>
                <th>Type</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((account) => (
                <tr key={account.id} aria-selected={account.id === selectedId} onClick={() => setSelectedId(account.id)}>
                  <td style={{ paddingLeft: 6 + (account.level - 1) * 14 }}>
                    <span className={account.isTitle ? 'coa-title' : ''}>{account.code}</span>
                  </td>
                  <td className={account.isTitle ? 'coa-title' : ''}>{account.name}</td>
                  <td>{account.isTitle ? 'Title' : account.controlKind ? `Active (control: ${account.controlKind})` : 'Active'}</td>
                  <td>
                    <StatusBadge status={account.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="coa-detail">
          {selected ? (
            <>
              <div className="form-section">Account Details</div>
              <div className="ui-field">
                <span>G/L Account</span>
                <span className="form-value">{selected.code}</span>
              </div>
              <label className="ui-field">
                <span>Name</span>
                <input className="grid-input" value={editName} readOnly={!canAdminister} onChange={(e) => setEditName(e.target.value)} />
              </label>
              <div className="ui-field">
                <span>Drawer</span>
                <span className="form-value">{TYPE_LABELS[selected.accountType]}</span>
              </div>
              <div className="ui-field">
                <span>Kind</span>
                <span className="form-value">{selected.isTitle ? 'Title account' : 'Active account'}</span>
              </div>
              <div className="ui-field">
                <span>Control Account</span>
                <span className="form-value">{selected.controlKind ?? 'No'}</span>
              </div>
              <label className="ui-field">
                <span>Status</span>
                <select className="grid-input" value={editStatus} disabled={!canAdminister} onChange={(e) => setEditStatus(e.target.value as 'active' | 'inactive')}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </label>
              <p className="ui-muted">{selected.hasPostings ? 'This account has postings and cannot be deleted.' : 'No postings yet.'}</p>
              {canAdminister ? (
                <Button type="button" variant="primary" busy={busy} onClick={() => void update()} disabled={editName === selected.name && editStatus === selected.status}>
                  Update
                </Button>
              ) : null}
            </>
          ) : (
            <p className="ui-muted">Select an account to see its details.</p>
          )}
          {adding && canAdminister ? (
            <form onSubmit={create} noValidate>
              <div className="form-section">New Account</div>
              <label className="ui-field">
                <span>Drawer</span>
                <select
                  className="grid-input"
                  value={accountType}
                  onChange={(e) => {
                    setAccountType(e.target.value as AccountType);
                    setParentId('');
                  }}
                >
                  {ACCOUNT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {TYPE_LABELS[type]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="ui-field">
                <span>Parent (title)</span>
                <select className="grid-input" value={parentId} onChange={(e) => setParentId(e.target.value)} aria-invalid={fields.parentId ? true : undefined}>
                  <option value="">Top level</option>
                  {titles.map((title) => (
                    <option key={title.id} value={title.id}>
                      {title.code} - {title.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="ui-field">
                <span>G/L Account</span>
                <input className="grid-input" value={code} maxLength={20} onChange={(e) => setCode(e.target.value)} aria-invalid={fields.code ? true : undefined} />
              </label>
              <label className="ui-field">
                <span>Name</span>
                <input className="grid-input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} aria-invalid={fields.name ? true : undefined} />
              </label>
              <label className="ui-field">
                <span>Title account</span>
                <input type="checkbox" checked={isTitle} onChange={(e) => setIsTitle(e.target.checked)} />
              </label>
              <Button type="submit" variant="primary" busy={busy} disabled={!code || !name}>
                Add
              </Button>
            </form>
          ) : null}
        </div>
      </div>
    </FormWindow>
  );
}

export function GlDeterminationForm({ call, canAdminister, onClose }: { call: ApiCall; canAdminister: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<GlDetermination[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [changes, setChanges] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [mapping, accountResult] = await Promise.all([
      call<GlDetermination[]>('GET', '/v1/fin/gl-determination'),
      call<Account[]>('GET', '/v1/fin/accounts'),
    ]);
    if (mapping.ok) setRows(mapping.body);
    else setError(errorMessage(mapping));
    if (accountResult.ok) setAccounts(accountResult.body);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const postable = accounts.filter((account) => !account.isTitle && account.status === 'active');
  const dirty = Object.keys(changes).length > 0;

  const save = async () => {
    if (!dirty || busy) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    const result = await call<GlDetermination[]>('PUT', '/v1/fin/gl-determination', {
      mappings: Object.entries(changes).map(([key, accountId]) => ({ key, accountId })),
    });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setRows(result.body);
    setChanges({});
    setNotice('Operation completed successfully.');
  };

  return (
    <FormWindow
      title="G/L Account Determination"
      onClose={onClose}
      footerLeft={
        <>
          <Button type="button" variant="primary" busy={busy} onClick={() => (dirty ? void save() : onClose())}>
            {dirty ? 'Update' : 'OK'}
          </Button>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      {error ? <Banner>{error}</Banner> : null}
      {notice ? <Banner tone="info">{notice}</Banner> : null}
      <DataTable
        rowNumbers
        rows={rows}
        rowKey={(row) => row.key}
        empty="No determination keys."
        columns={[
          { key: 'label', header: 'Type of Account', render: (row) => row.label },
          {
            key: 'account',
            header: 'Account Code',
            render: (row) => (
              <select
                className="grid-input"
                aria-label={`${row.label} account`}
                disabled={!canAdminister}
                value={changes[row.key] ?? row.accountId ?? ''}
                onChange={(e) => setChanges((current) => ({ ...current, [row.key]: e.target.value }))}
              >
                <option value="" disabled>
                  Not defined
                </option>
                {postable.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} - {account.name}
                  </option>
                ))}
              </select>
            ),
          },
        ]}
      />
      <p className="ui-muted">Documents post through these accounts. Control accounts can only be used for receivables and payables.</p>
    </FormWindow>
  );
}

export function PostingPeriodsForm({
  call,
  canAdminister,
  canClose,
  canReopen,
  onClose,
}: {
  call: ApiCall;
  canAdminister: boolean;
  canClose: boolean;
  canReopen: boolean;
  onClose: () => void;
}) {
  const [periods, setPeriods] = useState<PostingPeriod[]>([]);
  const [closing, setClosing] = useState<{ period: PostingPeriod; checks: PeriodCloseChecks } | null>(null);
  const [closeReason, setCloseReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [yearCode, setYearCode] = useState('');
  const [yearStart, setYearStart] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await call<PostingPeriod[]>('GET', '/v1/fin/periods');
    if (result.ok) setPeriods(result.body);
    else setError(errorMessage(result));
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const reviewClose = async (period: PostingPeriod) => {
    setError(null);
    setNotice(null);
    setCloseReason('');
    const result = await call<PeriodCloseChecks>('GET', `/v1/fin/periods/${period.id}/close-checks`);
    if (result.ok) setClosing({ period, checks: result.body });
    else setError(errorMessage(result));
  };

  const confirmClose = async () => {
    if (!closing || busy || !closeReason.trim()) return;
    setBusy(true);
    setError(null);
    const result = await call<PostingPeriod>('PATCH', `/v1/fin/periods/${closing.period.id}/status`, { status: 'closed', version: closing.period.version, reason: closeReason.trim() });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
    } else {
      setNotice(`${closing.period.name} is now closed.`);
      setClosing(null);
    }
    await load();
  };

  const reopen = async (period: PostingPeriod) => {
    const reason = window.prompt(`Reopen ${period.name}. Enter a reason:`);
    if (!reason?.trim()) return;
    setError(null);
    setNotice(null);
    const result = await call<PostingPeriod>('PATCH', `/v1/fin/periods/${period.id}/status`, { status: 'open', version: period.version, reason: reason.trim() });
    if (!result.ok) {
      setError(errorMessage(result));
    } else {
      setNotice(`${period.name} is now open.`);
    }
    await load();
  };

  const createYear = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    const result = await call<PostingPeriod[]>('POST', '/v1/fin/fiscal-years', { code: yearCode, startDate: yearStart });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setPeriods(result.body);
    setNotice(`Fiscal year ${yearCode} created with 12 monthly periods.`);
    setYearCode('');
    setYearStart('');
  };

  return (
    <FormWindow
      title="Posting Periods"
      onClose={onClose}
      footerLeft={
        <Button type="button" variant="primary" onClick={onClose}>
          OK
        </Button>
      }
    >
      {error ? <Banner>{error}</Banner> : null}
      {notice ? <Banner tone="info">{notice}</Banner> : null}
      <DataTable
        rowNumbers
        rows={periods}
        rowKey={(row) => row.id}
        empty="No posting periods. Create a fiscal year below."
        columns={[
          { key: 'code', header: 'Period Code', render: (row) => row.code },
          { key: 'name', header: 'Period Name', render: (row) => row.name },
          { key: 'year', header: 'Fiscal Year', render: (row) => row.fiscalYearCode },
          { key: 'from', header: 'From', render: (row) => row.startDate },
          { key: 'to', header: 'To', render: (row) => row.endDate },
          { key: 'status', header: 'Period Status', render: (row) => <StatusBadge status={row.status === 'open' ? 'active' : 'disabled'} /> },
          {
            key: 'action',
            header: '',
            render: (row) =>
              row.status === 'open' && canClose ? (
                <Button type="button" onClick={() => void reviewClose(row)}>
                  Close
                </Button>
              ) : row.status === 'closed' && canReopen ? (
                <Button type="button" onClick={() => void reopen(row)}>
                  Reopen
                </Button>
              ) : null,
          },
        ]}
      />
      {closing ? (
        <div className="reverse-panel">
          <div className="form-section">Close {closing.period.name}: Reconciliation Checks as of {closing.checks.endDate}</div>
          <div className="ui-table-wrap">
            <table className="ui-table" aria-label="Period close checks">
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Result</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {closing.checks.checks.map((check) => (
                  <tr key={check.key} className={check.passed ? undefined : 'row-warning'}>
                    <td>{check.label}</td>
                    <td>{check.passed ? 'Passed' : 'Failed'}</td>
                    <td>{check.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {closing.checks.passed ? (
            <div className="inline-fields">
              <label className="ui-field">
                <span>Reason</span>
                <input className="grid-input" aria-label="Close reason" value={closeReason} maxLength={500} onChange={(e) => setCloseReason(e.target.value)} />
              </label>
              <Button type="button" variant="primary" busy={busy} disabled={!closeReason.trim()} onClick={() => void confirmClose()}>
                Close Period
              </Button>
              <Button type="button" onClick={() => setClosing(null)}>
                Cancel
              </Button>
            </div>
          ) : (
            <p className="ui-muted">
              Resolve the failed checks before closing, for example by reversing journal entries posted directly to control or inventory accounts. <Button type="button" onClick={() => setClosing(null)}>Cancel</Button>
            </p>
          )}
        </div>
      ) : null}
      {canAdminister ? (
        <form onSubmit={createYear} noValidate>
          <div className="form-section">New Fiscal Year</div>
          <div className="inline-fields">
            <label className="ui-field">
              <span>Code</span>
              <input className="grid-input" value={yearCode} maxLength={20} onChange={(e) => setYearCode(e.target.value)} />
            </label>
            <label className="ui-field">
              <span>Start Date</span>
              <input className="grid-input" type="date" value={yearStart} onChange={(e) => setYearStart(e.target.value)} />
            </label>
            <Button type="submit" variant="primary" busy={busy} disabled={!yearCode || !yearStart}>
              Add
            </Button>
          </div>
          <p className="ui-muted">A fiscal year starts on the first of a month and is split into 12 monthly posting periods.</p>
        </form>
      ) : null}
    </FormWindow>
  );
}

export function TrialBalanceForm({ call, onClose }: { call: ApiCall; onClose: () => void }) {
  const year = new Date().getFullYear();
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  const [report, setReport] = useState<TrialBalance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (event?: FormEvent) => {
    event?.preventDefault();
    setError(null);
    setBusy(true);
    const result = await call<TrialBalance>('GET', `/v1/fin/reports/trial-balance?from=${from}&to=${to}`);
    setBusy(false);
    if (result.ok) setReport(result.body);
    else setError(errorMessage(result));
  };

  return (
    <FormWindow
      title="Trial Balance"
      onClose={onClose}
      footerLeft={
        <Button type="button" variant="primary" onClick={onClose}>
          OK
        </Button>
      }
    >
      <form onSubmit={run} className="inline-fields" noValidate>
        <label className="ui-field">
          <span>Posting Date From</span>
          <input className="grid-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="ui-field">
          <span>To</span>
          <input className="grid-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <Button type="submit" variant="primary" busy={busy}>
          Run
        </Button>
      </form>
      {error ? <Banner>{error}</Banner> : null}
      {report ? (
        <>
          <p className="ui-muted">
            {report.tenantName} · {report.from} to {report.to} · {report.currency} · generated {new Date(report.generatedAt).toLocaleString()} · {report.basis}
          </p>
          <div className="ui-table-wrap">
            <table className="ui-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Name</th>
                  <th className="numeric">Opening Balance</th>
                  <th className="numeric">Debit</th>
                  <th className="numeric">Credit</th>
                  <th className="numeric">Closing Balance</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="ui-muted">
                      No postings in this range.
                    </td>
                  </tr>
                ) : (
                  report.rows.map((row) => (
                    <tr key={row.accountId}>
                      <td>{row.code}</td>
                      <td>{row.name}</td>
                      <td className="numeric">{formatAmount(row.openingBalance)}</td>
                      <td className="numeric">{formatAmount(row.debit)}</td>
                      <td className="numeric">{formatAmount(row.credit)}</td>
                      <td className="numeric">{formatAmount(row.closingBalance)}</td>
                    </tr>
                  ))
                )}
                <tr className="totals-row">
                  <td colSpan={2}>Total</td>
                  <td className="numeric">{formatAmount(report.totals.openingBalance)}</td>
                  <td className="numeric">{formatAmount(report.totals.debit)}</td>
                  <td className="numeric">{formatAmount(report.totals.credit)}</td>
                  <td className="numeric">{formatAmount(report.totals.closingBalance)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className={report.totals.debit === report.totals.credit ? 'balance-ok' : 'balance-off'}>
            {report.totals.debit === report.totals.credit ? 'Debits equal credits.' : 'Debits and credits differ; contact support.'}
          </p>
        </>
      ) : (
        <p className="ui-muted">Choose a date range and select Run.</p>
      )}
    </FormWindow>
  );
}

export function DocumentNumberingForm({ call, canAdminister, onClose }: { call: ApiCall; canAdminister: boolean; onClose: () => void }) {
  const [series, setSeries] = useState<NumberingSeries[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [first, setFirst] = useState('1');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await call<NumberingSeries[]>('GET', '/v1/tenant/numbering-series');
    if (result.ok) setSeries(result.body);
    else setError(errorMessage(result));
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    const result = await call<NumberingSeries[]>('POST', '/v1/tenant/numbering-series', {
      documentType: 'journal_entry',
      name,
      prefix,
      nextNumber: Number(first),
    });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setSeries(result.body);
    setNotice(`Series ${name} added.`);
    setName('');
    setPrefix('');
    setFirst('1');
  };

  const makeDefault = async (row: NumberingSeries) => {
    setError(null);
    const result = await call<NumberingSeries[]>('POST', `/v1/tenant/numbering-series/${row.id}/default`);
    if (result.ok) {
      setSeries(result.body);
      setNotice(`${row.name} is now the default series.`);
    } else {
      setError(errorMessage(result));
    }
  };

  return (
    <FormWindow
      title="Document Numbering - Setup"
      onClose={onClose}
      footerLeft={
        <Button type="button" variant="primary" onClick={onClose}>
          OK
        </Button>
      }
    >
      {error ? <Banner>{error}</Banner> : null}
      {notice ? <Banner tone="info">{notice}</Banner> : null}
      <DataTable
        rowNumbers
        rows={series}
        rowKey={(row) => row.id}
        empty="No series."
        columns={[
          { key: 'doc', header: 'Document', render: (row) => (row.documentType === 'journal_entry' ? 'Journal Entry' : row.documentType) },
          { key: 'name', header: 'Name', render: (row) => row.name },
          { key: 'prefix', header: 'Prefix', render: (row) => row.prefix },
          { key: 'next', header: 'Next No.', render: (row) => row.nextNumber },
          { key: 'last', header: 'Last No.', render: (row) => row.lastNumber ?? '' },
          { key: 'default', header: 'Default', render: (row) => (row.isDefault ? 'Yes' : '') },
          {
            key: 'action',
            header: '',
            render: (row) =>
              canAdminister && !row.isDefault ? (
                <Button type="button" onClick={() => void makeDefault(row)}>
                  Set as Default
                </Button>
              ) : null,
          },
        ]}
      />
      <p className="ui-muted">Numbers are assigned when a document is posted, inside the same transaction, so a failed posting does not use a number.</p>
      {canAdminister ? (
        <form onSubmit={add} noValidate>
          <div className="form-section">New Journal Entry Series</div>
          <div className="inline-fields inline-fields--four">
            <label className="ui-field">
              <span>Name</span>
              <input className="grid-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="ui-field">
              <span>Prefix</span>
              <input className="grid-input" value={prefix} maxLength={10} onChange={(e) => setPrefix(e.target.value)} />
            </label>
            <label className="ui-field">
              <span>First No.</span>
              <input className="grid-input grid-input--number" inputMode="numeric" value={first} onChange={(e) => setFirst(e.target.value.replace(/\D/g, ''))} />
            </label>
            <Button type="submit" variant="primary" busy={busy} disabled={!name || !first}>
              Add
            </Button>
          </div>
        </form>
      ) : null}
    </FormWindow>
  );
}
