import { Fragment, useEffect, useState, type FormEvent } from 'react';
import type { AgingBasis, AgingBucketKey, AgingBuckets, ApAgingReport, ArAgingReport, Page, PartnerSummary } from '@nec/contracts';
import { Banner, Button, FormWindow } from '@nec/ui';
import { errorMessage } from '../api';
import { formatAmount, today } from '../format';
import type { ApiCall } from '../screens/Shell';

const BUCKETS: { key: AgingBucketKey; label: string }[] = [
  { key: 'current', label: 'Current' },
  { key: 'days1To30', label: '1-30 Days' },
  { key: 'days31To60', label: '31-60 Days' },
  { key: 'days61To90', label: '61-90 Days' },
  { key: 'over90', label: '90+ Days' },
];

export const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

const TYPE_LABELS = {
  ap_invoice: 'A/P Invoice',
  ar_invoice: 'A/R Invoice',
  outgoing_payment: 'Outgoing Payment',
  incoming_payment: 'Incoming Payment',
  opening_balance: 'Opening Balance',
  journal_entry: 'Journal Entry',
} as const;

type AgingSide = 'payables' | 'receivables';

interface AgingRow extends AgingBuckets {
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  documents: (ApAgingReport['vendors'][number]['documents'][number] | ArAgingReport['customers'][number]['documents'][number])[];
}

type AgingView = Omit<ApAgingReport, 'vendors'> & { rows: AgingRow[] };

const SIDES = {
  payables: {
    title: 'Vendor Liabilities Aging',
    partner: 'Vendor',
    partnerType: 'supplier',
    path: '/v1/fin/reports/ap-aging',
    filter: 'vendorId',
    all: 'All vendors',
    empty: 'No open vendor balances on this date.',
    fileName: 'Vendor Aging',
    toView: (body: unknown): AgingView => {
      const { vendors, ...report } = body as ApAgingReport;
      return { ...report, rows: vendors.map(({ vendorId, vendorCode, vendorName, ...rest }) => ({ partnerId: vendorId, partnerCode: vendorCode, partnerName: vendorName, ...rest })) };
    },
  },
  receivables: {
    title: 'Customer Receivables Aging',
    partner: 'Customer',
    partnerType: 'customer',
    path: '/v1/fin/reports/ar-aging',
    filter: 'customerId',
    all: 'All customers',
    empty: 'No open customer balances on this date.',
    fileName: 'Customer Aging',
    toView: (body: unknown): AgingView => {
      const { customers, ...report } = body as ArAgingReport;
      return { ...report, rows: customers.map(({ customerId, customerCode, customerName, ...rest }) => ({ partnerId: customerId, partnerCode: customerCode, partnerName: customerName, ...rest })) };
    },
  },
} as const;

