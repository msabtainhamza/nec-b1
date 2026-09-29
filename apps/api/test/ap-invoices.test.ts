import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type {
  Account,
  ApInvoice,
  GoodsReceipt,
  InvoiceableReceiptLine,
  Item,
  ItemGroup,
  JournalEntry,
  PartnerBalance,
  PartnerGroup,
  PaymentTerms,
  PostingPeriod,
  PurchaseOrder,
  PurchasingSettings,
  UnitOfMeasure,
} from '@nec/contracts';
import { ACME, ACME_OWNER, bearer, GLOBEX, GLOBEX_OWNER, loginToTenant, setup, SHARED, type TestContext } from './helpers.js';

const YEAR = new Date().getUTCFullYear();
const day = (month: number, date: number) => `${YEAR}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;

describe('A/P invoices', () => {
  let ctx: TestContext;
  let acme: string;
  let bpGroups: PartnerGroup[];
  let units: UnitOfMeasure[];
  let groups: ItemGroup[];
  let terms: PaymentTerms[];
  let accounts: Account[];
  let sequence = 0;

  const vendor = async (withTerms = true) => {
    sequence += 1;
    const response = await ctx.http
      .post('/v1/bp/partners')
      .set(bearer(acme))
      .send({
        code: `AP-V${sequence}`,
        partnerType: 'supplier',
        name: `AP Vendor ${sequence}`,
        groupId: bpGroups.find((g) => g.partnerType === 'supplier')?.id,
        paymentTermsId: withTerms ? terms.find((t) => t.code === 'NET30')?.id : null,
      });
    return response.body.id as string;
  };

  const item = async (itemType: 'inventory' | 'service') => {
    sequence += 1;
    const response = await ctx.http
      .post('/v1/inv/items')
      .set(bearer(acme))
      .send({
        code: `AP-${itemType}-${sequence}`,
        name: `AP ${itemType} ${sequence}`,
        itemType,
        groupId: groups.find((g) => g.code === (itemType === 'service' ? 'SERVICES' : 'GENERAL'))?.id,
        uomId: units.find((u) => u.code === 'EA')?.id,
      });
    return response.body as Item;
  };

  const purchase = async (vendorId: string, lines: { itemId: string; quantity: string; unitPrice: string }[]) => {
    const response = await ctx.http
      .post('/v1/pur/orders')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), vendorId, postingDate: day(6, 1), deliveryDate: day(6, 5), lines });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body as PurchaseOrder;
  };

  const receive = async (po: PurchaseOrder, quantities: string[], postingDate = day(6, 3)) => {
    const response = await ctx.http
      .post('/v1/pur/receipts')
      .set(bearer(acme))
      .send({
        idempotencyKey: randomUUID(),
        orderId: po.id,
        postingDate,
        lines: quantities
          .map((quantity, index) => ({ orderLineId: po.lines[index]?.id, quantity }))
          .filter((line) => line.quantity !== '0'),
      });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body as GoodsReceipt;
  };

  const invoice = (vendorId: string, lines: { receiptLineId: string; quantity: string; unitPrice: string }[], extra: Record<string, unknown> = {}) =>
    ctx.http
      .post('/v1/pur/invoices')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), vendorId, postingDate: day(6, 10), lines, ...extra });

  const balance = async (partnerId: string) => ((await ctx.http.get(`/v1/bp/partners/${partnerId}/balance`).set(bearer(acme))).body as PartnerBalance).balance;

  before(async () => {
    ctx = await setup();
    acme = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    bpGroups = (await ctx.http.get('/v1/bp/groups').set(bearer(acme))).body;
    units = (await ctx.http.get('/v1/inv/units').set(bearer(acme))).body;
    groups = (await ctx.http.get('/v1/inv/item-groups').set(bearer(acme))).body;
    terms = (await ctx.http.get('/v1/bp/payment-terms').set(bearer(acme))).body;
    accounts = (await ctx.http.get('/v1/fin/accounts').set(bearer(acme))).body;
  });

  after(async () => {
    await ctx.close();
  });

  it('invoices several receipts in one invoice and clears GRNI to the vendor payable', async () => {
    const vendorId = await vendor();
    const stocked = await item('inventory');
    const service = await item('service');
    const po = await purchase(vendorId, [
      { itemId: stocked.id, quantity: '10', unitPrice: '5' },
      { itemId: service.id, quantity: '1', unitPrice: '100' },
    ]);
    const first = await receive(po, ['6', '1']);
    const second = await receive(po, ['4', '0'], day(6, 4));
    const open = (await ctx.http.get(`/v1/pur/invoiceable?vendorId=${vendorId}`).set(bearer(acme))).body as InvoiceableReceiptLine[];
    assert.equal(open.length, 3);
    const response = await invoice(
      vendorId,
      open.map((line) => ({ receiptLineId: line.receiptLineId, quantity: line.openQuantity, unitPrice: line.receiptPrice })),
      { vendorReference: 'INV-1001', documentDate: day(6, 9) },
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const posted = response.body as ApInvoice;
    assert.equal(posted.documentNumber, 'AP1');
    assert.equal(posted.total, '150.0000');
    assert.equal(posted.openAmount, '150.0000');
    assert.equal(posted.dueDate, day(7, 9));
    assert.deepEqual([...new Set(posted.lines.map((line) => line.receiptNumber))].sort(), [first.documentNumber, second.documentNumber].sort());
    const journal = (await ctx.http.get(`/v1/fin/journal-entries/${posted.journalId}`).set(bearer(acme))).body as JournalEntry;
    assert.deepEqual(
      journal.lines.map((line) => `${line.accountCode}:${line.partnerCode ?? ''}:${line.debit}:${line.credit}`),
      ['2150::50.0000:0.0000', '5400::100.0000:0.0000', `2100:AP-V${sequence - 2}:0.0000:150.0000`],
    );
    assert.equal(await balance(vendorId), '150.0000');
    const remaining = (await ctx.http.get(`/v1/pur/invoiceable?vendorId=${vendorId}`).set(bearer(acme))).body as InvoiceableReceiptLine[];
    assert.equal(remaining.length, 0);
    const cancelReceipt = await ctx.http
      .post(`/v1/pur/receipts/${second.id}/cancel`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), postingDate: day(6, 11), reason: 'Should be blocked' });
    assert.equal(cancelReceipt.status, 409);
    assert.match(cancelReceipt.body.error.message, /Supplier invoices/);
  });

  it('rejects over-invoicing, duplicate vendor invoice numbers and other vendors’ receipts', async () => {
    const vendorId = await vendor();
    const otherVendor = await vendor();
    const stocked = await item('inventory');
    const po = await purchase(vendorId, [{ itemId: stocked.id, quantity: '5', unitPrice: '2' }]);
    const receipt = await receive(po, ['5']);
    const lineId = receipt.lines[0]?.id as string;
    const over = await invoice(vendorId, [{ receiptLineId: lineId, quantity: '6', unitPrice: '2' }]);
    assert.equal(over.status, 422);
    assert.equal(over.body.error.code, 'OVER_INVOICE');
    const wrongVendor = await invoice(otherVendor, [{ receiptLineId: lineId, quantity: '1', unitPrice: '2' }]);
    assert.equal(wrongVendor.status, 400);
    const firstPart = await invoice(vendorId, [{ receiptLineId: lineId, quantity: '2', unitPrice: '2' }], { vendorReference: 'DUP-1' });
    assert.equal(firstPart.status, 201);
    const duplicate = await invoice(vendorId, [{ receiptLineId: lineId, quantity: '1', unitPrice: '2' }], { vendorReference: 'dup-1' });
    assert.equal(duplicate.status, 409);
    const early = await invoice(vendorId, [{ receiptLineId: lineId, quantity: '1', unitPrice: '2' }], { postingDate: day(6, 2) });
    assert.equal(early.status, 400);
    const rest = await invoice(vendorId, [{ receiptLineId: lineId, quantity: '3', unitPrice: '2' }], { vendorReference: 'DUP-2' });
    assert.equal(rest.status, 201);
    assert.equal(await balance(vendorId), '10.0000');
  });

  it('enforces the price tolerance and records overrides and price differences', async () => {
    const vendorId = await vendor(false);
    const stocked = await item('inventory');
    const po = await purchase(vendorId, [{ itemId: stocked.id, quantity: '20', unitPrice: '10' }]);
    const receipt = await receive(po, ['20']);
    const lineId = receipt.lines[0]?.id as string;
    const variance = await invoice(vendorId, [{ receiptLineId: lineId, quantity: '5', unitPrice: '10.50' }]);
    assert.equal(variance.status, 422);
    assert.equal(variance.body.error.code, 'PRICE_VARIANCE');
    const overridden = await invoice(vendorId, [{ receiptLineId: lineId, quantity: '5', unitPrice: '10.50' }], { priceOverride: true });
    assert.equal(overridden.status, 201);
    assert.equal(overridden.body.priceOverride, true);
    assert.equal(overridden.body.dueDate, day(6, 10));
    const journal = (await ctx.http.get(`/v1/fin/journal-entries/${overridden.body.journalId}`).set(bearer(acme))).body as JournalEntry;
    assert.deepEqual(
      journal.lines.map((line) => `${line.accountCode}:${line.debit}:${line.credit}`),
      ['2150:50.0000:0.0000', '1300:2.5000:0.0000', '2100:0.0000:52.5000'],
    );
    const settings = (await ctx.http.get('/v1/pur/settings').set(bearer(acme))).body as PurchasingSettings;
    const updated = await ctx.http.put('/v1/pur/settings').set(bearer(acme)).send({ priceTolerancePercent: '5', version: settings.version });
    assert.equal(updated.status, 200);
    const withinTolerance = await invoice(vendorId, [{ receiptLineId: lineId, quantity: '5', unitPrice: '9.60' }]);
    assert.equal(withinTolerance.status, 201);
    const lower = (await ctx.http.get(`/v1/fin/journal-entries/${withinTolerance.body.journalId}`).set(bearer(acme))).body as JournalEntry;
    assert.deepEqual(
      lower.lines.map((line) => `${line.accountCode}:${line.debit}:${line.credit}`).sort(),
      ['1300:0.0000:2.0000', '2100:0.0000:48.0000', '2150:50.0000:0.0000'],
    );
    const audit = await ctx.http.get('/v1/tenant/audit-events?limit=30').set(bearer(acme));
    assert.ok((audit.body.items as { action: string }[]).some((event) => event.action === 'ap_invoice.posted_with_price_override'));
    const stock = (await ctx.http.get(`/v1/inv/items/${stocked.id}/stock`).set(bearer(acme))).body as { totalValue: string; averageCost: string };
    assert.equal(stock.totalValue, '200.5000');
    assert.equal(stock.averageCost, '10.025000');
  });

  it('applies dated purchase tax codes and posts input tax', async () => {
    const created = await ctx.http
      .post('/v1/fin/tax-codes')
      .set(bearer(acme))
      .send({ code: 'VAT10', name: 'Test purchase tax 10%', purpose: 'purchase', rate: '10', validFrom: day(1, 1) });
    assert.equal(created.status, 201);
    const increase = await ctx.http.post(`/v1/fin/tax-codes/${created.body.id}/rates`).set(bearer(acme)).send({ rate: '12', validFrom: day(8, 1) });
    assert.equal(increase.status, 201);
    assert.equal((increase.body as { rates: unknown[] }).rates.length, 2);
    const duplicateRate = await ctx.http.post(`/v1/fin/tax-codes/${created.body.id}/rates`).set(bearer(acme)).send({ rate: '13', validFrom: day(8, 1) });
    assert.equal(duplicateRate.status, 409);
    const vendorId = await vendor();
    const stocked = await item('inventory');
    const po = await purchase(vendorId, [{ itemId: stocked.id, quantity: '3', unitPrice: '10' }]);
    const receipt = await receive(po, ['3']);
    const june = await ctx.http
      .post('/v1/pur/invoices')
      .set(bearer(acme))
      .send({
        idempotencyKey: randomUUID(),
        vendorId,
        postingDate: day(6, 10),
        lines: [{ receiptLineId: receipt.lines[0]?.id, quantity: '3', unitPrice: '10', taxCodeId: created.body.id }],
      });
    assert.equal(june.status, 201, JSON.stringify(june.body));
    const posted = june.body as ApInvoice;
    assert.equal(posted.subtotal, '30.0000');
    assert.equal(posted.taxTotal, '3.0000');
    assert.equal(posted.total, '33.0000');
    assert.equal(posted.lines[0]?.taxRate, '10.0000');
    const journal = (await ctx.http.get(`/v1/fin/journal-entries/${posted.journalId}`).set(bearer(acme))).body as JournalEntry;
    assert.deepEqual(
      journal.lines.map((line) => `${line.accountCode}:${line.debit}:${line.credit}`).sort(),
      ['1400:3.0000:0.0000', '2100:0.0000:33.0000', '2150:30.0000:0.0000'],
    );
    const service = await ctx.http
      .post('/v1/pur/invoices')
      .set(bearer(acme))
      .send({
        idempotencyKey: randomUUID(),
        documentType: 'service',
        vendorId,
        postingDate: day(8, 15),
        lines: [{ kind: 'account', accountId: accounts.find((row) => row.code === '6200')?.id, description: 'Warehouse rent August', amount: '500', taxCodeId: created.body.id }],
      });
    assert.equal(service.status, 201, JSON.stringify(service.body));
    assert.equal(service.body.taxTotal, '60.0000');
    assert.equal(service.body.total, '560.0000');
    const salesOnly = await ctx.http
      .post('/v1/fin/tax-codes')
      .set(bearer(acme))
      .send({ code: 'OUT5', name: 'Sales only', purpose: 'sales', rate: '5', validFrom: day(1, 1) });
    const wrongPurpose = await ctx.http
      .post('/v1/pur/invoices')
      .set(bearer(acme))
      .send({
        idempotencyKey: randomUUID(),
        documentType: 'service',
        vendorId,
        postingDate: day(8, 15),
        lines: [{ kind: 'account', accountId: accounts.find((row) => row.code === '6200')?.id, description: 'Rent', amount: '1', taxCodeId: salesOnly.body.id }],
      });
    assert.equal(wrongPurpose.status, 400);
  });

  it('posts service-type invoices to G/L accounts and rejects mixed or control lines', async () => {
    const vendorId = await vendor();
    const control = await ctx.http
      .post('/v1/pur/invoices')
      .set(bearer(acme))
      .send({
        idempotencyKey: randomUUID(),
        documentType: 'service',
        vendorId,
        postingDate: day(6, 10),
        lines: [{ kind: 'account', accountId: accounts.find((row) => row.code === '2100')?.id, description: 'Bad', amount: '10' }],
      });
    assert.equal(control.status, 400);
    const stocked = await item('inventory');
    const mixed = await ctx.http
      .post('/v1/pur/invoices')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), documentType: 'service', vendorId, postingDate: day(6, 10), lines: [{ kind: 'item', itemId: stocked.id, quantity: '1', unitPrice: '1' }] });
    assert.equal(mixed.status, 400);
    const utilities = await ctx.http
      .post('/v1/pur/invoices')
      .set(bearer(acme))
      .send({
        idempotencyKey: randomUUID(),
        documentType: 'service',
        vendorId,
        postingDate: day(6, 10),
        vendorReference: 'UTIL-06',
        lines: [
          { kind: 'account', accountId: accounts.find((row) => row.code === '6300')?.id, description: 'Electricity', amount: '120' },
          { kind: 'account', accountId: accounts.find((row) => row.code === '6300')?.id, description: 'Water', amount: '30' },
        ],
      });
    assert.equal(utilities.status, 201);
    const journal = (await ctx.http.get(`/v1/fin/journal-entries/${utilities.body.journalId}`).set(bearer(acme))).body as JournalEntry;
    assert.deepEqual(journal.lines.map((line) => `${line.accountCode}:${line.debit}:${line.credit}`), ['6300:150.0000:0.0000', '2100:0.0000:150.0000']);
    assert.equal(await balance(vendorId), '150.0000');
  });

  it('receives stock directly on an item invoice without a goods receipt and reverses it on cancellation', async () => {
    const vendorId = await vendor();
    const stocked = await item('inventory');
    const service = await item('service');
    const direct = await ctx.http
      .post('/v1/pur/invoices')
      .set(bearer(acme))
      .send({
        idempotencyKey: randomUUID(),
        vendorId,
        postingDate: day(6, 10),
        lines: [
          { kind: 'item', itemId: stocked.id, quantity: '8', unitPrice: '2.5' },
          { kind: 'item', itemId: service.id, quantity: '1', unitPrice: '40' },
        ],
      });
    assert.equal(direct.status, 201, JSON.stringify(direct.body));
    const journal = (await ctx.http.get(`/v1/fin/journal-entries/${direct.body.journalId}`).set(bearer(acme))).body as JournalEntry;
    assert.deepEqual(
      journal.lines.map((line) => `${line.accountCode}:${line.debit}:${line.credit}`).sort(),
      ['1300:20.0000:0.0000', '2100:0.0000:60.0000', '5400:40.0000:0.0000'],
    );
    const stockAfter = (await ctx.http.get(`/v1/inv/items/${stocked.id}/stock`).set(bearer(acme))).body as { onHand: string; totalValue: string };
    assert.equal(stockAfter.onHand, '8.0000');
    assert.equal(stockAfter.totalValue, '20.0000');
    const cancelled = await ctx.http
      .post(`/v1/pur/invoices/${direct.body.id}/cancel`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), postingDate: day(6, 11), reason: 'Duplicate' });
    assert.equal(cancelled.status, 201);
    const stockCancelled = (await ctx.http.get(`/v1/inv/items/${stocked.id}/stock`).set(bearer(acme))).body as { onHand: string; totalValue: string };
    assert.equal(stockCancelled.onHand, '0.0000');
    assert.equal(stockCancelled.totalValue, '0.0000');
  });

  it('revalues stock on hand for price differences and blocks unsafe cancellation', async () => {
    const vendorId = await vendor();
    const stocked = await item('inventory');
    const po = await purchase(vendorId, [{ itemId: stocked.id, quantity: '20', unitPrice: '10' }]);
    const receipt = await receive(po, ['10']);
    const response = await invoice(vendorId, [{ receiptLineId: receipt.lines[0]?.id as string, quantity: '10', unitPrice: '11' }], { priceOverride: true });
    assert.equal(response.status, 201);
    assert.equal(response.body.lines[0].stockRevaluation, '10.0000');
    assert.equal(response.body.lines[0].priceDifference, '0.0000');
    const valued = (await ctx.http.get(`/v1/inv/items/${stocked.id}/stock`).set(bearer(acme))).body as { totalValue: string; averageCost: string };
    assert.equal(valued.totalValue, '110.0000');
    assert.equal(valued.averageCost, '11.000000');
    await receive(po, ['10'], day(6, 12));
    const blocked = await ctx.http
      .post(`/v1/pur/invoices/${response.body.id}/cancel`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), postingDate: day(6, 13), reason: 'Try' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'VALUATION_BLOCKED');
  });

  it('replays retries and cancels an invoice once, restoring quantities and the payable', async () => {
    const vendorId = await vendor();
    const stocked = await item('inventory');
    const po = await purchase(vendorId, [{ itemId: stocked.id, quantity: '4', unitPrice: '25' }]);
    const receipt = await receive(po, ['4']);
    const body = {
      idempotencyKey: randomUUID(),
      vendorId,
      postingDate: day(6, 10),
      vendorReference: 'RETRY-1',
      lines: [{ receiptLineId: receipt.lines[0]?.id, quantity: '4', unitPrice: '25' }],
    };
    const first = await ctx.http.post('/v1/pur/invoices').set(bearer(acme)).send(body);
    const retry = await ctx.http.post('/v1/pur/invoices').set(bearer(acme)).send(body);
    assert.equal(first.status, 201);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.id, first.body.id);
    assert.equal(await balance(vendorId), '100.0000');
    const cancels = await Promise.all(
      [1, 2, 3].map(() =>
        ctx.http.post(`/v1/pur/invoices/${first.body.id}/cancel`).set(bearer(acme)).send({ idempotencyKey: randomUUID(), postingDate: day(6, 12), reason: 'Wrong vendor invoice' }),
      ),
    );
    const succeeded = cancels.filter((response) => response.status === 201);
    assert.equal(succeeded.length, 1);
    assert.ok(cancels.filter((response) => response.status !== 201).every((response) => response.status === 409));
    const cancellation = succeeded[0]?.body as ApInvoice;
    assert.equal(cancellation.isCancellation, true);
    assert.equal(await balance(vendorId), '0.0000');
    const original = (await ctx.http.get(`/v1/pur/invoices/${first.body.id}`).set(bearer(acme))).body as ApInvoice;
    assert.equal(original.status, 'cancelled');
    assert.equal(original.openAmount, '0.0000');
    const reopened = (await ctx.http.get(`/v1/pur/invoiceable?vendorId=${vendorId}`).set(bearer(acme))).body as InvoiceableReceiptLine[];
    assert.equal(reopened[0]?.openQuantity, '4.0000');
    const reuse = await ctx.http.post('/v1/pur/invoices').set(bearer(acme)).send({ ...body, idempotencyKey: randomUUID() });
    assert.equal(reuse.status, 201);
    const cancelCancellation = await ctx.http
      .post(`/v1/pur/invoices/${cancellation.id}/cancel`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), postingDate: day(6, 12), reason: 'No' });
    assert.equal(cancelCancellation.status, 409);
  });

  it('rejects invoices into closed periods and isolates tenants', async () => {
    const vendorId = await vendor();
    const stocked = await item('inventory');
    const po = await purchase(vendorId, [{ itemId: stocked.id, quantity: '1', unitPrice: '1' }]);
    const receipt = await receive(po, ['1']);
    const lineId = receipt.lines[0]?.id as string;
    const globex = (await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX)).token;
    const globexVendorGroups = (await ctx.http.get('/v1/bp/groups').set(bearer(globex))).body as PartnerGroup[];
    const globexVendor = await ctx.http
      .post('/v1/bp/partners')
      .set(bearer(globex))
      .send({ code: 'G-V', partnerType: 'supplier', name: 'Globex vendor', groupId: globexVendorGroups.find((g) => g.partnerType === 'supplier')?.id });
    const cross = await ctx.http
      .post('/v1/pur/invoices')
      .set(bearer(globex))
      .send({ idempotencyKey: randomUUID(), vendorId: globexVendor.body.id, postingDate: day(6, 10), lines: [{ receiptLineId: lineId, quantity: '1', unitPrice: '1' }] });
    assert.equal(cross.status, 404);
    const periods = (await ctx.http.get('/v1/fin/periods').set(bearer(acme))).body as PostingPeriod[];
    const july = periods.find((period) => period.code === `${YEAR}-07`) as PostingPeriod;
    await ctx.http.patch(`/v1/fin/periods/${july.id}/status`).set(bearer(acme)).send({ status: 'closed', version: july.version, reason: 'Test' });
    const closed = await invoice(vendorId, [{ receiptLineId: lineId, quantity: '1', unitPrice: '1' }], { postingDate: day(7, 5) });
    assert.equal(closed.status, 422);
    assert.equal(closed.body.error.code, 'PERIOD_CLOSED');
    const auditor = await loginToTenant(ctx, SHARED, GLOBEX);
    const denied = await ctx.http.post('/v1/pur/invoices').set(bearer(auditor.token)).send({});
    assert.equal(denied.status, 403);
    const readable = await ctx.http.get('/v1/pur/invoices').set(bearer(auditor.token));
    assert.equal(readable.status, 200);
  });
});
