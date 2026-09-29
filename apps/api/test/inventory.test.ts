import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Account, Branch, Item, ItemGroup, PartnerGroup, PriceList, UnitOfMeasure, Warehouse } from '@nec/contracts';
import { ACME, ACME_OWNER, bearer, GLOBEX, GLOBEX_OWNER, loginToTenant, setup, SHARED, type TestContext } from './helpers.js';

describe('inventory master data', () => {
  let ctx: TestContext;
  let acme: string;
  let globex: string;
  let units: UnitOfMeasure[];
  let groups: ItemGroup[];
  let warehouses: Warehouse[];
  let lists: PriceList[];

  const unit = (code: string) => units.find((row) => row.code === code)?.id ?? '';
  const group = (code: string) => groups.find((row) => row.code === code)?.id ?? '';
  const list = (code: string) => lists.find((row) => row.code === code)?.id ?? '';

  const item = (code: string, extra: Record<string, unknown> = {}) => ({
    code,
    name: `Item ${code}`,
    itemType: 'inventory',
    groupId: group('GENERAL'),
    uomId: unit('EA'),
    defaultWarehouseId: warehouses[0]?.id,
    reorderPoint: '10',
    prices: [
      { priceListId: list('SALES'), price: '12.50' },
      { priceListId: list('PURCHASE'), price: '8.00' },
    ],
    ...extra,
  });

  before(async () => {
    ctx = await setup();
    acme = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    globex = (await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX)).token;
    units = (await ctx.http.get('/v1/inv/units').set(bearer(acme))).body;
    groups = (await ctx.http.get('/v1/inv/item-groups').set(bearer(acme))).body;
    warehouses = (await ctx.http.get('/v1/inv/warehouses').set(bearer(acme))).body;
    lists = (await ctx.http.get('/v1/inv/price-lists').set(bearer(acme))).body;
  });

  after(async () => {
    await ctx.close();
  });

  it('provisions default units, groups, a branch warehouse and price lists', () => {
    assert.deepEqual(units.map((row) => row.code), ['BOX', 'EA', 'KG', 'L']);
    assert.deepEqual(groups.map((row) => row.code).sort(), ['GENERAL', 'SERVICES']);
    assert.equal(warehouses.length, 1);
    assert.equal(warehouses[0]?.code, 'WH01');
    assert.equal(warehouses[0]?.isBranchDefault, true);
    assert.deepEqual(lists.map((row) => `${row.code}:${row.purpose}:${row.isDefault}`), ['SALES:sales:true', 'PURCHASE:purchase:true']);
  });

  it('creates an inventory item with prices and reads it back', async () => {
    const response = await ctx.http.post('/v1/inv/items').set(bearer(acme)).send(item('A-100', { barcode: '5000000000017' }));
    assert.equal(response.status, 201);
    const created = response.body as Item;
    assert.equal(created.itemType, 'inventory');
    assert.equal(created.reorderPoint, '10.0000');
    assert.equal(created.prices.length, 2);
    const salesList = await ctx.http.get(`/v1/inv/price-lists/${list('SALES')}/prices?search=A-100`).set(bearer(acme));
    assert.equal(salesList.body.items[0].price, '12.5000');
    const search = await ctx.http.get('/v1/inv/items?search=5000000000017').set(bearer(acme));
    assert.equal(search.body.total, 1);
  });

  it('keeps item codes and barcodes unique per tenant only', async () => {
    const duplicate = await ctx.http.post('/v1/inv/items').set(bearer(acme)).send(item('A-100'));
    assert.equal(duplicate.status, 409);
    const barcode = await ctx.http.post('/v1/inv/items').set(bearer(acme)).send(item('A-101', { barcode: '5000000000017' }));
    assert.equal(barcode.status, 409);
    const globexUnits = (await ctx.http.get('/v1/inv/units').set(bearer(globex))).body as UnitOfMeasure[];
    const globexGroups = (await ctx.http.get('/v1/inv/item-groups').set(bearer(globex))).body as ItemGroup[];
    const sameCode = await ctx.http
      .post('/v1/inv/items')
      .set(bearer(globex))
      .send({ code: 'A-100', name: 'Globex item', itemType: 'service', groupId: globexGroups[0]?.id, uomId: globexUnits[0]?.id });
    assert.equal(sameCode.status, 201);
  });

  it('enforces item type rules, unit decimals and tenant ownership of references', async () => {
    const serviceWithStock = await ctx.http
      .post('/v1/inv/items')
      .set(bearer(acme))
      .send(item('S-1', { itemType: 'service', groupId: group('SERVICES') }));
    assert.equal(serviceWithStock.status, 400);
    const service = await ctx.http
      .post('/v1/inv/items')
      .set(bearer(acme))
      .send(item('S-1', { itemType: 'service', groupId: group('SERVICES'), defaultWarehouseId: null, reorderPoint: null, isPurchaseItem: false }));
    assert.equal(service.status, 201);
    const neither = await ctx.http.post('/v1/inv/items').set(bearer(acme)).send(item('N-1', { isSalesItem: false, isPurchaseItem: false }));
    assert.equal(neither.status, 400);
    const decimals = await ctx.http.post('/v1/inv/items').set(bearer(acme)).send(item('D-1', { reorderPoint: '1.5' }));
    assert.equal(decimals.status, 400);
    assert.equal(decimals.body.error.details[0].path, 'reorderPoint');
    const kg = await ctx.http.post('/v1/inv/items').set(bearer(acme)).send(item('D-2', { uomId: unit('KG'), reorderPoint: '1.250' }));
    assert.equal(kg.status, 201);
    const globexWarehouses = (await ctx.http.get('/v1/inv/warehouses').set(bearer(globex))).body as Warehouse[];
    const foreignWarehouse = await ctx.http.post('/v1/inv/items').set(bearer(acme)).send(item('F-1', { defaultWarehouseId: globexWarehouses[0]?.id }));
    assert.equal(foreignWarehouse.status, 400);
    const globexLists = (await ctx.http.get('/v1/inv/price-lists').set(bearer(globex))).body as PriceList[];
    const foreignPrice = await ctx.http
      .post('/v1/inv/items')
      .set(bearer(acme))
      .send(item('F-2', { prices: [{ priceListId: globexLists[0]?.id, price: '1' }] }));
    assert.equal(foreignPrice.status, 400);
    const customerAsVendor = await ctx.http.get('/v1/bp/groups').set(bearer(acme));
    const customer = await ctx.http
      .post('/v1/bp/partners')
      .set(bearer(acme))
      .send({ code: 'IC1', partnerType: 'customer', name: 'Not a vendor', groupId: (customerAsVendor.body as PartnerGroup[]).find((g) => g.partnerType === 'customer')?.id });
    const wrongVendor = await ctx.http.post('/v1/inv/items').set(bearer(acme)).send(item('F-3', { preferredVendorId: customer.body.id }));
    assert.equal(wrongVendor.status, 400);
  });

  it('updates items with versioning and removes prices that are no longer listed', async () => {
    const created = (await ctx.http.post('/v1/inv/items').set(bearer(acme)).send(item('U-1'))).body as Item;
    const { code: _code, ...fields } = item('U-1');
    const updated = await ctx.http
      .put(`/v1/inv/items/${created.id}`)
      .set(bearer(acme))
      .send({ ...fields, version: 1, name: 'Renamed item', prices: [{ priceListId: list('SALES'), price: '15' }] });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, 'Renamed item');
    assert.deepEqual((updated.body as Item).prices.map((row) => row.price), ['15.0000']);
    const stale = await ctx.http.put(`/v1/inv/items/${created.id}`).set(bearer(acme)).send({ ...fields, version: 1 });
    assert.equal(stale.status, 409);
    const cross = await ctx.http.get(`/v1/inv/items/${created.id}`).set(bearer(globex));
    assert.equal(cross.status, 404);
  });

  it('manages warehouses per branch and protects default warehouses', async () => {
    const branches = (await ctx.http.get('/v1/tenant/branches').set(bearer(acme))).body as Branch[];
    const accounts = (await ctx.http.get('/v1/fin/accounts').set(bearer(acme))).body as Account[];
    const created = await ctx.http
      .post('/v1/inv/warehouses')
      .set(bearer(acme))
      .send({ code: 'WH02', name: 'Second Warehouse', branchId: branches.find((b) => b.code === 'WH1')?.id, inventoryAccountId: accounts.find((a) => a.code === '1300')?.id });
    assert.equal(created.status, 201);
    assert.equal(created.body.isBranchDefault, true);
    const wrongAccount = await ctx.http
      .post('/v1/inv/warehouses')
      .set(bearer(acme))
      .send({ code: 'WH03', name: 'Bad account', branchId: branches[0]?.id, inventoryAccountId: accounts.find((a) => a.code === '4100')?.id });
    assert.equal(wrongAccount.status, 400);
    const defaultWh = warehouses[0] as Warehouse;
    const deactivate = await ctx.http
      .put(`/v1/inv/warehouses/${defaultWh.id}`)
      .set(bearer(acme))
      .send({ version: defaultWh.version, name: defaultWh.name, status: 'inactive' });
    assert.equal(deactivate.status, 409);
  });

  it('validates item group accounts and price list rules', async () => {
    const accounts = (await ctx.http.get('/v1/fin/accounts').set(bearer(acme))).body as Account[];
    const good = await ctx.http
      .post('/v1/inv/item-groups')
      .set(bearer(acme))
      .send({ code: 'BEVERAGE', name: 'Beverages', inventoryAccountId: accounts.find((a) => a.code === '1300')?.id, cogsAccountId: accounts.find((a) => a.code === '5100')?.id });
    assert.equal(good.status, 201);
    const bad = await ctx.http
      .post('/v1/inv/item-groups')
      .set(bearer(acme))
      .send({ code: 'BAD', name: 'Bad', revenueAccountId: accounts.find((a) => a.code === '1200')?.id });
    assert.equal(bad.status, 400);
    const wholesale = await ctx.http
      .post('/v1/inv/price-lists')
      .set(bearer(acme))
      .send({ code: 'WHOLESALE', name: 'Wholesale', purpose: 'sales', validFrom: '2026-01-01', validTo: '2026-12-31' });
    assert.equal(wholesale.status, 201);
    assert.equal(wholesale.body.currency, 'USD');
    const backwards = await ctx.http
      .post('/v1/inv/price-lists')
      .set(bearer(acme))
      .send({ code: 'BACK', name: 'Backwards', purpose: 'sales', validFrom: '2026-12-31', validTo: '2026-01-01' });
    assert.equal(backwards.status, 400);
    const items = (await ctx.http.get('/v1/inv/items?limit=5').set(bearer(acme))).body.items as { id: string }[];
    const setPrices = await ctx.http
      .put(`/v1/inv/price-lists/${wholesale.body.id}/prices`)
      .set(bearer(acme))
      .send({ prices: items.map((row) => ({ itemId: row.id, price: '9.99' })) });
    assert.equal(setPrices.status, 204);
    const entries = await ctx.http.get(`/v1/inv/price-lists/${wholesale.body.id}/prices`).set(bearer(acme));
    assert.equal((entries.body.items as { price: string | null }[]).filter((row) => row.price === '9.9900').length, items.length);
    const defaultList = lists.find((row) => row.code === 'SALES') as PriceList;
    const deactivateDefault = await ctx.http
      .put(`/v1/inv/price-lists/${defaultList.id}`)
      .set(bearer(acme))
      .send({ version: defaultList.version, name: defaultList.name, status: 'inactive' });
    assert.equal(deactivateDefault.status, 409);
  });

  it('lets auditors read items but not change them', async () => {
    const auditor = await loginToTenant(ctx, SHARED, GLOBEX);
    const read = await ctx.http.get('/v1/inv/items').set(bearer(auditor.token));
    assert.equal(read.status, 200);
    const write = await ctx.http.post('/v1/inv/units').set(bearer(auditor.token)).send({ code: 'PCS', name: 'Pieces' });
    assert.equal(write.status, 403);
  });
});