export function csvCell(value: string | number, text = true): string {
  let cell = String(value);
  if (text && /^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

function agingCsv(side: AgingSide, report: AgingView): string {
  const config = SIDES[side];
  const rows: string[][] = [
    [config.title],
    ['Company', csvCell(report.tenantName)],
    ['As of', report.asOf],
    ['Aging by', report.basis === 'due_date' ? 'Due date' : 'Posting date'],
    ['Currency', report.currency],
    ['Generated', report.generatedAt],
    ['Basis', csvCell(report.accountingBasis)],
    [],
    [`${config.partner} Code`, `${config.partner} Name`, 'Document Type', 'Document No.', 'Reference', 'Posting Date', 'Due Date', 'Days', 'Bucket', 'Original Amount', 'Open Amount'],
  ];
  for (const vendor of report.rows) {
    for (const doc of vendor.documents) {
      rows.push([
        csvCell(vendor.partnerCode),
        csvCell(vendor.partnerName),
        TYPE_LABELS[doc.type],
        csvCell(doc.documentNumber),
        csvCell(doc.reference ?? ''),
        doc.postingDate,
        doc.dueDate,
        String(doc.days),
        BUCKETS.find((bucket) => bucket.key === doc.bucket)?.label ?? doc.bucket,
        csvCell(doc.originalAmount, false),
        csvCell(doc.openAmount, false),
      ]);
    }
  }
  rows.push([], [`${config.partner} Code`, `${config.partner} Name`, ...BUCKETS.map((bucket) => bucket.label), 'Total']);
  for (const vendor of report.rows) rows.push([csvCell(vendor.partnerCode), csvCell(vendor.partnerName), ...BUCKETS.map((bucket) => vendor[bucket.key]), vendor.total]);
  rows.push(['Total', '', ...BUCKETS.map((bucket) => report.totals[bucket.key]), report.totals.total]);
  rows.push([], [`Control account ${report.controlAccount.code}`, csvCell(report.controlAccount.name), report.controlAccount.balance], ['Difference', '', report.difference]);
  return `${BYTE_ORDER_MARK}${rows.map((row) => row.join(',')).join('\r\n')}\r\n`;
}

export function AgingForm({ call, side, onClose }: { call: ApiCall; side: AgingSide; onClose: () => void }) {
  const config = SIDES[side];
  const [asOf, setAsOf] = useState(today());
  const [basis, setBasis] = useState<AgingBasis>('due_date');
  const [vendorId, setVendorId] = useState('');
  const [vendors, setVendors] = useState<PartnerSummary[]>([]);
  const [report, setReport] = useState<AgingView | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void call<Page<PartnerSummary>>('GET', `/v1/bp/partners?partnerType=${config.partnerType}&limit=200`).then((result) => {
      if (result.ok) setVendors(result.body.items);
    });
  }, [call, config]);

  const run = async (event?: FormEvent) => {
    event?.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    const result = await call<unknown>('GET', `${config.path}?asOf=${asOf}&basis=${basis}${vendorId ? `&${config.filter}=${vendorId}` : ''}`);
    setBusy(false);
    if (result.ok) {
      setReport(config.toView(result.body));
      setExpanded(new Set());
    } else setError(errorMessage(result));
  };

  const exportCsv = async () => {
    if (!report) return;
    setError(null);
    const result = await window.erp.saveTextFile(`${config.fileName} ${report.asOf}.csv`, agingCsv(side, report));
    if (result.saved) setNotice('Report exported.');
  };

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <FormWindow
      title={config.title}
      width={980}
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
          <span>Aging Date</span>
          <input className="grid-input" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>
        <label className="ui-field">
          <span>Age By</span>
          <select className="grid-input" value={basis} onChange={(e) => setBasis(e.target.value as AgingBasis)}>
            <option value="due_date">Due Date</option>
            <option value="posting_date">Posting Date</option>
          </select>
        </label>
        <label className="ui-field">
          <span>{config.partner}</span>
          <select className="grid-input" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">{config.all}</option>
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.code} - {vendor.name}
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
            {report.tenantName} · as of {report.asOf} · aged by {report.basis === 'due_date' ? 'due date' : 'posting date'} · {report.currency} · generated{' '}
            {new Date(report.generatedAt).toLocaleString()}
          </p>
          <div className="ui-table-wrap">
            <table className="ui-table" aria-label={config.title}>
              <thead>
                <tr>
                  <th>{config.partner} / Document</th>
                  <th>Name / Reference</th>
                  <th>Due Date</th>
                  <th className="numeric">Days</th>
                  {BUCKETS.map((bucket) => (
                    <th key={bucket.key} className="numeric">
                      {bucket.label}
                    </th>
                  ))}
                  <th className="numeric">Balance</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="ui-muted">
                      {config.empty}
                    </td>
                  </tr>
                ) : (
                  report.rows.map((vendor) => (
                    <Fragment key={vendor.partnerId}>
                      <tr className="group-row">
                        <td>
                          <Button type="button" variant="ghost" aria-expanded={expanded.has(vendor.partnerId)} aria-label={`Show documents for ${vendor.partnerCode}`} onClick={() => toggle(vendor.partnerId)}>
                            {expanded.has(vendor.partnerId) ? '−' : '+'}
                          </Button>{' '}
                          {vendor.partnerCode}
                        </td>
                        <td>{vendor.partnerName}</td>
                        <td />
                        <td />
                        {BUCKETS.map((bucket) => (
                          <td key={bucket.key} className="numeric">
                            {vendor[bucket.key] === '0.0000' ? '' : formatAmount(vendor[bucket.key])}
                          </td>
                        ))}
                        <td className="numeric">
                          <strong>{formatAmount(vendor.total)}</strong>
                        </td>
                      </tr>
                      {expanded.has(vendor.partnerId)
                        ? vendor.documents.map((doc) => (
                            <tr key={`${doc.type}-${doc.id}`}>
                              <td className="indent-cell">
                                {TYPE_LABELS[doc.type]} {doc.documentNumber}
                              </td>
                              <td>{doc.reference ?? ''}</td>
                              <td>{doc.dueDate}</td>
                              <td className="numeric">{doc.days}</td>
                              {BUCKETS.map((bucket) => (
                                <td key={bucket.key} className="numeric">
                                  {doc.bucket === bucket.key ? formatAmount(doc.openAmount) : ''}
                                </td>
                              ))}
                              <td className="numeric">{formatAmount(doc.openAmount)}</td>
                            </tr>
                          ))
                        : null}
                    </Fragment>
                  ))
                )}
                <tr className="totals-row">
                  <td colSpan={4}>Total</td>
                  {BUCKETS.map((bucket) => (
                    <td key={bucket.key} className="numeric">
                      {formatAmount(report.totals[bucket.key])}
                    </td>
                  ))}
                  <td className="numeric">{formatAmount(report.totals.total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className={report.difference === '0.0000' ? 'balance-ok' : 'balance-off'}>
            Control account {report.controlAccount.code} {report.controlAccount.name}: {formatAmount(report.controlAccount.balance)} {report.currency}.{' '}
            {report.difference === '0.0000' ? 'The aging reconciles with the control account.' : `Difference ${formatAmount(report.difference)}; investigate before relying on this report.`}
          </p>
          <p className="ui-muted">{report.accountingBasis}.</p>
        </>
      ) : (
        <p className="ui-muted">Choose an aging date and select Run.</p>
      )}
    </FormWindow>
  );
}
