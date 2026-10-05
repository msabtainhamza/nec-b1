import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Dashboard, ItemGroup, PartnerGroup, UnitOfMeasure } from '@nec/contracts';
import { ACME, ACME_OWNER, bearer, loginToTenant, setup, type TestContext } from './helpers.js';

const YEAR = new Date().getUTCFullYear();

describe('Home dashboard', () => {
  let ctx: TestContext;
  let owner: string;

  before(async () => {
    ctx = await setup();
    owner = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
  });

  after(async () => {
    await ctx.close();
  });

  it('shows open orders, overdue invoices, low stock and monthly totals', async () => {
    const empty = (await ctx.http.get('/v1/tenant/dashboard').set(bearer(owner))).body as Dashboard;
    assert.deepEqual([empty.openSalesOrders, empty.overdueReceivables, empty.overduePayables], [{ count: 0, amount: '0.0000' }, { count: 0, amount: '0.0000' }, { count: 0, amount: '0.0000' }]);
    assert.equal(empty.periods.length, 6);
    assert.equal(empty.periods.at(-1)?.month, empty.asOf.slice(0, 7));

    const groups = (await ctx.http.get('/v1/bp/groups').set(bearer(owner))).body as PartnerGroup[];
    const itemGroups = (await ctx.http.get('/v1/inv/item-groups').set(bearer(owner))).body as ItemGroup[];
    const units = (await ctx.http.get('/v1/inv/units').set(bearer(owner))).body as UnitOfMeasure[];
    const customer = await ctx.http.post('/v1/bp/partners').set(bearer(owner)).send({ code: 'DB-C', partnerType: 'customer', name: 'Dashboard customer', groupId: groups.find((g) => g.partnerType === 'customer')?.id });
    const service = await ctx.http.post('/v1/inv/items').set(bearer(owner)).send({ code: 'DB-SRV', name: 'Dashboard service', itemType: 'service', groupId: itemGroups[0]?.id, uomId: units.find((u) => u.code === 'EA')?.id });
    const stocked = await ctx.http.post('/v1/inv/items').set(bearer(owner)).send({ code: 'DB-STK', name: 'Dashboard stock', itemType: 'inventory', groupId: itemGroups[0]?.id, uomId: units.find((u) => u.code === 'EA')?.id, reorderPoint: '5' });
    assert.equal(stocked.status, 201, JSON.stringify(stocked.body));
    const date = `${YEAR}-01-02`;
    const order = await ctx.http.post('/v1/sal/orders').set(bearer(owner)).send({ idempotencyKey: randomUUID(), customerId: customer.body.id, postingDate: date, deliveryDate: date, lines: [{ itemId: service.body.id, quantity: '2', unitPrice: '50' }] });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    const invoice = await ctx.http.post('/v1/sal/invoices').set(bearer(owner)).send({ idempotencyKey: randomUUID(), customerId: customer.body.id, postingDate: date, dueDate: date, lines: [{ kind: 'order', orderLineId: order.body.lines[0].id, quantity: '1' }] });
    assert.equal(invoice.status, 201, JSON.stringify(invoice.body));

    const dashboard = (await ctx.http.get('/v1/tenant/dashboard').set(bearer(owner))).body as Dashboard;
    assert.deepEqual(dashboard.openSalesOrders, { count: 1, amount: '50.0000' });
    if (dashboard.asOf > date) assert.deepEqual(dashboard.overdueReceivables, { count: 1, amount: '50.0000' });
    assert.ok((dashboard.lowStockItems ?? 0) >= 1);
    const january = dashboard.periods.find((period) => period.month === `${YEAR}-01`);
    if (january) assert.equal(january.sales, '50.0000');
    assert.equal(dashboard.currency.length, 3);
    assert.equal(dashboard.pendingApprovals, 0);
  });

  it('shows only the widgets the user is allowed to see', async () => {
    const created = await ctx.http.post('/v1/tenant/roles').set(bearer(owner)).send({ code: 'stock_only', name: 'Stock only', permissions: ['inv.stock.view'] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((await ctx.http.post('/v1/tenant/invitations').set(bearer(owner)).send({ email: 'dash.stock@nec-erp.localhost', roleIds: [created.body.id] })).status, 201);
    assert.equal((await ctx.http.post('/v1/invitations/accept').send({ token: ctx.mailer.tokenFor('dash.stock@nec-erp.localhost'), password: ctx.password, displayName: 'Stock only' })).status, 200);
    const limited = (await loginToTenant(ctx, 'dash.stock@nec-erp.localhost', ACME)).token;
    const dashboard = (await ctx.http.get('/v1/tenant/dashboard').set(bearer(limited))).body as Dashboard;
    assert.deepEqual([dashboard.openSalesOrders, dashboard.openPurchaseOrders, dashboard.overdueReceivables, dashboard.overduePayables], [null, null, null, null]);
    assert.ok(dashboard.lowStockItems !== null);
    assert.equal(dashboard.pendingApprovals, null);
    assert.ok(dashboard.periods.every((period) => period.sales === null && period.purchases === null));
  });
});
