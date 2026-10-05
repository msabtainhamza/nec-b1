import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Member, Role } from '@nec/contracts';
import { ACME, ACME_OWNER, bearer, GLOBEX, GLOBEX_OWNER, loginToTenant, setup, type TestContext } from './helpers.js';

describe('Custom roles and member role assignment', () => {
  let ctx: TestContext;
  let owner: string;
  let admin: string;
  let clerk: () => Promise<string>;
  let roles: Role[];
  let custom: Role;

  const members = async () => (await ctx.http.get('/v1/tenant/members').set(bearer(owner))).body as Member[];
  const member = async (email: string) => (await members()).find((row) => row.email === email) as Member;
  const role = (code: string) => roles.find((row) => row.code === code) as Role;

  before(async () => {
    ctx = await setup();
    owner = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    roles = (await ctx.http.get('/v1/tenant/roles').set(bearer(owner))).body as Role[];
    for (const [email, code] of [['roles.admin@nec-erp.localhost', 'administrator'], ['roles.clerk@nec-erp.localhost', 'auditor']] as const) {
      assert.equal((await ctx.http.post('/v1/tenant/invitations').set(bearer(owner)).send({ email, roleIds: [role(code).id] })).status, 201);
      assert.equal((await ctx.http.post('/v1/invitations/accept').send({ token: ctx.mailer.tokenFor(email), password: ctx.password, displayName: email })).status, 200);
    }
    admin = (await loginToTenant(ctx, 'roles.admin@nec-erp.localhost', ACME)).token;
    clerk = async () => (await loginToTenant(ctx, 'roles.clerk@nec-erp.localhost', ACME)).token;
  });

  after(async () => {
    await ctx.close();
  });

  it('creates custom roles only from permissions the creator holds', async () => {
    const created = await ctx.http.post('/v1/tenant/roles').set(bearer(owner)).send({ code: 'stock_viewer', name: 'Stock viewer', permissions: ['inv.stock.view', 'inv.item.view', 'inv.item.view'] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    custom = created.body as Role;
    assert.deepEqual([custom.isSystem, custom.permissions], [false, ['inv.item.view', 'inv.stock.view']]);
    assert.equal((await ctx.http.post('/v1/tenant/roles').set(bearer(owner)).send({ code: 'stock_viewer', name: 'Again', permissions: ['inv.item.view'] })).status, 409);
    assert.equal((await ctx.http.post('/v1/tenant/roles').set(bearer(owner)).send({ code: 'bad', name: 'Bad', permissions: ['made.up.permission'] })).status, 400);
    assert.equal((await ctx.http.post('/v1/tenant/roles').set(bearer(admin)).send({ code: 'exporter', name: 'Exporter', permissions: ['admin.tenant.export'] })).status, 403);
    assert.equal((await ctx.http.put(`/v1/tenant/roles/${role('auditor').id}`).set(bearer(owner)).send({ name: 'Auditor', permissions: ['inv.item.view'] })).status, 409);
  });

  it('applies role changes to the member on the next request and keeps an active owner', async () => {
    const target = await member('roles.clerk@nec-erp.localhost');
    const token = await clerk();
    assert.equal((await ctx.http.get('/v1/fin/accounts').set(bearer(token))).status, 200);
    const changed = await ctx.http.put(`/v1/tenant/members/${target.membershipId}/roles`).set(bearer(owner)).send({ roleIds: [custom.id], version: target.version });
    assert.equal(changed.status, 204, JSON.stringify(changed.body));
    assert.equal((await ctx.http.put(`/v1/tenant/members/${target.membershipId}/roles`).set(bearer(owner)).send({ roleIds: [custom.id], version: target.version })).status, 409);
    assert.equal((await ctx.http.get('/v1/inv/items').set(bearer(token))).status, 200);
    assert.equal((await ctx.http.get('/v1/fin/accounts').set(bearer(token))).status, 403);
    assert.equal((await ctx.http.get('/v1/bp/partners').set(bearer(token))).status, 403);
    const updated = await ctx.http.put(`/v1/tenant/roles/${custom.id}`).set(bearer(owner)).send({ name: 'Stock and partners', permissions: ['inv.item.view', 'inv.stock.view', 'bp.partner.view'] });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal((await ctx.http.get('/v1/bp/partners').set(bearer(token))).status, 200);
    assert.deepEqual((await member('roles.clerk@nec-erp.localhost')).roles, ['stock_viewer']);

    const self = await member(ACME_OWNER);
    const lastOwner = await ctx.http.put(`/v1/tenant/members/${self.membershipId}/roles`).set(bearer(owner)).send({ roleIds: [role('administrator').id], version: self.version });
    assert.equal(lastOwner.status, 409);
    assert.match(lastOwner.body.error.message, /active owner/);
    assert.equal((await ctx.http.put(`/v1/tenant/members/${self.membershipId}/roles`).set(bearer(admin)).send({ roleIds: [role('auditor').id], version: self.version })).status, 403);
  });

  it('deletes a custom role only when nobody uses it and keeps roles company-specific', async () => {
    assert.equal((await ctx.http.delete(`/v1/tenant/roles/${custom.id}`).set(bearer(owner))).status, 409);
    assert.equal((await ctx.http.delete(`/v1/tenant/roles/${role('auditor').id}`).set(bearer(owner))).status, 409);
    const target = await member('roles.clerk@nec-erp.localhost');
    assert.equal((await ctx.http.put(`/v1/tenant/members/${target.membershipId}/roles`).set(bearer(owner)).send({ roleIds: [role('auditor').id], version: target.version })).status, 204);
    const globex = (await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX)).token;
    assert.equal((await ctx.http.delete(`/v1/tenant/roles/${custom.id}`).set(bearer(globex))).status, 404);
    assert.equal((await ctx.http.delete(`/v1/tenant/roles/${custom.id}`).set(bearer(owner))).status, 204);
    assert.ok(!((await ctx.http.get('/v1/tenant/roles').set(bearer(owner))).body as Role[]).some((row) => row.code === 'stock_viewer'));
  });
});
