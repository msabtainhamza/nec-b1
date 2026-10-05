import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { ApprovalRequestSummary, ApprovalTemplate, ItemGroup, PartnerGroup, Role, UnitOfMeasure } from '@nec/contracts';
import { ACME, ACME_OWNER, bearer, loginToTenant, setup, type TestContext } from './helpers.js';

const YEAR = new Date().getUTCFullYear();
const date = `${YEAR}-04-01`;

describe('Approval procedures', () => {
  let ctx: TestContext;
  let owner: string;
  let sales: string;
  let manager: string;
  let manager2: string;
  let approverRole: Role;
  let customerId: string;
  let vendorId: string;
  let serviceId: string;

  const invite = async (email: string, roleId: string) => {
    assert.equal((await ctx.http.post('/v1/tenant/invitations').set(bearer(owner)).send({ email, roleIds: [roleId] })).status, 201);
    assert.equal((await ctx.http.post('/v1/invitations/accept').send({ token: ctx.mailer.tokenFor(email), password: ctx.password, displayName: email.split('@')[0] })).status, 200);
    return (await loginToTenant(ctx, email, ACME)).token;
  };
  const salesOrder = (token: string, price: string, key = randomUUID()) =>
    ctx.http.post('/v1/sal/orders').set(bearer(token)).send({ idempotencyKey: key, customerId, postingDate: date, deliveryDate: date, lines: [{ itemId: serviceId, quantity: '1', unitPrice: price }] });
  const decide = (token: string, request: ApprovalRequestSummary, decision: 'approved' | 'rejected') =>
    ctx.http.post(`/v1/tenant/approvals/${request.id}/decision`).set(bearer(token)).send({ decision, remarks: `${decision} in test`, version: request.version });
  const fetch = async (id: string) => (await ctx.http.get(`/v1/tenant/approvals/${id}`).set(bearer(owner))).body as ApprovalRequestSummary;

  before(async () => {
    ctx = await setup();
    owner = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    const roles = (await ctx.http.get('/v1/tenant/roles').set(bearer(owner))).body as Role[];
    const created = await ctx.http.post('/v1/tenant/roles').set(bearer(owner)).send({ code: 'order_approver', name: 'Order approver', permissions: ['admin.approval.view', 'sal.order.view', 'sal.order.create', 'pur.order.view'] });
    approverRole = created.body as Role;
    sales = await invite('appr.sales@nec-erp.localhost', roles.find((r) => r.code === 'sales')?.id as string);
    manager = await invite('appr.manager@nec-erp.localhost', approverRole.id);
    manager2 = await invite('appr.manager2@nec-erp.localhost', approverRole.id);
    const groups = (await ctx.http.get('/v1/bp/groups').set(bearer(owner))).body as PartnerGroup[];
    const itemGroups = (await ctx.http.get('/v1/inv/item-groups').set(bearer(owner))).body as ItemGroup[];
    const units = (await ctx.http.get('/v1/inv/units').set(bearer(owner))).body as UnitOfMeasure[];
    customerId = (await ctx.http.post('/v1/bp/partners').set(bearer(owner)).send({ code: 'AP-C', partnerType: 'customer', name: 'Approval customer', groupId: groups.find((g) => g.partnerType === 'customer')?.id })).body.id;
    vendorId = (await ctx.http.post('/v1/bp/partners').set(bearer(owner)).send({ code: 'AP-V', partnerType: 'supplier', name: 'Approval vendor', groupId: groups.find((g) => g.partnerType === 'supplier')?.id })).body.id;
    serviceId = (await ctx.http.post('/v1/inv/items').set(bearer(owner)).send({ code: 'AP-SRV', name: 'Approval service', itemType: 'service', groupId: itemGroups[0]?.id, uomId: units.find((u) => u.code === 'EA')?.id })).body.id;
  });

  after(async () => {
    await ctx.close();
  });

  it('holds orders above the template amount for approval and lets the originator add them once approved', async () => {
    assert.equal((await ctx.http.post('/v1/tenant/approval-templates').set(bearer(sales)).send({ name: 'Large orders', documentType: 'sales_order', minTotal: '100', approverRoleId: approverRole.id, requiredApprovals: 1 })).status, 403);
    assert.equal((await ctx.http.post('/v1/tenant/approval-templates').set(bearer(owner)).send({ name: 'Bad', documentType: 'sales_order', minTotal: '100', approverRoleId: randomUUID(), requiredApprovals: 1 })).status, 400);
    const template = await ctx.http.post('/v1/tenant/approval-templates').set(bearer(owner)).send({ name: 'Large orders', documentType: 'sales_order', minTotal: '100', approverRoleId: approverRole.id, requiredApprovals: 1 });
    assert.equal(template.status, 201, JSON.stringify(template.body));
    assert.equal((template.body as ApprovalTemplate).approverRoleName, 'Order approver');

    assert.equal((await salesOrder(sales, '50')).status, 201);
    const key = randomUUID();
    const held = await salesOrder(sales, '150', key);
    assert.equal(held.status, 202, JSON.stringify(held.body));
    const request = held.body.request as ApprovalRequestSummary;
    assert.deepEqual([held.body.approvalRequired, request.status, request.total, request.approvals, request.requiredApprovals, request.documentId], [true, 'pending', '150.0000', 0, 1, null]);
    const replay = await salesOrder(sales, '150', key);
    assert.equal(replay.status, 202);
    assert.equal(replay.body.request.id, request.id);
    assert.equal(((await ctx.http.get('/v1/sal/orders').set(bearer(owner))).body as { total: number }).total, 1);

    assert.equal((await decide(sales, request, 'approved')).status, 403);
    const toDecide = (await ctx.http.get('/v1/tenant/approvals?scope=to_decide').set(bearer(manager))).body as ApprovalRequestSummary[];
    assert.deepEqual(toDecide.map((row) => row.id), [request.id]);
    assert.equal((await ctx.http.post(`/v1/tenant/approvals/${request.id}/complete`).set(bearer(sales)).send({})).status, 409);
    const approved = await decide(manager, request, 'approved');
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal((approved.body as ApprovalRequestSummary).status, 'approved');
    assert.equal((await decide(manager2, approved.body as ApprovalRequestSummary, 'approved')).status, 409);

    assert.equal((await ctx.http.post(`/v1/tenant/approvals/${request.id}/complete`).set(bearer(manager)).send({})).status, 403);
    const completed = await ctx.http.post(`/v1/tenant/approvals/${request.id}/complete`).set(bearer(sales)).send({});
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.request.status, 'completed');
    assert.match(completed.body.document.documentNumber, /^SO/);
    assert.equal(completed.body.request.documentNumber, completed.body.document.documentNumber);
    const again = await ctx.http.post(`/v1/tenant/approvals/${request.id}/complete`).set(bearer(sales)).send({});
    assert.equal(again.body.document.id, completed.body.document.id);
    assert.equal(((await ctx.http.get('/v1/sal/orders').set(bearer(owner))).body as { total: number }).total, 2);
  });

  it('rejects on any rejection, lets originators cancel, and never lets approvers decide their own documents', async () => {
    const rejected = (await salesOrder(sales, '200')).body.request as ApprovalRequestSummary;
    assert.equal(((await decide(manager, rejected, 'rejected')).body as ApprovalRequestSummary).status, 'rejected');
    assert.equal((await ctx.http.post(`/v1/tenant/approvals/${rejected.id}/complete`).set(bearer(sales)).send({})).status, 409);

    const cancelled = (await salesOrder(sales, '300')).body.request as ApprovalRequestSummary;
    assert.equal((await ctx.http.post(`/v1/tenant/approvals/${cancelled.id}/cancel`).set(bearer(manager)).send({})).status, 403);
    assert.equal(((await ctx.http.post(`/v1/tenant/approvals/${cancelled.id}/cancel`).set(bearer(sales)).send({})).body as ApprovalRequestSummary).status, 'cancelled');

    const own = await salesOrder(manager, '400');
    assert.equal(own.status, 202);
    const ownRequest = own.body.request as ApprovalRequestSummary;
    assert.equal(ownRequest.canDecide, false);
    assert.equal((await decide(manager, ownRequest, 'approved')).status, 403);
    assert.equal(((await decide(manager2, ownRequest, 'approved')).body as ApprovalRequestSummary).status, 'approved');
    const decisions = (await fetch(ownRequest.id)).decisions;
    assert.deepEqual(decisions.map((d) => [d.decision, d.remarks]), [['approved', 'approved in test']]);
  });

  it('requires the configured number of approvals for purchase orders', async () => {
    const template = await ctx.http.post('/v1/tenant/approval-templates').set(bearer(owner)).send({ name: 'All purchases', documentType: 'purchase_order', minTotal: '0', approverRoleId: approverRole.id, requiredApprovals: 2 });
    assert.equal(template.status, 201);
    const held = await ctx.http.post('/v1/pur/orders').set(bearer(owner)).send({ idempotencyKey: randomUUID(), vendorId, postingDate: date, deliveryDate: date, lines: [{ itemId: serviceId, quantity: '2', unitPrice: '10' }] });
    assert.equal(held.status, 202, JSON.stringify(held.body));
    const request = held.body.request as ApprovalRequestSummary;
    const first = (await decide(manager, request, 'approved')).body as ApprovalRequestSummary;
    assert.deepEqual([first.status, first.approvals], ['pending', 1]);
    const second = (await decide(manager2, first, 'approved')).body as ApprovalRequestSummary;
    assert.equal(second.status, 'approved');
    const completed = await ctx.http.post(`/v1/tenant/approvals/${request.id}/complete`).set(bearer(owner)).send({});
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.match(completed.body.document.documentNumber, /^PO/);
    const off = await ctx.http.put(`/v1/tenant/approval-templates/${template.body.id}`).set(bearer(owner)).send({ ...template.body, minTotal: '0', active: false, version: template.body.version });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal((await ctx.http.post('/v1/pur/orders').set(bearer(owner)).send({ idempotencyKey: randomUUID(), vendorId, postingDate: date, deliveryDate: date, lines: [{ itemId: serviceId, quantity: '1', unitPrice: '10' }] })).status, 201);
  });
});
