import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { sql } from 'kysely';
import type { Account, GeneralLedgerReport, JournalEntry, PartnerGroup, PeriodCloseChecks, PostingPeriod } from '@nec/contracts';
import { ACME, ACME_OWNER, bearer, GLOBEX, GLOBEX_OWNER, loginToTenant, setup, type TestContext } from './helpers.js';

const YEAR = new Date().getUTCFullYear();
const day = (month: number, date: number) => `${YEAR}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;

describe('General ledger and period closing', () => {
  let ctx: TestContext;
  let acme: string;
  let accountant: string;
  let accounts: Account[];
  let customerId: string;

  const account = (code: string) => accounts.find((row) => row.code === code)?.id as string;
  const journal = async (postingDate: string, lines: Record<string, unknown>[]) => {
    const response = await ctx.http.post('/v1/fin/journal-entries').set(bearer(acme)).send({ idempotencyKey: randomUUID(), postingDate, memo: 'Close test', lines });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body as JournalEntry;
  };
  const ledger = async (query: string, token = acme) => {
    const response = await ctx.http.get(`/v1/fin/reports/general-ledger?${query}`).set(bearer(token));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body as GeneralLedgerReport;
  };
  const period = async (date: string) => ((await ctx.http.get('/v1/fin/periods').set(bearer(acme))).body as PostingPeriod[]).find((row) => row.startDate <= date && row.endDate >= date) as PostingPeriod;
  const setStatus = (target: PostingPeriod, status: 'open' | 'closed', token = acme) =>
    ctx.http.patch(`/v1/fin/periods/${target.id}/status`).set(bearer(token)).send({ status, version: target.version, reason: 'Month end' });

  before(async () => {
    ctx = await setup();
    acme = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    accounts = (await ctx.http.get('/v1/fin/accounts').set(bearer(acme))).body as Account[];
    const groups = (await ctx.http.get('/v1/bp/groups').set(bearer(acme))).body as PartnerGroup[];
    const customer = await ctx.http.post('/v1/bp/partners').set(bearer(acme)).send({ code: 'GL-C', partnerType: 'customer', name: 'Ledger customer', groupId: groups.find((g) => g.partnerType === 'customer')?.id });
    customerId = customer.body.id;
    const roles = (await ctx.http.get('/v1/tenant/roles').set(bearer(acme))).body as { id: string; code: string }[];
    assert.equal((await ctx.http.post('/v1/tenant/invitations').set(bearer(acme)).send({ email: 'close.accountant@nec-erp.localhost', roleIds: [roles.find((r) => r.code === 'accountant')?.id] })).status, 201);
    assert.equal((await ctx.http.post('/v1/invitations/accept').send({ token: ctx.mailer.tokenFor('close.accountant@nec-erp.localhost'), password: ctx.password, displayName: 'Close Accountant' })).status, 200);
    accountant = (await loginToTenant(ctx, 'close.accountant@nec-erp.localhost', ACME)).token;
  });

  after(async () => {
    await ctx.close();
  });

  it('lists journal lines per account with opening, running and closing balances and filters', async () => {
    const first = await journal(day(1, 10), [{ accountId: account('1100'), debit: '100' }, { accountId: account('4100'), credit: '100' }]);
    const second = await journal(day(2, 5), [{ accountId: account('1100'), debit: '40' }, { accountId: account('4100'), credit: '40' }]);
    const third = await journal(day(2, 20), [{ accountId: account('5400'), debit: '15' }, { accountId: account('1100'), credit: '15' }]);
    await journal(day(2, 25), [{ partnerId: customerId, debit: '30' }, { accountId: account('4100'), credit: '30' }]);

    const report = await ledger(`from=${day(2, 1)}&to=${day(2, 28)}&accountFrom=1100&accountTo=1100`);
    assert.equal(report.accounts.length, 1);
    const cash = report.accounts[0];
    assert.deepEqual([cash?.accountCode, cash?.openingBalance, cash?.debit, cash?.credit, cash?.closingBalance], ['1100', '100.0000', '40.0000', '15.0000', '125.0000']);
    assert.deepEqual(cash?.lines.map((line) => [line.journalNumber, line.debit, line.credit, line.balance]), [
      [second.documentNumber, '40.0000', '0.0000', '140.0000'],
      [third.documentNumber, '0.0000', '15.0000', '125.0000'],
    ]);
    assert.ok(!report.accounts.some((row) => row.accountCode === '4100'));
    const all = await ledger(`from=${day(1, 1)}&to=${day(2, 28)}`);
    assert.equal(all.totals.debit, all.totals.credit);
    assert.ok(all.accounts.find((row) => row.accountCode === '1100')?.lines.some((line) => line.journalNumber === first.documentNumber));
    const partner = await ledger(`from=${day(1, 1)}&to=${day(2, 28)}&partnerId=${customerId}`);
    assert.deepEqual(partner.accounts.map((row) => [row.accountCode, row.closingBalance, row.lines[0]?.partnerCode]), [['1200', '30.0000', 'GL-C']]);
    assert.equal((await ctx.http.get(`/v1/fin/reports/general-ledger?from=${day(3, 1)}&to=${day(2, 1)}`).set(bearer(acme))).status, 400);
    const globex = (await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX)).token;
    assert.deepEqual((await ledger(`from=${day(1, 1)}&to=${day(2, 28)}`, globex)).accounts, []);
  });

  it('closes a period only when every reconciliation check passes and reopens only with the reopen permission', async () => {
    const march = await period(day(3, 15));
    const clean = (await ctx.http.get(`/v1/fin/periods/${march.id}/close-checks`).set(bearer(acme))).body as PeriodCloseChecks;
    assert.equal(clean.passed, true, JSON.stringify(clean));
    assert.deepEqual(clean.checks.map((check) => check.key), ['trial_balance', 'receivables', 'payables', 'inventory']);

    const stray = await journal(day(3, 10), [{ accountId: account('1300'), debit: '9' }, { accountId: account('1100'), credit: '9' }]);
    const failing = (await ctx.http.get(`/v1/fin/periods/${march.id}/close-checks`).set(bearer(acme))).body as PeriodCloseChecks;
    assert.equal(failing.passed, false);
    assert.deepEqual(failing.checks.filter((check) => !check.passed).map((check) => check.key), ['inventory']);
    assert.match(failing.checks.find((check) => check.key === 'inventory')?.detail ?? '', /1300: stock 0\.0000, ledger 9\.0000/);
    const refused = await setStatus(march, 'closed', accountant);
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error.code, 'PERIOD_CLOSE_CHECKS_FAILED');
    assert.equal((await period(day(3, 15))).status, 'open');

    const reversed = await ctx.http.post(`/v1/fin/journal-entries/${stray.id}/reverse`).set(bearer(acme)).send({ idempotencyKey: randomUUID(), postingDate: day(3, 11), reason: 'Posted to the wrong account' });
    assert.equal(reversed.status, 201, JSON.stringify(reversed.body));
    const closed = await setStatus(await period(day(3, 15)), 'closed', accountant);
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal((closed.body as PostingPeriod).status, 'closed');
    assert.equal((await ctx.http.post('/v1/fin/journal-entries').set(bearer(acme)).send({ idempotencyKey: randomUUID(), postingDate: day(3, 20), memo: 'Late', lines: [{ accountId: account('1100'), debit: '1' }, { accountId: account('4100'), credit: '1' }] })).status, 422);

    assert.equal((await setStatus(closed.body as PostingPeriod, 'open', accountant)).status, 403);
    const reopened = await setStatus(closed.body as PostingPeriod, 'open');
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
    const audit = await ctx.asApp.transaction().execute(async (trx) => {
      await sql`select set_config('app.tenant_id', ${ctx.tenantId(ACME)}, true)`.execute(trx);
      return trx.selectFrom('audit_events').select(['action', 'after_data']).where('entity_id', '=', march.id).orderBy('occurred_at').execute();
    });
    assert.deepEqual(audit.map((event) => event.action), ['posting_period.closed', 'posting_period.reopened']);
    assert.equal(((audit[0]?.after_data as { checks: { passed: boolean }[] }).checks ?? []).length, 4);
  });
});
