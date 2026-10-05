import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ArInvoiceDocument } from '@nec/contracts';
import { formatAmount, formatQuantity, invoicePdfName, renderInvoiceHtml, validateInvoiceId } from './invoice-document.js';

const sample = (): ArInvoiceDocument => ({
  invoice: {
    id: '7d3f8a52-1c2b-4d6e-9f00-112233445566',
    documentNumber: 'IN12',
    customerId: 'c',
    customerCode: 'C100',
    customerName: 'Customer',
    branchCode: 'HQ',
    postingDate: '2026-04-06',
    documentDate: '2026-04-06',
    dueDate: '2026-05-06',
    customerReference: 'PO <77>',
    remarks: null,
    currency: 'PKR',
    subtotal: '1250.0000',
    taxTotal: '125.0000',
    total: '1375.0000',
    paidAmount: '0.0000',
    openAmount: '1375.0000',
    status: 'posted',
    isCancellation: false,
    cancellationOfId: null,
    cancelledById: null,
    cancellationReason: null,
    journalId: null,
    journalNumber: null,
    paymentTermsCode: 'NET30',
    priceOverride: false,
    postedAt: '2026-04-06T10:00:00.000Z',
    lines: [
      {
        id: 'l1', lineNo: 1, lineKind: 'order', deliveryId: null, deliveryNumber: null, deliveryLineId: null, orderLineId: 'o', orderNumber: 'SO1',
        itemId: 'i', itemCode: 'SRV-1', description: '<script>alert(1)</script> Consulting', uomCode: 'EA', quantity: '2.5000', unitPrice: '500.0000',
        sourcePrice: '500.0000', lineTotal: '1250.0000', revenueAccountCode: '4100', taxCode: 'VAT10', taxRate: '10.0000', taxAmount: '125.0000',
      },
    ],
  },
  seller: { name: 'Acme & Sons', code: null, taxNumber: 'TAX-1', phone: null, email: null, address: { street: '1 Road', city: 'Karachi', state: null, zipCode: '75500', country: 'Pakistan' } },
  buyer: { name: 'Buyer "Quoted" Ltd', code: 'C100', taxNumber: null, phone: null, email: null, address: null },
  footer: 'Bank: <none>',
  taxSummary: [{ taxCode: 'VAT10', taxRate: '10.0000', base: '1250.0000', taxAmount: '125.0000' }],
  cancellationOfNumber: null,
  cancelledByNumber: null,
  snapshotTaken: true,
  generatedAt: '2026-04-06T10:00:00.000Z',
});

describe('invoice document rendering', () => {
  it('escapes every printed value and blocks scripts with a restrictive policy', () => {
    const html = renderInvoiceHtml(sample());
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; Consulting'));
    assert.ok(html.includes('Acme &amp; Sons'));
    assert.ok(html.includes('Buyer &quot;Quoted&quot; Ltd'));
    assert.ok(html.includes('PO &lt;77&gt;'));
    assert.ok(html.includes('Bank: &lt;none&gt;'));
    assert.ok(html.includes("default-src 'none'"));
    assert.ok(html.includes('Tax number: TAX-1'));
    assert.ok(html.includes('Karachi 75500'));
    assert.ok(html.includes('1,375.00'));
    assert.ok(html.includes('2.5 EA'));
    assert.ok(html.includes('<td>Payment terms</td><td>NET30</td>'));
  });

  it('marks cancellations and cancelled originals and names the file safely', () => {
    const cancellation = sample();
    cancellation.invoice.isCancellation = true;
    cancellation.invoice.documentNumber = 'IN13';
    cancellation.cancellationOfNumber = 'IN12';
    const html = renderInvoiceHtml(cancellation);
    assert.ok(html.includes('Invoice Cancellation'));
    assert.ok(html.includes('This document cancels invoice IN12.'));
    assert.equal(invoicePdfName(cancellation), 'Cancellation IN13.pdf');
    const original = sample();
    original.invoice.status = 'cancelled';
    original.cancelledByNumber = 'IN13';
    assert.ok(renderInvoiceHtml(original).includes('Cancelled by IN13.'));
    original.invoice.documentNumber = 'IN/12:*';
    assert.equal(invoicePdfName(original), 'Invoice IN-12--.pdf');
  });

  it('formats amounts and quantities and accepts only invoice UUIDs', () => {
    assert.equal(formatAmount('1234567.5000'), '1,234,567.50');
    assert.equal(formatAmount('0.1250'), '0.125');
    assert.equal(formatAmount('-12.0000'), '-12.00');
    assert.equal(formatQuantity('10.0000'), '10');
    assert.equal(formatQuantity('0.2500'), '0.25');
    assert.equal(validateInvoiceId('7d3f8a52-1c2b-4d6e-9f00-112233445566'), '7d3f8a52-1c2b-4d6e-9f00-112233445566');
    for (const value of ['../x', '7d3f8a52-1c2b-4d6e-9f00-11223344556', 42, null]) assert.throws(() => validateInvoiceId(value), /invoice id/);
  });
});
