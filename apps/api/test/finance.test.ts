import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { sql, type Transaction } from 'kysely';
import type { Account, GlDetermination, JournalEntry, PartnerGroup, PostingPeriod, TrialBalance } from '@nec/contracts';
import type { Database } from '../src/database/schema.js';
import { ACME, ACME_OWNER, bearer, GLOBEX, GLOBEX_OWNER, loginToTenant, setup, SHARED, type TestContext } from './helpers.js';

const YEAR = new Date().getUTCFullYear();
const date = (month: number, day: number) => `${YEAR}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

describe('financials core', () => {
  let ctx: TestContext;
  let acme: string;
  let globex: string;
  let accounts: Account[];
  let periods: PostingPeriod[];

  const account = (code: string) => {
    const found = accounts.find((row) => row.code === code);
    assert.ok(found, `account ${code}`);
    return found.id;
  };

  const journal = (lines: { accountId?: string; partnerId?: string; debit?: string; credit?: string }[], extra: Record<string, unknown> = {}) => ({
    idempotencyKey: randomUUID(),
    postingDate: date(3, 15),
    memo: 'Test entry',
    lines,
    ...extra,
  });

  const cashSale = (amount = '100.00') => [
    { accountId: account('1100'), debit: amount },
    { accountId: account('4100'), credit: amount },
  ];

  before(async () => {
    ctx = await setup();
    acme = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    globex = (await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX)).token;
    accounts = (await ctx.http.get('/v1/fin/accounts').set(bearer(acme))).body as Account[];
    periods = (await ctx.http.get('/v1/fin/periods').set(bearer(acme))).body as PostingPeriod[];
  });

  after(async () => {
    await ctx.close();
  });

  it('provisions a default chart of accounts, determination, periods and numbering', async () => {
    assert.ok(accounts.length >= 29);
    assert.equal(accounts.find((row) => row.code === '1200')?.controlKind, 'receivable');
    assert.equal(accounts.find((row) => row.code === '1')?.isTitle, true);
    assert.equal(accounts.find((row) => row.code === '1100')?.level, 3);
    assert.equal(periods.length, 12);
    assert.ok(periods.every((period) => period.status === 'open'));
    const determination = (await ctx.http.get('/v1/fin/gl-determination').set(bearer(acme))).body as GlDetermination[];
    assert.equal(determination.find((row) => row.key === 'receivable_control')?.accountCode, '1200');
    const series = await ctx.http.get('/v1/tenant/numbering-series').set(bearer(acme));
    assert.equal((series.body as { documentType: string; prefix: string }[]).find((row) => row.documentType === 'journal_entry')?.prefix, 'JE');
  });

  it('posts balanced journal entries with sequential numbers', async () => {
    const first = await ctx.http.post('/v1/fin/journal-entries').set(bearer(acme)).send(journal(cashSale('100.00')));
    assert.equal(first.status, 201);
    const second = await ctx.http.post('/v1/fin/journal-entries').set(bearer(acme)).send(journal(cashSale('50.25')));
    assert.equal(second.status, 201);
    const a = first.body as JournalEntry;
    const b = second.body as JournalEntry;
    assert.equal(a.documentNumber, 'JE1');
    assert.equal(b.documentNumber, 'JE2');
    assert.equal(a.totalDebit, '100.0000');
    assert.equal(a.periodCode, `${YEAR}-03`);
    assert.equal(a.lines.length, 2);
  });

  it('rejects unbalanced, title, control and cross-tenant postings', async () => {
    const unbalanced = await ctx.http
      .post('/v1/fin/journal-entries')
      .set(bearer(acme))
      .send(journal([{ accountId: account('1100'), debit: '10' }, { accountId: account('4100'), credit: '9.99' }]));
    assert.equal(unbalanced.status, 422);
    assert.equal(unbalanced.body.error.code, 'JOURNAL_UNBALANCED');
    const title = await ctx.http
      .post('/v1/fin/journal-entries')
      .set(bearer(acme))
      .send(journal([{ accountId: account('11'), debit: '10' }, { accountId: account('4100'), credit: '10' }]));
    assert.equal(title.status, 422);
    const control = await ctx.http
      .post('/v1/fin/journal-entries')
      .set(bearer(acme))
      .send(journal([{ accountId: account('1200'), debit: '10' }, { accountId: account('4100'), credit: '10' }]));
    assert.equal(control.status, 422);
    assert.match(control.body.error.message, /control account/);
    const both = await ctx.http
      .post('/v1/fin/journal-entries')
      .set(bearer(acme))
      .send(journal([{ accountId: account('1100'), debit: '10', credit: '10' }, { accountId: account('4100'), credit: '10' }]));
    assert.equal(both.status, 422);
    const globexAccounts = (await ctx.http.get('/v1/fin/accounts').set(bearer(globex))).body as Account[];
    const foreign = await ctx.http
      .post('/v1/fin/journal-entries')
      .set(bearer(acme))
      .send(journal([{ accountId: globexAccounts.find((row) => row.code === '1100')?.id, debit: '10' }, { accountId: account('4100'), credit: '10' }]));
    assert.equal(foreign.status, 422);
    const list = await ctx.http.get('/v1/fin/journal-entries').set(bearer(acme));
    assert.equal(list.body.total, 2);
  });

  it('posts business partner lines to the control account and rejects leads', async () => {
    const groups = (await ctx.http.get('/v1/bp/groups').set(bearer(acme))).body as PartnerGroup[];
    const customer = await ctx.http
      .post('/v1/bp/partners')
      .set(bearer(acme))
      .send({ code: 'FC001', partnerType: 'customer', name: 'Finance Customer', groupId: groups.find((g) => g.partnerType === 'customer')?.id });
    const lead = await ctx.http
      .post('/v1/bp/partners')
      .set(bearer(acme))
      .send({ code: 'FL001', partnerType: 'lead', name: 'Finance Lead' });
    const posted = await ctx.http
      .post('/v1/fin/journal-entries')
      .set(bearer(acme))
      .send(journal([{ partnerId: customer.body.id, debit: '250' }, { accountId: account('4100'), credit: '250' }]));
    assert.equal(posted.status, 201);
    assert.equal(posted.body.lines[0].accountCode, '1200');
    assert.equal(posted.body.lines[0].partnerCode, 'FC001');
    const leadPosting = await ctx.http
      .post('/v1/fin/journal-entries')
      .set(bearer(acme))
      .send(journal([{ partnerId: lead.body.id, debit: '5' }, { accountId: account('4100'), credit: '5' }]));
    assert.equal(leadPosting.status, 422);
  });

  it('replays an identical retry and rejects a conflicting reuse of the key', async () => {
    const body = journal(cashSale('75'));
    const first = await ctx.http.post('/v1/fin/journal-entries').set(bearer(acme)).send(body);
    const retry = await ctx.http.post('/v1/fin/journal-entries').set(bearer(acme)).send(body);
    assert.equal(first.status, 201);
    assert.equal(retry.status, 200);
    assert.equal(retry.headers['idempotent-replayed'], 'true');
    assert.equal(retry.body.id, first.body.id);
    const conflicting = await ctx.http.post('/v1/fin/journal-entries').set(bearer(acme)).send({ ...body, memo: 'Different' });
    assert.equal(conflicting.status, 409);
    assert.equal(conflicting.body.error.code, 'IDEMPOTENCY_CONFLICT');
  });

  it('creates exactly one journal for concurrent submissions with the same key', async () => {
    const before = (await ctx.http.get('/v1/fin/journal-entries').set(bearer(acme))).body.total as number;
    const body = journal(cashSale('33.33'));
    const responses = await Promise.all(Array.from({ length: 5 }, () => ctx.http.post('/v1/fin/journal-entries').set(bearer(acme)).send(body)));
    assert.ok(responses.every((response) => response.status === 201 || response.status === 200));
    assert.equal(new Set(responses.map((response) => response.body.id)).size, 1);
    const afterCount = (await ctx.http.get('/v1/fin/journal-entries').set(bearer(acme))).body.total as number;
    assert.equal(afterCount, before + 1);
  });

  it('rejects posting into a closed period and allows it after an audited reopening', async () => {
    const march = periods.find((period) => period.code === `${YEAR}-03`);
    assert.ok(march);
    const close = await ctx.http
      .patch(`/v1/fin/periods/${march.id}/status`)
      .set(bearer(acme))
      .send({ status: 'closed', version: march.version, reason: 'Month end' });
    assert.equal(close.status, 200);
    const blocked = await ctx.http.post('/v1/fin/journal-entries').set(bearer(acme)).send(journal(cashSale('10')));
    assert.equal(blocked.status, 422);
    assert.equal(blocked.body.error.code, 'PERIOD_CLOSED');
    const reopen = await ctx.http
      .patch(`/v1/fin/periods/${march.id}/status`)
      .set(bearer(acme))
      .send({ status: 'open', version: close.body.version, reason: 'Late invoice' });
    assert.equal(reopen.status, 200);
    const allowed = await ctx.http.post('/v1/fin/journal-entries').set(bearer(acme)).send(journal(cashSale('10')));
    assert.equal(allowed.status, 201);
    const audit = await ctx.http.get('/v1/tenant/audit-events?limit=50').set(bearer(acme));
    const actions = (audit.body.items as { action: string }[]).map((event) => event.action);
    assert.ok(actions.includes('posting_period.closed'));
    assert.ok(actions.includes('posting_period.reopened'));
    const undefinedPeriod = await ctx.http
      .post('/v1/fin/journal-entries')
      .set(bearer(acme))
      .send(journal(cashSale('10'), { postingDate: `${YEAR + 5}-01-10` }));
    assert.equal(undefinedPeriod.body.error.code, 'PERIOD_NOT_DEFINED');
  });

  it('reverses a manual journal once, with swapped amounts and a link to the original', async () => {
    const original = (await ctx.http.post('/v1/fin/journal-entries').set(bearer(acme)).send(journal(cashSale('400')))).body as JournalEntry;
    const early = await ctx.http
      .post(`/v1/fin/journal-entries/${original.id}/reverse`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), postingDate: date(3, 1), reason: 'Too early' });
    assert.equal(early.status, 422);
    const responses = await Promise.all(
      [1, 2, 3].map(() =>
        ctx.http
          .post(`/v1/fin/journal-entries/${original.id}/reverse`)
          .set(bearer(acme))
          .send({ idempotencyKey: randomUUID(), postingDate: date(3, 20), reason: 'Posted to the wrong account' }),
      ),
    );
    const succeeded = responses.filter((response) => response.status === 201);
    assert.equal(succeeded.length, 1);
    assert.ok(responses.filter((response) => response.status !== 201).every((response) => response.status === 409));
    const reversal = succeeded[0]?.body as JournalEntry;
    assert.equal(reversal.sourceType, 'reversal');
    assert.equal(reversal.reversalOfId, original.id);
    assert.equal(reversal.lines[0]?.credit, original.lines[0]?.debit);
    assert.equal(reversal.lines[1]?.debit, original.lines[1]?.credit);
    const reloaded = await ctx.http.get(`/v1/fin/journal-entries/${original.id}`).set(bearer(acme));
    assert.equal(reloaded.body.reversedById, reversal.id);
    const reverseReversal = await ctx.http
      .post(`/v1/fin/journal-entries/${reversal.id}/reverse`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), postingDate: date(3, 21), reason: 'Undo' });
    assert.equal(reverseReversal.status, 409);
  });

  it('keeps the trial balance balanced and nets reversals', async () => {
    const report = (await ctx.http.get(`/v1/fin/reports/trial-balance?from=${date(1, 1)}&to=${date(12, 31)}`).set(bearer(acme))).body as TrialBalance;
    assert.equal(report.totals.debit, report.totals.credit);
    assert.equal(report.totals.closingBalance, '0.0000');
    const cash = report.rows.find((row) => row.code === '1100');
    assert.ok(cash);
    assert.equal(cash.closingBalance, '268.5800');
    const beforeReversal = (await ctx.http.get(`/v1/fin/reports/trial-balance?from=${date(1, 1)}&to=${date(3, 19)}`).set(bearer(acme))).body as TrialBalance;
    assert.equal(beforeReversal.rows.find((row) => row.code === '1100')?.closingBalance, '668.5800');
  });

  it('enforces immutability and balance in the database itself', async () => {
    const acmeId = ctx.tenantId(ACME);
    const inTenant = <T>(fn: (trx: Transaction<Database>) => Promise<T>) =>
      ctx.asApp.transaction().execute(async (trx) => {
        await sql`select set_config('app.tenant_id', ${acmeId}, true)`.execute(trx);
        return fn(trx);
      });
    await assert.rejects(inTenant((trx) => trx.updateTable('journal_entries').set({ memo: 'tampered' }).execute()), /permission denied|append-only/);
    await assert.rejects(inTenant((trx) => trx.deleteFrom('journal_lines').execute()), /permission denied|append-only/);
    const period = periods.find((row) => row.code === `${YEAR}-03`);
    const series = await inTenant((trx) => trx.selectFrom('numbering_series').select('id').executeTakeFirstOrThrow());
    await assert.rejects(
      inTenant(async (trx) => {
        const header = await trx
          .insertInto('journal_entries')
          .values({
            tenant_id: acmeId,
            series_id: series.id,
            number: 999999,
            document_number: 'X999999',
            source_type: 'manual',
            posting_date: date(3, 15),
            document_date: date(3, 15),
            due_date: date(3, 15),
            period_id: period?.id ?? '',
            currency: 'USD',
            total_debit: '10.0000',
            total_credit: '10.0000',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('journal_lines')
          .values([
            { tenant_id: acmeId, journal_id: header.id, line_no: 1, account_id: account('1100'), debit: '10.0000', credit: '0' },
            { tenant_id: acmeId, journal_id: header.id, line_no: 2, account_id: account('4100'), debit: '0', credit: '9.0000' },
          ])
          .execute();
      }),
      /not balanced/,
    );
  });

  it('isolates journals between tenants and enforces permissions', async () => {
    const acmeList = await ctx.http.get('/v1/fin/journal-entries').set(bearer(acme));
    const acmeJournalId = acmeList.body.items[0].id as string;
    const cross = await ctx.http.get(`/v1/fin/journal-entries/${acmeJournalId}`).set(bearer(globex));
    assert.equal(cross.status, 404);
    const globexList = await ctx.http.get('/v1/fin/journal-entries').set(bearer(globex));
    assert.equal(globexList.body.total, 0);
    const auditor = await loginToTenant(ctx, SHARED, GLOBEX);
    const read = await ctx.http.get('/v1/fin/accounts').set(bearer(auditor.token));
    assert.equal(read.status, 200);
    const post = await ctx.http.post('/v1/fin/journal-entries').set(bearer(auditor.token)).send(journal(cashSale('1')));
    assert.equal(post.status, 403);
    const roles = await ctx.http.get('/v1/tenant/roles').set(bearer(acme));
    assert.ok((roles.body as { code: string }[]).some((role) => role.code === 'accountant'));
  });

  it('validates account setup, determination and fiscal years', async () => {
    const created = await ctx.http
      .post('/v1/fin/accounts')
      .set(bearer(acme))
      .send({ code: '1120', name: 'Petty Cash', accountType: 'asset', parentId: account('11') });
    assert.equal(created.status, 201);
    assert.equal(created.body.level, 3);
    const wrongParent = await ctx.http
      .post('/v1/fin/accounts')
      .set(bearer(acme))
      .send({ code: '4200', name: 'Wrong', accountType: 'income', parentId: account('11') });
    assert.equal(wrongParent.status, 400);
    const wrongType = await ctx.http
      .put('/v1/fin/gl-determination')
      .set(bearer(acme))
      .send({ mappings: [{ key: 'revenue', accountId: account('1100') }] });
    assert.equal(wrongType.status, 400);
    const wrongControl = await ctx.http
      .put('/v1/fin/gl-determination')
      .set(bearer(acme))
      .send({ mappings: [{ key: 'receivable_control', accountId: account('1100') }] });
    assert.equal(wrongControl.status, 400);
    const remap = await ctx.http
      .put('/v1/fin/gl-determination')
      .set(bearer(acme))
      .send({ mappings: [{ key: 'cash', accountId: created.body.id }] });
    assert.equal(remap.status, 200);
    const deactivateMapped = await ctx.http
      .put(`/v1/fin/accounts/${created.body.id}`)
      .set(bearer(acme))
      .send({ version: created.body.version, name: 'Petty Cash', status: 'inactive' });
    assert.equal(deactivateMapped.status, 409);
    const overlap = await ctx.http.post('/v1/fin/fiscal-years').set(bearer(acme)).send({ code: 'DUP', startDate: `${YEAR}-06-01` });
    assert.equal(overlap.status, 409);
    const next = await ctx.http.post('/v1/fin/fiscal-years').set(bearer(acme)).send({ code: String(YEAR + 1), startDate: `${YEAR + 1}-01-01` });
    assert.equal(next.status, 201);
    assert.equal((next.body as PostingPeriod[]).length, 24);
  });

  it('uses a newly selected default numbering series', async () => {
    const created = await ctx.http
      .post('/v1/tenant/numbering-series')
      .set(bearer(acme))
      .send({ documentType: 'journal_entry', name: `Y${YEAR}`, prefix: `JV${YEAR}-`, nextNumber: 1000, isDefault: true });
    assert.equal(created.status, 201);
    const posted = await ctx.http.post('/v1/fin/journal-entries').set(bearer(acme)).send(journal(cashSale('1')));
    assert.equal(posted.body.documentNumber, `JV${YEAR}-1000`);
  });
});
