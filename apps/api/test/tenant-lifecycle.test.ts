import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ACME, ACME_OWNER, bearer, GLOBEX, GLOBEX_OWNER, loginToTenant, operatorLogin, setup, SHARED, type TestContext } from './helpers.js';

describe('Company export and deletion request', () => {
  let ctx: TestContext;
  let owner: string;
  let tenantId: string;

  before(async () => {
    ctx = await setup();
    tenantId = ctx.tenantId(ACME);
    owner = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
  });

  after(async () => {
    await ctx.close();
  });

  it('exports every company table without secrets for holders of the export permission', async () => {
    const auditor = (await loginToTenant(ctx, SHARED, GLOBEX)).token;
    assert.equal((await ctx.http.get('/v1/tenant/export').set(bearer(auditor))).status, 403);
    const exported = await ctx.http.get('/v1/tenant/export').set(bearer(owner));
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    const body = exported.body as { formatVersion: number; tenant: { code: string }; tables: Record<string, Record<string, unknown>[]> };
    assert.equal(body.formatVersion, 1);
    assert.equal(body.tenant.code, 'acme-trading');
    for (const table of ['business_partners', 'items', 'accounts', 'memberships', 'roles', 'audit_events']) assert.ok(Array.isArray(body.tables[table]), table);
    assert.equal(body.tables.idempotency_keys, undefined);
    assert.ok((body.tables.accounts?.length ?? 0) > 0);
    assert.ok(body.tables.accounts?.every((row) => row.tenant_id === tenantId));
    assert.ok(!JSON.stringify(body).includes('token_hash'));
    assert.ok(!JSON.stringify(body).includes('password_hash'));
  });

  it('records a confirmed deletion request, restricts the company to export, and lets an operator restore it', async () => {
    assert.equal((await ctx.http.post('/v1/tenant/deletion-request').set(bearer(owner)).send({ confirmCode: 'wrong', reason: 'Closing the business' })).status, 400);
    const requested = await ctx.http.post('/v1/tenant/deletion-request').set(bearer(owner)).send({ confirmCode: 'acme-trading', reason: 'Closing the business' });
    assert.equal(requested.status, 204, JSON.stringify(requested.body));
    const restricted = await ctx.http.post('/v1/inv/units').set(bearer(owner)).send({ code: 'RST', name: 'Restricted', decimals: 0 });
    assert.equal(restricted.status, 403);
    assert.equal((await ctx.http.get('/v1/tenant/export').set(bearer(owner))).status, 200);
    const relogin = (await ctx.http.post('/v1/auth/login').send({ email: ACME_OWNER, password: ctx.password })).body.accessToken as string;
    const tenants = (await ctx.http.get('/v1/auth/tenants').set(bearer(relogin))).body as { code: string; accessMode: string }[];
    assert.equal(tenants.find((row) => row.code === 'acme-trading')?.accessMode, 'restricted_export');

    const globex = (await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX)).token;
    assert.equal((await ctx.http.post('/v1/inv/units').set(bearer(globex)).send({ code: 'GLB', name: 'Globex unit', decimals: 0 })).status, 201);

    const operator = await operatorLogin(ctx);
    assert.equal((await ctx.http.post(`/v1/platform/tenants/${tenantId}/restore`).set(bearer(operator)).send({ reason: 'Customer withdrew the request' })).status, 204);
    assert.equal((await ctx.http.post(`/v1/platform/tenants/${tenantId}/restore`).set(bearer(operator)).send({ reason: 'Again' })).status, 409);
    assert.equal((await ctx.http.post('/v1/inv/units').set(bearer(owner)).send({ code: 'RST', name: 'Restored', decimals: 0 })).status, 201);
    const events = await ctx.asApp.selectFrom('platform_audit_events').select('action').where('action', 'in', ['tenant.deletion_requested', 'tenant.restored']).orderBy('occurred_at').execute();
    assert.deepEqual(events.map((event) => event.action), ['tenant.deletion_requested', 'tenant.restored']);
  });
});
