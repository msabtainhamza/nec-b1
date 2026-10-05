import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { sql } from 'kysely';
import type { Account, BusinessPartner, CreditSettings, ItemGroup, NumberingSeries, PartnerGroup, Role, SalesOrder, UnitOfMeasure } from '@nec/contracts';
import { ACME, ACME_OWNER, bearer, GLOBEX, GLOBEX_OWNER, loginToTenant, setup, SHARED, type TestContext } from './helpers.js';
import { CreditService } from '../src/sales/credit.service.js';

const date = `${new Date().getUTCFullYear()}-03-01`;
describe('Customer credit policy', () => {
  let ctx: TestContext;
  let owner: string;
  let salesperson: string;
  let itemId: string;
  let serviceId: string;
  let warehouseId: string;
  let customerGroup: string;
  let sequence = 0;
  const post = (path: string, body: object, auth = owner) => ctx.http.post(path).set(bearer(auth)).send(body);
  const policy = async (mode: CreditSettings['mode']) => {
    const current = await ctx.http.get('/v1/sal/credit-settings').set(bearer(owner));
    const result = await ctx.http.put('/v1/sal/credit-settings').set(bearer(owner)).send({ mode, version: current.body.version });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body as CreditSettings;
  };
  const customer = async (creditLimit = '100') => {
    const result = await post('/v1/bp/partners', { code: `CR-${++sequence}`, name: `Credit customer ${sequence}`, partnerType: 'customer', groupId: customerGroup, creditLimit });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body as BusinessPartner;
  };
  const orderBody = (customerId: string, amount: string, extra: Record<string, unknown> = {}) => ({ idempotencyKey: randomUUID(), customerId, postingDate: date, deliveryDate: date, lines: [{ itemId: serviceId, quantity: '1', unitPrice: amount }], ...extra });
  const snapshot = async (customerId: string) => (await ctx.http.get(`/v1/bp/partners/${customerId}/balance`).set(bearer(owner))).body;
  const events = async (id: string) => ctx.asApp.transaction().execute(async (trx) => {
    await sql`select set_config('app.tenant_id', ${ctx.tenantId(ACME)}, true)`.execute(trx);
    return trx.selectFrom('audit_events').select(['action', 'after_data']).where('entity_id', '=', id).where('action', 'like', 'sales.credit%').execute();
  });
  before(async () => {
    ctx = await setup();
    owner = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    const groups = (await ctx.http.get('/v1/bp/groups').set(bearer(owner))).body as PartnerGroup[];
    customerGroup = groups.find((g) => g.partnerType === 'customer')!.id;
    const itemGroups = (await ctx.http.get('/v1/inv/item-groups').set(bearer(owner))).body as ItemGroup[];
    const units = (await ctx.http.get('/v1/inv/units').set(bearer(owner))).body as UnitOfMeasure[];
    warehouseId = (await ctx.http.get('/v1/inv/warehouses').set(bearer(owner))).body[0].id;
    for (const type of ['inventory', 'service']) {
      const result = await post('/v1/inv/items', { code: `CREDIT-${type}`, name: type, itemType: type, groupId: itemGroups[0]!.id, uomId: units.find((u) => u.code === 'EA')!.id });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      if (type === 'inventory') itemId = result.body.id; else serviceId = result.body.id;
    }
    const roles = (await ctx.http.get('/v1/tenant/roles').set(bearer(owner))).body as Role[];
    const invited = await post('/v1/tenant/invitations', { email: 'credit.sales@nec-erp.localhost', roleIds: [roles.find((r) => r.code === 'sales')!.id] });
    assert.equal(invited.status, 201);
    const accepted = await post('/v1/invitations/accept', { token: ctx.mailer.tokenFor('credit.sales@nec-erp.localhost'), password: ctx.password, displayName: 'Credit Sales' });
    assert.equal(accepted.status, 200);
    salesperson = (await loginToTenant(ctx, 'credit.sales@nec-erp.localhost', ACME)).token;
  });
  after(async () => { if (ctx) await ctx.close(); });

  it('defaults off, versions policy changes and isolates settings and permissions', async () => {
    assert.deepEqual((await ctx.http.get('/v1/sal/credit-settings').set(bearer(owner))).body, { mode: 'disabled', version: 0 });
    const zero = await customer('0');
    assert.equal((await post('/v1/sal/orders', orderBody(zero.id, '100'))).status, 201);
    const setting = await policy('block');
    assert.equal((await ctx.http.put('/v1/sal/credit-settings').set(bearer(owner)).send({ mode: 'disabled', version: setting.version - 1 })).status, 409);
    assert.equal((await ctx.http.put('/v1/sal/credit-settings').set(bearer(salesperson)).send({ mode: 'disabled', version: setting.version })).status, 403);
    assert.equal((await ctx.http.get('/v1/sal/credit-settings').set(bearer(salesperson))).status, 200);
    const globex = (await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX)).token;
    assert.deepEqual((await ctx.http.get('/v1/sal/credit-settings').set(bearer(globex))).body, { mode: 'disabled', version: 0 });
    const auditor = (await loginToTenant(ctx, SHARED, GLOBEX)).token;
    assert.equal((await ctx.http.put('/v1/sal/credit-settings').set(bearer(auditor)).send({ mode: 'block', version: 0 })).status, 403);
    await ctx.asApp.transaction().execute(async (trx) => {
      await sql`select set_config('app.tenant_id', ${ctx.tenantId(GLOBEX)}, true)`.execute(trx);
      assert.equal((await trx.selectFrom('sales_credit_settings').selectAll().execute()).length, 0);
    });
  });

  it('serializes concurrent orders, permits the exact limit, and treats zero as zero', async () => {
    await policy('block');
    const buyer = await customer();
    const seriesIds: string[] = [];
    for (const n of [1, 2, 3]) {
      const series = await post('/v1/tenant/numbering-series', { documentType: 'sales_order', name: `Credit concurrency ${n}`, prefix: `CC${n}-` });
      assert.equal(series.status, 201);
      const id = (series.body as NumberingSeries[]).find((row) => row.name === `Credit concurrency ${n}`)?.id;
      assert.ok(id);
      seriesIds.push(id);
    }
    const attempts = await Promise.all(seriesIds.map((seriesId) => post('/v1/sal/orders', orderBody(buyer.id, '60', { seriesId }))));
    assert.deepEqual(attempts.map((r) => r.status).sort(), [201, 409, 409]);
    assert.equal((await snapshot(buyer.id)).creditExposure.total, '60.0000');
    assert.equal((await post('/v1/sal/orders', orderBody(buyer.id, '40'))).status, 201);
    const blocked = await post('/v1/sal/orders', orderBody(buyer.id, '0.0001', { creditAcknowledged: true }));
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'CREDIT_LIMIT_EXCEEDED');
    assert.equal(blocked.body.error.details.exposure.total, '100.0001');
    assert.equal((await snapshot(buyer.id)).creditExposure.total, '100.0000');
    const zero = await customer('0');
    assert.equal((await post('/v1/sal/orders', orderBody(zero.id, '0'))).status, 201);
    assert.equal((await post('/v1/sal/orders', orderBody(zero.id, '1'))).status, 409);
  });

  it('requires acknowledgement for warnings and audits authorized overrides once', async () => {
    await policy('warn');
    const buyer = await customer('10');
    const body = orderBody(buyer.id, '20');
    const warning = await post('/v1/sal/orders', body, salesperson);
    assert.equal(warning.status, 409);
    assert.equal(warning.body.error.details.mode, 'warn');
    assert.equal(warning.body.error.details.canOverride, false);
    const confirmed = { ...body, creditAcknowledged: true };
    const posted = await post('/v1/sal/orders', confirmed, salesperson);
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    assert.equal((await post('/v1/sal/orders', confirmed, salesperson)).status, 200);
    assert.deepEqual((await events(posted.body.id)).map((e) => e.action), ['sales.credit_warning_acknowledged']);
    await policy('block');
    const override = orderBody(buyer.id, '10', { creditOverrideReason: 'Approved customer exception' });
    assert.equal((await post('/v1/sal/orders', override, salesperson)).status, 403);
    const accepted = await post('/v1/sal/orders', override);
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.equal((await post('/v1/sal/orders', override)).status, 200);
    const audit = await events(accepted.body.id);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.action, 'sales.credit_override');
    assert.equal((audit[0]!.after_data as { reason: string }).reason, 'Approved customer exception');
    assert.equal((await post('/v1/sal/orders', orderBody(buyer.id, '1', { creditOverrideReason: ' ' }))).status, 400);
  });

  it('waits for an in-flight credit decision before evaluating another numbering series', async () => {
    await policy('block');
    const buyer = await customer('100');
    const series = await post('/v1/tenant/numbering-series', { documentType: 'sales_order', name: 'Overlapping credit order', prefix: 'OVER-' });
    assert.equal(series.status, 201);
    const seriesId = (series.body as NumberingSeries[]).find((row) => row.name === 'Overlapping credit order')?.id;
    assert.ok(seriesId);
    const credit = ctx.app.get(CreditService);
    const original = credit.check;
    let reached!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let firstCheck = true;
    credit.check = async (...args: Parameters<CreditService['check']>) => {
      await original.apply(credit, args);
      if (args[2] === buyer.id && firstCheck) {
        firstCheck = false;
        reached();
        await held;
      }
    };
    const first = post('/v1/sal/orders', orderBody(buyer.id, '60')).then((response) => response);
    let second: typeof first | undefined;
    try {
      await Promise.race([entered, first.then((r) => { throw new Error(`First request did not reach the credit check: ${r.status}`); })]);
      let secondDone = false;
      second = post('/v1/sal/orders', orderBody(buyer.id, '60', { seriesId })).then((response) => { secondDone = true; return response; });
      const until = Date.now() + 3000;
      while (!secondDone && Date.now() < until) {
        const waiting = await sql<{ count: string }>`select count(*)::text as count from pg_locks
          where locktype = 'advisory' and not granted
          and objid = (hashtextextended(${`credit-exposure:${ctx.tenantId(ACME)}`}, 0) & 4294967295)::oid`.execute(ctx.asApp);
        if (Number(waiting.rows[0]!.count) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      release();
      const responses = await Promise.all([first, second]);
      assert.deepEqual(responses.map((r) => r.status), [201, 409]);
      assert.equal(responses[1]!.body.error.details.exposure.total, '120.0000');
      assert.equal((await snapshot(buyer.id)).creditExposure.total, '60.0000');
    } finally {
      release();
      credit.check = original;
      await first;
      if (second) await second;
    }
  });

  it('locks only credit-relevant writes under an active policy and makes policy changes wait for in-flight writes', async () => {
    const key = (resource: string) => `${resource}:${ctx.tenantId(ACME)}`;
    const hold = async (resource: string, shared = false) => {
      let release!: () => void;
      let ready!: () => void;
      const acquired = new Promise<void>((resolve) => { ready = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      const done = ctx.asApp.transaction().execute(async (trx) => {
        if (shared) await sql`select pg_advisory_xact_lock_shared(hashtextextended(${key(resource)}, 0))`.execute(trx);
        else await sql`select pg_advisory_xact_lock(hashtextextended(${key(resource)}, 0))`.execute(trx);
        ready();
        await released;
      });
      await acquired;
      return { release: async () => { release(); await done; } };
    };
    const waiting = async (resource: string) => {
      const until = Date.now() + 3000;
      while (Date.now() < until) {
        const rows = await sql<{ count: string }>`select count(*)::text as count from pg_locks where locktype = 'advisory' and not granted
          and objid = (hashtextextended(${key(resource)}, 0) & 4294967295)::oid`.execute(ctx.asApp);
        if (Number(rows.rows[0]!.count) > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    };
    const within = <T>(promise: PromiseLike<T>, label: string) => Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} waited for a credit lock`)), 3000)),
    ]);
    await policy('disabled');
    const buyer = await customer('100');
    const exposure = await hold('credit-exposure');
    try {
      assert.equal((await within(ctx.http.get('/v1/sal/orders').set(bearer(owner)), 'Order list')).status, 200);
      assert.equal((await within(ctx.http.get('/v1/sal/invoices').set(bearer(owner)), 'Invoice list')).status, 200);
      assert.equal((await within(ctx.http.get('/v1/bank/incoming-payments').set(bearer(owner)), 'Payment list')).status, 200);
      assert.equal((await within(snapshot(buyer.id), 'Partner balance')).creditExposure.creditLimit, '100.0000');
      assert.equal((await within(post('/v1/sal/orders', orderBody(buyer.id, '10')), 'Order under a disabled policy')).status, 201);
      await within(policy('warn'), 'Policy change');
      let finished = false;
      const order = post('/v1/sal/orders', orderBody(buyer.id, '10')).then((response) => { finished = true; return response; });
      assert.equal(await waiting('credit-exposure'), true);
      assert.equal(finished, false);
      await exposure.release();
      assert.equal((await order).status, 201);
    } finally {
      await exposure.release();
    }
    const inFlight = await hold('credit-policy', true);
    try {
      let changed = false;
      const change = policy('disabled').then((result) => { changed = true; return result; });
      assert.equal(await waiting('credit-policy'), true);
      assert.equal(changed, false);
      await inFlight.release();
      assert.equal((await change).mode, 'disabled');
    } finally {
      await inFlight.release();
    }
  });

  it('checks delivery and tax-inclusive invoices atomically and permits payments and corrections', async () => {
    await policy('block');
    const buyer = await customer('100');
    const receipt = await post('/v1/inv/adjustments', { idempotencyKey: randomUUID(), direction: 'receipt', postingDate: date, reason: 'Credit test stock', lines: [{ itemId, warehouseId, quantity: '20', unitCost: '2' }] });
    assert.equal(receipt.status, 201);
    const created = await post('/v1/sal/orders', orderBody(buyer.id, '0', { lines: [{ itemId, warehouseId, quantity: '10', unitPrice: '10' }] }));
    assert.equal(created.status, 201);
    const order = created.body as SalesOrder;
    const lowered = await ctx.http.put(`/v1/bp/partners/${buyer.id}`).set(bearer(owner)).send({ ...buyer, creditLimit: '50' });
    assert.equal(lowered.status, 200, JSON.stringify(lowered.body));
    const delivery = { idempotencyKey: randomUUID(), orderId: order.id, postingDate: date, lines: [{ orderLineId: order.lines[0]!.id, quantity: '10' }] };
    const stockBefore = (await ctx.http.get(`/v1/inv/items/${itemId}/stock`).set(bearer(owner))).body;
    const blocked = await post('/v1/sal/deliveries', delivery);
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.deepEqual((await ctx.http.get(`/v1/inv/items/${itemId}/stock`).set(bearer(owner))).body, stockBefore);
    const restored = await ctx.http.put(`/v1/bp/partners/${buyer.id}`).set(bearer(owner)).send({ ...lowered.body, creditLimit: '100' });
    assert.equal(restored.status, 200);
    const delivered = await post('/v1/sal/deliveries', delivery);
    assert.equal(delivered.status, 201, JSON.stringify(delivered.body));
    assert.equal((await snapshot(buyer.id)).creditExposure.total, '100.0000');
    const tax = await post('/v1/fin/tax-codes', { code: 'CR10', name: 'Credit test tax', purpose: 'sales', rate: '10', validFrom: date });
    assert.equal(tax.status, 201);
    const invoice = { idempotencyKey: randomUUID(), customerId: buyer.id, postingDate: date, lines: [{ kind: 'delivery', deliveryLineId: delivered.body.lines[0].id, quantity: '10', taxCodeId: tax.body.id }] };
    const rejected = await post('/v1/sal/invoices', invoice);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.details.exposure.total, '110.0000');
    assert.equal((await snapshot(buyer.id)).balance, '0.0000');
    const paid = await post('/v1/bank/incoming-payments', { idempotencyKey: randomUUID(), customerId: buyer.id, postingDate: date, paymentMeans: 'bank_transfer', amount: '20', allocations: [] });
    assert.equal(paid.status, 201);
    const invoiced = await post('/v1/sal/invoices', invoice);
    assert.equal(invoiced.status, 201, JSON.stringify(invoiced.body));
    assert.equal((await snapshot(buyer.id)).creditExposure.total, '90.0000');
    const cancelled = await post(`/v1/bank/incoming-payments/${paid.body.id}/cancel`, { idempotencyKey: randomUUID(), postingDate: date, reason: 'Correct mistaken payment' });
    assert.equal(cancelled.status, 201);
    assert.equal((await snapshot(buyer.id)).creditExposure.total, '110.0000');
    assert.equal((await post('/v1/sal/orders', orderBody(buyer.id, '1'))).status, 409);
  });

  it('counts opening receivables and prevents quotation conversion from bypassing the policy', async () => {
    await policy('block');
    const buyer = await customer('100');
    const opening = await post('/v1/fin/opening-balances/partners', { idempotencyKey: randomUUID(), postingDate: date, reason: 'Legacy receivable', lines: [{ partnerId: buyer.id, reference: 'LEGACY', debit: '80' }] });
    assert.equal(opening.status, 201, JSON.stringify(opening.body));
    const quote = await post('/v1/sal/quotations', { ...orderBody(buyer.id, '30'), validUntil: `${new Date().getUTCFullYear() + 1}-12-31` });
    assert.equal(quote.status, 201);
    const issued = await ctx.http.patch(`/v1/sal/quotations/${quote.body.id}/status`).set(bearer(owner)).send({ version: quote.body.version, status: 'issued' });
    assert.equal(issued.status, 200);
    const body = { idempotencyKey: randomUUID(), version: issued.body.version, postingDate: date, deliveryDate: date };
    assert.equal((await post(`/v1/sal/quotations/${quote.body.id}/convert`, body)).status, 409);
    const unchanged = (await ctx.http.get(`/v1/sal/quotations/${quote.body.id}`).set(bearer(owner))).body;
    assert.equal(unchanged.status, 'issued');
    assert.equal(unchanged.orderId, null);
    const converted = await post(`/v1/sal/quotations/${quote.body.id}/convert`, { ...body, creditOverrideReason: 'Approved quote' });
    assert.equal(converted.status, 201, JSON.stringify(converted.body));
    assert.equal((await snapshot(buyer.id)).creditExposure.total, '110.0000');
    assert.equal((await events(converted.body.id))[0]?.action, 'sales.credit_override');
  });

  it('includes manual journals and releases exposure when orders close or invoices are cancelled', async () => {
    await policy('block');
    const buyer = await customer('100');
    const accounts = (await ctx.http.get('/v1/fin/accounts').set(bearer(owner))).body as Account[];
    const journal = await post('/v1/fin/journal-entries', { idempotencyKey: randomUUID(), postingDate: date, memo: 'Customer charge', lines: [
      { partnerId: buyer.id, debit: '75' }, { accountId: accounts.find((a) => a.code === '4100')!.id, credit: '75' },
    ] });
    assert.equal(journal.status, 201, JSON.stringify(journal.body));
    assert.equal((await post('/v1/sal/orders', orderBody(buyer.id, '26'))).status, 409);
    const created = await post('/v1/sal/orders', orderBody(buyer.id, '25'));
    assert.equal(created.status, 201);
    const closed = await ctx.http.patch(`/v1/sal/orders/${created.body.id}/status`).set(bearer(owner)).send({ status: 'closed', version: created.body.version });
    assert.equal(closed.status, 200);
    assert.equal((await snapshot(buyer.id)).creditExposure.total, '75.0000');
    const replacement = await post('/v1/sal/orders', orderBody(buyer.id, '25'));
    const invoice = await post('/v1/sal/invoices', { idempotencyKey: randomUUID(), customerId: buyer.id, postingDate: date, lines: [{ kind: 'order', orderLineId: replacement.body.lines[0].id, quantity: '1' }] });
    assert.equal(invoice.status, 201);
    assert.equal((await snapshot(buyer.id)).creditExposure.total, '100.0000');
    const cancelled = await post(`/v1/sal/invoices/${invoice.body.id}/cancel`, { idempotencyKey: randomUUID(), postingDate: date, reason: 'Correct service invoice' });
    assert.equal(cancelled.status, 201);
    const balance = await snapshot(buyer.id);
    assert.equal(balance.balance, '75.0000');
    assert.equal(balance.creditExposure.openOrders, '25.0000');
    assert.equal(balance.creditExposure.total, '100.0000');
  });
});
