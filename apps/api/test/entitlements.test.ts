import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Member, Role } from '@nec/contracts';
import { ACME, ACME_OWNER, bearer, GLOBEX, GLOBEX_OWNER, login, loginToTenant, setup, SHARED, type TestContext } from './helpers.js';

describe('plan limits, invitations and roles', () => {
  let ctx: TestContext;
  let acmeOwner: string;
  let acmeRoles: Role[];

  before(async () => {
    ctx = await setup();
    acmeOwner = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    acmeRoles = (await ctx.http.get('/v1/tenant/roles').set(bearer(acmeOwner))).body as Role[];
  });

  after(async () => {
    await ctx.close();
  });

  const roleId = (code: string) => {
    const role = acmeRoles.find((candidate) => candidate.code === code);
    assert.ok(role, `role ${code} exists`);
    return role.id;
  };

  it('allows concurrent invitations only up to the seat limit', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        ctx.http
          .post('/v1/tenant/invitations')
          .set(bearer(acmeOwner))
          .send({ email: `invitee${index}@nec-erp.localhost`, roleIds: [roleId('auditor')] }),
      ),
    );
    const statuses = responses.map((response) => response.status).sort();
    assert.deepEqual(statuses, [201, 201, 201, 422, 422]);
    const rejected = responses.find((response) => response.status === 422);
    assert.equal(rejected?.body.error.code, 'PLAN_LIMIT_EXCEEDED');
    assert.match(rejected?.body.error.message, /allows 5 active seats/);
  });

  it('rejects an invitation when the smaller plan is already full', async () => {
    const globex = await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX);
    const roles = (await ctx.http.get('/v1/tenant/roles').set(bearer(globex.token))).body as Role[];
    const response = await ctx.http
      .post('/v1/tenant/invitations')
      .set(bearer(globex.token))
      .send({ email: 'extra@nec-erp.localhost', roleIds: [roles[0]?.id] });
    assert.equal(response.status, 422);
    assert.equal(response.body.error.details.limit, 2);
  });

  it('accepts an emailed invitation and creates a verified login', async () => {
    const pending = await ctx.http.get('/v1/tenant/invitations').set(bearer(acmeOwner));
    const email = (pending.body as { email: string }[])[0]?.email;
    assert.ok(email);
    const token = ctx.mailer.tokenFor(email);
    const accepted = await ctx.http
      .post('/v1/invitations/accept')
      .send({ token, password: ctx.password, displayName: 'New Auditor' });
    assert.equal(accepted.status, 200);
    const reused = await ctx.http.post('/v1/invitations/accept').send({ token, password: ctx.password, displayName: 'Again' });
    assert.equal(reused.status, 400);
    const session = await login(ctx, email);
    assert.deepEqual(session.tenants.map((tenant) => tenant.code), [ACME]);
  });

  it('frees a seat when an invitation is revoked and checks the limit on reactivation', async () => {
    const pending = (await ctx.http.get('/v1/tenant/invitations').set(bearer(acmeOwner))).body as { id: string }[];
    assert.ok(pending[0]);
    const revoked = await ctx.http.delete(`/v1/tenant/invitations/${pending[0].id}`).set(bearer(acmeOwner));
    assert.equal(revoked.status, 204);

    const members = (await ctx.http.get('/v1/tenant/members').set(bearer(acmeOwner))).body as Member[];
    const auditor = members.find((member) => member.displayName === 'New Auditor');
    assert.ok(auditor);
    const disabled = await ctx.http
      .patch(`/v1/tenant/members/${auditor.membershipId}/status`)
      .set(bearer(acmeOwner))
      .send({ status: 'disabled', version: auditor.version });
    assert.equal(disabled.status, 204);

    const fillers = await Promise.all(
      ['filler1@nec-erp.localhost', 'filler2@nec-erp.localhost'].map((email) =>
        ctx.http.post('/v1/tenant/invitations').set(bearer(acmeOwner)).send({ email, roleIds: [roleId('auditor')] }),
      ),
    );
    assert.deepEqual(fillers.map((response) => response.status), [201, 201]);

    const reactivate = await ctx.http
      .patch(`/v1/tenant/members/${auditor.membershipId}/status`)
      .set(bearer(acmeOwner))
      .send({ status: 'active', version: auditor.version + 1 });
    assert.equal(reactivate.status, 422);
    assert.equal(reactivate.body.error.code, 'PLAN_LIMIT_EXCEEDED');

    const stale = await ctx.http
      .patch(`/v1/tenant/members/${auditor.membershipId}/status`)
      .set(bearer(acmeOwner))
      .send({ status: 'active', version: auditor.version });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  });

  it('allows concurrent branch creation only up to the branch limit', async () => {
    const before = (await ctx.http.get('/v1/tenant/branches').set(bearer(acmeOwner))).body as unknown[];
    const remaining = 3 - before.length;
    const responses = await Promise.all(
      ['B1', 'B2', 'B3'].map((code) => ctx.http.post('/v1/tenant/branches').set(bearer(acmeOwner)).send({ code, name: code })),
    );
    const created = responses.filter((response) => response.status === 201).length;
    assert.equal(created, Math.max(remaining, 0));
    assert.ok(responses.filter((response) => response.status !== 201).every((response) => response.body.error.code === 'PLAN_LIMIT_EXCEEDED'));
  });

  it('enforces permissions in the API and audits the denial', async () => {
    const auditor = await loginToTenant(ctx, SHARED, GLOBEX);
    const read = await ctx.http.get('/v1/tenant/branches').set(bearer(auditor.token));
    assert.equal(read.status, 200);
    const write = await ctx.http.post('/v1/tenant/branches').set(bearer(auditor.token)).send({ code: 'NO', name: 'Denied' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'FORBIDDEN');
    const globexOwner = await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX);
    const audit = await ctx.http.get('/v1/tenant/audit-events?limit=20').set(bearer(globexOwner.token));
    assert.equal(audit.status, 200);
    assert.ok(
      (audit.body.items as { action: string; outcome: string }[]).some(
        (event) => event.action === 'authorization.denied' && event.outcome === 'denied',
      ),
    );
  });

  it('prevents granting permissions the inviter does not hold', async () => {
    const administrator = await loginToTenant(ctx, SHARED, ACME);
    const response = await ctx.http
      .post('/v1/tenant/invitations')
      .set(bearer(administrator.token))
      .send({ email: 'escalate@nec-erp.localhost', roleIds: [roleId('owner')] });
    assert.equal(response.status, 403);
  });

  it('keeps at least one active owner', async () => {
    const administrator = await loginToTenant(ctx, SHARED, ACME);
    const members = (await ctx.http.get('/v1/tenant/members').set(bearer(administrator.token))).body as Member[];
    const owner = members.find((member) => member.roles.includes('owner'));
    assert.ok(owner);
    const response = await ctx.http
      .patch(`/v1/tenant/members/${owner.membershipId}/status`)
      .set(bearer(administrator.token))
      .send({ status: 'disabled', version: owner.version });
    assert.equal(response.status, 409);
  });
});
