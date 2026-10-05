import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { createPool } from '../src/database/database.service.js';
import type { Database } from '../src/database/schema.js';
import type { SupportGrant, SupportSessionResponse } from '@nec/contracts';
import { ACME, ACME_OWNER, bearer, loginToTenant, operatorLogin, setup, type TestContext } from './helpers.js';

describe('Time-limited support access', () => {
  let ctx: TestContext;
  let owner: string;
  let operator: string;
  let tenantId: string;

  const openSession = () => ctx.http.post(`/v1/platform/tenants/${tenantId}/support-session`).set(bearer(operator)).send({ reason: 'Ticket 4411: stock figures' });

  before(async () => {
    ctx = await setup();
    tenantId = ctx.tenantId(ACME);
    owner = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    operator = await operatorLogin(ctx);
  });

  after(async () => {
    await ctx.close();
  });

  it('requires a company grant and gives operators read-only, view-only access that is audited', async () => {
    const refused = await openSession();
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'SUPPORT_NOT_AUTHORIZED');
    assert.equal((await ctx.http.post('/v1/tenant/support-access').set(bearer(owner)).send({ hours: 0, reason: 'x' })).status, 400);
    const granted = await ctx.http.post('/v1/tenant/support-access').set(bearer(owner)).send({ hours: 2, reason: 'Help with stock figures' });
    assert.equal(granted.status, 201, JSON.stringify(granted.body));
    assert.equal((granted.body as SupportGrant).active, true);

    const session = await openSession();
    assert.equal(session.status, 200, JSON.stringify(session.body));
    const support = (session.body as SupportSessionResponse).accessToken;
    assert.equal((session.body as SupportSessionResponse).tenant.code, 'acme-trading');
    assert.equal((await ctx.http.get('/v1/inv/items').set(bearer(support))).status, 200);
    assert.equal((await ctx.http.get('/v1/fin/accounts').set(bearer(support))).status, 200);
    const write = await ctx.http.post('/v1/inv/units').set(bearer(support)).send({ code: 'SUP', name: 'Support unit', decimals: 0 });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'SUPPORT_ACCESS_DENIED');
    assert.match(write.body.error.message, /read-only/);
    assert.equal((await ctx.http.get('/v1/auth/tenants').set(bearer(support))).status, 403);
    assert.equal((await ctx.http.get('/v1/platform/tenants').set(bearer(support))).status, 401);

    const tenantAudit = await ctx.asApp.transaction().execute(async (trx) => {
      await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      return trx.selectFrom('audit_events').select(['action', 'actor_type']).where('action', 'like', 'support_access.%').orderBy('occurred_at').execute();
    });
    assert.deepEqual(tenantAudit.map((row) => [row.action, row.actor_type]), [['support_access.granted', 'user'], ['support_access.session_started', 'operator']]);
    const requests = await ctx.asApp.selectFrom('platform_audit_events').select('details').where('action', '=', 'support.request').execute();
    assert.ok(requests.length >= 3);
  });

  it('stops working as soon as the company revokes the grant or it expires', async () => {
    const grants = (await ctx.http.get('/v1/tenant/support-access').set(bearer(owner))).body as SupportGrant[];
    const active = grants.find((grant) => grant.active) as SupportGrant;
    const support = ((await openSession()).body as SupportSessionResponse).accessToken;
    assert.equal((await ctx.http.get('/v1/inv/items').set(bearer(support))).status, 200);
    assert.equal((await ctx.http.delete(`/v1/tenant/support-access/${active.id}`).set(bearer(owner))).status, 204);
    const denied = await ctx.http.get('/v1/inv/items').set(bearer(support));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'SUPPORT_ACCESS_DENIED');
    assert.equal((await openSession()).status, 403);

    assert.equal((await ctx.http.post('/v1/tenant/support-access').set(bearer(owner)).send({ hours: 1, reason: 'Second look' })).status, 201);
    const again = ((await openSession()).body as SupportSessionResponse).accessToken;
    const asOwner = new Kysely<Database>({ dialect: new PostgresDialect({ pool: createPool(ctx.config, ctx.config.DB_OWNER_USER, ctx.config.DB_OWNER_PASSWORD) }) });
    try {
      await asOwner.transaction().execute(async (trx) => {
        await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
        await sql`update support_grants set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where revoked_at is null`.execute(trx);
      });
    } finally {
      await asOwner.destroy();
    }
    assert.equal((await ctx.http.get('/v1/inv/items').set(bearer(again))).status, 403);
    const listed = (await ctx.http.get('/v1/tenant/support-access').set(bearer(owner))).body as SupportGrant[];
    assert.deepEqual(listed.map((grant) => grant.active), [false, false]);
  });
});
