import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { sql } from 'kysely';
import { OPENING_IMPORT_TEMPLATES, type ItemGroup, type ItemStock, type OpenPaymentItem, type OpeningBalance, type OpeningImportResult, type PartnerGroup, type UnitOfMeasure } from '@nec/contracts';
import { ACME, ACME_OWNER, bearer, GLOBEX, GLOBEX_OWNER, loginToTenant, setup, SHARED, type TestContext } from './helpers.js';

const YEAR = new Date().getUTCFullYear();
const day = (month: number, date: number) => `${YEAR}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;

describe('Opening balance imports', () => {
  let ctx: TestContext;
  let acme: string;

  const importBalances = (kind: 'account' | 'partner', mode: 'validate' | 'commit', csv: string, extra: Record<string, unknown> = {}, token = acme) =>
    ctx.http
      .post('/v1/fin/opening-balances/import')
      .set(bearer(token))
      .send({ idempotencyKey: randomUUID(), kind, mode, csv, fileName: 'balances.csv', postingDate: day(1, 1), reason: 'Go-live import', ...extra });

  const importStock = (mode: 'validate' | 'commit', csv: string, extra: Record<string, unknown> = {}) =>
    ctx.http
      .post('/v1/inv/opening-balances/import')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), mode, csv, fileName: 'stock.csv', postingDate: day(1, 1), reason: 'Go-live count', ...extra });

  const errorsOf = (body: OpeningImportResult) => body.errors.map((error) => `${error.row ?? '-'}:${error.column ?? '-'}:${error.message}`);
  const documentCount = async (kind: string) => (await ctx.http.get(`/v1/fin/opening-balances?kind=${kind}`).set(bearer(acme))).body.total as number;

  before(async () => {
    ctx = await setup();
    acme = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    const groups = (await ctx.http.get('/v1/bp/groups').set(bearer(acme))).body as PartnerGroup[];
    for (const [code, partnerType] of [
      ['V1000', 'supplier'],
      ['C2000', 'customer'],
    ] as const) {
      const response = await ctx.http
        .post('/v1/bp/partners')
        .set(bearer(acme))
        .send({ code, partnerType, name: `${code} partner`, groupId: groups.find((g) => g.partnerType === partnerType)?.id });
      assert.equal(response.status, 201, JSON.stringify(response.body));
    }
    const units = (await ctx.http.get('/v1/inv/units').set(bearer(acme))).body as UnitOfMeasure[];
    const itemGroups = (await ctx.http.get('/v1/inv/item-groups').set(bearer(acme))).body as ItemGroup[];
    for (const code of ['A-100', 'B-200']) {
      const response = await ctx.http
        .post('/v1/inv/items')
        .set(bearer(acme))
        .send({ code, name: `Item ${code}`, itemType: 'inventory', groupId: itemGroups.find((g) => g.code === 'GENERAL')?.id, uomId: units.find((u) => u.code === 'EA')?.id });
      assert.equal(response.status, 201, JSON.stringify(response.body));
    }
  });

  after(async () => {
    await ctx.close();
  });

  it('validates the G/L template without posting, then commits it once', async () => {
    const csv = OPENING_IMPORT_TEMPLATES.account.content;
    const validated = await importBalances('account', 'validate', csv);
    assert.equal(validated.status, 200, JSON.stringify(validated.body));
    const check = validated.body as OpeningImportResult;
    assert.equal(check.valid, true);
    assert.equal(check.committed, false);
    assert.equal(check.rowCount, 2);
    assert.equal(check.totalDebit, '1000.0000');
    assert.equal(check.totalCredit, '250.0000');
    assert.equal(check.documentNumber, null);
    assert.equal(await documentCount('account'), 0);

    const key = randomUUID();
    const committed = await importBalances('account', 'commit', csv, { idempotencyKey: key });
    assert.equal(committed.status, 201, JSON.stringify(committed.body));
    const result = committed.body as OpeningImportResult;
    assert.equal(result.committed, true);
    assert.equal(result.documentNumber, 'OB1');
    const document = (await ctx.http.get(`/v1/fin/opening-balances/${result.documentId}`).set(bearer(acme))).body as OpeningBalance;
    assert.deepEqual(document.lines.map((line) => `${line.accountCode}:${line.debit}:${line.credit}`), ['1100:1000.0000:0.0000', '2300:0.0000:250.0000']);
    assert.equal(document.offsetCredit, '750.0000');
    const replay = await importBalances('account', 'commit', csv, { idempotencyKey: key });
    assert.equal(replay.status, 200);
    assert.equal((replay.body as OpeningImportResult).replayed, true);
    assert.equal((replay.body as OpeningImportResult).documentId, result.documentId);
    assert.equal(await documentCount('account'), 1);

    const audit = await ctx.asApp.transaction().execute(async (trx) => {
      await sql`select set_config('app.tenant_id', ${ctx.tenantId(ACME)}, true)`.execute(trx);
      return (await sql<{ after: { source?: unknown } }>`select after_data as after from audit_events where entity_id = ${result.documentId}::uuid and action = 'opening_balance.account_posted'`.execute(trx)).rows;
    });
    assert.deepEqual(audit.map((row) => row.after.source), [{ import: true, fileName: 'balances.csv', rows: 2 }]);
  });

  it('reports every row error with its row and column and posts nothing', async () => {
    const header = await importBalances('account', 'validate', 'AccountCode,Amount\r\n1100,5\r\n');
    assert.deepEqual(errorsOf(header.body), ['1:Amount:Unknown column "Amount"']);
    const missing = await importBalances('account', 'commit', 'Debit,Credit\r\n5,\r\n');
    assert.deepEqual(errorsOf(missing.body), ['1:AccountCode:The required column AccountCode is missing']);
    assert.deepEqual(errorsOf((await importBalances('account', 'validate', 'AccountCode,Debit,Credit\r\n')).body), ['-:-:The file has no data rows']);
    assert.deepEqual(errorsOf((await importBalances('account', 'validate', 'AccountCode,Debit\r\n"1100,5\r\n')).body), ['2:-:Row 2: a quoted field is not closed']);

    const csv = ['AccountCode,Debit,Credit', '9999,10,', '1110,abc,', '1110,5,5', '', '1100,1,', '1100,2,', '3100,,'].join('\r\n');
    const response = await importBalances('account', 'commit', csv);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const result = response.body as OpeningImportResult;
    assert.equal(result.valid, false);
    assert.equal(result.committed, false);
    assert.equal(result.rowCount, 6);
    assert.deepEqual(errorsOf(result), [
      '2:AccountCode:G/L account 9999 does not exist',
      '3:Debit:Enter a non-negative amount with up to 4 decimal places',
      '4:AccountCode:Account 1110 also appears on row 3',
      '4:Debit:Enter either a debit or a credit amount',
      '7:AccountCode:Account 1100 also appears on row 6',
      '8:Debit:Enter either a debit or a credit amount',
    ]);

    const rules = await importBalances('account', 'validate', 'AccountCode,Debit,Credit\r\n1100,5,\r\n2100,,5\r\n');
    assert.deepEqual(errorsOf(rules.body), ['3:AccountCode:2100 is a control account; enter its balance through Business Partners Opening Balance']);
    const period = await importBalances('account', 'validate', 'AccountCode,Debit\r\n1100,5\r\n', { postingDate: `${YEAR + 5}-01-01` });
    assert.equal((period.body as OpeningImportResult).errors[0]?.row, null);
    assert.match((period.body as OpeningImportResult).errors[0]?.message ?? '', /No posting period/);
    assert.equal(await documentCount('account'), 1);
  });

  it('imports business partner open items with quoting, a byte-order mark and default due dates', async () => {
    const csv = `\uFEFFbpcode,Reference,DocumentDate,DueDate,Debit,Credit\r\nv1000,"LEG-1, part ""A""",${YEAR - 1}-12-15,,,"1,500.00"\r\nC2000,INV-7,${YEAR - 1}-12-20,${day(1, 19)},200,\r\nC2000,INV-8,2025-02-30,,5,\r\n`;
    const invalid = await importBalances('partner', 'commit', csv);
    assert.deepEqual(errorsOf(invalid.body), ['4:DocumentDate:Enter the date as YYYY-MM-DD']);
    const fixed = csv.replace('2025-02-30', `${YEAR - 1}-12-21`);
    const future = await importBalances('partner', 'validate', fixed.replace(`${YEAR - 1}-12-21`, day(2, 1)));
    assert.deepEqual(errorsOf(future.body), ['4:DocumentDate:the document date cannot be after the opening balance posting date']);
    const response = await importBalances('partner', 'commit', fixed);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const result = response.body as OpeningImportResult;
    assert.equal(result.totalCredit, '1500.0000');
    assert.equal(result.totalDebit, '205.0000');
    const document = (await ctx.http.get(`/v1/fin/opening-balances/${result.documentId}`).set(bearer(acme))).body as OpeningBalance;
    assert.deepEqual(document.lines.map((line) => [line.partnerCode, line.reference, line.dueDate, line.credit, line.debit]), [
      ['V1000', 'LEG-1, part "A"', `${YEAR - 1}-12-15`, '1500.0000', '0.0000'],
      ['C2000', 'INV-7', day(1, 19), '0.0000', '200.0000'],
      ['C2000', 'INV-8', `${YEAR - 1}-12-21`, '0.0000', '5.0000'],
    ]);
    const vendor = document.lines[0]?.partnerId as string;
    const payable = (await ctx.http.get(`/v1/bank/open-invoices?vendorId=${vendor}`).set(bearer(acme))).body as OpenPaymentItem[];
    assert.deepEqual(payable.map((row) => row.openAmount), ['1500.0000']);
    const receivable = (await ctx.http.get(`/v1/bank/open-receivables?customerId=${document.lines[1]?.partnerId}`).set(bearer(acme))).body as OpenPaymentItem[];
    assert.deepEqual(receivable.map((row) => row.openAmount), ['5.0000', '200.0000']);
  });

  it('accepts large files up to the row limit and rejects more', async () => {
    const rows = Array.from({ length: 1800 }, (_, index) => `V1000,LEGACY-REFERENCE-${String(index).padStart(6, '0')}-XXXXXXXXXXXXXXXX,,,,1.00`);
    const csv = ['BPCode,Reference,DocumentDate,DueDate,Debit,Credit', ...rows].join('\r\n');
    assert.ok(csv.length > 100_000);
    const large = await importBalances('partner', 'validate', csv);
    assert.equal(large.status, 200, JSON.stringify(large.body).slice(0, 300));
    assert.equal((large.body as OpeningImportResult).valid, true);
    assert.equal((large.body as OpeningImportResult).totalCredit, '1800.0000');
    const tooMany = ['AccountCode,Debit', ...Array.from({ length: 2001 }, () => '1100,1')].join('\n');
    assert.deepEqual(errorsOf((await importBalances('account', 'validate', tooMany)).body), ['-:-:The file has 2001 data rows; the limit is 2000']);
  });

  it('imports inventory opening stock and maps posting rules back to rows', async () => {
    const csv = 'ItemCode,WarehouseCode,Quantity,UnitCost\r\na-100,wh01,10,2.50\r\nB-200,WH01,4,1\r\n';
    const unknown = await importStock('validate', 'ItemCode,WarehouseCode,Quantity,UnitCost\r\nZ-1,WH09,0,x\r\n');
    assert.deepEqual(errorsOf(unknown.body), [
      '2:ItemCode:Item Z-1 does not exist',
      '2:WarehouseCode:Warehouse WH09 does not exist',
      '2:Quantity:Enter a quantity greater than zero with up to 4 decimal places',
      '2:UnitCost:Enter a non-negative unit cost with up to 4 decimal places',
    ]);
    const validated = await importStock('validate', csv);
    assert.equal(validated.status, 200, JSON.stringify(validated.body));
    assert.equal((validated.body as OpeningImportResult).totalDebit, '29.0000');
    const committed = await importStock('commit', csv);
    assert.equal(committed.status, 201, JSON.stringify(committed.body));
    const result = committed.body as OpeningImportResult;
    assert.match(result.documentNumber ?? '', /^IO/);
    const items = (await ctx.http.get('/v1/inv/items?search=A-100').set(bearer(acme))).body.items as { id: string; code: string }[];
    const stock = (await ctx.http.get(`/v1/inv/items/${items.find((row) => row.code === 'A-100')?.id}/stock`).set(bearer(acme))).body as ItemStock;
    assert.equal(stock.onHand, '10.0000');
    assert.equal(stock.averageCost, '2.500000');
    const again = await importStock('validate', 'ItemCode,WarehouseCode,Quantity,UnitCost\r\nB-200,WH01,1,1\r\n');
    assert.equal(again.status, 200);
    assert.equal((again.body as OpeningImportResult).errors[0]?.row, 2);
    assert.equal((again.body as OpeningImportResult).errors[0]?.column, 'ItemCode');
    assert.match((again.body as OpeningImportResult).errors[0]?.message ?? '', /already has stock transactions/);
  });

  it('enforces permissions and resolves codes only within the tenant', async () => {
    const auditor = (await loginToTenant(ctx, SHARED, GLOBEX)).token;
    assert.equal((await importBalances('account', 'validate', OPENING_IMPORT_TEMPLATES.account.content, {}, auditor)).status, 403);
    assert.equal((await ctx.http.post('/v1/inv/opening-balances/import').set(bearer(auditor)).send({})).status, 403);
    const globex = (await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX)).token;
    const cross = await importBalances('partner', 'validate', 'BPCode,Credit\r\nV1000,5\r\n', {}, globex);
    assert.deepEqual(errorsOf(cross.body), ['2:BPCode:Business partner V1000 does not exist']);
    assert.equal((await importBalances('account', 'validate', 'x', { kind: 'inventory' })).status, 400);
  });
});
