import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  bearer,
  currentTotp,
  GLOBEX,
  GLOBEX_OWNER,
  login,
  loginToTenant,
  operatorLogin,
  setup,
  SHARED,
  type TestContext,
} from './helpers.js';

describe('platform operations and subscription access', () => {
  let ctx: TestContext;
  let operator: string;

  before(async () => {
    ctx = await setup();
    operator = await operatorLogin(ctx);
  });

  after(async () => {
    await ctx.close();
  });

  it('rejects a replayed or missing second factor', async () => {
    const credentials = { email: process.env.SEED_OPERATOR_EMAIL, password: process.env.SEED_OPERATOR_PASSWORD };
    const replay = await ctx.http.post('/v1/platform/auth/login').send({ ...credentials, totp: currentTotp() });
    assert.equal(replay.status, 401);
    const wrong = await ctx.http.post('/v1/platform/auth/login').send({ ...credentials, totp: '000000' });
    assert.equal(wrong.status, 401);
    const missing = await ctx.http.post('/v1/platform/auth/login').send(credentials);
    assert.equal(missing.status, 400);
  });

  it('does not accept an operator token on tenant routes', async () => {
    const response = await ctx.http.get('/v1/auth/tenants').set(bearer(operator));
    assert.equal(response.status, 401);
  });

  it('provisions a tenant atomically and emails the owner invitation', async () => {
    const body = {
      code: 'initech-supply',
      legalName: 'Initech Supply Local Test Company',
      displayName: 'Initech Supply',
      baseCurrency: 'USD',
      timeZone: 'UTC',
      planCode: 'micro',
      defaultBranch: { code: 'HQ', name: 'Head Office' },
      ownerEmail: 'owner.initech@nec-erp.localhost',
    };
    const created = await ctx.http.post('/v1/platform/tenants').set(bearer(operator)).send(body);
    assert.equal(created.status, 201);
    assert.equal(created.body.mailSent, true);
    const duplicate = await ctx.http.post('/v1/platform/tenants').set(bearer(operator)).send(body);
    assert.equal(duplicate.status, 409);
    const missingPlan = await ctx.http
      .post('/v1/platform/tenants')
      .set(bearer(operator))
      .send({ ...body, code: 'no-plan-co', planCode: 'does-not-exist' });
    assert.equal(missingPlan.status, 404);
    const tenants = await ctx.http.get('/v1/platform/tenants').set(bearer(operator));
    assert.ok(!(tenants.body as { code: string }[]).some((tenant) => tenant.code === 'no-plan-co'));

    const token = ctx.mailer.tokenFor(body.ownerEmail);
    const accepted = await ctx.http
      .post('/v1/invitations/accept')
      .send({ token, password: ctx.password, displayName: 'Initech Owner' });
    assert.equal(accepted.status, 200);
    const session = await login(ctx, body.ownerEmail);
    assert.deepEqual(session.tenants.map((tenant) => tenant.code), ['initech-supply']);
  });

  it('restricts a suspended tenant to read and export for authorized administrators', async () => {
    const tenants = (await ctx.http.get('/v1/platform/tenants').set(bearer(operator))).body as {
      id: string;
      code: string;
      subscriptionVersion: number;
    }[];
    const globex = tenants.find((tenant) => tenant.code === GLOBEX);
    assert.ok(globex);
    const suspend = await ctx.http
      .post(`/v1/platform/tenants/${globex.id}/subscription`)
      .set(bearer(operator))
      .send({ state: 'suspended', version: globex.subscriptionVersion, reason: 'Test suspension' });
    assert.equal(suspend.status, 204);

    const owner = await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX);
    const read = await ctx.http.get('/v1/tenant/branches').set(bearer(owner.token));
    assert.equal(read.status, 200);
    const write = await ctx.http.post('/v1/tenant/branches').set(bearer(owner.token)).send({ code: 'S1', name: 'Blocked' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'SUBSCRIPTION_RESTRICTED');

    const auditor = await loginToTenant(ctx, SHARED, GLOBEX);
    const auditorRead = await ctx.http.get('/v1/tenant/branches').set(bearer(auditor.token));
    assert.equal(auditorRead.status, 403);
    assert.equal(auditorRead.body.error.code, 'SUBSCRIPTION_RESTRICTED');

    const stale = await ctx.http
      .post(`/v1/platform/tenants/${globex.id}/subscription`)
      .set(bearer(operator))
      .send({ state: 'active', version: globex.subscriptionVersion, reason: 'Stale' });
    assert.equal(stale.status, 409);

    const restore = await ctx.http
      .post(`/v1/platform/tenants/${globex.id}/subscription`)
      .set(bearer(operator))
      .send({ state: 'active', version: globex.subscriptionVersion + 1, reason: 'Payment received' });
    assert.equal(restore.status, 204);
    const afterRestore = await ctx.http.get('/v1/tenant/branches').set(bearer(auditor.token));
    assert.equal(afterRestore.status, 200);
  });

  it('hides tenants whose retention window has ended', async () => {
    const tenants = (await ctx.http.get('/v1/platform/tenants').set(bearer(operator))).body as {
      id: string;
      code: string;
      subscriptionVersion: number;
    }[];
    const initech = tenants.find((tenant) => tenant.code === 'initech-supply');
    assert.ok(initech);
    const cancel = await ctx.http
      .post(`/v1/platform/tenants/${initech.id}/subscription`)
      .set(bearer(operator))
      .send({
        state: 'cancelled',
        retentionEndsAt: new Date(Date.now() - 1000).toISOString(),
        version: initech.subscriptionVersion,
        reason: 'Retention expired',
      });
    assert.equal(cancel.status, 204);
    const session = await login(ctx, 'owner.initech@nec-erp.localhost');
    assert.deepEqual(session.tenants, []);
    const select = await ctx.http
      .post('/v1/auth/select-tenant')
      .set(bearer(session.accessToken))
      .send({ tenantId: initech.id });
    assert.equal(select.status, 404);
  });
});
