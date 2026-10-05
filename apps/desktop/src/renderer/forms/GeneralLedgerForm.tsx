import { Fragment, useEffect, useState, type FormEvent } from 'react';
import type { GeneralLedgerReport, Page, PartnerSummary } from '@nec/contracts';
import { Banner, Button, FormWindow } from '@nec/ui';
import { errorMessage } from '../api';
import { formatAmount } from '../format';
import type { ApiCall } from '../screens/Shell';
import { BYTE_ORDER_MARK, csvCell } from './ReportForms';

const SOURCE_LABELS: Record<string, string> = {
  manual: 'Journal Entry',
  reversal: 'Reversal',
  goods_receipt: 'Goods Receipt PO',
  ap_invoice: 'A/P Invoice',
  outgoing_payment: 'Outgoing Payment',
  incoming_payment: 'Incoming Payment',
  delivery: 'Delivery',
  ar_invoice: 'A/R Invoice',
  opening_balance: 'Opening Balance',
};

const sourceLabel = (type: string) => SOURCE_LABELS[type] ?? type.split('_').map((word) => (word === 'ap' || word === 'ar' ? `${word.toUpperCase().split('').join('/')}` : `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)).join(' ');

export function GeneralLedgerForm({ call, onClose }: { call: ApiCall; onClose: () => void }) {
  const year = new Date().getFullYear();
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  const [accountFrom, setAccountFrom] = useState('');
  const [accountTo, setAccountTo] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const [partners, setPartners] = useState<PartnerSummary[]>([]);
  const [report, setReport] = useState<GeneralLedgerReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void call<Page<PartnerSummary>>('GET', '/v1/bp/partners?limit=200').then((result) => {
      if (result.ok) setPartners(result.body.items);
    });
  }, [call]);

  const run = async (event?: FormEvent) => {
    event?.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    const params = new URLSearchParams({ from, to });
    if (accountFrom.trim()) params.set('accountFrom', accountFrom.trim());
    if (accountTo.trim()) params.set('accountTo', accountTo.trim());
    if (partnerId) params.set('partnerId', partnerId);
    const result = await call<GeneralLedgerReport>('GET', `/v1/fin/reports/general-ledger?${params.toString()}`);
    setBusy(false);
    if (result.ok) setReport(result.body);
    else setError(errorMessage(result));
  };

  const exportCsv = async () => {
    if (!report) return;
    const rows: (string | number)[][] = [
      ['Company', csvCell(report.tenantName)],
      ['From', report.from],
      ['To', report.to],
      ['Currency', report.currency],
      ['Basis', csvCell(report.basis)],
      ['Generated', report.generatedAt],
      [],
      ['Account', 'Name', 'Posting Date', 'Journal', 'Origin', 'Reference', 'Memo', 'BP', 'Debit', 'Credit', 'Balance'],
    ];
    for (const account of report.accounts) {
      rows.push([csvCell(account.accountCode), csvCell(account.accountName), '', '', 'Opening balance', '', '', '', '', '', account.openingBalance]);
      for (const line of account.lines) {
        rows.push([csvCell(account.accountCode), '', line.postingDate, csvCell(line.journalNumber), csvCell(sourceLabel(line.sourceType)), csvCell(line.reference ?? ''), csvCell(line.memo ?? ''), csvCell(line.partnerCode ?? ''), line.debit, line.credit, line.balance]);
      }
      rows.push([csvCell(account.accountCode), '', '', '', 'Closing balance', '', '', '', account.debit, account.credit, account.closingBalance]);
    }
    const saved = await window.erp.saveTextFile(`General Ledger ${report.from} to ${report.to}.csv`, `${BYTE_ORDER_MARK}${rows.map((row) => row.join(',')).join('\r\n')}\r\n`);
    if (saved.saved) setNotice('Report exported.');
  };

  return (
    <FormWindow
      title="General Ledger"
      width={1040}
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
          <span>From</span>
          <input className="grid-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="ui-field">
          <span>To</span>
          <input className="grid-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="ui-field">
          <span>Account From</span>
          <input className="grid-input" aria-label="Account from" value={accountFrom} maxLength={20} onChange={(e) => setAccountFrom(e.target.value)} />
        </label>
        <label className="ui-field">
          <span>Account To</span>
          <input className="grid-input" aria-label="Account to" value={accountTo} maxLength={20} onChange={(e) => setAccountTo(e.target.value)} />
        </label>
        <label className="ui-field">
          <span>Business Partner</span>
          <select className="grid-input" aria-label="Business partner" value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
            <option value="">All</option>
            {partners.map((partner) => (
              <option key={partner.id} value={partner.id}>
                {partner.code} - {partner.name}
              </option>
            ))}
          </select>
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
            {report.tenantName} · {report.from} to {report.to} · {report.currency} · {report.basis} · generated {new Date(report.generatedAt).toLocaleString()}
          </p>
          <div className="ui-table-wrap">
            <table className="ui-table" aria-label="General Ledger">
              <thead>
                <tr>
                  <th>Posting Date</th>
                  <th>Journal</th>
                  <th>Origin</th>
                  <th>Reference / Memo</th>
                  <th>BP</th>
                  <th className="numeric">Debit</th>
                  <th className="numeric">Credit</th>
                  <th className="numeric">Balance</th>
                </tr>
              </thead>
              <tbody>
                {report.accounts.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="ui-muted">
                      No postings or balances for these filters.
                    </td>
                  </tr>
                ) : null}
                {report.accounts.map((account) => (
                  <Fragment key={account.accountId}>
                    <tr className="group-row">
                      <td colSpan={5}>
                        {account.accountCode} - {account.accountName} · opening balance
                      </td>
                      <td />
                      <td />
                      <td className="numeric">{formatAmount(account.openingBalance)}</td>
                    </tr>
                    {account.lines.map((line, index) => (
                      <tr key={`${account.accountId}-${line.journalId}-${index}`}>
                        <td className="indent-cell">{line.postingDate}</td>
                        <td>{line.journalNumber}</td>
                        <td>{sourceLabel(line.sourceType)}</td>
                        <td>{[line.reference, line.memo].filter(Boolean).join(' · ')}</td>
                        <td>{line.partnerCode ?? ''}</td>
                        <td className="numeric">{line.debit === '0.0000' ? '' : formatAmount(line.debit)}</td>
                        <td className="numeric">{line.credit === '0.0000' ? '' : formatAmount(line.credit)}</td>
                        <td className="numeric">{formatAmount(line.balance)}</td>
                      </tr>
                    ))}
                    <tr className="totals-row">
                      <td colSpan={5}>{account.accountCode} closing balance</td>
                      <td className="numeric">{formatAmount(account.debit)}</td>
                      <td className="numeric">{formatAmount(account.credit)}</td>
                      <td className="numeric">{formatAmount(account.closingBalance)}</td>
                    </tr>
                  </Fragment>
                ))}
                {report.accounts.length > 0 ? (
                  <tr className="totals-row">
                    <td colSpan={5}>Total for the period</td>
                    <td className="numeric">{formatAmount(report.totals.debit)}</td>
                    <td className="numeric">{formatAmount(report.totals.credit)}</td>
                    <td />
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </FormWindow>
  );
}
