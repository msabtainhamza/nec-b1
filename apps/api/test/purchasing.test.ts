import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type {
  Account,
  GoodsReceipt,
  Item,
  ItemGroup,
  ItemStock,
  JournalEntry,
  PartnerGroup,
  PostingPeriod,
  PurchaseOrder,
  TrialBalance,
  UnitOfMeasure,
  Warehouse,
} from '@nec/contracts';
import { ACME, ACME_OWNER, bearer, GLOBEX, GLOBEX_OWNER, loginToTenant, setup, SHARED, type TestContext } from './helpers.js';

const YEAR = new Date().getUTCFullYear();
const day = (month: number, date: number) => `${YEAR}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;

describe('purchasing and stock ledger', () => {
  let ctx: TestContext;
  let acme: string;
  let vendorId: string;
  let units: UnitOfMeasure[];
  let groups: ItemGroup[];
  let warehouse: Warehouse;
  let accounts: Account[];
  let sequence = 0;

  const newItem = async (itemType: 'inventory' | 'service' = 'inventory') => {
    sequence += 1;
    const response = await ctx.http
      .post('/v1/inv/items')
      .set(bearer(acme))
      .send({
        code: `P-${itemType}-${sequence}`,
        name: `Purchased ${itemType} ${sequence}`,
        itemType,
        groupId: groups.find((g) => g.code === (itemType === 'service' ? 'SERVICES' : 'GENERAL'))?.id,
        uomId: units.find((u) => u.code === 'EA')?.id,
        defaultWarehouseId: itemType === 'inventory' ? warehouse.id : null,
      });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body as Item;
  };

  const order = async (lines: { itemId: string; quantity: string; unitPrice: string; discountPercent?: string }[], postingDate = day(4, 1)) => {
    const response = await ctx.http
      .post('/v1/pur/orders')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), vendorId, postingDate, deliveryDate: day(4, 10), lines });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body as PurchaseOrder;
  };

  const receive = (po: PurchaseOrder, quantities: Record<string, string>, extra: Record<string, unknown> = {}) =>
    ctx.http
      .post('/v1/pur/receipts')
      .set(bearer(acme))
      .send({
        idempotencyKey: randomUUID(),
        orderId: po.id,
        postingDate: day(4, 5),
        lines: Object.entries(quantities).map(([lineNo, quantity]) => ({ orderLineId: po.lines[Number(lineNo) - 1]?.id, quantity })),
        ...extra,
      });

  const stock = async (itemId: string) => (await ctx.http.get(`/v1/inv/items/${itemId}/stock`).set(bearer(acme))).body as ItemStock;

  const cancel = (receiptId: string, postingDate = day(4, 6)) =>
    ctx.http.post(`/v1/pur/receipts/${receiptId}/cancel`).set(bearer(acme)).send({ idempotencyKey: randomUUID(), postingDate, reason: 'Received in error' });

  before(async () => {
    ctx = await setup();
    acme = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    const bpGroups = (await ctx.http.get('/v1/bp/groups').set(bearer(acme))).body as PartnerGroup[];
    const vendor = await ctx.http
      .post('/v1/bp/partners')
      .set(bearer(acme))
      .send({ code: 'V-PUR', partnerType: 'supplier', name: 'Purchasing Vendor', groupId: bpGroups.find((g) => g.partnerType === 'supplier')?.id });
    vendorId = vendor.body.id;
    units = (await ctx.http.get('/v1/inv/units').set(bearer(acme))).body;
    groups = (await ctx.http.get('/v1/inv/item-groups').set(bearer(acme))).body;
    warehouse = ((await ctx.http.get('/v1/inv/warehouses').set(bearer(acme))).body as Warehouse[])[0] as Warehouse;
    accounts = (await ctx.http.get('/v1/fin/accounts').set(bearer(acme))).body;
  });

  after(async () => {
    await ctx.close();
  });

  it('receives an order of ten in two partial receipts without duplicating stock (scenario 4)', async () => {
    const item = await newItem();
    const po = await order([{ itemId: item.id, quantity: '10', unitPrice: '5' }]);
    assert.equal(po.documentNumber, 'PO1');
    assert.equal(po.lines[0]?.warehouseCode, warehouse.code);
    const first = await receive(po, { 1: '6' });
    assert.equal(first.status, 201);
    assert.equal((await stock(item.id)).onHand, '6.0000');
    assert.equal((await stock(item.id)).onOrder, '4.0000');
    const secondBody = {
      idempotencyKey: randomUUID(),
      orderId: po.id,
      postingDate: day(4, 6),
      lines: [{ orderLineId: po.lines[0]?.id, quantity: '4' }],
    };
    const second = await ctx.http.post('/v1/pur/receipts').set(bearer(acme)).send(secondBody);
    const duplicate = await ctx.http.post('/v1/pur/receipts').set(bearer(acme)).send(secondBody);
    assert.equal(second.status, 201);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.id, second.body.id);
    const after = await stock(item.id);
    assert.equal(after.onHand, '10.0000');
    assert.equal(after.onOrder, '0.0000');
    assert.equal(after.totalValue, '50.0000');
    const reloaded = (await ctx.http.get(`/v1/pur/orders/${po.id}`).set(bearer(acme))).body as PurchaseOrder;
    assert.equal(reloaded.status, 'closed');
    assert.equal(reloaded.closedReason, 'fully_received');
    assert.equal(reloaded.lines[0]?.openQuantity, '0.0000');
    const more = await receive(po, { 1: '1' });
    assert.equal(more.status, 409);
  });

  it('rejects over-receipts and keeps service lines out of stock', async () => {
    const item = await newItem();
    const service = await newItem('service');
    const po = await order([
      { itemId: item.id, quantity: '5', unitPrice: '2' },
      { itemId: service.id, quantity: '1', unitPrice: '100' },
    ]);
    const over = await receive(po, { 1: '6' });
    assert.equal(over.status, 422);
    assert.equal(over.body.error.code, 'OVER_RECEIPT');
    const ok = await receive(po, { 1: '5', 2: '1' });
    assert.equal(ok.status, 201);
    const receipt = ok.body as GoodsReceipt;
    assert.equal(receipt.lines[1]?.warehouseId, null);
    const journal = (await ctx.http.get(`/v1/fin/journal-entries/${receipt.journalId}`).set(bearer(acme))).body as JournalEntry;
    assert.equal(journal.sourceType, 'goods_receipt');
    assert.equal(journal.totalDebit, '10.0000');
    assert.deepEqual(
      journal.lines.map((line) => `${line.accountCode}:${line.debit}:${line.credit}`),
      ['1300:10.0000:0.0000', '2150:0.0000:10.0000'],
    );
    const serviceStock = await stock(service.id);
    assert.equal(serviceStock.onHand, '0.0000');
  });

  it('applies discounts with declared rounding', async () => {
    const item = await newItem();
    const po = await order([{ itemId: item.id, quantity: '3', unitPrice: '9.99', discountPercent: '10' }]);
    assert.equal(po.lines[0]?.netPrice, '8.9910');
    assert.equal(po.lines[0]?.lineTotal, '26.9730');
    assert.equal(po.total, '26.9730');
  });

  it('maintains a moving average cost across receipts at different prices', async () => {
    const item = await newItem();
    const cheap = await order([{ itemId: item.id, quantity: '10', unitPrice: '5' }]);
    const dear = await order([{ itemId: item.id, quantity: '10', unitPrice: '7' }]);
    assert.equal((await receive(cheap, { 1: '10' })).status, 201);
    assert.equal((await receive(dear, { 1: '10' })).status, 201);
    const valuation = await stock(item.id);
    assert.equal(valuation.onHand, '20.0000');
    assert.equal(valuation.totalValue, '120.0000');
    assert.equal(valuation.averageCost, '6.000000');
  });

  it('cancels the latest receipt, restoring stock, value, order quantities and the ledger', async () => {
    const item = await newItem();
    const po = await order([{ itemId: item.id, quantity: '10', unitPrice: '5' }]);
    const receipt = (await receive(po, { 1: '10' })).body as GoodsReceipt;
    const closed = (await ctx.http.get(`/v1/pur/orders/${po.id}`).set(bearer(acme))).body as PurchaseOrder;
    assert.equal(closed.status, 'closed');
    const early = await cancel(receipt.id, day(4, 1));
    assert.equal(early.status, 422);
    const responses = await Promise.all([cancel(receipt.id), cancel(receipt.id), cancel(receipt.id)]);
    const succeeded = responses.filter((response) => response.status === 201);
    assert.equal(succeeded.length, 1);
    assert.ok(responses.filter((response) => response.status !== 201).every((response) => response.status === 409));
    const cancellation = succeeded[0]?.body as GoodsReceipt;
    assert.equal(cancellation.isCancellation, true);
    assert.equal(cancellation.cancellationOfId, receipt.id);
    const original = (await ctx.http.get(`/v1/pur/receipts/${receipt.id}`).set(bearer(acme))).body as GoodsReceipt;
    assert.equal(original.status, 'cancelled');
    assert.equal(original.cancelledById, cancellation.id);
    const valuation = await stock(item.id);
    assert.equal(valuation.onHand, '0.0000');
    assert.equal(valuation.totalValue, '0.0000');
    const reopened = (await ctx.http.get(`/v1/pur/orders/${po.id}`).set(bearer(acme))).body as PurchaseOrder;
    assert.equal(reopened.status, 'open');
    assert.equal(reopened.lines[0]?.openQuantity, '10.0000');
    const cancellationJournal = (await ctx.http.get(`/v1/fin/journal-entries/${cancellation.journalId}`).set(bearer(acme))).body as JournalEntry;
    assert.deepEqual(
      cancellationJournal.lines.map((line) => `${line.accountCode}:${line.debit}:${line.credit}`),
      ['1300:0.0000:50.0000', '2150:50.0000:0.0000'],
    );
    const again = await cancel(receipt.id);
    assert.equal(again.status, 409);
    const cancelCancellation = await cancel(cancellation.id);
    assert.equal(cancelCancellation.status, 409);
    const movements = await ctx.http.get(`/v1/inv/stock-movements?itemId=${item.id}`).set(bearer(acme));
    assert.deepEqual((movements.body.items as { quantity: string }[]).map((row) => row.quantity).sort(), ['-10.0000', '10.0000']);
  });

  it('blocks automatic reversal when later stock transactions exist (REV-04)', async () => {
    const item = await newItem();
    const po = await order([{ itemId: item.id, quantity: '20', unitPrice: '4' }]);
    const first = (await receive(po, { 1: '10' })).body as GoodsReceipt;
    const second = (await receive(po, { 1: '10' }, { postingDate: day(4, 7) })).body as GoodsReceipt;
    const blocked = await cancel(first.id, day(4, 8));
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'VALUATION_BLOCKED');
    assert.equal((await stock(item.id)).onHand, '20.0000');
    const allowed = await cancel(second.id, day(4, 8));
    assert.equal(allowed.status, 201);
    assert.equal((await stock(item.id)).onHand, '10.0000');
  });

  it('keeps a manually closed order closed after a receipt cancellation', async () => {
    const item = await newItem();
    const po = await order([{ itemId: item.id, quantity: '10', unitPrice: '1' }]);
    const receipt = (await receive(po, { 1: '4' })).body as GoodsReceipt;
    const current = (await ctx.http.get(`/v1/pur/orders/${po.id}`).set(bearer(acme))).body as PurchaseOrder;
    const cancelOrder = await ctx.http.patch(`/v1/pur/orders/${po.id}/status`).set(bearer(acme)).send({ status: 'cancelled', version: current.version });
    assert.equal(cancelOrder.status, 409);
    const close = await ctx.http.patch(`/v1/pur/orders/${po.id}/status`).set(bearer(acme)).send({ status: 'closed', version: current.version });
    assert.equal(close.status, 200);
    assert.equal(close.body.closedReason, 'manual');
    assert.equal((await cancel(receipt.id)).status, 201);
    const after = (await ctx.http.get(`/v1/pur/orders/${po.id}`).set(bearer(acme))).body as PurchaseOrder;
    assert.equal(after.status, 'closed');
    assert.equal(after.closedReason, 'manual');
    const unused = await order([{ itemId: item.id, quantity: '1', unitPrice: '1' }]);
    const cancelUnused = await ctx.http.patch(`/v1/pur/orders/${unused.id}/status`).set(bearer(acme)).send({ status: 'cancelled', version: unused.version });
    assert.equal(cancelUnused.status, 200);
  });

  it('locks item type and unit after use and protects warehouses holding stock', async () => {
    const used = await newItem();
    await order([{ itemId: used.id, quantity: '1', unitPrice: '1' }]);
    const { code: _code, id: _id, version, createdAt: _c, updatedAt: _u, prices: _p, ...rest } = used;
    const change = await ctx.http
      .put(`/v1/inv/items/${used.id}`)
      .set(bearer(acme))
      .send({ ...rest, version, uomId: units.find((u) => u.code === 'BOX')?.id, prices: [] });
    assert.equal(change.status, 409);
    const fresh = await newItem();
    const { code: _fc, id: _fi, version: freshVersion, createdAt: _fca, updatedAt: _fu, prices: _fp, ...freshRest } = fresh;
    const freshChange = await ctx.http
      .put(`/v1/inv/items/${fresh.id}`)
      .set(bearer(acme))
      .send({ ...freshRest, version: freshVersion, uomId: units.find((u) => u.code === 'BOX')?.id, prices: [] });
    assert.equal(freshChange.status, 200);
    const branches = (await ctx.http.get('/v1/tenant/branches').set(bearer(acme))).body as { id: string; code: string }[];
    const extra = await ctx.http
      .post('/v1/inv/warehouses')
      .set(bearer(acme))
      .send({ code: 'WH-STOCK', name: 'Stock holder', branchId: branches.find((b) => b.code === 'WH1')?.id });
    const stocked = await newItem();
    const po = (
      await ctx.http
        .post('/v1/pur/orders')
        .set(bearer(acme))
        .send({ idempotencyKey: randomUUID(), vendorId, postingDate: day(4, 1), deliveryDate: day(4, 2), lines: [{ itemId: stocked.id, quantity: '2', unitPrice: '1', warehouseId: extra.body.id }] })
    ).body as PurchaseOrder;
    assert.equal((await receive(po, { 1: '2' })).status, 201);
    const reassigned = await ctx.http
      .put(`/v1/inv/warehouses/${extra.body.id}`)
      .set(bearer(acme))
      .send({ version: extra.body.version, name: extra.body.name, status: 'inactive' });
    assert.equal(reassigned.status, 409);
  });

  it('rejects receipts into a closed period and nets the trial balance', async () => {
    const item = await newItem();
    const po = await order([{ itemId: item.id, quantity: '2', unitPrice: '3' }]);
    const periods = (await ctx.http.get('/v1/fin/periods').set(bearer(acme))).body as PostingPeriod[];
    const may = periods.find((period) => period.code === `${YEAR}-05`) as PostingPeriod;
    await ctx.http.patch(`/v1/fin/periods/${may.id}/status`).set(bearer(acme)).send({ status: 'closed', version: may.version, reason: 'Test' });
    const blocked = await receive(po, { 1: '2' }, { postingDate: day(5, 10) });
    assert.equal(blocked.status, 422);
    assert.equal(blocked.body.error.code, 'PERIOD_CLOSED');
    const report = (await ctx.http.get(`/v1/fin/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}`).set(bearer(acme))).body as TrialBalance;
    assert.equal(report.totals.debit, report.totals.credit);
    const inventory = report.rows.find((row) => row.code === '1300');
    const grni = report.rows.find((row) => row.code === '2150');
    assert.ok(inventory && grni);
    assert.equal(inventory.closingBalance, grni.closingBalance.replace('-', ''));
    assert.ok(accounts.length > 0);
  });

  it('isolates purchasing data between tenants and enforces permissions', async () => {
    const item = await newItem();
    const po = await order([{ itemId: item.id, quantity: '1', unitPrice: '1' }]);
    const globex = (await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX)).token;
    const cross = await ctx.http.get(`/v1/pur/orders/${po.id}`).set(bearer(globex));
    assert.equal(cross.status, 404);
    const crossReceipt = await ctx.http
      .post('/v1/pur/receipts')
      .set(bearer(globex))
      .send({ idempotencyKey: randomUUID(), orderId: po.id, postingDate: day(4, 5), lines: [{ orderLineId: po.lines[0]?.id, quantity: '1' }] });
    assert.equal(crossReceipt.status, 404);
    const auditor = await loginToTenant(ctx, SHARED, GLOBEX);
    const denied = await ctx.http.post('/v1/pur/orders').set(bearer(auditor.token)).send({});
    assert.equal(denied.status, 403);
    const roles = (await ctx.http.get('/v1/tenant/roles').set(bearer(acme))).body as { code: string }[];
    assert.ok(roles.some((role) => role.code === 'buyer'));
    assert.ok(roles.some((role) => role.code === 'warehouse'));
  });
});
