import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { sql } from 'kysely';
import { MASTER_IMPORT_TEMPLATES, type BusinessPartner, type Item, type MasterImportResult, type Page, type PartnerSummary, type PriceList, type PriceListEntry } from '@nec/contracts';
import { ACME, ACME_OWNER, bearer, GLOBEX, GLOBEX_OWNER, loginToTenant, setup, type TestContext } from './helpers.js';

describe('Master data import', () => {
  let ctx: TestContext;
  let acme: string;

  const send = async (path: string, csv: string, extra: Record<string, unknown> = {}, token = acme) => {
    const response = await ctx.http.post(path).set(bearer(token)).send({ idempotencyKey: randomUUID(), mode: 'validate', fileName: 'test.csv', csv, ...extra });
    return response;
  };
  const partner = async (code: string) => {
    const list = (await ctx.http.get(`/v1/bp/partners?search=${code}`).set(bearer(acme))).body as Page<PartnerSummary>;
    const found = list.items.find((row) => row.code === code);
    return found ? ((await ctx.http.get(`/v1/bp/partners/${found.id}`).set(bearer(acme))).body as BusinessPartner) : null;
  };
  const item = async (code: string) => {
    const list = (await ctx.http.get(`/v1/inv/items?search=${code}`).set(bearer(acme))).body as Page<{ id: string; code: string }>;
    const found = list.items.find((row) => row.code === code);
    return found ? ((await ctx.http.get(`/v1/inv/items/${found.id}`).set(bearer(acme))).body as Item) : null;
  };

  before(async () => {
    ctx = await setup();
    acme = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
  });

  after(async () => {
    await ctx.close();
  });

  it('validates the partner template without saving, then commits it once with audit records', async () => {
    const csv = MASTER_IMPORT_TEMPLATES.partner.content;
    const validated = await send('/v1/bp/partners/import', csv);
    assert.equal(validated.status, 200, JSON.stringify(validated.body));
    assert.deepEqual({ ...(validated.body as MasterImportResult), errors: undefined }, { kind: 'partner', mode: 'validate', valid: true, committed: false, replayed: false, rowCount: 2, created: 2, updated: 0, errors: undefined });
    assert.equal(await partner('C3000'), null);

    const key = randomUUID();
    const committed = await send('/v1/bp/partners/import', csv, { mode: 'commit', idempotencyKey: key });
    assert.equal(committed.status, 201, JSON.stringify(committed.body));
    assert.equal((committed.body as MasterImportResult).created, 2);
    const replay = await send('/v1/bp/partners/import', csv, { mode: 'commit', idempotencyKey: key });
    assert.equal(replay.status, 200);
    assert.deepEqual([(replay.body as MasterImportResult).replayed, (replay.body as MasterImportResult).created], [true, 2]);
    assert.equal((await send('/v1/bp/partners/import', `${csv}X1,Extra,customer\r\n`, { mode: 'commit', idempotencyKey: key })).status, 409);

    const imported = await partner('C3000');
    assert.ok(imported);
    assert.deepEqual([imported.name, imported.partnerType, imported.taxId, imported.email, imported.creditLimit], ['Northwind Stores', 'customer', 'TAX-3000', 'orders@northwind.example', '5000.0000']);
    assert.deepEqual(imported.addresses.map((a) => [a.addressType, a.street, a.city, a.zipCode, a.country, a.isDefault]), [['bill_to', '1 Market Street', 'Lahore', '54000', 'PK', true]]);
    assert.equal((await partner('V3000'))?.partnerType, 'supplier');
    const events = await ctx.asApp.transaction().execute(async (trx) => {
      await sql`select set_config('app.tenant_id', ${ctx.tenantId(ACME)}, true)`.execute(trx);
      return trx.selectFrom('audit_events').select(['action', 'after_data']).where('action', 'in', ['master_data.imported', 'business_partner.created']).where('correlation_id', 'is not', null).execute();
    });
    assert.equal(events.filter((event) => event.action === 'master_data.imported').length, 1);
    assert.ok(events.filter((event) => event.action === 'business_partner.created').length >= 2);
  });

  it('reports every row error and saves nothing when any row fails', async () => {
    const csv = [
      'BPCode,BPName,BPType,GroupCode,PaymentTermsCode,Email,BillToCountry,CreditLimit',
      'N1,Good Customer,customer,,,,,',
      'N2,,customer,,,,,',
      'N3,Bad Group,customer,NOPE,NET99,,,',
      'N4,Bad Email,customer,,,not-an-email,Pakistan,',
      'N1,Duplicate,customer,,,,,',
      'C3000,Exists,customer,,,,,',
      'N5,Bad Limit,customer,,,,,-5',
    ].join('\r\n');
    const result = (await send('/v1/bp/partners/import', csv, { mode: 'commit' })).body as MasterImportResult;
    assert.equal(result.valid, false);
    assert.equal(result.committed, false);
    assert.deepEqual(result.errors.map((error) => [error.row, error.column]), [[6, 'BPCode']]);
    const rows = (await send('/v1/bp/partners/import', csv.replace('N1,Duplicate', 'N6,Duplicate'), { mode: 'commit' })).body as MasterImportResult;
    assert.deepEqual(
      rows.errors.map((error) => [error.row, error.column]),
      [
        [3, 'BPName'],
        [4, 'GroupCode'],
        [4, 'PaymentTermsCode'],
        [5, 'BillToCountry'],
        [7, 'BPCode'],
        [8, 'CreditLimit'],
      ],
    );
    assert.equal(await partner('N1'), null);
    const unknown = (await send('/v1/bp/partners/import', 'BPCode,Colour\r\nX,red\r\n')).body as MasterImportResult;
    assert.deepEqual(unknown.errors.map((error) => error.message), ['Unknown column "Colour"']);
    const email = (await send('/v1/bp/partners/import', 'BPCode,BPName,BPType,Email\r\nE1,Email,customer,not-an-email\r\n')).body as MasterImportResult;
    assert.deepEqual(email.errors.map((error) => [error.row, error.column]), [[2, 'Email']]);
  });

  it('updates only the supplied fields of existing partners when asked to', async () => {
    const csv = 'BPCode,Phone,BillToCity\r\nc3000,+92 42 1234,Islamabad\r\n';
    assert.equal((await send('/v1/bp/partners/import', csv, { mode: 'commit' })).body.errors[0].column, 'BPCode');
    const updated = await send('/v1/bp/partners/import', csv, { mode: 'commit', updateExisting: true });
    assert.equal(updated.status, 201, JSON.stringify(updated.body));
    assert.deepEqual([(updated.body as MasterImportResult).created, (updated.body as MasterImportResult).updated], [0, 1]);
    const after = await partner('C3000');
    assert.deepEqual([after?.name, after?.phone, after?.taxId, after?.addresses[0]?.city, after?.addresses[0]?.street], ['Northwind Stores', '+92 42 1234', 'TAX-3000', 'Islamabad', '1 Market Street']);
    const roles = (await ctx.http.get('/v1/tenant/roles').set(bearer(acme))).body as { id: string; code: string }[];
    assert.equal((await ctx.http.post('/v1/tenant/invitations').set(bearer(acme)).send({ email: 'import.accountant@nec-erp.localhost', roleIds: [roles.find((r) => r.code === 'accountant')?.id] })).status, 201);
    assert.equal((await ctx.http.post('/v1/invitations/accept').send({ token: ctx.mailer.tokenFor('import.accountant@nec-erp.localhost'), password: ctx.password, displayName: 'Import Accountant' })).status, 200);
    const accountant = (await loginToTenant(ctx, 'import.accountant@nec-erp.localhost', ACME)).token;
    assert.equal((await send('/v1/bp/partners/import', csv, {}, accountant)).status, 403);
    assert.equal((await send('/v1/inv/price-lists/import', 'PriceListCode,ItemCode,Price\r\nSALES,X,1\r\n', {}, accountant)).status, 403);
  });

  it('imports items, updates them, and keeps item type locked once used', async () => {
    const created = await send('/v1/inv/items/import', MASTER_IMPORT_TEMPLATES.item.content, { mode: 'commit' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((created.body as MasterImportResult).created, 2);
    const widget = await item('B-200');
    assert.deepEqual([widget?.itemType, widget?.reorderPoint, widget?.isPurchaseItem], ['inventory', '10.0000', true]);
    assert.equal((await item('SRV-INSTALL'))?.isPurchaseItem, false);
    const bad = (await send('/v1/inv/items/import', 'ItemCode,ItemName,ItemType,GroupCode,UomCode,SalesItem,DefaultWarehouseCode\r\nX-1,X,widget,GENERAL,EA,maybe,NOWH\r\nX-2,,inventory,GENERAL,EA,Y,\r\n')).body as MasterImportResult;
    assert.deepEqual(
      bad.errors.map((error) => [error.row, error.column]),
      [
        [2, 'SalesItem'],
        [2, 'DefaultWarehouseCode'],
        [3, 'ItemName'],
      ],
    );
    const received = await ctx.http.post('/v1/inv/adjustments').set(bearer(acme)).send({ idempotencyKey: randomUUID(), direction: 'receipt', postingDate: `${new Date().getUTCFullYear()}-03-01`, reason: 'Stock', lines: [{ itemId: widget?.id, warehouseId: widget?.defaultWarehouseId, quantity: '1', unitCost: '2' }] });
    assert.equal(received.status, 201, JSON.stringify(received.body));
    const locked = (await send('/v1/inv/items/import', 'ItemCode,ItemType,ReorderPoint\r\nB-200,service,\r\n', { updateExisting: true })).body as MasterImportResult;
    assert.equal(locked.errors[0]?.row, 2);
    assert.match(locked.errors[0]?.message ?? '', /can no longer change/);
    const reorder = await send('/v1/inv/items/import', 'ItemCode,ReorderPoint\r\nB-200,25\r\n', { mode: 'commit', updateExisting: true });
    assert.equal(reorder.status, 201, JSON.stringify(reorder.body));
    assert.deepEqual([(await item('B-200'))?.reorderPoint, (await item('B-200'))?.name], ['25.0000', 'Widget B']);
  });

  it('sets, changes and removes prices per price list', async () => {
    const lists = (await ctx.http.get('/v1/inv/price-lists').set(bearer(acme))).body as PriceList[];
    const sales = lists.find((list) => list.code === 'SALES') as PriceList;
    const entries = async () => ((await ctx.http.get(`/v1/inv/price-lists/${sales.id}/prices?search=B-200`).set(bearer(acme))).body as Page<PriceListEntry>).items.find((row) => row.itemCode === 'B-200')?.price;
    const first = await send('/v1/inv/price-lists/import', MASTER_IMPORT_TEMPLATES.price.content, { mode: 'commit' });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual([(first.body as MasterImportResult).created, (first.body as MasterImportResult).updated], [1, 0]);
    assert.equal(await entries(), '12.5000');
    const changed = (await send('/v1/inv/price-lists/import', 'PriceListCode,ItemCode,Price\r\nsales,b-200,13\r\n', { mode: 'commit' })).body as MasterImportResult;
    assert.deepEqual([changed.created, changed.updated], [0, 1]);
    assert.equal(await entries(), '13.0000');
    const bad = (await send('/v1/inv/price-lists/import', 'PriceListCode,ItemCode,Price\r\nNOPE,B-200,1\r\nSALES,NOITEM,1\r\nSALES,B-200,abc\r\nSALES,B-200,1\r\nSALES,B-200,2\r\n')).body as MasterImportResult;
    assert.deepEqual(
      bad.errors.map((error) => [error.row, error.column]),
      [
        [2, 'PriceListCode'],
        [3, 'ItemCode'],
        [4, 'Price'],
        [6, 'ItemCode'],
      ],
    );
    await send('/v1/inv/price-lists/import', 'PriceListCode,ItemCode,Price\r\nSALES,B-200,\r\n', { mode: 'commit' });
    assert.equal(await entries(), null);
  });

  it('resolves codes only within the signed-in company', async () => {
    const globex = (await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX)).token;
    const result = (await send('/v1/inv/items/import', 'ItemCode,ItemName,ItemType,GroupCode,UomCode,PreferredVendorCode\r\nG-1,Globex item,service,SERVICES,EA,V3000\r\n', {}, globex)).body as MasterImportResult;
    assert.deepEqual(result.errors.map((error) => [error.row, error.column]), [[2, 'PreferredVendorCode']]);
    const own = (await send('/v1/bp/partners/import', 'BPCode,BPName,BPType\r\nC3000,Globex customer,customer\r\n', { mode: 'commit' }, globex)).body as MasterImportResult;
    assert.deepEqual([own.committed, own.created], [true, 1]);
  });
});
