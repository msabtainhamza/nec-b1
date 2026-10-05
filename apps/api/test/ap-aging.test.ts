import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Account, ApAgingReport, ApInvoice, OutgoingPayment, PartnerGroup, PaymentTerms } from '@nec/contracts';
import { ACME, ACME_OWNER, bearer, GLOBEX, loginToTenant, setup, SHARED, type TestContext } from './helpers.js';

const YEAR = new Date().getUTCFullYear();
const day = (month: number, date: number) => `${YEAR}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;

describe('A/P aging', () => {
  let ctx: TestContext;
  let acme: string;
  let accounts: Account[];
  let vendorA: string;
  let vendorB: string;
  let inv1: ApInvoice;
  let inv2: ApInvoice;
  let payment: OutgoingPayment;
  let onAccount: OutgoingPayment;
  let manualNumber: string;

  const accountId = (code: string) => accounts.find((account) => account.code === code)?.id as string;

  const invoice = async (vendorId: string, amount: string, postingDate: string) => {
    const response = await ctx.http
      .post('/v1/pur/invoices')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), documentType: 'service', vendorId, postingDate, lines: [{ kind: 'account', accountId: accountId('5400'), description: 'Services', amount }] });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body as ApInvoice;
  };

  const pay = async (vendorId: string, amount: string, postingDate: string, allocations: { invoiceId: string; amount: string }[]) => {
    const response = await ctx.http
      .post('/v1/bank/outgoing-payments')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), vendorId, postingDate, paymentMeans: 'bank_transfer', amount, allocations });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body as OutgoingPayment;
  };

  const aging = async (asOf: string, extra = '') => {
    const response = await ctx.http.get(`/v1/fin/reports/ap-aging?asOf=${asOf}${extra}`).set(bearer(acme));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body as ApAgingReport;
  };

  const vendorRow = (report: ApAgingReport, id: string) => report.vendors.find((row) => row.vendorId === id);
  const open = (report: ApAgingReport, id: string) => Object.fromEntries((vendorRow(report, id)?.documents ?? []).map((doc) => [doc.documentNumber, `${doc.openAmount}@${doc.bucket}`]));

  before(async () => {
    ctx = await setup();
    acme = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    accounts = (await ctx.http.get('/v1/fin/accounts').set(bearer(acme))).body;
    const groups = (await ctx.http.get('/v1/bp/groups').set(bearer(acme))).body as PartnerGroup[];
    const terms = (await ctx.http.get('/v1/bp/payment-terms').set(bearer(acme))).body as PaymentTerms[];
    const supplierGroup = groups.find((g) => g.partnerType === 'supplier')?.id;
    vendorA = (
      await ctx.http.post('/v1/bp/partners').set(bearer(acme)).send({ code: 'AG-A', partnerType: 'supplier', name: 'Aging A', groupId: supplierGroup, paymentTermsId: terms.find((t) => t.code === 'NET30')?.id })
    ).body.id;
    vendorB = (await ctx.http.post('/v1/bp/partners').set(bearer(acme)).send({ code: 'AG-B', partnerType: 'supplier', name: 'Aging B', groupId: supplierGroup })).body.id;
    inv1 = await invoice(vendorA, '100', day(3, 1));
    inv2 = await invoice(vendorA, '50', day(5, 20));
    payment = await pay(vendorA, '40', day(4, 10), [{ invoiceId: inv1.id, amount: '40' }]);
    onAccount = await pay(vendorA, '15', day(6, 1), []);
    await invoice(vendorB, '30', day(6, 25));
    const manual = await ctx.http
      .post('/v1/fin/journal-entries')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), postingDate: day(6, 15), memo: 'Accrued freight', lines: [{ accountId: accountId('5400'), debit: '7' }, { partnerId: vendorA, credit: '7' }] });
    assert.equal(manual.status, 201, JSON.stringify(manual.body));
    manualNumber = manual.body.documentNumber;
  });

  after(async () => {
    await ctx.close();
  });

  it('ages open invoices, partial payments and payments on account by due date and reconciles to the control account (scenario 6)', async () => {
    const report = await aging(day(6, 30));
    assert.equal(report.basis, 'due_date');
    assert.equal(report.asOf, day(6, 30));
    assert.equal(report.currency, 'USD');
    assert.ok(report.tenantName && report.generatedAt && report.accountingBasis);
    assert.deepEqual(open(report, vendorA), {
      [inv1.documentNumber]: '60.0000@over90',
      [inv2.documentNumber]: '50.0000@days1To30',
      [onAccount.documentNumber]: '-15.0000@days1To30',
      [manualNumber]: '7.0000@days1To30',
    });
    const a = vendorRow(report, vendorA);
    assert.equal(a?.over90, '60.0000');
    assert.equal(a?.days1To30, '42.0000');
    assert.equal(a?.total, '102.0000');
    assert.equal(vendorRow(report, vendorB)?.days1To30, '30.0000');
    assert.equal(report.totals.total, '132.0000');
    assert.deepEqual(report.vendors.map((row) => row.vendorCode), ['AG-A', 'AG-B']);
    assert.equal(report.controlAccount.code, '2100');
    assert.equal(report.controlAccount.balance, '132.0000');
    assert.equal(report.difference, '0.0000');
    const inv1Doc = a?.documents.find((doc) => doc.id === inv1.id);
    assert.equal(inv1Doc?.days, 91);
    assert.equal(inv1Doc?.originalAmount, '100.0000');
  });

  it('ages by posting date and filters by vendor', async () => {
    const report = await aging(day(6, 30), `&basis=posting_date&vendorId=${vendorA}`);
    assert.deepEqual(report.vendors.map((row) => row.vendorCode), ['AG-A']);
    assert.deepEqual(open(report, vendorA), {
      [inv1.documentNumber]: '60.0000@over90',
      [inv2.documentNumber]: '50.0000@days31To60',
      [onAccount.documentNumber]: '-15.0000@days1To30',
      [manualNumber]: '7.0000@days1To30',
    });
    assert.equal(report.controlAccount.balance, '102.0000');
    assert.equal(report.difference, '0.0000');
  });

  it('reproduces earlier dates and keeps history after unallocation and cancellation', async () => {
    const early = await aging(day(4, 5));
    assert.deepEqual(open(early, vendorA), { [inv1.documentNumber]: '100.0000@days1To30' });
    assert.equal(early.difference, '0.0000');

    const unallocate = await ctx.http
      .post(`/v1/bank/outgoing-payments/${payment.id}/allocations/${payment.allocations[0]?.id}/unallocate`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), unallocationDate: day(7, 5), reason: 'Wrong invoice' });
    assert.equal(unallocate.status, 201, JSON.stringify(unallocate.body));
    const cancel = await ctx.http
      .post(`/v1/bank/outgoing-payments/${onAccount.id}/cancel`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), postingDate: day(7, 15), reason: 'Duplicate payment' });
    assert.equal(cancel.status, 201, JSON.stringify(cancel.body));

    const june = await aging(day(6, 30));
    assert.equal(open(june, vendorA)[inv1.documentNumber], '60.0000@over90');
    assert.equal(open(june, vendorA)[onAccount.documentNumber], '-15.0000@days1To30');
    assert.equal(june.totals.total, '132.0000');

    const july = await aging(day(7, 20));
    assert.deepEqual(open(july, vendorA), {
      [inv1.documentNumber]: '100.0000@over90',
      [inv2.documentNumber]: '50.0000@days31To60',
      [payment.documentNumber]: '-40.0000@over90',
      [manualNumber]: '7.0000@days31To60',
    });
    assert.equal(july.totals.total, '147.0000');
    assert.equal(july.difference, '0.0000');
  });

  it('drops invoices cancelled by the as-of date and isolates tenants', async () => {
    const groups = (await ctx.http.get('/v1/bp/groups').set(bearer(acme))).body as PartnerGroup[];
    const vendorC = (
      await ctx.http.post('/v1/bp/partners').set(bearer(acme)).send({ code: 'AG-C', partnerType: 'supplier', name: 'Aging C', groupId: groups.find((g) => g.partnerType === 'supplier')?.id })
    ).body.id as string;
    const wrong = await invoice(vendorC, '20', day(8, 1));
    const cancel = await ctx.http.post(`/v1/pur/invoices/${wrong.id}/cancel`).set(bearer(acme)).send({ idempotencyKey: randomUUID(), postingDate: day(8, 10), reason: 'Duplicate' });
    assert.equal(cancel.status, 201, JSON.stringify(cancel.body));
    assert.equal(vendorRow(await aging(day(8, 5)), vendorC)?.total, '20.0000');
    const cleared = await aging(day(8, 20));
    assert.equal(vendorRow(cleared, vendorC), undefined);
    assert.equal(cleared.difference, '0.0000');

    const auditor = await loginToTenant(ctx, SHARED, GLOBEX);
    const globexReport = await ctx.http.get(`/v1/fin/reports/ap-aging?asOf=${day(8, 20)}`).set(bearer(auditor.token));
    assert.equal(globexReport.status, 200);
    assert.equal((globexReport.body as ApAgingReport).vendors.length, 0);
    const bad = await ctx.http.get('/v1/fin/reports/ap-aging?asOf=not-a-date').set(bearer(acme));
    assert.equal(bad.status, 400);
  });
});
