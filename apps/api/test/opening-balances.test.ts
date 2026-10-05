import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type {
  Account,
  AdjustmentPreview,
  ApAgingReport,
  InventoryAdjustment,
  Item,
  ItemGroup,
  ItemStock,
  JournalEntry,
  OpenPayableInvoice,
  OpeningBalance,
  OutgoingPayment,
  PartnerBalance,
  PartnerGroup,
  UnitOfMeasure,
  Warehouse,
} from '@nec/contracts';
import { ACME, ACME_OWNER, bearer, GLOBEX, GLOBEX_OWNER, loginToTenant, setup, SHARED, type TestContext } from './helpers.js';

const YEAR = new Date().getUTCFullYear();
const day = (month: number, date: number) => `${YEAR}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
const PREVIOUS = (month: number, date: number) => `${YEAR - 1}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;

describe('Opening balances', () => {
  let ctx: TestContext;
  let acme: string;
  let accounts: Account[];
  let bpGroups: PartnerGroup[];
  let units: UnitOfMeasure[];
  let groups: ItemGroup[];
  let wh1: string;
  let wh2: string;
  let sequence = 0;

  const accountId = (code: string) => accounts.find((account) => account.code === code)?.id as string;

  const partner = async (partnerType: 'supplier' | 'customer') => {
    sequence += 1;
    const response = await ctx.http
      .post('/v1/bp/partners')
      .set(bearer(acme))
      .send({ code: `OB-${partnerType[0]}${sequence}`, partnerType, name: `Opening ${partnerType} ${sequence}`, groupId: bpGroups.find((g) => g.partnerType === partnerType)?.id });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return { id: response.body.id as string, code: response.body.code as string };
  };

  const item = async () => {
    sequence += 1;
    const response = await ctx.http
      .post('/v1/inv/items')
      .set(bearer(acme))
      .send({ code: `OBI-${sequence}`, name: `Opening item ${sequence}`, itemType: 'inventory', groupId: groups.find((g) => g.code === 'GENERAL')?.id, uomId: units.find((u) => u.code === 'EA')?.id });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body as Item;
  };

  const postAccounts = (lines: Record<string, unknown>[], extra: Record<string, unknown> = {}, token = acme) =>
    ctx.http
      .post('/v1/fin/opening-balances/accounts')
      .set(bearer(token))
      .send({ idempotencyKey: randomUUID(), postingDate: day(1, 1), reason: 'Go-live balances', lines, ...extra });

  const postPartners = (lines: Record<string, unknown>[], extra: Record<string, unknown> = {}, token = acme) =>
    ctx.http
      .post('/v1/fin/opening-balances/partners')
      .set(bearer(token))
      .send({ idempotencyKey: randomUUID(), postingDate: day(1, 1), reason: 'Legacy open items', lines, ...extra });

  const postStock = (lines: Record<string, unknown>[], extra: Record<string, unknown> = {}, path = '/v1/inv/opening-balances') =>
    ctx.http
      .post(path)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), postingDate: day(1, 1), reason: 'Go-live stock count', lines, ...extra });

  const cancel = (path: string, postingDate = day(1, 31)) => ctx.http.post(`${path}/cancel`).set(bearer(acme)).send({ idempotencyKey: randomUUID(), postingDate, reason: 'Entered in error' });

  const journal = async (id: string | null) => {
    const entry = (await ctx.http.get(`/v1/fin/journal-entries/${id}`).set(bearer(acme))).body as JournalEntry;
    return entry.lines.map((line) => `${line.accountCode}:${line.partnerCode ?? ''}:${line.debit}:${line.credit}`);
  };
  const balance = async (partnerId: string) => ((await ctx.http.get(`/v1/bp/partners/${partnerId}/balance`).set(bearer(acme))).body as PartnerBalance).balance;
  const stock = async (itemId: string) => (await ctx.http.get(`/v1/inv/items/${itemId}/stock`).set(bearer(acme))).body as ItemStock;
  const getOpening = async (id: string) => (await ctx.http.get(`/v1/fin/opening-balances/${id}`).set(bearer(acme))).body as OpeningBalance;
  const aging = async (asOf: string, vendorId: string, basis = 'due_date') =>
    (await ctx.http.get(`/v1/fin/reports/ap-aging?asOf=${asOf}&basis=${basis}&vendorId=${vendorId}`).set(bearer(acme))).body as ApAgingReport;

  before(async () => {
    ctx = await setup();
    acme = (await loginToTenant(ctx, ACME_OWNER, ACME)).token;
    accounts = (await ctx.http.get('/v1/fin/accounts').set(bearer(acme))).body;
    bpGroups = (await ctx.http.get('/v1/bp/groups').set(bearer(acme))).body;
    units = (await ctx.http.get('/v1/inv/units').set(bearer(acme))).body;
    groups = (await ctx.http.get('/v1/inv/item-groups').set(bearer(acme))).body;
    const warehouses = (await ctx.http.get('/v1/inv/warehouses').set(bearer(acme))).body as Warehouse[];
    wh1 = warehouses.find((w) => w.code === 'WH01')?.id as string;
    const second = await ctx.http.post('/v1/inv/warehouses').set(bearer(acme)).send({ code: 'WH02', name: 'Overflow', branchId: warehouses[0]?.branchId });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    wh2 = second.body.id;
  });

  after(async () => {
    await ctx.close();
  });

  it('posts G/L account opening balances against the opening balance account and replays retries', async () => {
    const lines = [
      { accountId: accountId('1100'), debit: '1000' },
      { accountId: accountId('1110'), debit: '500' },
      { accountId: accountId('2300'), credit: '300' },
    ];
    const key = randomUUID();
    const response = await postAccounts(lines, { idempotencyKey: key });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const opening = response.body as OpeningBalance;
    assert.equal(opening.documentNumber, 'OB1');
    assert.equal(opening.kind, 'account');
    assert.equal(opening.offsetAccountCode, '3900');
    assert.equal(opening.totalDebit, '1500.0000');
    assert.equal(opening.totalCredit, '300.0000');
    assert.equal(opening.offsetCredit, '1200.0000');
    assert.equal(opening.offsetDebit, '0.0000');
    assert.deepEqual(opening.lines.map((line) => `${line.accountCode}:${line.debit}:${line.credit}`), ['1100:1000.0000:0.0000', '1110:500.0000:0.0000', '2300:0.0000:300.0000']);
    assert.deepEqual(await journal(opening.journalId), ['1100::1000.0000:0.0000', '1110::500.0000:0.0000', '2300::0.0000:300.0000', '3900::0.0000:1200.0000']);

    const replay = await postAccounts(lines, { idempotencyKey: key });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, opening.id);
    const conflicting = await postAccounts([{ accountId: accountId('1100'), debit: '1' }], { idempotencyKey: key });
    assert.equal(conflicting.status, 409);

    const balanced = await postAccounts([
      { accountId: accountId('1100'), debit: '50' },
      { accountId: accountId('3100'), credit: '50' },
    ]);
    assert.equal(balanced.status, 201, JSON.stringify(balanced.body));
    assert.deepEqual(await journal(balanced.body.journalId), ['1100::50.0000:0.0000', '3100::0.0000:50.0000']);

    const manualReverse = await ctx.http
      .post(`/v1/fin/journal-entries/${opening.journalId}/reverse`)
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), postingDate: day(1, 31), reason: 'Try' });
    assert.equal(manualReverse.status, 409);
    const listed = (await ctx.http.get('/v1/fin/opening-balances?kind=account').set(bearer(acme))).body;
    assert.equal(listed.total, 2);
  });

  it('rejects control, inventory, title, offset and duplicate accounts and ambiguous amounts', async () => {
    const control = await postAccounts([{ accountId: accountId('2100'), credit: '10' }]);
    assert.equal(control.status, 400);
    assert.match(control.body.error.message, /Business Partners Opening Balance/);
    const inventory = await postAccounts([{ accountId: accountId('1300'), debit: '10' }]);
    assert.equal(inventory.status, 400);
    assert.match(inventory.body.error.message, /Inventory Opening Balance/);
    assert.equal((await postAccounts([{ accountId: accountId('11'), debit: '10' }])).status, 400);
    assert.equal((await postAccounts([{ accountId: accountId('3900'), debit: '10' }])).status, 400);
    const duplicate = await postAccounts([
      { accountId: accountId('1100'), debit: '10' },
      { accountId: accountId('1100'), debit: '5' },
    ]);
    assert.equal(duplicate.status, 400);
    assert.equal((await postAccounts([{ accountId: accountId('1100'), debit: '10', credit: '10' }])).status, 400);
    assert.equal((await postAccounts([{ accountId: accountId('1100') }])).status, 400);
    assert.equal((await postAccounts([{ accountId: accountId('1100'), debit: '10' }], { offsetAccountId: accountId('2100') })).status, 400);
    assert.equal((await postAccounts([{ accountId: accountId('1100'), debit: '10' }], { offsetAccountId: accountId('1300') })).status, 400);
    const custom = await postAccounts([{ accountId: accountId('1100'), debit: '10' }], { offsetAccountId: accountId('3100') });
    assert.equal(custom.status, 201, JSON.stringify(custom.body));
    assert.equal((custom.body as OpeningBalance).offsetAccountCode, '3100');
  });

  it('cancels a G/L opening balance once with a reversing journal', async () => {
    const posted = (await postAccounts([{ accountId: accountId('1110'), debit: '75' }])).body as OpeningBalance;
    const early = await cancel(`/v1/fin/opening-balances/${posted.id}`, PREVIOUS(12, 31));
    assert.equal(early.status, 422);
    const attempts = await Promise.all([1, 2, 3].map(() => cancel(`/v1/fin/opening-balances/${posted.id}`)));
    assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), [201, 409, 409]);
    const cancellation = attempts.find((attempt) => attempt.status === 201)?.body as OpeningBalance;
    assert.equal(cancellation.isCancellation, true);
    assert.equal(cancellation.cancellationOfId, posted.id);
    assert.deepEqual(await journal(cancellation.journalId), ['1110::0.0000:75.0000', '3900::75.0000:0.0000']);
    const original = await getOpening(posted.id);
    assert.equal(original.status, 'cancelled');
    assert.equal(original.cancelledById, cancellation.id);
    assert.equal((await cancel(`/v1/fin/opening-balances/${cancellation.id}`)).status, 409);
  });

  it('posts business partner open items, pays vendor lines, ages them and blocks cancellation while allocated', async () => {
    const vendor = await partner('supplier');
    const customer = await partner('customer');
    const response = await postPartners([
      { partnerId: vendor.id, reference: 'LEG-100', documentDate: PREVIOUS(11, 20), dueDate: PREVIOUS(12, 20), credit: '100' },
      { partnerId: vendor.id, reference: 'LEG-101', documentDate: PREVIOUS(12, 28), credit: '40' },
      { partnerId: customer.id, reference: 'INV-9', documentDate: PREVIOUS(12, 15), dueDate: day(1, 14), debit: '70' },
    ]);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const opening = response.body as OpeningBalance;
    assert.equal(opening.kind, 'partner');
    assert.equal(opening.offsetDebit, '70.0000');
    assert.equal(opening.lines[1]?.dueDate, PREVIOUS(12, 28));
    assert.deepEqual(
      opening.lines.map((line) => `${line.accountCode}:${line.partnerCode}:${line.openAmount}`),
      [`2100:${vendor.code}:100.0000`, `2100:${vendor.code}:40.0000`, `1200:${customer.code}:70.0000`],
    );
    assert.deepEqual(await journal(opening.journalId), [
      `2100:${vendor.code}:0.0000:100.0000`,
      `2100:${vendor.code}:0.0000:40.0000`,
      `1200:${customer.code}:70.0000:0.0000`,
      '3900::70.0000:0.0000',
    ]);
    assert.equal(await balance(vendor.id), '140.0000');
    assert.equal(await balance(customer.id), '70.0000');

    const open = (await ctx.http.get(`/v1/bank/open-invoices?vendorId=${vendor.id}`).set(bearer(acme))).body as OpenPayableInvoice[];
    assert.deepEqual(
      open.map((row) => [row.documentType, row.documentNumber, row.vendorReference, row.dueDate, row.openAmount]),
      [
        ['opening_balance', `${opening.documentNumber}/1`, 'LEG-100', PREVIOUS(12, 20), '100.0000'],
        ['opening_balance', `${opening.documentNumber}/2`, 'LEG-101', PREVIOUS(12, 28), '40.0000'],
      ],
    );
    const [first, second] = open as [OpenPayableInvoice, OpenPayableInvoice];

    const before = await aging(day(1, 20), vendor.id);
    assert.equal(before.totals.total, '140.0000');
    assert.equal(before.totals.days31To60, '100.0000');
    assert.equal(before.totals.days1To30, '40.0000');
    assert.equal(before.difference, '0.0000');
    assert.deepEqual(before.vendors[0]?.documents.map((doc) => [doc.type, doc.documentNumber, doc.postingDate]), [
      ['opening_balance', `${opening.documentNumber}/1`, PREVIOUS(11, 20)],
      ['opening_balance', `${opening.documentNumber}/2`, PREVIOUS(12, 28)],
    ]);

    const otherVendor = await partner('supplier');
    const wrongVendor = await ctx.http
      .post('/v1/bank/outgoing-payments')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), vendorId: otherVendor.id, postingDate: day(2, 10), paymentMeans: 'bank_transfer', amount: '10', allocations: [{ openingLineId: first.openingLineId, amount: '10' }] });
    assert.equal(wrongVendor.status, 400);
    const customerLine = opening.lines[2]?.id;
    const toCustomerLine = await ctx.http
      .post('/v1/bank/outgoing-payments')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), vendorId: vendor.id, postingDate: day(2, 10), paymentMeans: 'bank_transfer', amount: '10', allocations: [{ openingLineId: customerLine, amount: '10' }] });
    assert.equal(toCustomerLine.status, 400);
    const both = await ctx.http
      .post('/v1/bank/outgoing-payments')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), vendorId: vendor.id, postingDate: day(2, 10), paymentMeans: 'bank_transfer', amount: '10', allocations: [{ openingLineId: first.openingLineId, invoiceId: randomUUID(), amount: '10' }] });
    assert.equal(both.status, 400);
    const over = await ctx.http
      .post('/v1/bank/outgoing-payments')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), vendorId: vendor.id, postingDate: day(2, 10), paymentMeans: 'bank_transfer', amount: '150', allocations: [{ openingLineId: second.openingLineId, amount: '41' }] });
    assert.equal(over.status, 422);
    assert.equal(over.body.error.code, 'OVER_ALLOCATION');

    const paid = await ctx.http
      .post('/v1/bank/outgoing-payments')
      .set(bearer(acme))
      .send({
        idempotencyKey: randomUUID(),
        vendorId: vendor.id,
        postingDate: day(2, 10),
        paymentMeans: 'bank_transfer',
        amount: '120',
        allocations: [
          { openingLineId: first.openingLineId, amount: '100' },
          { openingLineId: second.openingLineId, amount: '20' },
        ],
      });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    const payment = paid.body as OutgoingPayment;
    assert.deepEqual(
      payment.allocations.map((row) => [row.documentType, row.invoiceNumber, row.vendorReference, row.amount]),
      [
        ['opening_balance', `${opening.documentNumber}/1`, 'LEG-100', '100.0000'],
        ['opening_balance', `${opening.documentNumber}/2`, 'LEG-101', '20.0000'],
      ],
    );
    const afterPayment = await getOpening(opening.id);
    assert.deepEqual(afterPayment.lines.map((line) => [line.paidAmount, line.openAmount]), [
      ['100.0000', '0.0000'],
      ['20.0000', '20.0000'],
      ['0.0000', '70.0000'],
    ]);
    assert.equal(await balance(vendor.id), '20.0000');
    const reopened = (await ctx.http.get(`/v1/bank/open-invoices?vendorId=${vendor.id}`).set(bearer(acme))).body as OpenPayableInvoice[];
    assert.deepEqual(reopened.map((row) => [row.documentNumber, row.openAmount]), [[`${opening.documentNumber}/2`, '20.0000']]);

    const paidAging = await aging(day(2, 28), vendor.id);
    assert.equal(paidAging.totals.total, '20.0000');
    assert.equal(paidAging.difference, '0.0000');
    const historical = await aging(day(1, 31), vendor.id);
    assert.equal(historical.totals.total, '140.0000');
    assert.equal(historical.difference, '0.0000');

    const blocked = await cancel(`/v1/fin/opening-balances/${opening.id}`, day(3, 1));
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error.message, new RegExp(payment.documentNumber));

    for (const allocation of payment.allocations) {
      const unallocated = await ctx.http
        .post(`/v1/bank/outgoing-payments/${payment.id}/allocations/${allocation.id}/unallocate`)
        .set(bearer(acme))
        .send({ idempotencyKey: randomUUID(), unallocationDate: day(3, 1), reason: 'Wrong vendor opening' });
      assert.equal(unallocated.status, 201, JSON.stringify(unallocated.body));
    }
    const cancelled = await cancel(`/v1/fin/opening-balances/${opening.id}`, day(3, 2));
    assert.equal(cancelled.status, 201, JSON.stringify(cancelled.body));
    assert.equal(await balance(vendor.id), '-120.0000');
    assert.equal(await balance(customer.id), '0.0000');
    const afterCancel = await aging(day(3, 31), vendor.id);
    assert.equal(afterCancel.totals.total, '-120.0000');
    assert.deepEqual(afterCancel.vendors[0]?.documents.map((doc) => doc.type), ['outgoing_payment']);
    assert.equal(afterCancel.difference, '0.0000');
    assert.equal((await aging(day(2, 28), vendor.id)).totals.total, '20.0000');
    assert.deepEqual((await ctx.http.get(`/v1/bank/open-invoices?vendorId=${vendor.id}`).set(bearer(acme))).body, []);
  });

  it('validates partner lines and defaults due dates from payment terms', async () => {
    const terms = (await ctx.http.get('/v1/bp/payment-terms').set(bearer(acme))).body as { id: string; code: string }[];
    const created = await ctx.http
      .post('/v1/bp/partners')
      .set(bearer(acme))
      .send({
        code: 'OB-NET30',
        partnerType: 'supplier',
        name: 'Opening vendor on terms',
        groupId: bpGroups.find((g) => g.partnerType === 'supplier')?.id,
        paymentTermsId: terms.find((term) => term.code === 'NET30')?.id,
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const vendor = { id: created.body.id as string };
    const response = await postPartners([{ partnerId: vendor.id, documentDate: PREVIOUS(12, 10), credit: '5' }]);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal((response.body as OpeningBalance).lines[0]?.dueDate, day(1, 9));
    assert.equal((await postPartners([{ partnerId: vendor.id, documentDate: day(1, 2), credit: '5' }])).status, 400);
    assert.equal((await postPartners([{ partnerId: vendor.id, documentDate: PREVIOUS(12, 10), dueDate: PREVIOUS(12, 1), credit: '5' }])).status, 400);
    assert.equal((await postPartners([{ partnerId: vendor.id, debit: '5', credit: '5' }])).status, 400);
    assert.equal((await postPartners([{ partnerId: randomUUID(), credit: '5' }])).status, 400);
  });

  it('posts inventory opening stock once per item and warehouse and sets the moving average', async () => {
    const product = await item();
    const lines = [{ itemId: product.id, warehouseId: wh1, quantity: '10', unitCost: '5' }];
    const previewResponse = await postStock(lines, {}, '/v1/inv/opening-balances/preview');
    assert.equal(previewResponse.status, 200, JSON.stringify(previewResponse.body));
    const preview = previewResponse.body as AdjustmentPreview;
    assert.equal(preview.adjustment.direction, 'opening');
    assert.deepEqual(preview.journalLines.map((line) => `${line.accountCode}:${line.debit}:${line.credit}`), ['1300:50.0000:0.0000', '3900:0.0000:50.0000']);
    assert.equal((await stock(product.id)).onHand, '0.0000');

    assert.equal((await postStock([{ itemId: product.id, warehouseId: wh1, quantity: '10' }])).status, 400);
    const duplicate = await postStock([
      { itemId: product.id, warehouseId: wh1, quantity: '1', unitCost: '1' },
      { itemId: product.id, warehouseId: wh1, quantity: '1', unitCost: '1' },
    ]);
    assert.equal(duplicate.status, 400);
    assert.equal((await postStock(lines, { offsetAccountId: accountId('2100') })).status, 400);

    const posted = await postStock(lines);
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    const opening = posted.body as InventoryAdjustment;
    assert.equal(opening.documentNumber, preview.adjustment.documentNumber);
    assert.match(opening.documentNumber, /^IO/);
    assert.equal(opening.offsetAccountCode, '3900');
    assert.deepEqual(await journal(opening.journalId), ['1300::50.0000:0.0000', '3900::0.0000:50.0000']);
    let state = await stock(product.id);
    assert.equal(state.onHand, '10.0000');
    assert.equal(state.averageCost, '5.000000');

    const again = await postStock([{ itemId: product.id, warehouseId: wh1, quantity: '1', unitCost: '5' }]);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'OPENING_BALANCE_EXISTS');
    const otherWarehouse = await postStock([{ itemId: product.id, warehouseId: wh2, quantity: '10', unitCost: '7' }]);
    assert.equal(otherWarehouse.status, 201, JSON.stringify(otherWarehouse.body));
    state = await stock(product.id);
    assert.equal(state.onHand, '20.0000');
    assert.equal(state.averageCost, '6.000000');

    const movements = (await ctx.http.get(`/v1/inv/stock-movements?itemId=${product.id}`).set(bearer(acme))).body;
    assert.deepEqual(new Set(movements.items.map((row: { sourceType: string }) => row.sourceType)), new Set(['inventory_opening_balance']));
    assert.equal((await ctx.http.get(`/v1/inv/adjustments/${opening.id}`).set(bearer(acme))).status, 404);
    assert.equal((await ctx.http.get(`/v1/inv/opening-balances/${opening.id}`).set(bearer(acme))).status, 200);
    const adjustmentList = (await ctx.http.get('/v1/inv/adjustments').set(bearer(acme))).body;
    assert.equal(adjustmentList.items.some((row: { id: string }) => row.id === opening.id), false);
    const openingList = (await ctx.http.get('/v1/inv/opening-balances').set(bearer(acme))).body;
    assert.equal(openingList.total, 2);
    const viaAdjustment = await ctx.http
      .post('/v1/inv/adjustments')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), direction: 'opening', postingDate: day(1, 1), reason: 'x', lines });
    assert.equal(viaAdjustment.status, 400);
    assert.equal((await cancel(`/v1/inv/adjustments/${opening.id}`)).status, 404);
  });

  it('refuses opening stock after other transactions and allows re-entry after a cancellation', async () => {
    const received = await item();
    const receipt = await ctx.http
      .post('/v1/inv/adjustments')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), direction: 'receipt', postingDate: day(1, 5), reason: 'Found', lines: [{ itemId: received.id, warehouseId: wh1, quantity: '1', unitCost: '1' }] });
    assert.equal(receipt.status, 201, JSON.stringify(receipt.body));
    const late = await postStock([{ itemId: received.id, warehouseId: wh1, quantity: '1', unitCost: '1' }]);
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, 'OPENING_BALANCE_EXISTS');

    const product = await item();
    const first = (await postStock([{ itemId: product.id, warehouseId: wh1, quantity: '4', unitCost: '2.5' }])).body as InventoryAdjustment;
    const cancelled = await cancel(`/v1/inv/opening-balances/${first.id}`);
    assert.equal(cancelled.status, 201, JSON.stringify(cancelled.body));
    const cancellation = cancelled.body as InventoryAdjustment;
    assert.equal(cancellation.direction, 'opening');
    assert.deepEqual(await journal(cancellation.journalId), ['1300::0.0000:10.0000', '3900::10.0000:0.0000']);
    assert.equal((await stock(product.id)).onHand, '0.0000');
    const reentered = await postStock([{ itemId: product.id, warehouseId: wh1, quantity: '4', unitCost: '3' }]);
    assert.equal(reentered.status, 201, JSON.stringify(reentered.body));
    assert.equal((await stock(product.id)).averageCost, '3.000000');

    const issue = await ctx.http
      .post('/v1/inv/adjustments')
      .set(bearer(acme))
      .send({ idempotencyKey: randomUUID(), direction: 'issue', postingDate: day(1, 10), reason: 'Damaged', lines: [{ itemId: product.id, warehouseId: wh1, quantity: '1' }] });
    assert.equal(issue.status, 201, JSON.stringify(issue.body));
    const blocked = await cancel(`/v1/inv/opening-balances/${reentered.body.id}`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'VALUATION_BLOCKED');
  });

  it('enforces permissions, closed periods and tenant isolation', async () => {
    const vendor = await partner('supplier');
    const opening = (await postPartners([{ partnerId: vendor.id, credit: '9' }])).body as OpeningBalance;
    const product = await item();
    const stockOpening = (await postStock([{ itemId: product.id, warehouseId: wh1, quantity: '1', unitCost: '1' }])).body as InventoryAdjustment;

    const globex = (await loginToTenant(ctx, GLOBEX_OWNER, GLOBEX)).token;
    assert.equal((await ctx.http.get(`/v1/fin/opening-balances/${opening.id}`).set(bearer(globex))).status, 404);
    assert.equal((await ctx.http.get(`/v1/inv/opening-balances/${stockOpening.id}`).set(bearer(globex))).status, 404);
    assert.equal(
      (await ctx.http.post(`/v1/fin/opening-balances/${opening.id}/cancel`).set(bearer(globex)).send({ idempotencyKey: randomUUID(), postingDate: day(1, 31), reason: 'x' })).status,
      404,
    );
    assert.equal((await postPartners([{ partnerId: vendor.id, credit: '1' }], {}, globex)).status, 400);
    assert.equal((await postAccounts([{ accountId: accountId('1100'), debit: '1' }], {}, globex)).status, 400);
    const globexList = (await ctx.http.get('/v1/fin/opening-balances').set(bearer(globex))).body;
    assert.equal(globexList.total, 0);

    const auditor = (await loginToTenant(ctx, SHARED, GLOBEX)).token;
    assert.equal((await ctx.http.get('/v1/fin/opening-balances').set(bearer(auditor))).status, 200);
    assert.equal((await ctx.http.get('/v1/inv/opening-balances').set(bearer(auditor))).status, 200);
    assert.equal((await ctx.http.post('/v1/fin/opening-balances/accounts').set(bearer(auditor)).send({})).status, 403);
    assert.equal((await ctx.http.post('/v1/fin/opening-balances/partners').set(bearer(auditor)).send({})).status, 403);
    assert.equal((await ctx.http.post('/v1/inv/opening-balances/preview').set(bearer(auditor)).send({})).status, 403);
    assert.equal((await ctx.http.post(`/v1/fin/opening-balances/${opening.id}/cancel`).set(bearer(auditor)).send({})).status, 403);

    const periods = (await ctx.http.get('/v1/fin/periods').set(bearer(acme))).body as { id: string; code: string; version: number }[];
    const november = periods.find((period) => period.code === `${YEAR}-11`) as { id: string; version: number };
    await ctx.http.patch(`/v1/fin/periods/${november.id}/status`).set(bearer(acme)).send({ status: 'closed', version: november.version, reason: 'Test' });
    const closedAccounts = await postAccounts([{ accountId: accountId('1100'), debit: '1' }], { postingDate: day(11, 1) });
    assert.equal(closedAccounts.status, 422);
    assert.equal(closedAccounts.body.error.code, 'PERIOD_CLOSED');
    const closedStock = await postStock([{ itemId: (await item()).id, warehouseId: wh1, quantity: '1', unitCost: '1' }], { postingDate: day(11, 1) });
    assert.equal(closedStock.body.error.code, 'PERIOD_CLOSED');
    const closedCancel = await cancel(`/v1/fin/opening-balances/${opening.id}`, day(11, 2));
    assert.equal(closedCancel.body.error.code, 'PERIOD_CLOSED');
  });
});
