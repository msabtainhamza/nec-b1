import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql, type Transaction } from 'kysely';
import type { Database } from '../src/database/schema.js';
import { ACME, ACME_OWNER, bearer, GLOBEX, GLOBEX_OWNER, loginToTenant, setup, SHARED, type TestContext } from './helpers.js';

describe('tenant isolation', () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await setup();
  });

  after(async () => {
    await ctx.close();
  });

  const inContext = <T>(tenantId: string | null, fn: (trx: Transaction<Database>) => Promise<T>) =>
    ctx.asApp.transaction().execute(async (trx) => {
      await sql`select set_config('app.tenant_id', ${tenantId ?? ''}, true)`.execute(trx);
      return fn(trx);
    });

  it('returns no tenant rows when no tenant context is set', async () => {
    const branches = await inContext(null, (trx) => trx.selectFrom('branches').selectAll().execute());
    const roles = await inContext(null, (trx) => trx.selectFrom('roles').selectAll().execute());
    const audit = await inContext(null, (trx) => trx.selectFrom('audit_events').selectAll().execute());
    assert.equal(branches.length, 0);
    assert.equal(roles.length, 0);
    assert.equal(audit.length, 0);
  });

  it('limits reads and aggregates to the active tenant even with overlapping codes', async () => {
    const acmeId = ctx.tenantId(ACME);
    const globexId = ctx.tenantId(GLOBEX);
    const acme = await inContext(acmeId, (trx) => trx.selectFrom('branches').select(['tenant_id', 'code']).execute());
    const globex = await inContext(globexId, (trx) => trx.selectFrom('branches').select(['tenant_id', 'code']).execute());
    assert.ok(acme.every((row) => row.tenant_id === acmeId));
    assert.ok(globex.every((row) => row.tenant_id === globexId));
    assert.ok(acme.some((row) => row.code === 'HQ'));
    assert.ok(globex.some((row) => row.code === 'HQ'));
    const count = await inContext(acmeId, (trx) =>
      trx.selectFrom('branches').select((eb) => eb.fn.countAll().as('count')).where('tenant_id', '=', globexId).executeTakeFirstOrThrow(),
    );
    assert.equal(Number(count.count), 0);
  });

  it('rejects writes that target another tenant', async () => {
    const acmeId = ctx.tenantId(ACME);
    const globexId = ctx.tenantId(GLOBEX);
    await assert.rejects(
      inContext(acmeId, (trx) => trx.insertInto('branches').values({ tenant_id: globexId, code: 'X1', name: 'Injected' }).execute()),
      /row-level security/,
    );
    const updated = await inContext(acmeId, (trx) =>
      trx.updateTable('branches').set({ name: 'Hijacked' }).where('tenant_id', '=', globexId).executeTakeFirst(),
    );
    assert.equal(Number(updated.numUpdatedRows), 0);
  });

  it('keeps audit events append-only for the application role', async () => {
    const acmeId = ctx.tenantId(ACME);
    await assert.rejects(
      inContext(acmeId, (trx) => trx.updateTable('audit_events').set({ action: 'tampered' }).execute()),
      /permission denied|append-only/,
    );
    await assert.rejects(
      inContext(acmeId, (trx) => trx.deleteFrom('audit_events').execute()),
      /permission denied|append-only/,
    );
  });

  it('does not leak tenant context across pooled connections', async () => {
    const acmeId = ctx.tenantId(ACME);
    await inContext(acmeId, (trx) => trx.selectFrom('branches').selectAll().execute());
    const results = await Promise.all(
      Array.from({ length: 15 }, () => ctx.asApp.selectFrom('branches').selectAll().execute()),
    );
    assert.ok(results.every((rows) => rows.length === 0));
    const setting = await sql<{ value: string | null }>`select current_setting('app.tenant_id', true) as value`.execute(ctx.asApp);
    assert.ok(!setting.rows[0]?.value);
  });

  it('returns not found for another tenant\'s record through the API', async () => {
    const acme = await loginToTenant(ctx, ACME_OWNER, ACME);
    const globex = await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX);
    const globexBranches = await ctx.http.get('/v1/tenant/branches').set(bearer(globex.token));
    assert.equal(globexBranches.status, 200);
    const globexBranchId = globexBranches.body[0].id as string;
    const crossRead = await ctx.http.get(`/v1/tenant/branches/${globexBranchId}`).set(bearer(acme.token));
    assert.equal(crossRead.status, 404);
    assert.equal(crossRead.body.error.code, 'NOT_FOUND');
    const crossWrite = await ctx.http
      .patch(`/v1/tenant/branches/${globexBranchId}/status`)
      .set(bearer(acme.token))
      .send({ status: 'disabled', version: 1 });
    assert.equal(crossWrite.status, 404);
  });

  it('ignores tenant identifiers supplied in the payload', async () => {
    const acme = await loginToTenant(ctx, ACME_OWNER, ACME);
    const response = await ctx.http
      .post('/v1/tenant/branches')
      .set(bearer(acme.token))
      .send({ code: 'PAY1', name: 'Payload branch', tenantId: ctx.tenantId(GLOBEX), tenant_id: ctx.tenantId(GLOBEX) });
    assert.equal(response.status, 201);
    const globexId = ctx.tenantId(GLOBEX);
    const leaked = await inContext(globexId, (trx) => trx.selectFrom('branches').selectAll().where('code', '=', 'PAY1').execute());
    assert.equal(leaked.length, 0);
    const acmeRows = await inContext(ctx.tenantId(ACME), (trx) => trx.selectFrom('branches').selectAll().where('code', '=', 'PAY1').execute());
    assert.equal(acmeRows.length, 1);
  });

  it('separates a shared user\'s view per active tenant and rejects stale tenant tokens', async () => {
    const acme = await loginToTenant(ctx, SHARED, ACME);
    const acmeContext = await ctx.http.get('/v1/tenant/context').set(bearer(acme.token));
    assert.equal(acmeContext.status, 200);
    assert.equal(acmeContext.body.tenant.code, ACME);
    const switched = await ctx.http
      .post('/v1/auth/select-tenant')
      .set(bearer(acme.login.accessToken))
      .send({ tenantId: ctx.tenantId(GLOBEX) });
    assert.equal(switched.status, 200);
    const globexContext = await ctx.http.get('/v1/tenant/context').set(bearer(switched.body.accessToken));
    assert.equal(globexContext.body.tenant.code, GLOBEX);
    assert.notDeepEqual(globexContext.body.permissions, acmeContext.body.permissions);
    const stale = await ctx.http.get('/v1/tenant/context').set(bearer(acme.token));
    assert.equal(stale.status, 401);
  });

  it('refuses tenant selection without a membership', async () => {
    const acme = await loginToTenant(ctx, ACME_OWNER, ACME);
    const response = await ctx.http
      .post('/v1/auth/select-tenant')
      .set(bearer(acme.login.accessToken))
      .send({ tenantId: ctx.tenantId(GLOBEX) });
    assert.equal(response.status, 404);
  });
});
