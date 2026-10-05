import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { LoginResult, MfaEnableResponse, MfaSetupResponse, MfaStatus, SecuritySettings } from '@nec/contracts';
import { currentTotp } from '../src/auth/totp.js';
import { ACME, ACME_OWNER, bearer, loginToTenant, operatorLogin, setup, type TestContext } from './helpers.js';

const ADMIN = 'mfa.admin@nec-erp.localhost';
const CLERK = 'mfa.clerk@nec-erp.localhost';

describe('Two-factor authentication', () => {
  let ctx: TestContext;
  let tenantId: string;
  let secret: string;
  let recovery: string[];

  const login = async (email: string) => (await ctx.http.post('/v1/auth/login').send({ email, password: ctx.password })).body as LoginResult;
  const userToken = async (email: string) => {
    const result = await login(email);
    assert.ok('accessToken' in result, JSON.stringify(result));
    return result.accessToken;
  };

  before(async () => {
    ctx = await setup();
    tenantId = ctx.tenantId(ACME);
    const owner = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    const roles = (await ctx.http.get('/v1/tenant/roles').set(bearer(owner))).body as { id: string; code: string }[];
    for (const [email, role] of [[ADMIN, 'administrator'], [CLERK, 'auditor']] as const) {
      assert.equal((await ctx.http.post('/v1/tenant/invitations').set(bearer(owner)).send({ email, roleIds: [roles.find((r) => r.code === role)?.id] })).status, 201);
      assert.equal((await ctx.http.post('/v1/invitations/accept').send({ token: ctx.mailer.tokenFor(email), password: ctx.password, displayName: email })).status, 200);
    }
  });

  after(async () => {
    await ctx.close();
  });

  it('enrols with an authenticator code, stores the secret encrypted and issues recovery codes', async () => {
    const token = await userToken(ADMIN);
    const started = await ctx.http.post('/v1/auth/mfa/setup').set(bearer(token));
    assert.equal(started.status, 200, JSON.stringify(started.body));
    secret = (started.body as MfaSetupResponse).secret;
    assert.match((started.body as MfaSetupResponse).uri, /^otpauth:\/\/totp\//);
    assert.deepEqual((await ctx.http.get('/v1/auth/mfa').set(bearer(token))).body, { enabled: false, pending: true, recoveryCodesRemaining: 0 });
    assert.equal((await ctx.http.post('/v1/auth/mfa/enable').set(bearer(token)).send({ code: '000000' })).status, 400);
    const enabled = await ctx.http.post('/v1/auth/mfa/enable').set(bearer(token)).send({ code: currentTotp(secret) });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    recovery = (enabled.body as MfaEnableResponse).recoveryCodes;
    assert.equal(recovery.length, 10);
    assert.equal(new Set(recovery).size, 10);
    assert.equal((await ctx.http.post('/v1/auth/mfa/setup').set(bearer(token))).status, 409);
    const stored = await ctx.asApp.selectFrom('user_mfa').select('secret_encrypted').executeTakeFirstOrThrow();
    assert.match(stored.secret_encrypted, /^v1:/);
    assert.ok(!stored.secret_encrypted.includes(secret));
  });

  it('requires a second step at login and rejects replayed, wrong and reused codes', async () => {
    const challenge = await login(ADMIN);
    assert.ok('mfaRequired' in challenge && challenge.mfaRequired);
    assert.equal((await ctx.http.post('/v1/auth/login/mfa').send({ challengeToken: challenge.challengeToken, code: '123456' })).status, 401);
    assert.equal((await ctx.http.post('/v1/auth/login/mfa').send({ challengeToken: challenge.challengeToken, code: currentTotp(secret) })).status, 401);
    const withRecovery = await ctx.http.post('/v1/auth/login/mfa').send({ challengeToken: challenge.challengeToken, code: recovery[0]?.toUpperCase() });
    assert.equal(withRecovery.status, 200, JSON.stringify(withRecovery.body));
    assert.equal((await ctx.http.post('/v1/auth/login/mfa').send({ challengeToken: challenge.challengeToken, code: recovery[1] })).status, 401);
    const next = await login(ADMIN);
    assert.ok('mfaRequired' in next);
    assert.equal((await ctx.http.post('/v1/auth/login/mfa').send({ challengeToken: next.challengeToken, code: recovery[0] })).status, 401);
    await ctx.asApp.updateTable('user_mfa').set({ last_counter: 0 }).execute();
    const totp = await ctx.http.post('/v1/auth/login/mfa').send({ challengeToken: next.challengeToken, code: currentTotp(secret) });
    assert.equal(totp.status, 200, JSON.stringify(totp.body));
    assert.equal(((await ctx.http.get('/v1/auth/mfa').set(bearer(totp.body.accessToken))).body as MfaStatus).recoveryCodesRemaining, 9);

    const locked = await login(ADMIN);
    assert.ok('mfaRequired' in locked);
    for (let attempt = 0; attempt < 5; attempt += 1) await ctx.http.post('/v1/auth/login/mfa').send({ challengeToken: locked.challengeToken, code: '111111' });
    await ctx.asApp.updateTable('user_mfa').set({ last_counter: 0 }).execute();
    assert.equal((await ctx.http.post('/v1/auth/login/mfa').send({ challengeToken: locked.challengeToken, code: currentTotp(secret) })).status, 401);
  });

  it('lets an administrator with two-factor require it for other administrators of the company', async () => {
    const challenge = await login(ADMIN);
    assert.ok('mfaRequired' in challenge);
    const admin = (await ctx.http.post('/v1/auth/login/mfa').send({ challengeToken: challenge.challengeToken, code: recovery[2] })).body.accessToken as string;
    const adminTenant = (await ctx.http.post('/v1/auth/select-tenant').set(bearer(admin)).send({ tenantId })).body.accessToken as string;
    const clerkUser = await userToken(CLERK);
    const clerkTenant = (await ctx.http.post('/v1/auth/select-tenant').set(bearer(clerkUser)).send({ tenantId })).body.accessToken as string;
    const owner = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;

    assert.deepEqual((await ctx.http.get('/v1/tenant/security-settings').set(bearer(owner))).body, { requireAdminMfa: false, version: 0 });
    assert.equal((await ctx.http.put('/v1/tenant/security-settings').set(bearer(clerkTenant)).send({ requireAdminMfa: true, version: 0 })).status, 403);
    assert.equal((await ctx.http.put('/v1/tenant/security-settings').set(bearer(owner)).send({ requireAdminMfa: true, version: 0 })).status, 409);
    const required = await ctx.http.put('/v1/tenant/security-settings').set(bearer(adminTenant)).send({ requireAdminMfa: true, version: 0 });
    assert.equal(required.status, 200, JSON.stringify(required.body));
    assert.deepEqual(required.body as SecuritySettings, { requireAdminMfa: true, version: 1 });

    const ownerUser = await userToken(ACME_OWNER);
    const refused = await ctx.http.post('/v1/auth/select-tenant').set(bearer(ownerUser)).send({ tenantId });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'MFA_REQUIRED');
    const clerkAgain = await userToken(CLERK);
    assert.equal((await ctx.http.post('/v1/auth/select-tenant').set(bearer(clerkAgain)).send({ tenantId })).status, 200);
    assert.equal((await ctx.http.put('/v1/tenant/security-settings').set(bearer(adminTenant)).send({ requireAdminMfa: false, version: 1 })).status, 200);
  });

  it('disables two-factor only with the password and a valid code', async () => {
    const challenge = await login(ADMIN);
    assert.ok('mfaRequired' in challenge);
    const token = (await ctx.http.post('/v1/auth/login/mfa').send({ challengeToken: challenge.challengeToken, code: recovery[3] })).body.accessToken as string;
    assert.equal((await ctx.http.post('/v1/auth/mfa/disable').set(bearer(token)).send({ password: 'wrong-password', code: recovery[4] })).status, 401);
    assert.equal((await ctx.http.post('/v1/auth/mfa/disable').set(bearer(token)).send({ password: ctx.password, code: recovery[0] })).status, 400);
    assert.equal((await ctx.http.post('/v1/auth/mfa/disable').set(bearer(token)).send({ password: ctx.password, code: recovery[4] })).status, 204);
    assert.ok('accessToken' in (await login(ADMIN)));
    assert.equal(Number((await ctx.asApp.selectFrom('user_mfa_recovery_codes').select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow()).count), 0);
  });

  it('keeps operator sign-in working and encrypts the operator secret after sign-in', async () => {
    await operatorLogin(ctx);
    const operator = await ctx.asApp.selectFrom('platform_operators').select('totp_secret').executeTakeFirstOrThrow();
    assert.match(operator.totp_secret, /^v1:/);
  });
});
