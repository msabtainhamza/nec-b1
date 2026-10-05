import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type {
  Account,
  AdjustmentPreview,
  ApInvoice,
  Branch,
  GoodsReceipt,
  InventoryAdjustment,
  Item,
  ItemGroup,
  ItemStock,
  JournalEntry,
  PartnerGroup,
  PurchaseOrder,
  StockTransfer,
  UnitOfMeasure,
  Warehouse,
} from '@nec/contracts';
import { ACME, ACME_OWNER, bearer, GLOBEX, GLOBEX_OWNER, loginToTenant, setup, SHARED, type TestContext } from './helpers.js';

const YEAR = new Date().getUTCFullYear();
const day = (month: number, date: number) => `${YEAR}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;

describe('Stock transfers and adjustments', () => {
  let ctx: TestContext;
  let acme: string;
  let units: UnitOfMeasure[];
  let groups: ItemGroup[];
  let accounts: Account[];
  let wh1: string;
  let wh2: string;
  let wh3: string;
  let sequence = 0;

  const accountId = (code: string) => accounts.find((account) => account.code === code)?.id as string;

  const item = async () => {
    sequence += 1;
    const response = await ctx.http
      .post('/v1/inv/items')
      .set(bearer(acme))
      .send({ code: `ST-${sequence}`, name: `Stock item ${sequence}`, itemType: 'inventory', groupId: groups.find((g) => g.code === 'GENERAL')?.id, uomId: units.find((u) => u.code === 'EA')?.id });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body as Item;
  };

  const adjust = (direction: 'receipt' | 'issue', lines: Record<string, unknown>[], extra: Record<string, unknown> = {}, path = '/v1/inv/adjustments') =>
    ctx.http
      .post(path)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), direction, postingDate: day(6, 10), reason: 'Stock count difference', lines, ...extra });

  const receiveStock = async (itemId: string, quantity: string, unitCost: string, warehouseId = wh1) => {
    const response = await adjust('receipt', [{ itemId, warehouseId, quantity, unitCost }], { postingDate: day(6, 5) });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body as InventoryAdjustment;
  };

  const transfer = (fromWarehouseId: string, toWarehouseId: string, lines: { itemId: string; quantity: string }[], extra: Record<string, unknown> = {}) =>
    ctx.http
      .post('/v1/inv/transfers')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), fromWarehouseId, toWarehouseId, postingDate: day(6, 12), reason: 'Replenish branch', lines, ...extra });

  const cancel = (kind: 'transfers' | 'adjustments', id: string, postingDate = day(6, 20)) =>
    ctx.http.post(`/v1/inv/${kind}/${id}/cancel`).set(bearer(acme)).send({ idempotencyKey: randomUUID(), postingDate, reason: 'Posted in error' });

  const stock = async (itemId: string) => (await ctx.http.get(`/v1/inv/items/${itemId}/stock`).set(bearer(acme))).body as ItemStock;
  const inWarehouse = (state: ItemStock, warehouseId: string) => state.warehouses.find((row) => row.warehouseId === warehouseId)?.onHand ?? '0.0000';
  const journal = async (id: string | null) => {
    const entry = (await ctx.http.get(`/v1/fin/journal-entries/${id}`).set(bearer(acme))).body as JournalEntry;
    return entry.lines.map((line) => `${line.accountCode}:${line.debit}:${line.credit}`);
  };

  before(async () => {
    ctx = await setup();
    acme = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    units = (await ctx.http.get('/v1/inv/units').set(bearer(acme))).body;
    groups = (await ctx.http.get('/v1/inv/item-groups').set(bearer(acme))).body;
    accounts = (await ctx.http.get('/v1/fin/accounts').set(bearer(acme))).body;
    const branches = (await ctx.http.get('/v1/tenant/branches').set(bearer(acme))).body as Branch[];
    const branchInventory = await ctx.http
      .post('/v1/fin/accounts')
      .set(bearer(acme))
      .send({ code: '1310', name: 'Inventory - Second Branch', accountType: 'asset', parentId: accountId('11') });
    assert.equal(branchInventory.status, 201, JSON.stringify(branchInventory.body));
    const warehouses = (await ctx.http.get('/v1/inv/warehouses').set(bearer(acme))).body as Warehouse[];
    wh1 = warehouses.find((w) => w.code === 'WH01')?.id as string;
    const second = await ctx.http.post('/v1/inv/warehouses').set(bearer(acme)).send({ code: 'WH02', name: 'Overflow', branchId: branches[0]?.id });
    const third = await ctx.http.post('/v1/inv/warehouses').set(bearer(acme)).send({ code: 'WH03', name: 'Branch store', branchId: branches[0]?.id, inventoryAccountId: branchInventory.body.id });
    assert.equal(third.status, 201, JSON.stringify(third.body));
    wh2 = second.body.id;
    wh3 = third.body.id;
    accounts = (await ctx.http.get('/v1/fin/accounts').set(bearer(acme))).body;
  });

  after(async () => {
    await ctx.close();
  });

  it('previews a goods receipt without side effects, then posts it with the same valuation', async () => {
    const product = await item();
    const lines = [{ itemId: product.id, warehouseId: wh1, quantity: '10', unitCost: '5' }];
    const noCost = await adjust('receipt', [{ itemId: product.id, warehouseId: wh1, quantity: '1' }]);
    assert.equal(noCost.status, 400);
    const previewResponse = await adjust('receipt', lines, {}, '/v1/inv/adjustments/preview');
    assert.equal(previewResponse.status, 200, JSON.stringify(previewResponse.body));
    const preview = previewResponse.body as AdjustmentPreview;
    assert.equal(preview.adjustment.totalValue, '50.0000');
    assert.deepEqual(preview.journalLines.map((line) => `${line.accountCode}:${line.debit}:${line.credit}`), ['1300:50.0000:0.0000', '5200:0.0000:50.0000']);
    assert.deepEqual(preview.valuations[0], { itemCode: product.code, onHandBefore: '0.0000', onHandAfter: '10.0000', valueBefore: '0.0000', valueAfter: '50.0000', averageCostAfter: '5.000000' });
    assert.equal((await stock(product.id)).onHand, '0.0000');
    assert.equal((await ctx.http.get('/v1/inv/adjustments?direction=receipt').set(bearer(acme))).body.total, 0);

    const posted = await adjust('receipt', lines);
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    const adjustment = posted.body as InventoryAdjustment;
    assert.equal(adjustment.documentNumber, preview.adjustment.documentNumber);
    assert.deepEqual(await journal(adjustment.journalId), ['1300:50.0000:0.0000', '5200:0.0000:50.0000']);
    const state = await stock(product.id);
    assert.equal(state.onHand, '10.0000');
    assert.equal(state.averageCost, '5.000000');

    const atAverage = await adjust('receipt', [{ itemId: product.id, warehouseId: wh1, quantity: '2' }]);
    assert.equal(atAverage.status, 201, JSON.stringify(atAverage.body));
    assert.equal((atAverage.body as InventoryAdjustment).totalValue, '10.0000');
  });

  it('issues stock at moving average, leaves no residue and rejects over-issue', async () => {
    const product = await item();
    await receiveStock(product.id, '3', '3.3333');
    const unitCost = await adjust('issue', [{ itemId: product.id, warehouseId: wh1, quantity: '1', unitCost: '1' }]);
    assert.equal(unitCost.status, 400);
    const over = await adjust('issue', [{ itemId: product.id, warehouseId: wh1, quantity: '4' }]);
    assert.equal(over.status, 422);
    assert.equal(over.body.error.code, 'INSUFFICIENT_STOCK');
    const wrongWarehouse = await adjust('issue', [{ itemId: product.id, warehouseId: wh2, quantity: '1' }]);
    assert.equal(wrongWarehouse.status, 422);
    const first = await adjust('issue', [{ itemId: product.id, warehouseId: wh1, quantity: '1' }]);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const issued = first.body as InventoryAdjustment;
    assert.equal(issued.totalValue, '3.3333');
    assert.match(issued.documentNumber, /^SI/);
    assert.deepEqual(await journal(issued.journalId), ['5200:3.3333:0.0000', '1300:0.0000:3.3333']);
    const rest = await adjust('issue', [{ itemId: product.id, warehouseId: wh1, quantity: '2' }], { offsetAccountId: accountId('5400') });
    assert.equal(rest.status, 201, JSON.stringify(rest.body));
    assert.equal((rest.body as InventoryAdjustment).totalValue, '6.6666');
    assert.equal((rest.body as InventoryAdjustment).offsetAccountCode, '5400');
    const state = await stock(product.id);
    assert.equal(state.onHand, '0.0000');
    assert.equal(state.totalValue, '0.0000');
    const control = await adjust('receipt', [{ itemId: product.id, warehouseId: wh1, quantity: '1', unitCost: '1' }], { offsetAccountId: accountId('2100') });
    assert.equal(control.status, 400);
    const sameAccount = await adjust('receipt', [{ itemId: product.id, warehouseId: wh1, quantity: '1', unitCost: '1' }], { offsetAccountId: accountId('1300') });
    assert.equal(sameAccount.status, 400);
  });

  it('transfers between warehouses with paired movements and a journal only across inventory accounts', async () => {
    const product = await item();
    await receiveStock(product.id, '10', '4');
    assert.equal((await transfer(wh1, wh1, [{ itemId: product.id, quantity: '1' }])).status, 400);
    const tooMuch = await transfer(wh1, wh2, [{ itemId: product.id, quantity: '11' }]);
    assert.equal(tooMuch.status, 422);
    const key = randomUUID();
    const first = await transfer(wh1, wh2, [{ itemId: product.id, quantity: '6' }], { idempotencyKey: key });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const replay = await transfer(wh1, wh2, [{ itemId: product.id, quantity: '6' }], { idempotencyKey: key });
    assert.equal(replay.status, 200);
    const sameAccounts = first.body as StockTransfer;
    assert.equal(sameAccounts.journalId, null);
    assert.equal(sameAccounts.totalValue, '24.0000');
    let state = await stock(product.id);
    assert.equal(inWarehouse(state, wh1), '4.0000');
    assert.equal(inWarehouse(state, wh2), '6.0000');
    assert.equal(state.onHand, '10.0000');
    assert.equal(state.totalValue, '40.0000');

    const across = await transfer(wh2, wh3, [{ itemId: product.id, quantity: '2' }]);
    assert.equal(across.status, 201, JSON.stringify(across.body));
    assert.deepEqual(await journal((across.body as StockTransfer).journalId), ['1310:8.0000:0.0000', '1300:0.0000:8.0000']);
    state = await stock(product.id);
    assert.equal(inWarehouse(state, wh3), '2.0000');
    assert.equal(state.totalValue, '40.0000');
    const movements = (await ctx.http.get(`/v1/inv/stock-movements?itemId=${product.id}`).set(bearer(acme))).body.items as { sourceNumber: string | null }[];
    assert.ok(movements.every((movement) => movement.sourceNumber));
  });

  it('cancels transfers and adjustments exactly once and blocks them after later movements', async () => {
    const product = await item();
    const received = await receiveStock(product.id, '10', '2');
    const moved = (await transfer(wh1, wh3, [{ itemId: product.id, quantity: '5' }])).body as StockTransfer;
    const blocked = await cancel('adjustments', received.id);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'VALUATION_BLOCKED');
    const early = await cancel('transfers', moved.id, day(6, 11));
    assert.equal(early.status, 422);
    const attempts = await Promise.all([1, 2, 3].map(() => cancel('transfers', moved.id)));
    assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), [201, 409, 409]);
    const cancellation = attempts.find((attempt) => attempt.status === 201)?.body as StockTransfer;
    assert.equal(cancellation.cancellationOfId, moved.id);
    assert.deepEqual(await journal(cancellation.journalId), ['1310:0.0000:10.0000', '1300:10.0000:0.0000']);
    let state = await stock(product.id);
    assert.equal(inWarehouse(state, wh1), '10.0000');
    assert.equal(inWarehouse(state, wh3), '0.0000');
    assert.equal((await ctx.http.get(`/v1/inv/transfers/${moved.id}`).set(bearer(acme))).body.status, 'cancelled');
    assert.equal((await cancel('transfers', cancellation.id)).status, 409);

    assert.equal((await cancel('adjustments', received.id)).status, 409);

    const fresh = await item();
    const freshReceipt = await receiveStock(fresh.id, '10', '2');
    const cancelled = await cancel('adjustments', freshReceipt.id);
    assert.equal(cancelled.status, 201, JSON.stringify(cancelled.body));
    assert.deepEqual(await journal((cancelled.body as InventoryAdjustment).journalId), ['1300:0.0000:20.0000', '5200:20.0000:0.0000']);
    state = await stock(fresh.id);
    assert.equal(state.onHand, '0.0000');
    assert.equal(state.totalValue, '0.0000');
  });

  it('cancels a document holding two lines of the same item', async () => {
    const product = await item();
    const twoLines = await adjust('receipt', [
      { itemId: product.id, warehouseId: wh1, quantity: '2', unitCost: '1' },
      { itemId: product.id, warehouseId: wh2, quantity: '3', unitCost: '2' },
    ]);
    assert.equal(twoLines.status, 201, JSON.stringify(twoLines.body));
    assert.equal((await cancel('adjustments', twoLines.body.id)).status, 201);

    sequence += 1;
    const groupsBp = (await ctx.http.get('/v1/bp/groups').set(bearer(acme))).body as PartnerGroup[];
    const vendor = await ctx.http.post('/v1/bp/partners').set(bearer(acme)).send({ code: `ST-V${sequence}`, partnerType: 'supplier', name: 'Stock vendor', groupId: groupsBp.find((g) => g.partnerType === 'supplier')?.id });
    const po = (
      await ctx.http
        .post('/v1/pur/orders')
        .set(bearer(acme))
        .send({ idempotencyKey: randomUUID(), vendorId: vendor.body.id, postingDate: day(6, 1), deliveryDate: day(6, 5), lines: [{ itemId: product.id, quantity: '1', unitPrice: '1' }, { itemId: product.id, quantity: '2', unitPrice: '1' }] })
    ).body as PurchaseOrder;
    const receipt = await ctx.http
      .post('/v1/pur/receipts')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), orderId: po.id, postingDate: day(6, 6), lines: po.lines.map((line) => ({ orderLineId: line.id, quantity: line.quantity })) });
    assert.equal(receipt.status, 201, JSON.stringify(receipt.body));
    const cancelReceipt = await ctx.http.post(`/v1/pur/receipts/${receipt.body.id}/cancel`).set(bearer(acme)).send({ idempotencyKey: randomUUID(), postingDate: day(6, 7), reason: 'Duplicate' });
    assert.equal(cancelReceipt.status, 201, JSON.stringify(cancelReceipt.body));
  });

  it('blocks receipt reversal after an issue (scenario 17) and splits invoice price differences by stock on hand', async () => {
    const product = await item();
    const groupsBp = (await ctx.http.get('/v1/bp/groups').set(bearer(acme))).body as PartnerGroup[];
    const vendor = await ctx.http.post('/v1/bp/partners').set(bearer(acme)).send({ code: 'ST-V-SPLIT', partnerType: 'supplier', name: 'Split vendor', groupId: groupsBp.find((g) => g.partnerType === 'supplier')?.id });
    const po = (
      await ctx.http
        .post('/v1/pur/orders')
        .set(bearer(acme))
        .send({ idempotencyKey: randomUUID(), vendorId: vendor.body.id, postingDate: day(6, 1), deliveryDate: day(6, 5), lines: [{ itemId: product.id, quantity: '10', unitPrice: '5' }] })
    ).body as PurchaseOrder;
    const receipt = (
      await ctx.http
        .post('/v1/pur/receipts')
        .set(bearer(acme))
        .send({ idempotencyKey: randomUUID(), orderId: po.id, postingDate: day(6, 3), lines: [{ orderLineId: po.lines[0]?.id, quantity: '10' }] })
    ).body as GoodsReceipt;
    const issue = await adjust('issue', [{ itemId: product.id, warehouseId: wh1, quantity: '6' }], { postingDate: day(6, 4) });
    assert.equal(issue.status, 201, JSON.stringify(issue.body));
    const reverse = await ctx.http.post(`/v1/pur/receipts/${receipt.id}/cancel`).set(bearer(acme)).send({ idempotencyKey: randomUUID(), postingDate: day(6, 8), reason: 'Wrong receipt' });
    assert.equal(reverse.status, 409);
    assert.equal(reverse.body.error.code, 'VALUATION_BLOCKED');

    const invoice = await ctx.http
      .post('/v1/pur/invoices')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), vendorId: vendor.body.id, postingDate: day(6, 9), priceOverride: true, lines: [{ receiptLineId: receipt.lines[0]?.id, quantity: '10', unitPrice: '6' }] });
    assert.equal(invoice.status, 201, JSON.stringify(invoice.body));
    const posted = invoice.body as ApInvoice;
    assert.equal(posted.lines[0]?.stockRevaluation, '4.0000');
    assert.equal(posted.lines[0]?.priceDifference, '6.0000');
    assert.deepEqual((await journal(posted.journalId)).sort(), ['1300:4.0000:0.0000', '2100:0.0000:60.0000', '2150:50.0000:0.0000', '5300:6.0000:0.0000'].sort());
    const state = await stock(product.id);
    assert.equal(state.onHand, '4.0000');
    assert.equal(state.totalValue, '24.0000');
    assert.equal(state.averageCost, '6.000000');
  });

  it('rejects closed periods, enforces permissions and isolates tenants', async () => {
    const product = await item();
    const received = await receiveStock(product.id, '1', '1');
    const globex = (await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX)).token;
    assert.equal((await ctx.http.get(`/v1/inv/adjustments/${received.id}`).set(bearer(globex))).status, 404);
    assert.equal((await ctx.http.post(`/v1/inv/adjustments/${received.id}/cancel`).set(bearer(globex)).send({ idempotencyKey: randomUUID(), postingDate: day(6, 20), reason: 'x' })).status, 404);
    const globexWarehouses = (await ctx.http.get('/v1/inv/warehouses').set(bearer(globex))).body as Warehouse[];
    const cross = await ctx.http
      .post('/v1/inv/transfers')
      .set(bearer(globex))
      .send({ idempotencyKey: randomUUID(), fromWarehouseId: wh1, toWarehouseId: globexWarehouses[0]?.id, postingDate: day(6, 12), reason: 'Cross tenant', lines: [{ itemId: product.id, quantity: '1' }] });
    assert.equal(cross.status, 400);
    const auditor = await loginToTenant(ctx, SHARED, GLOBEX);
    assert.equal((await ctx.http.post('/v1/inv/transfers').set(bearer(auditor.token)).send({})).status, 403);
    assert.equal((await ctx.http.post('/v1/inv/adjustments/preview').set(bearer(auditor.token)).send({})).status, 403);
    assert.equal((await ctx.http.get('/v1/inv/adjustments').set(bearer(auditor.token))).status, 200);
    const periods = (await ctx.http.get('/v1/fin/periods').set(bearer(acme))).body as { id: string; code: string; version: number }[];
    const october = periods.find((period) => period.code === `${YEAR}-10`) as { id: string; version: number };
    await ctx.http.patch(`/v1/fin/periods/${october.id}/status`).set(bearer(acme)).send({ status: 'closed', version: october.version, reason: 'Test' });
    const closed = await transfer(wh1, wh2, [{ itemId: product.id, quantity: '1' }], { postingDate: day(10, 2) });
    assert.equal(closed.status, 422);
    assert.equal(closed.body.error.code, 'PERIOD_CLOSED');
  });
});
