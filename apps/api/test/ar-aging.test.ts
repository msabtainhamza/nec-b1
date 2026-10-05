import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Account, ArAgingReport, IncomingPayment, OpeningBalance, PartnerGroup } from '@nec/contracts';
import { ACME, ACME_OWNER, bearer, GLOBEX, GLOBEX_OWNER, loginToTenant, setup, SHARED, type TestContext } from './helpers.js';

const YEAR = new Date().getUTCFullYear();
const day = (month: number, date: number) => `${YEAR}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;

describe('A/R aging', () => {
  let ctx: TestContext;
  let acme: string;
  let accounts: Account[];
  let bpGroups: PartnerGroup[];
  let sequence = 0;

  const accountId = (code: string) => accounts.find((account) => account.code === code)?.id as string;

  const partner = async (partnerType: 'customer' | 'supplier') => {
    sequence += 1;
    const response = await ctx.http
      .post('/v1/bp/partners')
      .set(bearer(acme))
      .send({ code: `AR-${partnerType[0]}${sequence}`, partnerType, name: `Aging ${partnerType} ${sequence}`, groupId: bpGroups.find((g) => g.partnerType === partnerType)?.id });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.id as string;
  };

  const opening = async (lines: Record<string, unknown>[], postingDate = day(1, 1)) => {
    const response = await ctx.http.post('/v1/fin/opening-balances/partners').set(bearer(acme)).send({ idempotencyKey: randomUUID(), postingDate, reason: 'Legacy receivables', lines });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body as OpeningBalance;
  };

  const receive = async (customerId: string, amount: string, allocations: Record<string, unknown>[], postingDate: string) => {
    const response = await ctx.http
      .post('/v1/bank/incoming-payments')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), customerId, postingDate, paymentMeans: 'bank_transfer', amount, allocations });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body as IncomingPayment;
  };

  const aging = async (asOf: string, extra = '') => {
    const response = await ctx.http.get(`/v1/fin/reports/ar-aging?asOf=${asOf}${extra}`).set(bearer(acme));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body as ArAgingReport;
  };

  before(async () => {
    ctx = await setup();
    acme = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    accounts = (await ctx.http.get('/v1/fin/accounts').set(bearer(acme))).body;
    bpGroups = (await ctx.http.get('/v1/bp/groups').set(bearer(acme))).body;
  });

  after(async () => {
    await ctx.close();
  });

  it('ages customer open items, partial receipts, payments on account and journals, and reconciles to the receivables account', async () => {
    const customerA = await partner('customer');
    const customerB = await partner('customer');
    const vendor = await partner('supplier');
    const document = await opening([
      { partnerId: customerA, reference: 'INV-100', documentDate: `${YEAR - 1}-12-01`, dueDate: `${YEAR - 1}-12-31`, debit: '100' },
      { partnerId: customerB, reference: 'INV-200', documentDate: `${YEAR - 1}-12-20`, dueDate: day(1, 19), debit: '50' },
      { partnerId: vendor, reference: 'BILL-1', credit: '80' },
    ]);
    await receive(customerA, '40', [{ openingLineId: document.lines[0]?.id, amount: '40' }], day(2, 1));
    await receive(customerB, '15', [], day(3, 20));
    const manual = await ctx.http
      .post('/v1/fin/journal-entries')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), postingDate: day(3, 15), memo: 'Recharged freight', lines: [{ partnerId: customerB, debit: '7' }, { accountId: accountId('4900'), credit: '7' }] });
    assert.equal(manual.status, 201, JSON.stringify(manual.body));

    const report = await aging(day(4, 1));
    assert.equal(report.currency, 'USD');
    assert.equal(report.controlAccount.code, '1200');
    assert.match(report.accountingBasis, /incoming payments/);
    const a = report.customers.find((row) => row.customerId === customerA);
    const b = report.customers.find((row) => row.customerId === customerB);
    assert.equal(report.customers.length, 2);
    assert.deepEqual(a?.documents.map((doc) => [doc.type, doc.documentNumber, doc.bucket, doc.openAmount]), [['opening_balance', `${document.documentNumber}/1`, 'over90', '60.0000']]);
    assert.deepEqual(
      b?.documents.map((doc) => [doc.type, doc.bucket, doc.openAmount]),
      [
        ['opening_balance', 'days61To90', '50.0000'],
        ['journal_entry', 'days1To30', '7.0000'],
        ['incoming_payment', 'days1To30', '-15.0000'],
      ],
    );
    assert.equal(a?.total, '60.0000');
    assert.equal(b?.total, '42.0000');
    assert.equal(report.totals.total, '102.0000');
    assert.equal(report.totals.over90, '60.0000');
    assert.equal(report.totals.days61To90, '50.0000');
    assert.equal(report.totals.days1To30, '-8.0000');
    assert.equal(report.controlAccount.balance, '102.0000');
    assert.equal(report.difference, '0.0000');

    const vendorView = (await ctx.http.get(`/v1/fin/reports/ap-aging?asOf=${day(4, 1)}&vendorId=${vendor}`).set(bearer(acme))).body;
    assert.equal(vendorView.totals.total, '80.0000');
    assert.equal(vendorView.difference, '0.0000');
  });

  it('ages by posting date and filters by customer', async () => {
    const customer = await partner('customer');
    await opening([{ partnerId: customer, reference: 'INV-9', documentDate: `${YEAR - 1}-11-15`, dueDate: day(2, 28), debit: '30' }]);
    const byDue = await aging(day(3, 10), `&customerId=${customer}`);
    assert.equal(byDue.customers[0]?.documents[0]?.bucket, 'days1To30');
    const byPosting = await aging(day(3, 10), `&customerId=${customer}&basis=posting_date`);
    assert.equal(byPosting.basis, 'posting_date');
    assert.equal(byPosting.customers[0]?.documents[0]?.bucket, 'over90');
    assert.equal(byPosting.customers.length, 1);
    assert.equal(byPosting.controlAccount.balance, '30.0000');
    assert.equal(byPosting.difference, '0.0000');
  });

  it('reproduces earlier dates after unallocation, payment cancellation and opening cancellation', async () => {
    const customer = await partner('customer');
    const document = await opening([{ partnerId: customer, reference: 'INV-5', documentDate: day(1, 1), dueDate: day(1, 31), debit: '90' }]);
    const payment = await receive(customer, '90', [{ openingLineId: document.lines[0]?.id, amount: '90' }], day(5, 1));
    const before = await aging(day(5, 31), `&customerId=${customer}`);
    assert.equal(before.totals.total, '0.0000');
    assert.equal(before.customers.length, 0);

    const allocation = payment.allocations[0] as IncomingPayment['allocations'][number];
    const unallocated = await ctx.http
      .post(`/v1/bank/incoming-payments/${payment.id}/allocations/${allocation.id}/unallocate`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), unallocationDate: day(6, 5), reason: 'Wrong customer' });
    assert.equal(unallocated.status, 201, JSON.stringify(unallocated.body));
    const cancelled = await ctx.http
      .post(`/v1/bank/incoming-payments/${payment.id}/cancel`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), postingDate: day(6, 10), reason: 'Bounced' });
    assert.equal(cancelled.status, 201, JSON.stringify(cancelled.body));

    assert.equal((await aging(day(5, 31), `&customerId=${customer}`)).totals.total, '0.0000');
    const between = await aging(day(6, 7), `&customerId=${customer}`);
    assert.deepEqual(between.customers[0]?.documents.map((doc) => [doc.type, doc.openAmount]), [
      ['opening_balance', '90.0000'],
      ['incoming_payment', '-90.0000'],
    ]);
    assert.equal(between.difference, '0.0000');
    const afterCancel = await aging(day(6, 20), `&customerId=${customer}`);
    assert.deepEqual(afterCancel.customers[0]?.documents.map((doc) => doc.type), ['opening_balance']);
    assert.equal(afterCancel.totals.total, '90.0000');
    assert.equal(afterCancel.difference, '0.0000');

    const reversed = await ctx.http
      .post(`/v1/fin/opening-balances/${document.id}/cancel`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), postingDate: day(7, 1), reason: 'Duplicate' });
    assert.equal(reversed.status, 201, JSON.stringify(reversed.body));
    assert.equal((await aging(day(6, 20), `&customerId=${customer}`)).totals.total, '90.0000');
    const final = await aging(day(7, 2), `&customerId=${customer}`);
    assert.equal(final.customers.length, 0);
    assert.equal(final.controlAccount.balance, '0.0000');
    assert.equal(final.difference, '0.0000');
  });

  it('isolates tenants, allows auditors to read and rejects invalid dates', async () => {
    const globex = (await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX)).token;
    const globexReport = (await ctx.http.get(`/v1/fin/reports/ar-aging?asOf=${day(8, 1)}`).set(bearer(globex))).body as ArAgingReport;
    assert.equal(globexReport.customers.length, 0);
    assert.equal(globexReport.totals.total, '0.0000');
    const auditor = await loginToTenant(ctx, SHARED, GLOBEX);
    assert.equal((await ctx.http.get(`/v1/fin/reports/ar-aging?asOf=${day(8, 1)}`).set(bearer(auditor.token))).status, 200);
    assert.equal((await ctx.http.get('/v1/fin/reports/ar-aging?asOf=not-a-date').set(bearer(acme))).status, 400);
  });
});
