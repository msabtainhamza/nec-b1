import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { sql } from 'kysely';
import type { ItemGroup, ItemStock, PartnerGroup, SalesOrder, SalesQuotation, UnitOfMeasure } from '@nec/contracts';
import { ACME, ACME_OWNER, bearer, GLOBEX, GLOBEX_OWNER, loginToTenant, setup, SHARED, type TestContext } from './helpers.js';

const today = new Date().toISOString().slice(0, 10);
const year = Number(today.slice(0, 4));
const future = `${year + 1}-12-31`;

describe('Sales quotations', () => {
  let ctx: TestContext;
  let token: string;
  let customerId: string;
  let itemId: string;
  let warehouseId: string;
  const payload = (extra: Record<string, unknown> = {}) => ({
    idempotencyKey: randomUUID(), customerId, postingDate: today, validUntil: future,
    customerReference: 'Customer quote reference', remarks: 'Agreed quotation',
    lines: [{ itemId, quantity: '3', unitPrice: '12.50', discountPercent: '10', warehouseId }], ...extra,
  });
  const post = (body = payload(), auth = token) => ctx.http.post('/v1/sal/quotations').set(bearer(auth)).send(body);
  const status = (q: SalesQuotation, value: string, auth = token) => ctx.http.patch(`/v1/sal/quotations/${q.id}/status`).set(bearer(auth)).send({ version: q.version, status: value });
  const create = async () => {
    const response = await post();
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body as SalesQuotation;
  };
  const issue = async () => {
    const response = await status(await create(), 'issued');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body as SalesQuotation;
  };
  const convert = (q: SalesQuotation, body = { idempotencyKey: randomUUID(), version: q.version, postingDate: today, deliveryDate: today }, auth = token) =>
    ctx.http.post(`/v1/sal/quotations/${q.id}/convert`).set(bearer(auth)).send(body);
  const get = async (id: string) => (await ctx.http.get(`/v1/sal/quotations/${id}`).set(bearer(token))).body as SalesQuotation;

  before(async () => {
    ctx = await setup();
    token = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    const groups = (await ctx.http.get('/v1/bp/groups').set(bearer(token))).body as PartnerGroup[];
    const customer = await ctx.http.post('/v1/bp/partners').set(bearer(token)).send({ code: 'QC1', name: 'Quotation customer', partnerType: 'customer', groupId: groups.find((g) => g.partnerType === 'customer')!.id });
    assert.equal(customer.status, 201, JSON.stringify(customer.body));
    customerId = customer.body.id;
    const itemGroups = (await ctx.http.get('/v1/inv/item-groups').set(bearer(token))).body as ItemGroup[];
    const units = (await ctx.http.get('/v1/inv/units').set(bearer(token))).body as UnitOfMeasure[];
    warehouseId = (await ctx.http.get('/v1/inv/warehouses').set(bearer(token))).body[0].id;
    const item = await ctx.http.post('/v1/inv/items').set(bearer(token)).send({ code: 'QI1', name: 'Quoted stock item', itemType: 'inventory', groupId: itemGroups[0]!.id, uomId: units.find((u) => u.code === 'EA')!.id });
    assert.equal(item.status, 201, JSON.stringify(item.body));
    itemId = item.body.id;
  });
  after(async () => { if (ctx) await ctx.close(); });

  it('edits a draft, issues saved prices and converts with source links and no stock or journal posting', async () => {
    const beforeStock = (await ctx.http.get(`/v1/inv/items/${itemId}/stock`).set(bearer(token))).body as ItemStock;
    const body = payload();
    const first = await post(body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    let q = first.body as SalesQuotation;
    assert.equal(q.status, 'draft');
    assert.equal(q.total, '33.7500');
    const replay = await post(body);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, q.id);
    assert.equal((await post({ ...body, validUntil: today })).status, 409);
    const draftCopy = await convert(q);
    assert.equal(draftCopy.status, 409);
    const patch = { ...body, version: q.version, lines: [{ itemId, quantity: '4', unitPrice: '20', discountPercent: '25', warehouseId }] };
    const update = await ctx.http.patch(`/v1/sal/quotations/${q.id}`).set(bearer(token)).send(patch);
    assert.equal(update.status, 200, JSON.stringify(update.body));
    assert.equal(update.body.total, '60.0000');
    assert.equal((await ctx.http.patch(`/v1/sal/quotations/${q.id}`).set(bearer(token)).send(patch)).status, 409);
    q = (await status(update.body, 'issued')).body as SalesQuotation;
    assert.equal(q.status, 'issued');
    assert.equal((await ctx.http.patch(`/v1/sal/quotations/${q.id}`).set(bearer(token)).send({ ...patch, version: q.version })).status, 409);
    const quotedStock = (await ctx.http.get(`/v1/inv/items/${itemId}/stock`).set(bearer(token))).body;
    assert.deepEqual(quotedStock, beforeStock);
    const request = { idempotencyKey: randomUUID(), version: q.version, postingDate: today, deliveryDate: today };
    const copied = await convert(q, request);
    assert.equal(copied.status, 201, JSON.stringify(copied.body));
    const order = copied.body as SalesOrder;
    assert.equal(order.total, q.total);
    assert.equal(order.quotationId, q.id);
    assert.equal(order.quotationNumber, q.documentNumber);
    assert.equal(order.lines[0]!.quotationLineId, q.lines[0]!.id);
    assert.equal(order.lines[0]!.quantity, '4.0000');
    assert.equal(order.lines[0]!.netPrice, '15.0000');
    assert.equal(order.customerReference, q.customerReference);
    const closed = await get(q.id);
    assert.equal(closed.status, 'closed');
    assert.equal(closed.orderId, order.id);
    assert.equal((await convert(q, request)).body.id, order.id);
    assert.equal((await convert(q, { ...request, deliveryDate: future })).status, 409);
    assert.equal((await status(closed, 'cancelled')).status, 409);
    await ctx.asApp.transaction().execute(async (trx) => {
      await sql`select set_config('app.tenant_id', ${ctx.tenantId(ACME)}, true)`.execute(trx);
      assert.equal((await trx.selectFrom('stock_movements').selectAll().execute()).length, 0);
      assert.equal((await trx.selectFrom('journal_entries').selectAll().execute()).length, 0);
      const events = await trx.selectFrom('audit_events').select('action').where('entity_id', '=', q.id).execute();
      assert.deepEqual(events.map((e) => e.action).sort(), ['sales_quotation.created', 'sales_quotation.updated', 'sales_quotation.issued', 'sales_quotation.converted'].sort());
    });
  });

  it('allows exactly one conversion under concurrency and replays the winning request', async () => {
    const q = await issue();
    const body = { idempotencyKey: randomUUID(), version: q.version, postingDate: today, deliveryDate: today };
    const same = await Promise.all([convert(q, body), convert(q, body), convert(q, body)]);
    assert.deepEqual(same.map((r) => r.status).sort(), [200, 200, 201]);
    assert.equal(new Set(same.map((r) => r.body.id)).size, 1);
    const other = await issue();
    const separate = await Promise.all([convert(other), convert(other), convert(other)]);
    assert.deepEqual(separate.map((r) => r.status).sort(), [201, 409, 409]);
  });

  it('enforces expiry on the server including backdated conversion and exposes expired lists', async () => {
    assert.equal((await post(payload({ validUntil: `${year - 1}-01-01` }))).status, 400);
    const old = await post(payload({ postingDate: `${year - 1}-01-01`, validUntil: `${year - 1}-12-31` }));
    assert.equal(old.status, 201);
    assert.equal((await status(old.body, 'issued')).status, 409);
    const q = await issue();
    await ctx.asApp.transaction().execute(async (trx) => {
      await sql`select set_config('app.tenant_id', ${ctx.tenantId(ACME)}, true)`.execute(trx);
      await trx.updateTable('sales_quotations').set({ posting_date: `${year - 1}-01-01`, valid_until: `${year - 1}-12-31` }).where('id', '=', q.id).execute();
    });
    assert.equal((await get(q.id)).status, 'expired');
    const list = await ctx.http.get('/v1/sal/quotations?status=expired').set(bearer(token));
    assert.equal(list.status, 200);
    assert.ok(list.body.items.some((row: SalesQuotation) => row.id === q.id));
    assert.equal((await convert(q, { idempotencyKey: randomUUID(), version: q.version, postingDate: `${year - 1}-06-01`, deliveryDate: today })).status, 409);
    assert.equal((await status(q, 'closed')).status, 200);
  });

  it('rolls back failed conversion and rejects dates, missing items and invalid lifecycle changes', async () => {
    const q = await issue();
    const key = randomUUID();
    const bad = { idempotencyKey: key, version: q.version, postingDate: today, deliveryDate: `${year - 1}-01-01` };
    assert.equal((await convert(q, bad)).status, 400);
    const unchanged = await get(q.id);
    assert.equal(unchanged.status, 'issued');
    assert.equal(unchanged.orderId, null);
    assert.equal((await convert(q, { ...bad, deliveryDate: today })).status, 201);
    const cancelled = await create();
    const result = await status(cancelled, 'cancelled');
    assert.equal(result.status, 200);
    assert.equal((await status(result.body, 'issued')).status, 409);
    assert.equal((await post(payload({ lines: [{ itemId: randomUUID(), quantity: '1', unitPrice: '1' }] }))).status, 400);
    assert.equal((await post(payload({ lines: [{ itemId, quantity: '0.5', unitPrice: '1' }] }))).status, 400);
  });

  it('isolates tenants and enforces quotation and conversion permissions', async () => {
    const q = await issue();
    const other = (await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX)).token;
    assert.equal((await ctx.http.get(`/v1/sal/quotations/${q.id}`).set(bearer(other))).status, 404);
    assert.equal((await convert(q, undefined, other)).status, 404);
    assert.equal((await post(payload(), other)).status, 400);
    const auditor = (await loginToTenant(ctx, SHARED, GLOBEX)).token;
    assert.equal((await ctx.http.get('/v1/sal/quotations').set(bearer(auditor))).status, 200);
    assert.equal((await post(payload(), auditor)).status, 403);
    assert.equal((await status(q, 'closed', auditor)).status, 403);
    assert.equal((await convert(q, undefined, auditor)).status, 403);
    await ctx.asApp.transaction().execute(async (trx) => {
      await sql`select set_config('app.tenant_id', ${ctx.tenantId(GLOBEX)}, true)`.execute(trx);
      assert.equal((await trx.selectFrom('sales_quotations').select('id').where('id', '=', q.id).execute()).length, 0);
      assert.equal((await trx.selectFrom('sales_quotation_lines').select('id').where('quotation_id', '=', q.id).execute()).length, 0);
    });
  });
});
