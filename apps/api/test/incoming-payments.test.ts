import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { IncomingPayment, JournalEntry, OpenPaymentItem, OpeningBalance, PartnerBalance, PartnerGroup } from '@nec/contracts';
import { ACME, ACME_OWNER, bearer, GLOBEX, GLOBEX_OWNER, loginToTenant, setup, SHARED, type TestContext } from './helpers.js';

const YEAR = new Date().getUTCFullYear();
const day = (month: number, date: number) => `${YEAR}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;

describe('Incoming payments', () => {
  let ctx: TestContext;
  let acme: string;
  let bpGroups: PartnerGroup[];
  let sequence = 0;

  const partner = async (partnerType: 'supplier' | 'customer') => {
    sequence += 1;
    const response = await ctx.http
      .post('/v1/bp/partners')
      .set(bearer(acme))
      .send({ code: `IP-${partnerType[0]}${sequence}`, partnerType, name: `Incoming ${partnerType} ${sequence}`, groupId: bpGroups.find((g) => g.partnerType === partnerType)?.id });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return { id: response.body.id as string, code: response.body.code as string };
  };

  const opening = async (lines: Record<string, unknown>[]) => {
    const response = await ctx.http
      .post('/v1/fin/opening-balances/partners')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), postingDate: day(1, 1), reason: 'Legacy receivables', lines });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body as OpeningBalance;
  };

  const receive = (customerId: string, amount: string, allocations: Record<string, unknown>[], extra: Record<string, unknown> = {}, token = acme) =>
    ctx.http
      .post('/v1/bank/incoming-payments')
      .set(bearer(token))
      .send({ idempotencyKey: randomUUID(), customerId, postingDate: day(3, 10), paymentMeans: 'bank_transfer', amount, allocations, ...extra });

  const openItems = async (customerId: string) => (await ctx.http.get(`/v1/bank/open-receivables?customerId=${customerId}`).set(bearer(acme))).body as OpenPaymentItem[];
  const balance = async (partnerId: string) => ((await ctx.http.get(`/v1/bp/partners/${partnerId}/balance`).set(bearer(acme))).body as PartnerBalance).balance;
  const journal = async (id: string) =>
    ((await ctx.http.get(`/v1/fin/journal-entries/${id}`).set(bearer(acme))).body as JournalEntry).lines.map((line) => `${line.accountCode}:${line.partnerCode ?? ''}:${line.debit}:${line.credit}`);
  const getOpening = async (id: string) => (await ctx.http.get(`/v1/fin/opening-balances/${id}`).set(bearer(acme))).body as OpeningBalance;

  before(async () => {
    ctx = await setup();
    acme = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    bpGroups = (await ctx.http.get('/v1/bp/groups').set(bearer(acme))).body;
  });

  after(async () => {
    await ctx.close();
  });

  it('receives a customer payment against opening balance lines and keeps the remainder on account', async () => {
    const customer = await partner('customer');
    const vendor = await partner('supplier');
    const document = await opening([
      { partnerId: customer.id, reference: 'INV-1', documentDate: day(1, 1), dueDate: day(1, 31), debit: '300' },
      { partnerId: customer.id, reference: 'INV-2', documentDate: day(1, 1), dueDate: day(2, 28), debit: '50' },
      { partnerId: vendor.id, reference: 'BILL-1', credit: '80' },
    ]);
    const open = await openItems(customer.id);
    assert.deepEqual(
      open.map((row) => [row.documentType, row.documentNumber, row.vendorReference, row.openAmount]),
      [
        ['opening_balance', `${document.documentNumber}/1`, 'INV-1', '300.0000'],
        ['opening_balance', `${document.documentNumber}/2`, 'INV-2', '50.0000'],
      ],
    );
    assert.deepEqual(await openItems(vendor.id), []);
    const [first, second] = open as [OpenPaymentItem, OpenPaymentItem];

    const response = await receive(customer.id, '340', [
      { openingLineId: first.openingLineId, amount: '300' },
      { openingLineId: second.openingLineId, amount: '20' },
    ], { reference: 'RCPT-1' });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const payment = response.body as IncomingPayment;
    assert.equal(payment.documentNumber, 'IP1');
    assert.equal(payment.direction, 'incoming');
    assert.equal(payment.customerCode, customer.code);
    assert.equal(payment.partnerCode, customer.code);
    assert.equal(payment.accountCode, '1110');
    assert.equal(payment.allocatedAmount, '320.0000');
    assert.equal(payment.unappliedAmount, '20.0000');
    assert.deepEqual(payment.allocations.map((row) => [row.invoiceNumber, row.reference, row.amount]), [
      [`${document.documentNumber}/1`, 'INV-1', '300.0000'],
      [`${document.documentNumber}/2`, 'INV-2', '20.0000'],
    ]);
    assert.deepEqual(await journal(payment.journalId), ['1110::340.0000:0.0000', `1200:${customer.code}:0.0000:340.0000`]);
    assert.equal(await balance(customer.id), '10.0000');
    assert.deepEqual((await getOpening(document.id)).lines.map((line) => line.openAmount), ['0.0000', '30.0000', '80.0000']);
    assert.deepEqual((await openItems(customer.id)).map((row) => row.openAmount), ['30.0000']);

    const later = await ctx.http
      .post(`/v1/bank/incoming-payments/${payment.id}/allocations`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), allocationDate: day(3, 11), allocations: [{ openingLineId: second.openingLineId, amount: '20' }] });
    assert.equal(later.status, 201, JSON.stringify(later.body));
    assert.equal((later.body as IncomingPayment).unappliedAmount, '0.0000');
    assert.deepEqual((await openItems(customer.id)).map((row) => row.openAmount), ['10.0000']);

    const cash = await receive(customer.id, '5', [], { paymentMeans: 'cash' });
    assert.equal(cash.status, 201, JSON.stringify(cash.body));
    assert.equal((cash.body as IncomingPayment).accountCode, '1100');
  });

  it('rejects vendors, vendor lines, A/P invoices and over-allocation, and keeps directions apart', async () => {
    const customer = await partner('customer');
    const vendor = await partner('supplier');
    const document = await opening([
      { partnerId: customer.id, debit: '40' },
      { partnerId: vendor.id, credit: '25' },
    ]);
    const [customerLine, vendorLine] = document.lines as [OpeningBalance['lines'][number], OpeningBalance['lines'][number]];
    assert.equal((await receive(vendor.id, '10', [])).status, 400);
    assert.equal((await receive(customer.id, '10', [{ openingLineId: vendorLine.id, amount: '10' }])).status, 400);
    assert.equal((await receive(customer.id, '10', [{ invoiceId: randomUUID(), amount: '10' }])).status, 400);
    const over = await receive(customer.id, '100', [{ openingLineId: customerLine.id, amount: '41' }]);
    assert.equal(over.status, 422);
    assert.equal(over.body.error.code, 'OVER_ALLOCATION');
    const tooLittle = await receive(customer.id, '10', [{ openingLineId: customerLine.id, amount: '20' }]);
    assert.equal(tooLittle.status, 422);

    const outgoing = await ctx.http
      .post('/v1/bank/outgoing-payments')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), vendorId: vendor.id, postingDate: day(3, 10), paymentMeans: 'bank_transfer', amount: '10', allocations: [{ openingLineId: customerLine.id, amount: '10' }] });
    assert.equal(outgoing.status, 400);

    const received = (await receive(customer.id, '15', [])).body as IncomingPayment;
    assert.equal((await ctx.http.get(`/v1/bank/outgoing-payments/${received.id}`).set(bearer(acme))).status, 404);
    assert.equal((await ctx.http.get(`/v1/bank/incoming-payments/${received.id}`).set(bearer(acme))).status, 200);
    const outgoingList = (await ctx.http.get('/v1/bank/outgoing-payments?limit=200').set(bearer(acme))).body;
    assert.equal(outgoingList.items.some((row: { id: string }) => row.id === received.id), false);
    const incomingList = (await ctx.http.get(`/v1/bank/incoming-payments?customerId=${customer.id}`).set(bearer(acme))).body;
    assert.deepEqual(incomingList.items.map((row: { customerName: string }) => row.customerName), [`Incoming customer ${sequence - 1}`]);
    const cancelAsOutgoing = await ctx.http
      .post(`/v1/bank/outgoing-payments/${received.id}/cancel`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), postingDate: day(3, 20), reason: 'Wrong direction' });
    assert.equal(cancelAsOutgoing.status, 404);
  });

  it('unallocates, cancels once and blocks opening balance cancellation while allocated', async () => {
    const customer = await partner('customer');
    const document = await opening([{ partnerId: customer.id, reference: 'INV-9', debit: '60' }]);
    const line = document.lines[0] as OpeningBalance['lines'][number];
    const payment = (await receive(customer.id, '60', [{ openingLineId: line.id, amount: '60' }])).body as IncomingPayment;

    const blocked = await ctx.http
      .post(`/v1/fin/opening-balances/${document.id}/cancel`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), postingDate: day(3, 20), reason: 'Wrong customer' });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error.message, new RegExp(payment.documentNumber));

    const allocation = payment.allocations[0] as IncomingPayment['allocations'][number];
    const unallocated = await ctx.http
      .post(`/v1/bank/incoming-payments/${payment.id}/allocations/${allocation.id}/unallocate`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), unallocationDate: day(3, 12), reason: 'Applied to the wrong invoice' });
    assert.equal(unallocated.status, 201, JSON.stringify(unallocated.body));
    assert.equal((unallocated.body as IncomingPayment).unappliedAmount, '60.0000');
    assert.equal((await getOpening(document.id)).lines[0]?.openAmount, '60.0000');
    const again = await ctx.http
      .post(`/v1/bank/incoming-payments/${payment.id}/allocations/${allocation.id}/unallocate`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), unallocationDate: day(3, 12), reason: 'Again' });
    assert.equal(again.status, 409);

    const reallocated = await ctx.http
      .post(`/v1/bank/incoming-payments/${payment.id}/allocations`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), allocationDate: day(3, 13), allocations: [{ openingLineId: line.id, amount: '60' }] });
    assert.equal(reallocated.status, 201, JSON.stringify(reallocated.body));

    const attempts = await Promise.all(
      [1, 2, 3].map(() =>
        ctx.http.post(`/v1/bank/incoming-payments/${payment.id}/cancel`).set(bearer(acme)).send({ idempotencyKey: randomUUID(), postingDate: day(3, 20), reason: 'Bounced' }),
      ),
    );
    assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), [201, 409, 409]);
    const cancellation = attempts.find((attempt) => attempt.status === 201)?.body as IncomingPayment;
    assert.equal(cancellation.isCancellation, true);
    assert.deepEqual(await journal(cancellation.journalId), ['1110::0.0000:60.0000', `1200:${customer.code}:60.0000:0.0000`]);
    assert.equal(await balance(customer.id), '60.0000');
    assert.equal((await getOpening(document.id)).lines[0]?.openAmount, '60.0000');
    const original = (await ctx.http.get(`/v1/bank/incoming-payments/${payment.id}`).set(bearer(acme))).body as IncomingPayment;
    assert.equal(original.status, 'cancelled');
    assert.deepEqual(original.allocations.map((row) => row.active), [false, false]);

    const cancelledOpening = await ctx.http
      .post(`/v1/fin/opening-balances/${document.id}/cancel`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), postingDate: day(3, 21), reason: 'Wrong customer' });
    assert.equal(cancelledOpening.status, 201, JSON.stringify(cancelledOpening.body));
  });

  it('isolates tenants and enforces permissions', async () => {
    const customer = await partner('customer');
    const payment = (await receive(customer.id, '12', [])).body as IncomingPayment;
    const globex = (await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX)).token;
    assert.equal((await ctx.http.get(`/v1/bank/incoming-payments/${payment.id}`).set(bearer(globex))).status, 404);
    assert.equal((await receive(customer.id, '1', [], {}, globex)).status, 400);
    assert.equal((await ctx.http.get(`/v1/bank/open-receivables?customerId=${customer.id}`).set(bearer(globex))).body.length, 0);
    const auditor = (await loginToTenant(ctx, SHARED, GLOBEX)).token;
    assert.equal((await ctx.http.get('/v1/bank/incoming-payments').set(bearer(auditor))).status, 200);
    assert.equal((await ctx.http.post('/v1/bank/incoming-payments').set(bearer(auditor)).send({})).status, 403);
  });
});
