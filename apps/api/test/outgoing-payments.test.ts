import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { sql } from 'kysely';
import type { Account, ApInvoice, JournalEntry, OpenPayableInvoice, OutgoingPayment, PartnerBalance, PartnerGroup, PostingPeriod, TrialBalance } from '@nec/contracts';
import { ACME, ACME_OWNER, bearer, GLOBEX, GLOBEX_OWNER, loginToTenant, setup, SHARED, type TestContext } from './helpers.js';

const YEAR = new Date().getUTCFullYear();
const day = (month: number, date: number) => `${YEAR}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;

describe('Outgoing payments', () => {
  let ctx: TestContext;
  let acme: string;
  let bpGroups: PartnerGroup[];
  let accounts: Account[];
  let sequence = 0;

  const accountId = (code: string) => accounts.find((account) => account.code === code)?.id as string;

  const vendor = async () => {
    sequence += 1;
    const response = await ctx.http
      .post('/v1/bp/partners')
      .set(bearer(acme))
      .send({ code: `OP-V${sequence}`, partnerType: 'supplier', name: `OP Vendor ${sequence}`, groupId: bpGroups.find((g) => g.partnerType === 'supplier')?.id });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.id as string;
  };

  const invoice = async (vendorId: string, amount: string, postingDate = day(8, 1)) => {
    const response = await ctx.http
      .post('/v1/pur/invoices')
      .set(bearer(acme))
      .send({
        idempotencyKey: randomUUID(),
        documentType: 'service',
        vendorId,
        postingDate,
        lines: [{ kind: 'account', accountId: accountId('5400'), description: 'Services', amount }],
      });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body as ApInvoice;
  };

  const pay = (vendorId: string, amount: string, allocations: { invoiceId: string; amount: string }[], extra: Record<string, unknown> = {}) =>
    ctx.http
      .post('/v1/bank/outgoing-payments')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), vendorId, postingDate: day(8, 10), paymentMeans: 'bank_transfer', amount, allocations, ...extra });

  const getInvoice = async (id: string) => (await ctx.http.get(`/v1/pur/invoices/${id}`).set(bearer(acme))).body as ApInvoice;
  const getPayment = async (id: string) => (await ctx.http.get(`/v1/bank/outgoing-payments/${id}`).set(bearer(acme))).body as OutgoingPayment;
  const balance = async (partnerId: string) => ((await ctx.http.get(`/v1/bp/partners/${partnerId}/balance`).set(bearer(acme))).body as PartnerBalance).balance;
  const bankBalance = async () => {
    const report = (await ctx.http.get(`/v1/fin/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}`).set(bearer(acme))).body as TrialBalance;
    return report.rows.find((row) => row.code === '1110')?.closingBalance ?? '0.0000';
  };

  before(async () => {
    ctx = await setup();
    acme = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    bpGroups = (await ctx.http.get('/v1/bp/groups').set(bearer(acme))).body;
    accounts = (await ctx.http.get('/v1/fin/accounts').set(bearer(acme))).body;
  });

  after(async () => {
    await ctx.close();
  });

  it('applies a partial payment, posts the vendor and bank journal and rejects over-allocation', async () => {
    const vendorId = await vendor();
    const ap = await invoice(vendorId, '100');
    const open = (await ctx.http.get(`/v1/bank/open-invoices?vendorId=${vendorId}`).set(bearer(acme))).body as OpenPayableInvoice[];
    assert.deepEqual(open.map((row) => [row.documentNumber, row.openAmount]), [[ap.documentNumber, '100.0000']]);
    const bankBefore = await bankBalance();
    const response = await pay(vendorId, '40', [{ invoiceId: ap.id, amount: '40' }], { reference: 'TRF-1' });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const payment = response.body as OutgoingPayment;
    assert.equal(payment.documentNumber, 'OP1');
    assert.equal(payment.accountCode, '1110');
    assert.equal(payment.allocatedAmount, '40.0000');
    assert.equal(payment.unappliedAmount, '0.0000');
    assert.equal(payment.allocations.length, 1);
    const journal = (await ctx.http.get(`/v1/fin/journal-entries/${payment.journalId}`).set(bearer(acme))).body as JournalEntry;
    assert.deepEqual(
      journal.lines.map((line) => `${line.accountCode}:${line.partnerCode ?? ''}:${line.debit}:${line.credit}`),
      [`2100:OP-V${sequence}:40.0000:0.0000`, '1110::0.0000:40.0000'],
    );
    const after = await getInvoice(ap.id);
    assert.equal(after.paidAmount, '40.0000');
    assert.equal(after.openAmount, '60.0000');
    assert.equal(await balance(vendorId), '60.0000');
    assert.equal(Number(bankBefore) - Number(await bankBalance()), 40);

    const over = await pay(vendorId, '70', [{ invoiceId: ap.id, amount: '70' }]);
    assert.equal(over.status, 422);
    assert.equal(over.body.error.code, 'OVER_ALLOCATION');
    const moreThanPaid = await pay(vendorId, '10', [{ invoiceId: ap.id, amount: '20' }]);
    assert.equal(moreThanPaid.status, 422);
    assert.equal(moreThanPaid.body.error.code, 'OVER_ALLOCATION');
    assert.equal((await getInvoice(ap.id)).paidAmount, '40.0000');
    assert.equal(await balance(vendorId), '60.0000');
  });

  it('pays several invoices, keeps the remainder on account and allocates it later', async () => {
    const vendorId = await vendor();
    const first = await invoice(vendorId, '30');
    const second = await invoice(vendorId, '50');
    const third = await invoice(vendorId, '25');
    const response = await pay(vendorId, '100', [
      { invoiceId: first.id, amount: '30' },
      { invoiceId: second.id, amount: '50' },
    ], { paymentMeans: 'cash' });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const payment = response.body as OutgoingPayment;
    assert.equal(payment.accountCode, '1100');
    assert.equal(payment.unappliedAmount, '20.0000');
    assert.equal(await balance(vendorId), '5.0000');
    const open = (await ctx.http.get(`/v1/bank/open-invoices?vendorId=${vendorId}`).set(bearer(acme))).body as OpenPayableInvoice[];
    assert.deepEqual(open.map((row) => row.documentNumber), [third.documentNumber]);

    const tooMuch = await ctx.http
      .post(`/v1/bank/outgoing-payments/${payment.id}/allocations`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), allocationDate: day(8, 11), allocations: [{ invoiceId: third.id, amount: '25' }] });
    assert.equal(tooMuch.status, 422);
    assert.equal(tooMuch.body.error.code, 'OVER_ALLOCATION');
    const early = await ctx.http
      .post(`/v1/bank/outgoing-payments/${payment.id}/allocations`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), allocationDate: day(8, 9), allocations: [{ invoiceId: third.id, amount: '20' }] });
    assert.equal(early.status, 422);
    const later = await ctx.http
      .post(`/v1/bank/outgoing-payments/${payment.id}/allocations`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), allocationDate: day(8, 11), allocations: [{ invoiceId: third.id, amount: '20' }] });
    assert.equal(later.status, 201, JSON.stringify(later.body));
    assert.equal((later.body as OutgoingPayment).unappliedAmount, '0.0000');
    assert.equal((await getInvoice(third.id)).openAmount, '5.0000');
    assert.equal(await balance(vendorId), '5.0000');
  });

  it('unallocates a payment applied to the wrong invoice without touching the cash journal (scenario 18)', async () => {
    const vendorId = await vendor();
    const wrong = await invoice(vendorId, '80');
    const right = await invoice(vendorId, '60');
    const payment = (await pay(vendorId, '60', [{ invoiceId: wrong.id, amount: '60' }])).body as OutgoingPayment;
    const blocked = await ctx.http
      .post(`/v1/pur/invoices/${wrong.id}/cancel`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), postingDate: day(8, 12), reason: 'Blocked by payment' });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error.message, new RegExp(`${payment.documentNumber}: 60.0000`));

    const journalsBefore = (await ctx.http.get('/v1/fin/journal-entries?limit=200').set(bearer(acme))).body.total as number;
    const bankBefore = await bankBalance();
    const allocationId = payment.allocations[0]?.id as string;
    const unallocate = (key = randomUUID()) =>
      ctx.http
        .post(`/v1/bank/outgoing-payments/${payment.id}/allocations/${allocationId}/unallocate`)
        .set(bearer(acme))
        .send({ idempotencyKey: key, unallocationDate: day(8, 12), reason: 'Applied to the wrong invoice' });
    const key = randomUUID();
    const response = await unallocate(key);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const unallocated = response.body as OutgoingPayment;
    assert.equal(unallocated.unappliedAmount, '60.0000');
    assert.equal(unallocated.allocations[0]?.active, false);
    assert.equal(unallocated.allocations[0]?.unallocationReason, 'Applied to the wrong invoice');
    const replay = await unallocate(key);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers['idempotent-replayed'], 'true');
    const again = await unallocate();
    assert.equal(again.status, 409);
    assert.equal((await getInvoice(wrong.id)).openAmount, '80.0000');
    assert.equal((await ctx.http.get('/v1/fin/journal-entries?limit=200').set(bearer(acme))).body.total, journalsBefore);
    assert.equal(await bankBalance(), bankBefore);
    assert.equal(await balance(vendorId), '80.0000');

    const reallocate = await ctx.http
      .post(`/v1/bank/outgoing-payments/${payment.id}/allocations`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), allocationDate: day(8, 12), allocations: [{ invoiceId: right.id, amount: '60' }] });
    assert.equal(reallocate.status, 201, JSON.stringify(reallocate.body));
    const reallocated = reallocate.body as OutgoingPayment;
    assert.equal(reallocated.allocations.length, 2);
    assert.equal(reallocated.unappliedAmount, '0.0000');
    assert.equal((await getInvoice(right.id)).openAmount, '0.0000');
    const overWrong = await ctx.http
      .post(`/v1/bank/outgoing-payments/${payment.id}/allocations`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), allocationDate: day(8, 12), allocations: [{ invoiceId: wrong.id, amount: '1' }] });
    assert.equal(overWrong.status, 422);

    const cancelInvoice = await ctx.http
      .post(`/v1/pur/invoices/${wrong.id}/cancel`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), postingDate: day(8, 12), reason: 'Duplicate invoice' });
    assert.equal(cancelInvoice.status, 201, JSON.stringify(cancelInvoice.body));
    assert.equal(await balance(vendorId), '0.0000');
  });

  it('cancels an erroneous payment, undoing its allocations and journal atomically once', async () => {
    const vendorId = await vendor();
    const first = await invoice(vendorId, '45');
    const second = await invoice(vendorId, '55');
    const payment = (await pay(vendorId, '120', [
      { invoiceId: first.id, amount: '45' },
      { invoiceId: second.id, amount: '30' },
    ])).body as OutgoingPayment;
    assert.equal(await balance(vendorId), '-20.0000');
    const bankBefore = await bankBalance();
    const early = await ctx.http
      .post(`/v1/bank/outgoing-payments/${payment.id}/cancel`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), postingDate: day(8, 9), reason: 'Too early' });
    assert.equal(early.status, 422);
    const attempts = await Promise.all(
      [1, 2, 3].map(() =>
        ctx.http
          .post(`/v1/bank/outgoing-payments/${payment.id}/cancel`)
          .set(bearer(acme))
          .send({ idempotencyKey: randomUUID(), postingDate: day(8, 15), reason: 'Paid the wrong vendor' }),
      ),
    );
    assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), [201, 409, 409]);
    const cancellation = attempts.find((attempt) => attempt.status === 201)?.body as OutgoingPayment;
    assert.equal(cancellation.isCancellation, true);
    assert.equal(cancellation.cancellationOfId, payment.id);
    const original = await getPayment(payment.id);
    assert.equal(original.status, 'cancelled');
    assert.equal(original.cancelledById, cancellation.id);
    assert.equal(original.allocatedAmount, '0.0000');
    assert.equal(original.unappliedAmount, '0.0000');
    assert.ok(original.allocations.every((allocation) => !allocation.active && allocation.unallocationDate === day(8, 15)));
    assert.equal((await getInvoice(first.id)).openAmount, '45.0000');
    assert.equal((await getInvoice(second.id)).openAmount, '55.0000');
    assert.equal(await balance(vendorId), '100.0000');
    assert.equal(Number(await bankBalance()) - Number(bankBefore), 120);
    const reversal = (await ctx.http.get(`/v1/fin/journal-entries/${cancellation.journalId}`).set(bearer(acme))).body as JournalEntry;
    assert.deepEqual(
      reversal.lines.map((line) => `${line.accountCode}:${line.debit}:${line.credit}`),
      ['2100:0.0000:120.0000', '1110:120.0000:0.0000'],
    );
    const cancelCancellation = await ctx.http
      .post(`/v1/bank/outgoing-payments/${cancellation.id}/cancel`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), postingDate: day(8, 16), reason: 'No' });
    assert.equal(cancelCancellation.status, 409);
    const allocateCancelled = await ctx.http
      .post(`/v1/bank/outgoing-payments/${payment.id}/allocations`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), allocationDate: day(8, 16), allocations: [{ invoiceId: first.id, amount: '1' }] });
    assert.equal(allocateCancelled.status, 409);
  });

  it('replays identical requests, rejects conflicting keys and serialises concurrent allocations', async () => {
    const vendorId = await vendor();
    const ap = await invoice(vendorId, '50');
    const key = randomUUID();
    const body = { idempotencyKey: key, vendorId, postingDate: day(8, 10), paymentMeans: 'bank_transfer', amount: '10', allocations: [{ invoiceId: ap.id, amount: '10' }] };
    const first = await ctx.http.post('/v1/bank/outgoing-payments').set(bearer(acme)).send(body);
    const replay = await ctx.http.post('/v1/bank/outgoing-payments').set(bearer(acme)).send(body);
    assert.equal(first.status, 201);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, first.body.id);
    const conflicting = await ctx.http.post('/v1/bank/outgoing-payments').set(bearer(acme)).send({ ...body, amount: '11' });
    assert.equal(conflicting.status, 409);
    assert.equal(conflicting.body.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await getInvoice(ap.id)).paidAmount, '10.0000');

    const racers = await Promise.all([1, 2, 3, 4].map(() => pay(vendorId, '15', [{ invoiceId: ap.id, amount: '15' }])));
    assert.deepEqual(racers.map((racer) => racer.status).sort(), [201, 201, 422, 422]);
    assert.equal((await getInvoice(ap.id)).paidAmount, '40.0000');
  });

  it('validates vendors, invoices, dates and payment accounts', async () => {
    const vendorId = await vendor();
    const otherVendor = await vendor();
    const ap = await invoice(vendorId, '20', day(8, 20));
    const other = await invoice(otherVendor, '20');
    const wrongVendor = await pay(vendorId, '20', [{ invoiceId: other.id, amount: '20' }]);
    assert.equal(wrongVendor.status, 400);
    const future = await pay(vendorId, '20', [{ invoiceId: ap.id, amount: '20' }]);
    assert.equal(future.status, 400);
    assert.match(future.body.error.message, /dated after/);
    const duplicate = await pay(vendorId, '20', [
      { invoiceId: ap.id, amount: '10' },
      { invoiceId: ap.id, amount: '10' },
    ], { postingDate: day(8, 21) });
    assert.equal(duplicate.status, 400);
    const control = await pay(vendorId, '5', [], { accountId: accountId('2100') });
    assert.equal(control.status, 400);
    const expense = await pay(vendorId, '5', [], { accountId: accountId('5400') });
    assert.equal(expense.status, 400);
    const zero = await pay(vendorId, '0', []);
    assert.equal(zero.status, 400);
    const customerGroup = bpGroups.find((g) => g.partnerType === 'customer')?.id;
    const customer = await ctx.http.post('/v1/bp/partners').set(bearer(acme)).send({ code: 'OP-C1', partnerType: 'customer', name: 'Customer', groupId: customerGroup });
    const notVendor = await pay(customer.body.id, '5', []);
    assert.equal(notVendor.status, 400);
    const onAccount = await pay(vendorId, '5', [], { accountId: accountId('1100'), paymentMeans: 'cheque' });
    assert.equal(onAccount.status, 201, JSON.stringify(onAccount.body));
    assert.equal((onAccount.body as OutgoingPayment).unappliedAmount, '5.0000');
  });

  it('keeps allocation history append-only, rejects closed periods and isolates tenants', async () => {
    const vendorId = await vendor();
    const ap = await invoice(vendorId, '10');
    const payment = (await pay(vendorId, '10', [{ invoiceId: ap.id, amount: '10' }])).body as OutgoingPayment;
    await assert.rejects(
      ctx.asApp.transaction().execute(async (trx) => {
        await sql`select set_config('app.tenant_id', ${ctx.tenantId(ACME)}, true)`.execute(trx);
        await sql`update payment_allocations set amount = 1 where payment_id = ${payment.id}::uuid`.execute(trx);
      }),
    );
    const periods = (await ctx.http.get('/v1/fin/periods').set(bearer(acme))).body as PostingPeriod[];
    const september = periods.find((period) => period.code === `${YEAR}-09`) as PostingPeriod;
    const close = await ctx.http.patch(`/v1/fin/periods/${september.id}/status`).set(bearer(acme)).send({ status: 'closed', version: september.version, reason: 'Test' });
    assert.equal(close.status, 200, JSON.stringify(close.body));
    const closed = await pay(vendorId, '5', [], { postingDate: day(9, 5) });
    assert.equal(closed.status, 422);
    assert.equal(closed.body.error.code, 'PERIOD_CLOSED');
    const closedCancel = await ctx.http
      .post(`/v1/bank/outgoing-payments/${payment.id}/cancel`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), postingDate: day(9, 5), reason: 'Closed' });
    assert.equal(closedCancel.status, 422);

    const globex = (await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX)).token;
    assert.equal((await ctx.http.get(`/v1/bank/outgoing-payments/${payment.id}`).set(bearer(globex))).status, 404);
    const globexGroups = (await ctx.http.get('/v1/bp/groups').set(bearer(globex))).body as PartnerGroup[];
    const globexVendor = await ctx.http
      .post('/v1/bp/partners')
      .set(bearer(globex))
      .send({ code: 'OP-GV', partnerType: 'supplier', name: 'Globex vendor', groupId: globexGroups.find((g) => g.partnerType === 'supplier')?.id });
    const cross = await ctx.http
      .post('/v1/bank/outgoing-payments')
      .set(bearer(globex))
      .send({ idempotencyKey: randomUUID(), vendorId: globexVendor.body.id, postingDate: day(8, 10), paymentMeans: 'cash', amount: '10', allocations: [{ invoiceId: ap.id, amount: '10' }] });
    assert.equal(cross.status, 404);
    const crossUnallocate = await ctx.http
      .post(`/v1/bank/outgoing-payments/${payment.id}/allocations/${payment.allocations[0]?.id}/unallocate`)
      .set(bearer(globex))
      .send({ idempotencyKey: randomUUID(), unallocationDate: day(8, 12), reason: 'Cross tenant' });
    assert.equal(crossUnallocate.status, 404);
    assert.equal((await getInvoice(ap.id)).paidAmount, '10.0000');

    const auditor = await loginToTenant(ctx, SHARED, GLOBEX);
    assert.equal((await ctx.http.post('/v1/bank/outgoing-payments').set(bearer(auditor.token)).send({})).status, 403);
    assert.equal((await ctx.http.post(`/v1/bank/outgoing-payments/${payment.id}/cancel`).set(bearer(auditor.token)).send({})).status, 403);
    assert.equal((await ctx.http.get('/v1/bank/outgoing-payments').set(bearer(auditor.token))).status, 200);
  });
});
