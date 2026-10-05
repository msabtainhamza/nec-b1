import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Account, Branch, InventoryStatusReport, InventoryValuationReport, Item, ItemGroup, PartnerGroup, UnitOfMeasure, Warehouse } from '@nec/contracts';
import { ACME, ACME_OWNER, bearer, GLOBEX, GLOBEX_OWNER, loginToTenant, setup, type TestContext } from './helpers.js';

const YEAR = new Date().getUTCFullYear();
const day = (month: number, date: number) => `${YEAR}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;

describe('Inventory reports', () => {
  let ctx: TestContext;
  let acme: string;
  let product: Item;
  let wh1: string;
  let wh2: string;
  let accounts: Account[];

  const post = (path: string, body: object) => ctx.http.post(path).set(bearer(acme)).send(body);
  const status = async (query = '') => {
    const response = await ctx.http.get(`/v1/inv/reports/inventory-status${query}`).set(bearer(acme));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body as InventoryStatusReport;
  };
  const valuation = async (query: string, token = acme) => {
    const response = await ctx.http.get(`/v1/inv/reports/inventory-valuation${query}`).set(bearer(token));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body as InventoryValuationReport;
  };

  before(async () => {
    ctx = await setup();
    acme = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    const groups = (await ctx.http.get('/v1/inv/item-groups').set(bearer(acme))).body as ItemGroup[];
    const units = (await ctx.http.get('/v1/inv/units').set(bearer(acme))).body as UnitOfMeasure[];
    const branches = (await ctx.http.get('/v1/tenant/branches').set(bearer(acme))).body as Branch[];
    wh1 = ((await ctx.http.get('/v1/inv/warehouses').set(bearer(acme))).body as Warehouse[]).find((w) => w.code === 'WH01')?.id as string;
    const second = await post('/v1/inv/warehouses', { code: 'WH-REP', name: 'Report warehouse', branchId: branches[0]?.id });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    wh2 = second.body.id;
    const created = await post('/v1/inv/items', { code: 'REP-1', name: 'Report item', itemType: 'inventory', groupId: groups.find((g) => g.code === 'GENERAL')?.id, uomId: units.find((u) => u.code === 'EA')?.id, reorderPoint: '10' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    product = created.body as Item;
    accounts = (await ctx.http.get('/v1/fin/accounts').set(bearer(acme))).body as Account[];
  });

  after(async () => {
    await ctx.close();
  });

  it('shows on hand, committed, ordered and available per warehouse and flags items at or below the reorder point', async () => {
    assert.equal((await post('/v1/inv/adjustments', { idempotencyKey: randomUUID(), direction: 'receipt', postingDate: day(3, 1), reason: 'Stock', lines: [{ itemId: product.id, warehouseId: wh1, quantity: '8', unitCost: '5' }] })).status, 201);
    assert.equal((await post('/v1/inv/transfers', { idempotencyKey: randomUUID(), postingDate: day(3, 2), fromWarehouseId: wh1, toWarehouseId: wh2, reason: 'Move', lines: [{ itemId: product.id, quantity: '3' }] })).status, 201);
    const bpGroups = (await ctx.http.get('/v1/bp/groups').set(bearer(acme))).body as PartnerGroup[];
    const customer = await post('/v1/bp/partners', { code: 'REP-C', partnerType: 'customer', name: 'Report customer', groupId: bpGroups.find((g) => g.partnerType === 'customer')?.id });
    const vendor = await post('/v1/bp/partners', { code: 'REP-V', partnerType: 'supplier', name: 'Report vendor', groupId: bpGroups.find((g) => g.partnerType === 'supplier')?.id });
    assert.equal((await post('/v1/sal/orders', { idempotencyKey: randomUUID(), customerId: customer.body.id, postingDate: day(3, 3), deliveryDate: day(3, 3), lines: [{ itemId: product.id, quantity: '2', unitPrice: '9', warehouseId: wh1 }] })).status, 201);
    assert.equal((await post('/v1/pur/orders', { idempotencyKey: randomUUID(), vendorId: vendor.body.id, postingDate: day(3, 3), deliveryDate: day(3, 9), lines: [{ itemId: product.id, quantity: '4', unitPrice: '5', warehouseId: wh2 }] })).status, 201);

    const report = await status();
    const row = report.items.find((item) => item.itemCode === 'REP-1');
    assert.ok(row);
    assert.deepEqual(
      { onHand: row.onHand, committed: row.committed, ordered: row.ordered, available: row.available, reorderPoint: row.reorderPoint, below: row.belowReorderPoint },
      { onHand: '8.0000', committed: '2.0000', ordered: '4.0000', available: '10.0000', reorderPoint: '10.0000', below: true },
    );
    assert.deepEqual(
      row.warehouses.map((w) => [w.warehouseCode, w.onHand, w.committed, w.ordered, w.available]),
      [
        ['WH-REP', '3.0000', '0.0000', '4.0000', '7.0000'],
        ['WH01', '5.0000', '2.0000', '0.0000', '3.0000'],
      ],
    );
    assert.deepEqual((await status('?belowReorderPoint=true')).items.map((item) => item.itemCode), ['REP-1']);
    const onlyWh1 = (await status(`?warehouseId=${wh1}&search=rep-1`)).items[0];
    assert.equal(onlyWh1?.available, '3.0000');
    assert.equal(onlyWh1?.warehouses.length, 1);
    assert.equal((await ctx.http.get('/v1/inv/reports/inventory-status?belowReorderPoint=maybe').set(bearer(acme))).status, 400);
  });

  it('values stock as of a date and reconciles each inventory account to the general ledger', async () => {
    const before = await valuation(`?asOf=${day(2, 28)}`);
    assert.deepEqual(before.rows, []);
    const report = await valuation(`?asOf=${day(3, 31)}`);
    assert.deepEqual(
      report.rows.map((row) => [row.itemCode, row.warehouseCode, row.accountCode, row.quantity, row.value, row.averageCost]),
      [
        ['REP-1', 'WH-REP', '1300', '3.0000', '15.0000', '5.000000'],
        ['REP-1', 'WH01', '1300', '5.0000', '25.0000', '5.000000'],
      ],
    );
    assert.equal(report.totalValue, '40.0000');
    const inventory = report.accounts.find((account) => account.accountCode === '1300');
    assert.deepEqual(inventory && [inventory.stockValue, inventory.ledgerBalance, inventory.difference], ['40.0000', '40.0000', '0.0000']);

    const account = (code: string) => accounts.find((row) => row.code === code)?.id;
    const manual = await post('/v1/fin/journal-entries', { idempotencyKey: randomUUID(), postingDate: day(3, 20), memo: 'Direct inventory posting', lines: [{ accountId: account('1300'), debit: '7' }, { accountId: account('1100'), credit: '7' }] });
    assert.equal(manual.status, 201, JSON.stringify(manual.body));
    const after = (await valuation(`?asOf=${day(3, 31)}`)).accounts.find((row) => row.accountCode === '1300');
    assert.deepEqual(after && [after.stockValue, after.ledgerBalance, after.difference], ['40.0000', '47.0000', '7.0000']);
    const earlier = (await valuation(`?asOf=${day(3, 15)}`)).accounts.find((row) => row.accountCode === '1300');
    assert.equal(earlier?.difference, '0.0000');

    const filtered = await valuation(`?asOf=${day(3, 31)}&warehouseId=${wh2}`);
    assert.equal(filtered.filtered, true);
    assert.deepEqual(filtered.accounts, []);
    assert.equal(filtered.totalValue, '15.0000');

    const globex = (await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX)).token;
    assert.deepEqual((await valuation(`?asOf=${day(3, 31)}`, globex)).rows, []);
    assert.equal((await ctx.http.get('/v1/inv/reports/inventory-valuation').set(bearer(acme))).status, 400);
  });
});
