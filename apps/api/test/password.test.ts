import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ACME, ACME_OWNER, bearer, loginToTenant, setup, type TestContext } from './helpers.js';

const EMAIL = 'reset.user@nec-erp.localhost';
const NEW_PASSWORD = 'A-new-and-long-password-1';

describe('Password reset and change', () => {
  let ctx: TestContext;

  const login = (password: string, email = EMAIL) => ctx.http.post('/v1/auth/login').send({ email, password });

  before(async () => {
    ctx = await setup();
    const owner = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    const roles = (await ctx.http.get('/v1/tenant/roles').set(bearer(owner))).body as { id: string; code: string }[];
    assert.equal((await ctx.http.post('/v1/tenant/invitations').set(bearer(owner)).send({ email: EMAIL, roleIds: [roles.find((r) => r.code === 'auditor')?.id] })).status, 201);
    assert.equal((await ctx.http.post('/v1/invitations/accept').send({ token: ctx.mailer.tokenFor(EMAIL), password: ctx.password, displayName: 'Reset User' })).status, 200);
  });

  after(async () => {
    await ctx.close();
  });

  it('accepts reset requests without revealing accounts and resets with a single-use code that revokes sessions', async () => {
    const sent = ctx.mailer.messages.length;
    assert.equal((await ctx.http.post('/v1/auth/password-reset/request').send({ email: 'nobody@nec-erp.localhost' })).status, 202);
    assert.equal(ctx.mailer.messages.length, sent);
    const before = await login(ctx.password);
    assert.equal(before.status, 200);

    assert.equal((await ctx.http.post('/v1/auth/password-reset/request').send({ email: 'Reset.User@NEC-ERP.localhost' })).status, 202);
    const first = ctx.mailer.tokenFor(EMAIL);
    assert.equal((await ctx.http.post('/v1/auth/password-reset/request').send({ email: EMAIL })).status, 202);
    const second = ctx.mailer.tokenFor(EMAIL);
    assert.notEqual(first, second);
    assert.equal((await ctx.http.post('/v1/auth/password-reset/confirm').send({ token: first, password: NEW_PASSWORD })).status, 400);
    assert.equal((await ctx.http.post('/v1/auth/password-reset/confirm').send({ token: second, password: 'short' })).status, 400);

    const confirmed = await ctx.http.post('/v1/auth/password-reset/confirm').send({ token: second, password: NEW_PASSWORD });
    assert.equal(confirmed.status, 204, JSON.stringify(confirmed.body));
    assert.equal((await ctx.http.post('/v1/auth/password-reset/confirm').send({ token: second, password: NEW_PASSWORD })).body.error.code, 'RESET_TOKEN_INVALID');
    assert.equal((await ctx.http.post('/v1/auth/refresh').send({ refreshToken: before.body.refreshToken })).status, 401);
    assert.equal((await login(ctx.password)).status, 401);
    assert.equal((await login(NEW_PASSWORD)).status, 200);

    assert.equal((await ctx.http.post('/v1/auth/password-reset/request').send({ email: EMAIL })).status, 202);
    const expired = ctx.mailer.tokenFor(EMAIL);
    await ctx.asApp.updateTable('password_reset_tokens').set({ expires_at: new Date(Date.now() - 1000) }).where('used_at', 'is', null).execute();
    assert.equal((await ctx.http.post('/v1/auth/password-reset/confirm').send({ token: expired, password: 'Yet-another-long-password-2' })).status, 400);
  });

  it('changes the password with the current one and revokes the other sessions only', async () => {
    const current = await login(NEW_PASSWORD);
    const other = await login(NEW_PASSWORD);
    const auth = bearer(current.body.accessToken);
    assert.equal((await ctx.http.post('/v1/auth/password').set(auth).send({ currentPassword: 'wrong-password', newPassword: 'Changed-long-password-3' })).status, 401);
    assert.equal((await ctx.http.post('/v1/auth/password').set(auth).send({ currentPassword: NEW_PASSWORD, newPassword: NEW_PASSWORD })).status, 400);
    const changed = await ctx.http.post('/v1/auth/password').set(auth).send({ currentPassword: NEW_PASSWORD, newPassword: 'Changed-long-password-3' });
    assert.equal(changed.status, 204, JSON.stringify(changed.body));
    assert.equal((await ctx.http.post('/v1/auth/refresh').send({ refreshToken: other.body.refreshToken })).status, 401);
    assert.equal((await ctx.http.post('/v1/auth/refresh').send({ refreshToken: current.body.refreshToken })).status, 200);
    assert.equal((await login('Changed-long-password-3')).status, 200);
    assert.equal((await ctx.http.post('/v1/auth/password').send({ currentPassword: 'x', newPassword: 'Changed-long-password-4' })).status, 401);
  });
});
