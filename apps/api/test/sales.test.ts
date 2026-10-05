import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { sql } from 'kysely';
import type {
  ArAgingReport,
  ArInvoice,
  ArInvoiceDocument,
  Delivery,
  IncomingPayment,
  InvoiceableSalesLine,
  Item,
  ItemGroup,
  ItemStock,
  JournalEntry,
  OpenPaymentItem,
  PartnerBalance,
  PartnerGroup,
  PaymentTerms,
  PriceList,
  SalesOrder,
  TaxCode,
  UnitOfMeasure,
  Warehouse,
} from '@nec/contracts';
import { ACME, ACME_OWNER, bearer, GLOBEX, GLOBEX_OWNER, loginToTenant, setup, SHARED, type TestContext } from './helpers.js';

const YEAR = new Date().getUTCFullYear();
const day = (month: number, date: number) => `${YEAR}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;

describe('Sales: orders, deliveries and A/R invoices', () => {
  let ctx: TestContext;
  let acme: string;
  let units: UnitOfMeasure[];
  let groups: ItemGroup[];
  let bpGroups: PartnerGroup[];
  let wh1: string;
  let vat: TaxCode;
  let sequence = 0;

  const customer = async () => {
    sequence += 1;
    const terms = (await ctx.http.get('/v1/bp/payment-terms').set(bearer(acme))).body as PaymentTerms[];
    const response = await ctx.http
      .post('/v1/bp/partners')
      .set(bearer(acme))
      .send({
        code: `SC-${sequence}`,
        partnerType: 'customer',
        name: `Sales customer ${sequence}`,
        groupId: bpGroups.find((g) => g.partnerType === 'customer')?.id,
        paymentTermsId: terms.find((term) => term.code === 'NET30')?.id,
      });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return { id: response.body.id as string, code: response.body.code as string };
  };

  const item = async (itemType: 'inventory' | 'service' = 'inventory', extra: Record<string, unknown> = {}) => {
    sequence += 1;
    const response = await ctx.http
      .post('/v1/inv/items')
      .set(bearer(acme))
      .send({ code: `SI-${sequence}`, name: `Sales item ${sequence}`, itemType, groupId: groups.find((g) => g.code === 'GENERAL')?.id, uomId: units.find((u) => u.code === 'EA')?.id, ...extra });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body as Item;
  };

  const receive = async (itemId: string, quantity: string, unitCost: string) => {
    const response = await ctx.http
      .post('/v1/inv/adjustments')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), direction: 'receipt', postingDate: day(3, 1), reason: 'Initial stock', lines: [{ itemId, warehouseId: wh1, quantity, unitCost }] });
    assert.equal(response.status, 201, JSON.stringify(response.body));
  };

  const order = async (customerId: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) => {
    const response = await ctx.http
      .post('/v1/sal/orders')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), customerId, postingDate: day(4, 1), deliveryDate: day(4, 10), lines, ...extra });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body as SalesOrder;
  };

  const deliver = (orderId: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}, token = acme) =>
    ctx.http.post('/v1/sal/deliveries').set(bearer(token)).send({ idempotencyKey: randomUUID(), orderId, postingDate: day(4, 5), lines, ...extra });

  const invoice = (customerId: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
    ctx.http.post('/v1/sal/invoices').set(bearer(acme)).send({ idempotencyKey: randomUUID(), customerId, postingDate: day(4, 6), lines, ...extra });

  const cancel = (path: string, postingDate = day(4, 20)) => ctx.http.post(`${path}/cancel`).set(bearer(acme)).send({ idempotencyKey: randomUUID(), postingDate, reason: 'Entered in error' });

  const getOrder = async (id: string) => (await ctx.http.get(`/v1/sal/orders/${id}`).set(bearer(acme))).body as SalesOrder;
  const stock = async (itemId: string) => (await ctx.http.get(`/v1/inv/items/${itemId}/stock`).set(bearer(acme))).body as ItemStock;
  const balance = async (partnerId: string) => ((await ctx.http.get(`/v1/bp/partners/${partnerId}/balance`).set(bearer(acme))).body as PartnerBalance).balance;
  const journal = async (id: string | null) =>
    ((await ctx.http.get(`/v1/fin/journal-entries/${id}`).set(bearer(acme))).body as JournalEntry).lines.map((line) => `${line.accountCode}:${line.partnerCode ?? ''}:${line.debit}:${line.credit}`);

  before(async () => {
    ctx = await setup();
    acme = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    units = (await ctx.http.get('/v1/inv/units').set(bearer(acme))).body;
    groups = (await ctx.http.get('/v1/inv/item-groups').set(bearer(acme))).body;
    bpGroups = (await ctx.http.get('/v1/bp/groups').set(bearer(acme))).body;
    wh1 = ((await ctx.http.get('/v1/inv/warehouses').set(bearer(acme))).body as Warehouse[]).find((w) => w.code === 'WH01')?.id as string;
    const tax = await ctx.http.post('/v1/fin/tax-codes').set(bearer(acme)).send({ code: 'VAT10', name: 'Sales tax 10%', purpose: 'sales', rate: '10', validFrom: day(1, 1) });
    assert.equal(tax.status, 201, JSON.stringify(tax.body));
    vat = tax.body as TaxCode;
  });

  after(async () => {
    await ctx.close();
  });

  it('orders ten, delivers six, invoices six, then delivers and invoices the remainder (scenario 5)', async () => {
    const buyer = await customer();
    const product = await item();
    await receive(product.id, '20', '5');
    const so = await order(buyer.id, [{ itemId: product.id, quantity: '10', unitPrice: '12' }], { customerReference: 'PO-778' });
    assert.match(so.documentNumber, /^SO/);
    assert.equal(so.total, '120.0000');
    assert.equal(so.lines[0]?.warehouseCode, 'WH01');
    let state = await stock(product.id);
    assert.equal(state.committed, '10.0000');
    const exposure = async () => ((await ctx.http.get(`/v1/bp/partners/${buyer.id}/balance`).set(bearer(acme))).body as PartnerBalance).creditExposure;
    assert.deepEqual(await exposure(), { openOrders: '120.0000', uninvoicedDeliveries: '0.0000', total: '120.0000', creditLimit: '0.0000', remaining: '-120.0000' });
    assert.equal(state.available, '10.0000');
    const orderLine = so.lines[0]?.id as string;

    const first = await deliver(so.id, [{ orderLineId: orderLine, quantity: '6' }]);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const dn1 = first.body as Delivery;
    assert.match(dn1.documentNumber, /^DN/);
    assert.equal(dn1.total, '72.0000');
    assert.deepEqual(await exposure(), { openOrders: '48.0000', uninvoicedDeliveries: '72.0000', total: '120.0000', creditLimit: '0.0000', remaining: '-120.0000' });
    assert.equal(dn1.costTotal, '30.0000');
    assert.deepEqual(await journal(dn1.journalId), ['5100::30.0000:0.0000', '1300::0.0000:30.0000']);
    state = await stock(product.id);
    assert.equal(state.onHand, '14.0000');
    assert.equal(state.committed, '4.0000');
    let current = await getOrder(so.id);
    assert.equal(current.lines[0]?.deliveredQuantity, '6.0000');
    assert.equal(current.lines[0]?.openQuantity, '4.0000');
    assert.equal(current.status, 'open');
    const over = await deliver(so.id, [{ orderLineId: orderLine, quantity: '5' }]);
    assert.equal(over.status, 422);
    assert.equal(over.body.error.code, 'OVER_DELIVERY');

    const invoiceable = (await ctx.http.get(`/v1/sal/invoiceable?customerId=${buyer.id}`).set(bearer(acme))).body as InvoiceableSalesLine[];
    assert.deepEqual(invoiceable.map((row) => [row.kind, row.deliveryNumber, row.openQuantity, row.unitPrice]), [['delivery', dn1.documentNumber, '6.0000', '12.0000']]);
    const posted = await invoice(buyer.id, [{ kind: 'delivery', deliveryLineId: dn1.lines[0]?.id, quantity: '6', taxCodeId: vat.id }], { customerReference: 'PO-778' });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    const in1 = posted.body as ArInvoice;
    assert.match(in1.documentNumber, /^IN/);
    assert.equal(in1.subtotal, '72.0000');
    assert.equal(in1.taxTotal, '7.2000');
    assert.equal(in1.total, '79.2000');
    assert.equal((await exposure())?.total, '127.2000');
    assert.equal((await exposure())?.uninvoicedDeliveries, '0.0000');
    assert.equal(in1.dueDate, day(5, 6));
    assert.deepEqual(await journal(in1.journalId), [`1200:${buyer.code}:79.2000:0.0000`, '4100::0.0000:72.0000', '2200::0.0000:7.2000']);
    const overInvoice = await invoice(buyer.id, [{ kind: 'delivery', deliveryLineId: dn1.lines[0]?.id, quantity: '1' }]);
    assert.equal(overInvoice.status, 422);
    assert.equal(overInvoice.body.error.code, 'OVER_INVOICE');

    const second = (await deliver(so.id, [{ orderLineId: orderLine, quantity: '4' }], { postingDate: day(4, 8) })).body as Delivery;
    current = await getOrder(so.id);
    assert.equal(current.status, 'closed');
    assert.equal(current.closedReason, 'fulfilled');
    assert.deepEqual(current.deliveries.map((row) => row.documentNumber), [dn1.documentNumber, second.documentNumber]);
    const in2 = await invoice(buyer.id, [{ kind: 'delivery', deliveryLineId: second.lines[0]?.id, quantity: '4', taxCodeId: vat.id }], { postingDate: day(4, 9) });
    assert.equal(in2.status, 201, JSON.stringify(in2.body));
    assert.equal((in2.body as ArInvoice).total, '52.8000');
    assert.equal((await getOrder(so.id)).lines[0]?.invoicedQuantity, '10.0000');
    assert.equal(await balance(buyer.id), '132.0000');
    assert.equal((await exposure())?.total, '132.0000');
    assert.equal((await exposure())?.openOrders, '0.0000');
    assert.equal((await stock(product.id)).committed, '0.0000');
  });

  it('invoices service lines directly from the order and keeps stock items on deliveries', async () => {
    const buyer = await customer();
    const product = await item();
    const service = await item('service');
    await receive(product.id, '5', '2');
    const so = await order(buyer.id, [
      { itemId: product.id, quantity: '2', unitPrice: '10', discountPercent: '10' },
      { itemId: service.id, quantity: '3', unitPrice: '50' },
    ]);
    assert.equal(so.total, '168.0000');
    const [stockLine, serviceLine] = so.lines as [SalesOrder['lines'][number], SalesOrder['lines'][number]];
    assert.equal(serviceLine.warehouseId, null);
    const serviceDelivery = await deliver(so.id, [{ orderLineId: serviceLine.id, quantity: '1' }]);
    assert.equal(serviceDelivery.status, 400);
    const stockDirect = await invoice(buyer.id, [{ kind: 'order', orderLineId: stockLine.id, quantity: '1' }]);
    assert.equal(stockDirect.status, 400);
    const invoiceable = (await ctx.http.get(`/v1/sal/invoiceable?customerId=${buyer.id}`).set(bearer(acme))).body as InvoiceableSalesLine[];
    assert.deepEqual(invoiceable.map((row) => [row.kind, row.itemCode, row.openQuantity]), [['order', service.code, '3.0000']]);
    const partial = await invoice(buyer.id, [{ kind: 'order', orderLineId: serviceLine.id, quantity: '2', unitPrice: '55' }]);
    assert.equal(partial.status, 201, JSON.stringify(partial.body));
    assert.equal((partial.body as ArInvoice).total, '110.0000');
    assert.equal((partial.body as ArInvoice).priceOverride, false);
    assert.equal((partial.body as ArInvoice).lines[0]?.sourcePrice, '50.0000');
    assert.deepEqual(await journal((partial.body as ArInvoice).journalId), [`1200:${buyer.code}:110.0000:0.0000`, '4100::0.0000:110.0000']);
    let current = await getOrder(so.id);
    assert.equal(current.lines[1]?.openQuantity, '1.0000');
    await deliver(so.id, [{ orderLineId: stockLine.id, quantity: '2' }]);
    assert.equal((await getOrder(so.id)).status, 'open');
    await invoice(buyer.id, [{ kind: 'order', orderLineId: serviceLine.id, quantity: '1' }]);
    current = await getOrder(so.id);
    assert.equal(current.status, 'closed');
    assert.equal(current.closedReason, 'fulfilled');
  });

  it('allows invoice price changes by default and, once a tolerance is set, requires an audited authorized override beyond it', async () => {
    const buyer = await customer();
    const service = await item('service');
    const so = await order(buyer.id, [{ itemId: service.id, quantity: '5', unitPrice: '100' }]);
    const line = so.lines[0]?.id as string;
    const settings = async () => (await ctx.http.get('/v1/sal/settings').set(bearer(acme))).body as { priceTolerancePercent: string | null; version: number };
    assert.deepEqual(await settings(), { priceTolerancePercent: null, version: 0 });
    const unrestricted = await invoice(buyer.id, [{ kind: 'order', orderLineId: line, quantity: '1', unitPrice: '150' }]);
    assert.equal(unrestricted.status, 201, JSON.stringify(unrestricted.body));
    assert.equal((unrestricted.body as ArInvoice).priceOverride, false);
    assert.equal((unrestricted.body as ArInvoice).lines[0]?.sourcePrice, '100.0000');
    const zero = await ctx.http.put('/v1/sal/settings').set(bearer(acme)).send({ priceTolerancePercent: '0', version: 0 });
    assert.equal(zero.status, 200, JSON.stringify(zero.body));

    const rejected = await invoice(buyer.id, [{ kind: 'order', orderLineId: line, quantity: '1', unitPrice: '101' }]);
    assert.equal(rejected.status, 422, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.code, 'PRICE_VARIANCE');
    assert.deepEqual(rejected.body.error.details.variances, [{ line: 1, itemCode: service.code, sourcePrice: '100.0000', unitPrice: '101.0000' }]);
    assert.equal(rejected.body.error.details.canOverride, true);
    assert.equal((await getOrder(so.id)).lines[0]?.invoicedQuantity, '1.0000');

    const changed = await ctx.http.put('/v1/sal/settings').set(bearer(acme)).send({ priceTolerancePercent: '1', version: 1 });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.deepEqual(changed.body, { priceTolerancePercent: '1.0000', version: 2 });
    assert.equal((await ctx.http.put('/v1/sal/settings').set(bearer(acme)).send({ priceTolerancePercent: '2', version: 1 })).status, 409);
    assert.equal((await ctx.http.put('/v1/sal/settings').set(bearer(acme)).send({ priceTolerancePercent: '101', version: 2 })).status, 400);
    const within = await invoice(buyer.id, [{ kind: 'order', orderLineId: line, quantity: '1', unitPrice: '101' }]);
    assert.equal(within.status, 201, JSON.stringify(within.body));
    assert.equal((within.body as ArInvoice).priceOverride, false);
    assert.equal((within.body as ArInvoice).lines[0]?.sourcePrice, '100.0000');
    const below = await invoice(buyer.id, [{ kind: 'order', orderLineId: line, quantity: '1', unitPrice: '98.99' }]);
    assert.equal(below.status, 422);

    const roles = (await ctx.http.get('/v1/tenant/roles').set(bearer(acme))).body as { id: string; code: string }[];
    const invited = await ctx.http.post('/v1/tenant/invitations').set(bearer(acme)).send({ email: 'price.accountant@nec-erp.localhost', roleIds: [roles.find((role) => role.code === 'accountant')?.id] });
    assert.equal(invited.status, 201, JSON.stringify(invited.body));
    const accepted = await ctx.http.post('/v1/invitations/accept').send({ token: ctx.mailer.tokenFor('price.accountant@nec-erp.localhost'), password: ctx.password, displayName: 'Price Accountant' });
    assert.equal(accepted.status, 200);
    const accountant = (await loginToTenant(ctx, 'price.accountant@nec-erp.localhost', ACME)).token;
    assert.equal((await ctx.http.put('/v1/sal/settings').set(bearer(accountant)).send({ priceTolerancePercent: '50', version: 2 })).status, 403);
    const free = { idempotencyKey: randomUUID(), customerId: buyer.id, postingDate: day(4, 6), lines: [{ kind: 'order', orderLineId: line, quantity: '1', unitPrice: '0' }] };
    const noRight = await ctx.http.post('/v1/sal/invoices').set(bearer(accountant)).send(free);
    assert.equal(noRight.status, 422);
    assert.equal(noRight.body.error.details.canOverride, false);
    assert.equal((await ctx.http.post('/v1/sal/invoices').set(bearer(accountant)).send({ ...free, priceOverride: true })).status, 403);

    const overridden = await ctx.http.post('/v1/sal/invoices').set(bearer(acme)).send({ ...free, priceOverride: true });
    assert.equal(overridden.status, 201, JSON.stringify(overridden.body));
    const posted = overridden.body as ArInvoice;
    assert.equal(posted.priceOverride, true);
    assert.equal(posted.total, '0.0000');
    assert.equal((await ctx.http.post('/v1/sal/invoices').set(bearer(acme)).send({ ...free, priceOverride: true })).status, 200);
    const audit = await ctx.asApp.transaction().execute(async (trx) => {
      await sql`select set_config('app.tenant_id', ${ctx.tenantId(ACME)}, true)`.execute(trx);
      return trx.selectFrom('audit_events').select(['action', 'after_data']).where('entity_id', '=', posted.id).execute();
    });
    assert.deepEqual(audit.map((event) => event.action), ['ar_invoice.posted_with_price_override']);
    assert.deepEqual((audit[0]?.after_data as { variances: unknown }).variances, [{ line: 1, itemCode: service.code, sourcePrice: '100.0000', unitPrice: '0.0000' }]);
    const cancelled = await cancel(`/v1/sal/invoices/${(within.body as ArInvoice).id}`);
    assert.equal(cancelled.status, 201, JSON.stringify(cancelled.body));
    assert.equal((cancelled.body as ArInvoice).lines[0]?.sourcePrice, '100.0000');
    const off = await ctx.http.put('/v1/sal/settings').set(bearer(acme)).send({ priceTolerancePercent: null, version: 2 });
    assert.deepEqual(off.body, { priceTolerancePercent: null, version: 3 });
  });

  it('prints A/R invoices from a posting-time snapshot of company and customer details', async () => {
    const profileBefore = (await ctx.http.get('/v1/tenant/company-profile').set(bearer(acme))).body as { version: number };
    const profile = await ctx.http.put('/v1/tenant/company-profile').set(bearer(acme)).send({
      street: '12 Harbour Road', city: 'Karachi', country: 'Pakistan', taxNumber: 'TAX-001', phone: '+92 21 000000', email: 'Billing@Acme.example', invoiceFooter: 'Thank you for your business.', version: profileBefore.version,
    });
    assert.equal(profile.status, 200, JSON.stringify(profile.body));
    assert.equal(profile.body.email, 'billing@acme.example');
    assert.equal((await ctx.http.put('/v1/tenant/company-profile').set(bearer(acme)).send({ version: profileBefore.version })).status, 409);
    sequence += 1;
    const created = await ctx.http.post('/v1/bp/partners').set(bearer(acme)).send({
      code: `SC-${sequence}`, partnerType: 'customer', name: 'Printed Customer Ltd', taxId: 'CUST-TAX-9', groupId: bpGroups.find((g) => g.partnerType === 'customer')?.id,
      addresses: [
        { addressType: 'ship_to', addressName: 'Warehouse', street: '9 Dock Lane', city: 'Lahore', country: 'PK' },
        { addressType: 'bill_to', addressName: 'Head office', street: '1 Mall Road', city: 'Lahore', zipCode: '54000', country: 'PK', isDefault: true },
      ],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const buyer = created.body as { id: string; code: string };
    const service = await item('service');
    const so = await order(buyer.id, [{ itemId: service.id, quantity: '2', unitPrice: '100' }, { itemId: service.id, quantity: '1', unitPrice: '50' }]);
    const posted = await invoice(buyer.id, [
      { kind: 'order', orderLineId: so.lines[0]?.id, quantity: '2', taxCodeId: vat.id },
      { kind: 'order', orderLineId: so.lines[1]?.id, quantity: '1' },
    ]);
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    const original = posted.body as ArInvoice;

    const changed = await ctx.http.put('/v1/tenant/company-profile').set(bearer(acme)).send({ street: 'New address', taxNumber: 'TAX-CHANGED', version: profile.body.version });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const printed = await ctx.http.get(`/v1/sal/invoices/${original.id}/document`).set(bearer(acme));
    assert.equal(printed.status, 200, JSON.stringify(printed.body));
    const document = printed.body as ArInvoiceDocument;
    assert.equal(document.snapshotTaken, true);
    assert.equal(document.invoice.documentNumber, original.documentNumber);
    assert.deepEqual(document.seller, {
      name: document.seller.name, code: null, taxNumber: 'TAX-001', phone: '+92 21 000000', email: 'billing@acme.example',
      address: { street: '12 Harbour Road', city: 'Karachi', state: null, zipCode: null, country: 'Pakistan' },
    });
    assert.ok(document.seller.name.length > 0);
    assert.deepEqual(document.buyer, {
      name: 'Printed Customer Ltd', code: buyer.code, taxNumber: 'CUST-TAX-9', phone: null, email: null,
      address: { street: '1 Mall Road', city: 'Lahore', state: null, zipCode: '54000', country: 'PK' },
    });
    assert.equal(document.footer, 'Thank you for your business.');
    assert.deepEqual(document.taxSummary, [
      { taxCode: 'VAT10', taxRate: '10.0000', base: '200.0000', taxAmount: '20.0000' },
      { taxCode: null, taxRate: '0.0000', base: '50.0000', taxAmount: '0.0000' },
    ]);
    assert.equal(document.invoice.total, '270.0000');
    assert.equal(document.cancellationOfNumber, null);

    const cancelled = await cancel(`/v1/sal/invoices/${original.id}`);
    assert.equal(cancelled.status, 201, JSON.stringify(cancelled.body));
    const reversal = (await ctx.http.get(`/v1/sal/invoices/${(cancelled.body as ArInvoice).id}/document`).set(bearer(acme))).body as ArInvoiceDocument;
    assert.equal(reversal.cancellationOfNumber, original.documentNumber);
    assert.equal(reversal.seller.taxNumber, 'TAX-001');
    assert.equal(reversal.snapshotTaken, true);
    const after = (await ctx.http.get(`/v1/sal/invoices/${original.id}/document`).set(bearer(acme))).body as ArInvoiceDocument;
    assert.equal(after.invoice.status, 'cancelled');
    assert.equal(after.cancelledByNumber, (cancelled.body as ArInvoice).documentNumber);

    const globex = (await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX)).token;
    assert.equal((await ctx.http.get(`/v1/sal/invoices/${original.id}/document`).set(bearer(globex))).status, 404);
    const auditor = (await loginToTenant(ctx, SHARED, GLOBEX)).token;
    assert.equal((await ctx.http.put('/v1/tenant/company-profile').set(bearer(auditor)).send({ version: 0 })).status, 403);
    assert.equal(((await ctx.http.get('/v1/tenant/company-profile').set(bearer(globex))).body as { taxNumber: string | null }).taxNumber, null);
  });

  it('fills order prices from the sales price list and rejects lines without a price', async () => {
    const lists = (await ctx.http.get('/v1/inv/price-lists').set(bearer(acme))).body as PriceList[];
    const sales = lists.find((list) => list.purpose === 'sales' && list.isDefault) as PriceList;
    const purchase = lists.find((list) => list.purpose === 'purchase') as PriceList;
    const buyer = await customer();
    const priced = await item('service');
    const unpriced = await item('service');
    const set = await ctx.http.put(`/v1/inv/price-lists/${sales.id}/prices`).set(bearer(acme)).send({ prices: [{ itemId: priced.id, price: '42.5' }] });
    assert.equal(set.status, 204, JSON.stringify(set.body));

    const lookup = await ctx.http.get(`/v1/sal/prices?postingDate=${day(4, 1)}&itemIds=${priced.id},${unpriced.id}`).set(bearer(acme));
    assert.equal(lookup.status, 200, JSON.stringify(lookup.body));
    assert.deepEqual(lookup.body, { priceList: { id: sales.id, code: sales.code, name: sales.name }, prices: [{ itemId: priced.id, price: '42.5000' }] });

    const filled = await order(buyer.id, [{ itemId: priced.id, quantity: '2' }, { itemId: unpriced.id, quantity: '1', unitPrice: '0' }]);
    assert.equal(filled.lines[0]?.unitPrice, '42.5000');
    assert.equal(filled.lines[1]?.unitPrice, '0.0000');
    assert.equal(filled.total, '85.0000');
    assert.equal(filled.priceListCode, sales.code);

    const missing = await ctx.http.post('/v1/sal/orders').set(bearer(acme)).send({ idempotencyKey: randomUUID(), customerId: buyer.id, postingDate: day(4, 1), deliveryDate: day(4, 10), lines: [{ itemId: unpriced.id, quantity: '1' }] });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.details[0].path, 'lines.0.unitPrice');
    assert.match(missing.body.error.message, new RegExp(`no price in price list ${sales.code}`));
    const wrongList = await ctx.http.post('/v1/sal/orders').set(bearer(acme)).send({ idempotencyKey: randomUUID(), customerId: buyer.id, postingDate: day(4, 1), deliveryDate: day(4, 10), priceListId: purchase.id, lines: [{ itemId: priced.id, quantity: '1' }] });
    assert.equal(wrongList.status, 400);
    assert.equal(wrongList.body.error.details[0].path, 'priceListId');
    const blankQuote = await ctx.http.post('/v1/sal/quotations').set(bearer(acme)).send({ idempotencyKey: randomUUID(), customerId: buyer.id, postingDate: day(4, 1), validUntil: day(4, 30), lines: [{ itemId: priced.id, quantity: '1' }] });
    assert.equal(blankQuote.status, 201, JSON.stringify(blankQuote.body));
    assert.equal(blankQuote.body.lines[0].unitPrice, '42.5000');
  });

  it('carries payment terms and bill-to and ship-to addresses from the order to its invoice', async () => {
    const terms = (await ctx.http.get('/v1/bp/payment-terms').set(bearer(acme))).body as PaymentTerms[];
    const net30 = terms.find((term) => term.code === 'NET30') as PaymentTerms;
    const immediate = terms.find((term) => term.code === 'IMMEDIATE') as PaymentTerms;
    sequence += 1;
    const created = await ctx.http.post('/v1/bp/partners').set(bearer(acme)).send({
      code: `SC-${sequence}`, partnerType: 'customer', name: 'Addressed Customer', paymentTermsId: net30.id, groupId: bpGroups.find((g) => g.partnerType === 'customer')?.id,
      addresses: [
        { addressType: 'bill_to', addressName: 'Accounts', street: '5 Ledger Street', city: 'Multan', country: 'PK' },
        { addressType: 'bill_to', addressName: 'Head office', street: '1 Main Boulevard', city: 'Lahore', country: 'PK', isDefault: true },
        { addressType: 'ship_to', addressName: 'Depot', street: '7 Dock Lane', city: 'Karachi', country: 'PK' },
      ],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const partner = created.body as { id: string; addresses: { id: string; addressName: string }[] };
    const service = await item('service');
    const line = [{ itemId: service.id, quantity: '1', unitPrice: '10' }];

    const defaults = await order(partner.id, line);
    assert.equal(defaults.paymentTermsCode, 'NET30');
    assert.equal(defaults.billTo?.addressName, 'Head office');
    assert.equal(defaults.shipTo?.addressName, 'Depot');

    const accounts = partner.addresses.find((address) => address.addressName === 'Accounts')?.id;
    const chosen = await order(partner.id, line, { paymentTermsId: immediate.id, billToAddressId: accounts });
    assert.equal(chosen.paymentTermsCode, 'IMMEDIATE');
    assert.deepEqual(chosen.billTo, { addressName: 'Accounts', street: '5 Ledger Street', city: 'Multan', state: null, zipCode: null, country: 'PK' });
    const wrongAddress = await ctx.http.post('/v1/sal/orders').set(bearer(acme)).send({
      idempotencyKey: randomUUID(), customerId: partner.id, postingDate: day(4, 1), deliveryDate: day(4, 10), shipToAddressId: accounts, lines: line,
    });
    assert.equal(wrongAddress.status, 400);
    assert.equal(wrongAddress.body.error.details[0].path, 'shipToAddressId');

    const billed = await invoice(partner.id, [{ kind: 'order', orderLineId: chosen.lines[0]?.id, quantity: '1' }]);
    assert.equal(billed.status, 201, JSON.stringify(billed.body));
    assert.equal((billed.body as ArInvoice).dueDate, day(4, 6));
    const document = (await ctx.http.get(`/v1/sal/invoices/${(billed.body as ArInvoice).id}/document`).set(bearer(acme))).body as ArInvoiceDocument;
    assert.equal(document.buyer.address?.street, '5 Ledger Street');
    const standard = await invoice(partner.id, [{ kind: 'order', orderLineId: defaults.lines[0]?.id, quantity: '1' }]);
    assert.equal((standard.body as ArInvoice).dueDate, day(5, 6));
    assert.equal((standard.body as ArInvoice).paymentTermsCode, 'NET30');

    const edited = await order(partner.id, line);
    const changedHeader = await invoice(partner.id, [{ kind: 'order', orderLineId: edited.lines[0]?.id, quantity: '1' }], { paymentTermsId: immediate.id, billToAddressId: accounts });
    assert.equal(changedHeader.status, 201, JSON.stringify(changedHeader.body));
    assert.equal((changedHeader.body as ArInvoice).dueDate, day(4, 6));
    assert.equal((changedHeader.body as ArInvoice).paymentTermsCode, 'IMMEDIATE');
    const editedDocument = (await ctx.http.get(`/v1/sal/invoices/${(changedHeader.body as ArInvoice).id}/document`).set(bearer(acme))).body as ArInvoiceDocument;
    assert.equal(editedDocument.buyer.address?.street, '5 Ledger Street');
    const shipAddress = partner.addresses.find((address) => address.addressName === 'Depot')?.id;
    const another = await order(partner.id, line);
    const badAddress = await invoice(partner.id, [{ kind: 'order', orderLineId: another.lines[0]?.id, quantity: '1' }], { billToAddressId: shipAddress });
    assert.equal(badAddress.status, 400);
    assert.equal(badAddress.body.error.details[0].path, 'billToAddressId');
  });

  it('warns when open order quantities exceed available stock after other open orders', async () => {
    const buyer = await customer();
    const product = await item();
    await receive(product.id, '5', '2');
    const first = await order(buyer.id, [{ itemId: product.id, quantity: '4', unitPrice: '9' }]);
    assert.deepEqual(first.stockWarnings, []);
    const second = await order(buyer.id, [{ itemId: product.id, quantity: '2', unitPrice: '9' }, { itemId: product.id, quantity: '1', unitPrice: '9' }]);
    assert.deepEqual(second.stockWarnings, [
      { lineNo: 1, itemCode: product.code, warehouseCode: 'WH01', openQuantity: '2.0000', available: '1.0000' },
      { lineNo: 2, itemCode: product.code, warehouseCode: 'WH01', openQuantity: '1.0000', available: '1.0000' },
    ]);
    const closed = await ctx.http.patch(`/v1/sal/orders/${first.id}/status`).set(bearer(acme)).send({ status: 'closed', version: first.version });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.deepEqual((await getOrder(second.id)).stockWarnings, []);
    assert.deepEqual((await getOrder(first.id)).stockWarnings, []);
  });

  it('rejects deliveries beyond stock without side effects and validates orders', async () => {
    const buyer = await customer();
    const product = await item();
    await receive(product.id, '3', '4');
    const so = await order(buyer.id, [{ itemId: product.id, quantity: '5', unitPrice: '9' }]);
    const short = await deliver(so.id, [{ orderLineId: so.lines[0]?.id, quantity: '4' }]);
    assert.equal(short.status, 422);
    assert.equal(short.body.error.code, 'INSUFFICIENT_STOCK');
    assert.equal((await getOrder(so.id)).lines[0]?.deliveredQuantity, '0.0000');
    assert.equal((await stock(product.id)).onHand, '3.0000');
    assert.equal((await ctx.http.get(`/v1/sal/deliveries?orderId=${so.id}`).set(bearer(acme))).body.total, 0);

    const notForSale = await item('inventory', { isSalesItem: false });
    const badItem = await ctx.http
      .post('/v1/sal/orders')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), customerId: buyer.id, postingDate: day(4, 1), deliveryDate: day(4, 10), lines: [{ itemId: notForSale.id, quantity: '1', unitPrice: '1' }] });
    assert.equal(badItem.status, 400);
    const vendor = await ctx.http.post('/v1/bp/partners').set(bearer(acme)).send({ code: 'SV-1', partnerType: 'supplier', name: 'Not a customer', groupId: bpGroups.find((g) => g.partnerType === 'supplier')?.id });
    const vendorOrder = await ctx.http
      .post('/v1/sal/orders')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), customerId: vendor.body.id, postingDate: day(4, 1), deliveryDate: day(4, 10), lines: [{ itemId: product.id, quantity: '1', unitPrice: '1' }] });
    assert.equal(vendorOrder.status, 400);
    const early = await ctx.http
      .post('/v1/sal/orders')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), customerId: buyer.id, postingDate: day(4, 10), deliveryDate: day(4, 1), lines: [{ itemId: product.id, quantity: '1', unitPrice: '1' }] });
    assert.equal(early.status, 400);

    const key = randomUUID();
    const once = await deliver(so.id, [{ orderLineId: so.lines[0]?.id, quantity: '1' }], { idempotencyKey: key });
    const replay = await deliver(so.id, [{ orderLineId: so.lines[0]?.id, quantity: '1' }], { idempotencyKey: key });
    assert.equal(once.status, 201);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, once.body.id);
    assert.equal((await getOrder(so.id)).lines[0]?.deliveredQuantity, '1.0000');

    const version = (await getOrder(so.id)).version;
    const closedManually = await ctx.http.patch(`/v1/sal/orders/${so.id}/status`).set(bearer(acme)).send({ status: 'cancelled', version });
    assert.equal(closedManually.status, 409);
  });

  it('pays A/R invoices through incoming payments, ages them and blocks cancellations that have dependants', async () => {
    const buyer = await customer();
    const product = await item();
    await receive(product.id, '10', '3');
    const so = await order(buyer.id, [{ itemId: product.id, quantity: '4', unitPrice: '25' }]);
    const dn = (await deliver(so.id, [{ orderLineId: so.lines[0]?.id, quantity: '4' }])).body as Delivery;
    const inv = (await invoice(buyer.id, [{ kind: 'delivery', deliveryLineId: dn.lines[0]?.id, quantity: '4' }])).body as ArInvoice;
    assert.equal(inv.total, '100.0000');

    const blockedDelivery = await cancel(`/v1/sal/deliveries/${dn.id}`);
    assert.equal(blockedDelivery.status, 409);
    assert.match(blockedDelivery.body.error.message, new RegExp(inv.documentNumber));

    const open = (await ctx.http.get(`/v1/bank/open-receivables?customerId=${buyer.id}`).set(bearer(acme))).body as OpenPaymentItem[];
    assert.deepEqual(open.map((row) => [row.documentType, row.documentNumber, row.openAmount]), [['ar_invoice', inv.documentNumber, '100.0000']]);
    const receipt = await ctx.http
      .post('/v1/bank/incoming-payments')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), customerId: buyer.id, postingDate: day(4, 15), paymentMeans: 'bank_transfer', amount: '60', allocations: [{ arInvoiceId: inv.id, amount: '60' }] });
    assert.equal(receipt.status, 201, JSON.stringify(receipt.body));
    const payment = receipt.body as IncomingPayment;
    assert.deepEqual(payment.allocations.map((row) => [row.documentType, row.invoiceNumber, row.amount]), [['ar_invoice', inv.documentNumber, '60.0000']]);
    const overPay = await ctx.http
      .post('/v1/bank/incoming-payments')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), customerId: buyer.id, postingDate: day(4, 15), paymentMeans: 'bank_transfer', amount: '50', allocations: [{ arInvoiceId: inv.id, amount: '41' }] });
    assert.equal(overPay.status, 422);
    const vendorPay = await ctx.http
      .post('/v1/bank/outgoing-payments')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), vendorId: buyer.id, postingDate: day(4, 15), paymentMeans: 'bank_transfer', amount: '1', allocations: [] });
    assert.equal(vendorPay.status, 400);
    const afterPayment = (await ctx.http.get(`/v1/sal/invoices/${inv.id}`).set(bearer(acme))).body as ArInvoice;
    assert.equal(afterPayment.paidAmount, '60.0000');
    assert.equal(afterPayment.openAmount, '40.0000');
    assert.equal(await balance(buyer.id), '40.0000');

    const aging = (await ctx.http.get(`/v1/fin/reports/ar-aging?asOf=${day(6, 30)}&customerId=${buyer.id}`).set(bearer(acme))).body as ArAgingReport;
    assert.deepEqual(aging.customers[0]?.documents.map((doc) => [doc.type, doc.documentNumber, doc.bucket, doc.openAmount]), [['ar_invoice', inv.documentNumber, 'days31To60', '40.0000']]);
    assert.equal(aging.difference, '0.0000');
    assert.match(aging.accountingBasis, /A\/R invoices/);

    const blockedInvoice = await cancel(`/v1/sal/invoices/${inv.id}`);
    assert.equal(blockedInvoice.status, 409);
    assert.match(blockedInvoice.body.error.message, new RegExp(payment.documentNumber));
    const unallocated = await ctx.http
      .post(`/v1/bank/incoming-payments/${payment.id}/allocations/${payment.allocations[0]?.id}/unallocate`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), unallocationDate: day(4, 16), reason: 'Wrong invoice' });
    assert.equal(unallocated.status, 201, JSON.stringify(unallocated.body));

    const attempts = await Promise.all([1, 2, 3].map(() => cancel(`/v1/sal/invoices/${inv.id}`)));
    assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), [201, 409, 409]);
    const cancellation = attempts.find((attempt) => attempt.status === 201)?.body as ArInvoice;
    assert.deepEqual(await journal(cancellation.journalId), [`1200:${buyer.code}:0.0000:100.0000`, '4100::100.0000:0.0000']);
    assert.equal((await ctx.http.get(`/v1/sal/deliveries/${dn.id}`).set(bearer(acme))).body.lines[0].invoicedQuantity, '0.0000');
    assert.equal((await getOrder(so.id)).lines[0]?.invoicedQuantity, '0.0000');
    assert.equal((await cancel(`/v1/sal/invoices/${cancellation.id}`)).status, 409);

    const reversed = await cancel(`/v1/sal/deliveries/${dn.id}`, day(4, 21));
    assert.equal(reversed.status, 201, JSON.stringify(reversed.body));
    assert.deepEqual(await journal((reversed.body as Delivery).journalId), ['5100::0.0000:12.0000', '1300::12.0000:0.0000']);
    assert.equal((await stock(product.id)).onHand, '10.0000');
    const reopened = await getOrder(so.id);
    assert.equal(reopened.status, 'open');
    assert.equal(reopened.lines[0]?.deliveredQuantity, '0.0000');
    assert.equal(await balance(buyer.id), '-60.0000');
  });

  it('blocks a delivery cancellation after later stock movements', async () => {
    const buyer = await customer();
    const product = await item();
    await receive(product.id, '10', '2');
    const so = await order(buyer.id, [{ itemId: product.id, quantity: '6', unitPrice: '5' }]);
    const first = (await deliver(so.id, [{ orderLineId: so.lines[0]?.id, quantity: '3' }])).body as Delivery;
    await deliver(so.id, [{ orderLineId: so.lines[0]?.id, quantity: '3' }], { postingDate: day(4, 6) });
    const blocked = await cancel(`/v1/sal/deliveries/${first.id}`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'VALUATION_BLOCKED');
  });

  it('enforces permissions, closed periods and tenant isolation', async () => {
    const buyer = await customer();
    const product = await item();
    await receive(product.id, '2', '1');
    const so = await order(buyer.id, [{ itemId: product.id, quantity: '1', unitPrice: '3' }]);
    const globex = (await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX)).token;
    assert.equal((await ctx.http.get(`/v1/sal/orders/${so.id}`).set(bearer(globex))).status, 404);
    assert.equal((await deliver(so.id, [{ orderLineId: so.lines[0]?.id, quantity: '1' }], {}, globex)).status, 404);
    const crossOrder = await ctx.http
      .post('/v1/sal/orders')
      .set(bearer(globex))
      .send({ idempotencyKey: randomUUID(), customerId: buyer.id, postingDate: day(4, 1), deliveryDate: day(4, 10), lines: [{ itemId: product.id, quantity: '1', unitPrice: '1' }] });
    assert.equal(crossOrder.status, 400);
    const auditor = (await loginToTenant(ctx, SHARED, GLOBEX)).token;
    assert.equal((await ctx.http.get('/v1/sal/orders').set(bearer(auditor))).status, 200);
    assert.equal((await ctx.http.get('/v1/sal/invoices').set(bearer(auditor))).status, 200);
    assert.equal((await ctx.http.post('/v1/sal/orders').set(bearer(auditor)).send({})).status, 403);
    assert.equal((await ctx.http.post('/v1/sal/deliveries').set(bearer(auditor)).send({})).status, 403);
    assert.equal((await ctx.http.post('/v1/sal/invoices').set(bearer(auditor)).send({})).status, 403);
    const roles = (await ctx.http.get('/v1/tenant/roles').set(bearer(acme))).body as { code: string; permissions: string[] }[];
    const sales = roles.find((role) => role.code === 'sales');
    assert.ok(sales?.permissions.includes('sal.order.create'));
    assert.equal(sales?.permissions.includes('sal.delivery.post'), false);

    const periods = (await ctx.http.get('/v1/fin/periods').set(bearer(acme))).body as { id: string; code: string; version: number }[];
    const december = periods.find((period) => period.code === `${YEAR}-12`) as { id: string; version: number };
    await ctx.http.patch(`/v1/fin/periods/${december.id}/status`).set(bearer(acme)).send({ status: 'closed', version: december.version, reason: 'Test' });
    const closed = await deliver(so.id, [{ orderLineId: so.lines[0]?.id, quantity: '1' }], { postingDate: day(12, 2) });
    assert.equal(closed.status, 422);
    assert.equal(closed.body.error.code, 'PERIOD_CLOSED');
    assert.equal((await getOrder(so.id)).lines[0]?.deliveredQuantity, '0.0000');
  });
});
