import type { ArInvoiceDocument, InvoicePartySnapshot, PostalAddress } from '@nec/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateInvoiceId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid invoice id');
  return value;
}

export function escapeHtml(value: string | null | undefined): string {
  return (value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);
}

export function formatAmount(value: string): string {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const padded = fraction.padEnd(4, '0');
  const decimals = padded.slice(2) === '00' ? padded.slice(0, 2) : padded.replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimals}`;
}

export function formatQuantity(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

function addressLines(address: PostalAddress | null): string[] {
  if (!address) return [];
  const locality = [address.city, address.state, address.zipCode].filter(Boolean).join(' ');
  return [address.street, locality, address.country].filter((line): line is string => Boolean(line));
}

function party(title: string, value: InvoicePartySnapshot): string {
  const lines = [
    `<strong>${escapeHtml(value.name)}</strong>`,
    ...(value.code ? [`Code: ${escapeHtml(value.code)}`] : []),
    ...addressLines(value.address).map(escapeHtml),
    ...(value.taxNumber ? [`Tax number: ${escapeHtml(value.taxNumber)}`] : []),
    ...(value.phone ? [`Phone: ${escapeHtml(value.phone)}`] : []),
    ...(value.email ? [`Email: ${escapeHtml(value.email)}`] : []),
  ];
  return `<section class="party"><h2>${escapeHtml(title)}</h2><p>${lines.join('<br>')}</p></section>`;
}

export function invoicePdfName(document: ArInvoiceDocument): string {
  return `${document.invoice.isCancellation ? 'Cancellation' : 'Invoice'} ${document.invoice.documentNumber}.pdf`.replace(/[^A-Za-z0-9 _.-]/g, '-');
}

export function renderInvoiceHtml(document: ArInvoiceDocument): string {
  const { invoice } = document;
  const currency = escapeHtml(invoice.currency);
  const title = invoice.isCancellation ? 'Invoice Cancellation' : 'Invoice';
  const notices = [
    ...(invoice.isCancellation && document.cancellationOfNumber ? [`This document cancels invoice ${escapeHtml(document.cancellationOfNumber)}.`] : []),
    ...(invoice.status === 'cancelled' && document.cancelledByNumber ? [`Cancelled by ${escapeHtml(document.cancelledByNumber)}.`] : []),
    ...(!document.snapshotTaken ? ['Company and customer details reflect current master data; this invoice was posted before details were recorded at posting.'] : []),
  ];
  const rows = invoice.lines
    .map(
      (line) => `<tr>
        <td>${line.lineNo}</td>
        <td>${escapeHtml(line.itemCode)}</td>
        <td>${escapeHtml(line.description)}</td>
        <td class="num">${escapeHtml(formatQuantity(line.quantity))} ${escapeHtml(line.uomCode)}</td>
        <td class="num">${escapeHtml(formatAmount(line.unitPrice))}</td>
        <td>${escapeHtml(line.taxCode ?? '')}</td>
        <td class="num">${escapeHtml(formatAmount(line.taxAmount))}</td>
        <td class="num">${escapeHtml(formatAmount(line.lineTotal))}</td>
      </tr>`,
    )
    .join('');
  const taxRows = document.taxSummary
    .map(
      (row) => `<tr>
        <td>${escapeHtml(row.taxCode ?? 'No tax')}</td>
        <td class="num">${escapeHtml(formatQuantity(row.taxRate))}%</td>
        <td class="num">${escapeHtml(formatAmount(row.base))}</td>
        <td class="num">${escapeHtml(formatAmount(row.taxAmount))}</td>
      </tr>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(title)} ${escapeHtml(invoice.documentNumber)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, sans-serif; font-size: 10pt; color: #1a1a1a; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #333; padding-bottom: 8px; margin-bottom: 12px; }
  h1 { font-size: 18pt; margin: 0; }
  h2 { font-size: 9pt; text-transform: uppercase; letter-spacing: 0.04em; color: #555; margin: 0 0 4px; }
  .meta { border-collapse: collapse; }
  .meta td { padding: 1px 0 1px 12px; }
  .meta td:first-child { color: #555; }
  .parties { display: flex; gap: 24px; margin-bottom: 12px; }
  .party { flex: 1; }
  .party p { margin: 0; line-height: 1.4; }
  .notice { border: 1px solid #b00020; color: #b00020; padding: 6px 8px; margin-bottom: 10px; font-weight: 600; }
  table.lines, table.tax { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
  table.lines th, table.tax th { text-align: left; border-bottom: 1px solid #333; padding: 4px; font-size: 9pt; }
  table.lines td, table.tax td { border-bottom: 1px solid #ddd; padding: 4px; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; }
  th.num { text-align: right; }
  .summary { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
  .summary table.tax { width: 55%; }
  .totals { border-collapse: collapse; min-width: 38%; }
  .totals td { padding: 3px 4px; }
  .totals tr.grand td { border-top: 2px solid #333; font-weight: 700; font-size: 11pt; }
  footer { margin-top: 18px; border-top: 1px solid #ddd; padding-top: 6px; color: #444; white-space: pre-wrap; }
</style>
</head>
<body>
<header>
  <div>
    <h1>${escapeHtml(title)}</h1>
    <div>${escapeHtml(document.seller.name)}</div>
  </div>
  <table class="meta">
    <tr><td>Number</td><td><strong>${escapeHtml(invoice.documentNumber)}</strong></td></tr>
    <tr><td>Document date</td><td>${escapeHtml(invoice.documentDate)}</td></tr>
    <tr><td>Posting date</td><td>${escapeHtml(invoice.postingDate)}</td></tr>
    <tr><td>Due date</td><td>${escapeHtml(invoice.dueDate)}</td></tr>
    ${invoice.paymentTermsCode ? `<tr><td>Payment terms</td><td>${escapeHtml(invoice.paymentTermsCode)}</td></tr>` : ''}
    ${invoice.customerReference ? `<tr><td>Customer reference</td><td>${escapeHtml(invoice.customerReference)}</td></tr>` : ''}
    <tr><td>Currency</td><td>${currency}</td></tr>
  </table>
</header>
${notices.map((notice) => `<div class="notice">${notice}</div>`).join('')}
<div class="parties">
  ${party('From', document.seller)}
  ${party('Bill to', document.buyer)}
</div>
<table class="lines">
  <thead><tr><th>#</th><th>Item</th><th>Description</th><th class="num">Quantity</th><th class="num">Unit price</th><th>Tax</th><th class="num">Tax amount</th><th class="num">Total (${currency})</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<div class="summary">
  <table class="tax">
    <thead><tr><th>Tax code</th><th class="num">Rate</th><th class="num">Taxable amount</th><th class="num">Tax</th></tr></thead>
    <tbody>${taxRows}</tbody>
  </table>
  <table class="totals">
    <tr><td>Total before tax</td><td class="num">${escapeHtml(formatAmount(invoice.subtotal))}</td></tr>
    <tr><td>Tax</td><td class="num">${escapeHtml(formatAmount(invoice.taxTotal))}</td></tr>
    <tr class="grand"><td>Total ${currency}</td><td class="num">${escapeHtml(formatAmount(invoice.total))}</td></tr>
  </table>
</div>
${invoice.remarks ? `<p>Remarks: ${escapeHtml(invoice.remarks)}</p>` : ''}
${document.footer ? `<footer>${escapeHtml(document.footer)}</footer>` : ''}
</body>
</html>`;
}
