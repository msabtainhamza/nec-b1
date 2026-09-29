import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ACME, ACME_OWNER, bearer, login, loginToTenant, setup, SHARED, type TestContext } from './helpers.js';

describe('authentication and sessions', () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await setup();
  });

  after(async () => {
    await ctx.close();
  });

  it('lists only the tenants the user belongs to', async () => {
    const shared = await login(ctx, SHARED);
    assert.deepEqual(shared.tenants.map((tenant) => tenant.code).sort(), ['acme-trading', 'globex-distribution']);
    const owner = await login(ctx, ACME_OWNER);
    assert.deepEqual(owner.tenants.map((tenant) => tenant.code), ['acme-trading']);
  });

  it('rejects an incorrect password without revealing which field was wrong', async () => {
    const wrongPassword = await ctx.http.post('/v1/auth/login').send({ email: ACME_OWNER, password: 'not-the-password' });
    const unknownUser = await ctx.http.post('/v1/auth/login').send({ email: 'nobody@nec-erp.localhost', password: 'not-the-password' });
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownUser.status, 401);
    assert.equal(wrongPassword.body.error.message, unknownUser.body.error.message);
  });

  it('requires authentication for tenant routes and a selected tenant for tenant data', async () => {
    const anonymous = await ctx.http.get('/v1/tenant/branches');
    assert.equal(anonymous.status, 401);
    const session = await login(ctx, ACME_OWNER);
    const noTenant = await ctx.http.get('/v1/tenant/branches').set(bearer(session.accessToken));
    assert.equal(noTenant.status, 403);
    assert.equal(noTenant.body.error.code, 'TENANT_NOT_SELECTED');
  });

  it('rotates refresh tokens and revokes the session when a used token is replayed', async () => {
    const session = await login(ctx, ACME_OWNER);
    const first = await ctx.http.post('/v1/auth/refresh').send({ refreshToken: session.refreshToken });
    assert.equal(first.status, 200);
    assert.notEqual(first.body.refreshToken, session.refreshToken);
    const replay = await ctx.http.post('/v1/auth/refresh').send({ refreshToken: session.refreshToken });
    assert.equal(replay.status, 401);
    const afterReplay = await ctx.http.post('/v1/auth/refresh').send({ refreshToken: first.body.refreshToken });
    assert.equal(afterReplay.status, 401);
    const access = await ctx.http.get('/v1/auth/tenants').set(bearer(first.body.accessToken));
    assert.equal(access.status, 401);
  });

  it('keeps the active tenant across refresh', async () => {
    const { login: session } = await loginToTenant(ctx, ACME_OWNER, ACME);
    const refreshed = await ctx.http.post('/v1/auth/refresh').send({ refreshToken: session.refreshToken });
    assert.equal(refreshed.status, 200);
    const context = await ctx.http.get('/v1/tenant/context').set(bearer(refreshed.body.accessToken));
    assert.equal(context.status, 200);
    assert.equal(context.body.tenant.code, ACME);
  });

  it('logs out and revokes other sessions', async () => {
    const first = await login(ctx, ACME_OWNER);
    await login(ctx, ACME_OWNER);
    const sessions = await ctx.http.get('/v1/auth/sessions').set(bearer(first.accessToken));
    assert.equal(sessions.status, 200);
    const other = (sessions.body as { id: string; current: boolean }[]).find((row) => !row.current);
    assert.ok(other);
    const revoked = await ctx.http.delete(`/v1/auth/sessions/${other.id}`).set(bearer(first.accessToken));
    assert.equal(revoked.status, 204);
    const logout = await ctx.http.post('/v1/auth/logout').set(bearer(first.accessToken));
    assert.equal(logout.status, 204);
    const afterLogout = await ctx.http.get('/v1/auth/tenants').set(bearer(first.accessToken));
    assert.equal(afterLogout.status, 401);
    const refreshFirst = await ctx.http.post('/v1/auth/refresh').send({ refreshToken: first.refreshToken });
    assert.equal(refreshFirst.status, 401);
  });

  it('does not accept a user token on platform routes', async () => {
    const session = await login(ctx, ACME_OWNER);
    const response = await ctx.http.get('/v1/platform/tenants').set(bearer(session.accessToken));
    assert.equal(response.status, 401);
  });
});
