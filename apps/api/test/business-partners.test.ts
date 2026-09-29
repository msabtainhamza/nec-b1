import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { BusinessPartner, PartnerGroup, PaymentTerms } from '@nec/contracts';
import { ACME, ACME_OWNER, bearer, GLOBEX, GLOBEX_OWNER, loginToTenant, setup, SHARED, type TestContext } from './helpers.js';

describe('business partner master data', () => {
  let ctx: TestContext;
  let acme: string;
  let globex: string;
  let acmeGroups: PartnerGroup[];
  let acmeTerms: PaymentTerms[];

  before(async () => {
    ctx = await setup();
    acme = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    globex = (await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX)).token;
    acmeGroups = (await ctx.http.get('/v1/bp/groups').set(bearer(acme))).body as PartnerGroup[];
    acmeTerms = (await ctx.http.get('/v1/bp/payment-terms').set(bearer(acme))).body as PaymentTerms[];
  });

  after(async () => {
    await ctx.close();
  });

  const group = (type: 'customer' | 'supplier') => {
    const found = acmeGroups.find((candidate) => candidate.partnerType === type);
    assert.ok(found, `${type} group exists`);
    return found.id;
  };

  const customer = (code: string, extra: Record<string, unknown> = {}) => ({
    code,
    partnerType: 'customer',
    name: `Customer ${code}`,
    groupId: group('customer'),
    paymentTermsId: acmeTerms[0]?.id,
    creditLimit: '15000.50',
    contacts: [
      { name: 'Ayesha Khan', position: 'Buyer', email: 'Ayesha@Example.test', isDefault: true },
      { name: 'Bilal Ahmed', phone: '+92 300 0000000' },
    ],
    addresses: [
      { addressType: 'bill_to', addressName: 'Head Office', street: '1 Main Road', city: 'Lahore', country: 'pk', isDefault: true },
      { addressType: 'ship_to', addressName: 'Warehouse', city: 'Lahore', country: 'PK', isDefault: true },
    ],
    ...extra,
  });

  it('provisions default groups and payment terms for each tenant', () => {
    assert.deepEqual(acmeGroups.map((row) => row.code).sort(), ['CUSTOMERS', 'SUPPLIERS']);
    assert.deepEqual(acmeTerms.map((row) => row.code), ['IMMEDIATE', 'NET30']);
  });

  it('creates a customer with contacts and addresses and records an audit event', async () => {
    const response = await ctx.http.post('/v1/bp/partners').set(bearer(acme)).send(customer('C0001'));
    assert.equal(response.status, 201);
    const partner = response.body as BusinessPartner;
    assert.equal(partner.currency, 'USD');
    assert.equal(partner.creditLimit, '15000.5000');
    assert.equal(partner.contacts.length, 2);
    assert.equal(partner.contacts[0]?.email, 'ayesha@example.test');
    assert.equal(partner.addresses[0]?.country, 'PK');
    const fetched = await ctx.http.get(`/v1/bp/partners/${partner.id}`).set(bearer(acme));
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.code, 'C0001');
    const audit = await ctx.http.get('/v1/tenant/audit-events?limit=5').set(bearer(acme));
    assert.ok((audit.body.items as { action: string }[]).some((event) => event.action === 'business_partner.created'));
  });

  it('scopes partner codes to the tenant and rejects duplicates within one tenant', async () => {
    const duplicate = await ctx.http.post('/v1/bp/partners').set(bearer(acme)).send(customer('C0001'));
    assert.equal(duplicate.status, 409);
    const globexGroups = (await ctx.http.get('/v1/bp/groups').set(bearer(globex))).body as PartnerGroup[];
    const sameCode = await ctx.http
      .post('/v1/bp/partners')
      .set(bearer(globex))
      .send({ code: 'C0001', partnerType: 'customer', name: 'Globex customer', groupId: globexGroups.find((g) => g.partnerType === 'customer')?.id });
    assert.equal(sameCode.status, 201);
  });

  it('hides partners and setup records of other tenants', async () => {
    const list = await ctx.http.get('/v1/bp/partners?search=C0001').set(bearer(acme));
    assert.equal(list.body.total, 1);
    const globexList = await ctx.http.get('/v1/bp/partners').set(bearer(globex));
    const globexPartnerId = (globexList.body.items as { id: string }[])[0]?.id;
    assert.ok(globexPartnerId);
    const crossRead = await ctx.http.get(`/v1/bp/partners/${globexPartnerId}`).set(bearer(acme));
    assert.equal(crossRead.status, 404);
    const crossWrite = await ctx.http
      .put(`/v1/bp/partners/${globexPartnerId}`)
      .set(bearer(acme))
      .send({ version: 1, partnerType: 'customer', name: 'Hijack' });
    assert.equal(crossWrite.status, 404);
    const globexGroups = (await ctx.http.get('/v1/bp/groups').set(bearer(globex))).body as PartnerGroup[];
    const foreignGroup = await ctx.http
      .post('/v1/bp/partners')
      .set(bearer(acme))
      .send({ code: 'C0099', partnerType: 'customer', name: 'Foreign group', groupId: globexGroups[0]?.id });
    assert.equal(foreignGroup.status, 400);
    assert.equal(foreignGroup.body.error.details[0].path, 'groupId');
  });

  it('enforces base currency, group type and single defaults', async () => {
    const currency = await ctx.http.post('/v1/bp/partners').set(bearer(acme)).send(customer('C0002', { currency: 'EUR' }));
    assert.equal(currency.status, 400);
    assert.equal(currency.body.error.details[0].path, 'currency');
    const wrongGroup = await ctx.http.post('/v1/bp/partners').set(bearer(acme)).send(customer('C0003', { groupId: group('supplier') }));
    assert.equal(wrongGroup.status, 400);
    const twoDefaults = await ctx.http
      .post('/v1/bp/partners')
      .set(bearer(acme))
      .send(customer('C0004', { contacts: [{ name: 'A', isDefault: true }, { name: 'B', isDefault: true }] }));
    assert.equal(twoDefaults.status, 400);
    const badAmount = await ctx.http.post('/v1/bp/partners').set(bearer(acme)).send(customer('C0005', { creditLimit: '12.34567' }));
    assert.equal(badAmount.status, 400);
  });

  it('updates with optimistic versioning and restricts type changes', async () => {
    const lead = await ctx.http
      .post('/v1/bp/partners')
      .set(bearer(acme))
      .send({ code: 'L0001', partnerType: 'lead', name: 'Prospect', groupId: group('customer') });
    assert.equal(lead.status, 201);
    const converted = await ctx.http
      .put(`/v1/bp/partners/${lead.body.id}`)
      .set(bearer(acme))
      .send({ version: 1, partnerType: 'customer', name: 'Prospect Ltd', groupId: group('customer'), contacts: [{ name: 'New Contact', isDefault: true }] });
    assert.equal(converted.status, 200);
    assert.equal(converted.body.partnerType, 'customer');
    assert.equal(converted.body.version, 2);
    assert.equal(converted.body.contacts.length, 1);
    const stale = await ctx.http
      .put(`/v1/bp/partners/${lead.body.id}`)
      .set(bearer(acme))
      .send({ version: 1, partnerType: 'customer', name: 'Stale' });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
    const toSupplier = await ctx.http
      .put(`/v1/bp/partners/${lead.body.id}`)
      .set(bearer(acme))
      .send({ version: 2, partnerType: 'supplier', name: 'Prospect Ltd', groupId: group('supplier') });
    assert.equal(toSupplier.status, 409);
    const deactivated = await ctx.http
      .put(`/v1/bp/partners/${lead.body.id}`)
      .set(bearer(acme))
      .send({ version: 2, partnerType: 'customer', name: 'Prospect Ltd', status: 'inactive' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.status, 'inactive');
    const deleted = await ctx.http.delete(`/v1/bp/partners/${lead.body.id}`).set(bearer(acme));
    assert.equal(deleted.status, 404);
  });

  it('lets auditors read but not create partners', async () => {
    const auditor = await loginToTenant(ctx, SHARED, GLOBEX);
    const read = await ctx.http.get('/v1/bp/partners').set(bearer(auditor.token));
    assert.equal(read.status, 200);
    const write = await ctx.http.post('/v1/bp/partners').set(bearer(auditor.token)).send({ code: 'X1', partnerType: 'customer', name: 'X' });
    assert.equal(write.status, 403);
  });

  it('blocks the module when the plan does not include it', async () => {
    const globexId = ctx.tenantId(GLOBEX);
    await ctx.asApp
      .updateTable('tenant_entitlements')
      .set({ modules: ['admin'] })
      .where('tenant_id', '=', globexId)
      .execute();
    const blocked = await ctx.http.get('/v1/bp/partners').set(bearer(globex));
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'MODULE_NOT_ENTITLED');
    const adminStillWorks = await ctx.http.get('/v1/tenant/branches').set(bearer(globex));
    assert.equal(adminStillWorks.status, 200);
    await ctx.asApp
      .updateTable('tenant_entitlements')
      .set({ modules: ['admin', 'bp'] })
      .where('tenant_id', '=', globexId)
      .execute();
  });
});
