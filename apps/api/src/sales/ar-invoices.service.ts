import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { CreditService } from './credit.service.js';
import { sql } from 'kysely';
import type {
  ArInvoice,
  ArInvoiceDocument,
  InvoicePrintSnapshot,
  InvoiceTaxSummary,
  OrderAddress,
  ArInvoiceListQuery,
  ArInvoiceSummary,
  CancelSalesDocumentRequest,
  CreateArInvoiceRequest,
  InvoiceableSalesLine,
  Page,
  SalesSettings,
  UpdateSalesSettingsRequest,
} from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { AppError, conflict, forbidden, isUniqueViolation, notFound, versionConflict } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, lockTenantResource, type Trx } from '../database/database.service.js';
import { claimIdempotencyKey, completeIdempotencyKey } from '../finance/idempotency.js';
import { decimalPlaces, formatMoney, multiplyMoney, parseMoney, sumMoney, type Money } from '../finance/money.js';
import { PostingService, type PostingLine } from '../finance/posting.service.js';
import { loadCompanyProfile } from '../tenancy/company-profile.service.js';
import { SalesOrdersService } from './sales-orders.service.js';

const lineError = (index: number, field: string, message: string, status = 400, code = 'VALIDATION_FAILED') =>
  new AppError(status, code, message, [{ path: `lines.${index}.${field}`, message }]);

function divideRounded(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator);
}

function percentOf(amount: bigint, ratePercent: bigint): bigint {
  return divideRounded(amount * ratePercent, 100n * 10000n);
}

interface PlannedLine {
  kind: 'delivery' | 'order';
  deliveryId: string | null;
  deliveryLineId: string | null;
  deliveryInvoiced: string | null;
  orderId: string;
  orderLineId: string;
  itemId: string;
  description: string;
  quantity: Money;
  unitPrice: Money;
  sourcePrice: Money;
  lineTotal: Money;
  revenueAccountId: string;
  taxCodeId: string | null;
  taxRate: Money;
  taxAmount: Money;
  branchId: string;
}

@Injectable()
export class ArInvoicesService {
  constructor(
    private readonly credit: CreditService,
    private readonly database: DatabaseService,
    private readonly posting: PostingService,
    private readonly orders: SalesOrdersService,
    private readonly audit: AuditService,
  ) {}

  private run<T>(principal: TenantPrincipal, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId, serializeCredit: true }, fn);
  }

  private read<T>(principal: TenantPrincipal, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, fn);
  }

  private async printSnapshot(trx: Trx, tenantId: string, customerId: string, billTo: OrderAddress | null = null): Promise<InvoicePrintSnapshot> {
    const tenant = await trx.selectFrom('tenants').select('legal_name').where('id', '=', tenantId).executeTakeFirstOrThrow();
    const profile = await loadCompanyProfile(trx, tenantId);
    const partner = await trx
      .selectFrom('business_partners')
      .select(['code', 'name', 'tax_id', 'phone', 'email'])
      .where('tenant_id', '=', tenantId)
      .where('id', '=', customerId)
      .executeTakeFirstOrThrow();
    const address = await trx
      .selectFrom('bp_addresses')
      .select(['street', 'city', 'state', 'zip_code', 'country'])
      .where('tenant_id', '=', tenantId)
      .where('partner_id', '=', customerId)
      .where('address_type', '=', 'bill_to')
      .orderBy('is_default', 'desc')
      .orderBy('line_no')
      .executeTakeFirst();
    return {
      seller: {
        name: tenant.legal_name,
        code: null,
        taxNumber: profile.taxNumber,
        phone: profile.phone,
        email: profile.email,
        address: { street: profile.street, city: profile.city, state: profile.state, zipCode: profile.zipCode, country: profile.country },
      },
      buyer: {
        name: partner.name,
        code: partner.code,
        taxNumber: partner.tax_id,
        phone: partner.phone,
        email: partner.email,
        address: billTo
          ? { street: billTo.street, city: billTo.city, state: billTo.state, zipCode: billTo.zipCode, country: billTo.country }
          : address
            ? { street: address.street, city: address.city, state: address.state, zipCode: address.zip_code, country: address.country }
            : null,
      },
      footer: profile.invoiceFooter,
    };
  }

  async document(principal: TenantPrincipal, invoiceId: string): Promise<ArInvoiceDocument> {
    return this.read(principal, async (trx) => {
      const tenantId = principal.tenantId;
      const invoice = await this.loadOrThrow(trx, tenantId, invoiceId);
      const row = await trx.selectFrom('ar_invoices').select(['print_snapshot', 'cancellation_of_id']).where('tenant_id', '=', tenantId).where('id', '=', invoiceId).executeTakeFirstOrThrow();
      const stored = row.print_snapshot as InvoicePrintSnapshot | null;
      const snapshot = stored ?? (await this.printSnapshot(trx, tenantId, invoice.customerId));
      const related = async (id: string | null) =>
        id ? ((await trx.selectFrom('ar_invoices').select('document_number').where('tenant_id', '=', tenantId).where('id', '=', id).executeTakeFirst())?.document_number ?? null) : null;
      const groups = new Map<string, InvoiceTaxSummary & { baseMinor: Money; taxMinor: Money }>();
      for (const line of invoice.lines) {
        const key = `${line.taxCode ?? ''}|${line.taxRate}`;
        const group = groups.get(key) ?? { taxCode: line.taxCode, taxRate: line.taxRate, base: '0', taxAmount: '0', baseMinor: 0n, taxMinor: 0n };
        group.baseMinor += parseMoney(line.lineTotal);
        group.taxMinor += parseMoney(line.taxAmount);
        groups.set(key, group);
      }
      return {
        invoice,
        seller: snapshot.seller,
        buyer: snapshot.buyer,
        footer: snapshot.footer,
        taxSummary: [...groups.values()].map((group) => ({ taxCode: group.taxCode, taxRate: group.taxRate, base: formatMoney(group.baseMinor), taxAmount: formatMoney(group.taxMinor) })),
        cancellationOfNumber: await related(row.cancellation_of_id),
        cancelledByNumber: await related(invoice.cancelledById),
        snapshotTaken: stored !== null,
        generatedAt: new Date().toISOString(),
      };
    });
  }

  private async loadSettings(trx: Trx, tenantId: string): Promise<SalesSettings> {
    const row = await trx.selectFrom('sales_settings').select(['price_tolerance_percent', 'version']).where('tenant_id', '=', tenantId).executeTakeFirst();
    return row ? { priceTolerancePercent: row.price_tolerance_percent, version: row.version } : { priceTolerancePercent: null, version: 0 };
  }

  async settings(principal: TenantPrincipal): Promise<SalesSettings> {
    return this.read(principal, (trx) => this.loadSettings(trx, principal.tenantId));
  }

  async updateSettings(principal: TenantPrincipal, input: UpdateSalesSettingsRequest, correlationId: string): Promise<SalesSettings> {
    return this.read(principal, async (trx) => {
      await lockTenantResource(trx, principal.tenantId, 'sales-settings');
      const current = await this.loadSettings(trx, principal.tenantId);
      if (current.version !== input.version) throw versionConflict();
      const next = { priceTolerancePercent: input.priceTolerancePercent === null ? null : formatMoney(parseMoney(input.priceTolerancePercent)), version: current.version + 1 };
      const values = { price_tolerance_percent: next.priceTolerancePercent, version: next.version, updated_at: new Date() };
      await trx.insertInto('sales_settings').values({ tenant_id: principal.tenantId, ...values }).onConflict((oc) => oc.column('tenant_id').doUpdateSet(values)).execute();
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'sales_settings.changed',
        entityType: 'sales_settings',
        entityId: null,
        before: { priceTolerancePercent: current.priceTolerancePercent },
        after: { priceTolerancePercent: next.priceTolerancePercent },
        correlationId,
      });
      return next;
    });
  }

  async invoiceable(principal: TenantPrincipal, customerId: string): Promise<InvoiceableSalesLine[]> {
    return this.read(principal, async (trx) => {
      const tenantId = principal.tenantId;
      const delivered = await trx
        .selectFrom('delivery_lines as l')
        .innerJoin('deliveries as d', (join) => join.onRef('d.id', '=', 'l.delivery_id').onRef('d.tenant_id', '=', 'l.tenant_id'))
        .innerJoin('sales_order_lines as ol', (join) => join.onRef('ol.id', '=', 'l.order_line_id').onRef('ol.tenant_id', '=', 'l.tenant_id'))
        .innerJoin('sales_orders as o', (join) => join.onRef('o.id', '=', 'ol.order_id').onRef('o.tenant_id', '=', 'ol.tenant_id'))
        .innerJoin('items as i', (join) => join.onRef('i.id', '=', 'l.item_id').onRef('i.tenant_id', '=', 'l.tenant_id'))
        .innerJoin('units_of_measure as u', (join) => join.onRef('u.id', '=', 'ol.uom_id').onRef('u.tenant_id', '=', 'ol.tenant_id'))
        .select(['d.id as delivery_id', 'd.document_number as delivery_number', 'd.posting_date', 'o.document_number as order_number', 'l.id', 'l.order_line_id', 'l.item_id', 'i.code', 'ol.description', 'u.code as uom_code', 'l.quantity', 'l.invoiced_quantity', 'l.net_price'])
        .where('l.tenant_id', '=', tenantId)
        .where('d.customer_id', '=', customerId)
        .where('d.status', '=', 'posted')
        .where('d.is_cancellation', '=', false)
        .whereRef('l.invoiced_quantity', '<', 'l.quantity')
        .orderBy('d.posting_date')
        .orderBy('d.document_number')
        .orderBy('l.line_no')
        .execute();
      const services = await trx
        .selectFrom('sales_order_lines as l')
        .innerJoin('sales_orders as o', (join) => join.onRef('o.id', '=', 'l.order_id').onRef('o.tenant_id', '=', 'l.tenant_id'))
        .innerJoin('items as i', (join) => join.onRef('i.id', '=', 'l.item_id').onRef('i.tenant_id', '=', 'l.tenant_id'))
        .innerJoin('units_of_measure as u', (join) => join.onRef('u.id', '=', 'l.uom_id').onRef('u.tenant_id', '=', 'l.tenant_id'))
        .select(['o.document_number as order_number', 'o.posting_date', 'l.id', 'l.item_id', 'i.code', 'l.description', 'u.code as uom_code', 'l.quantity', 'l.invoiced_quantity', 'l.net_price'])
        .where('l.tenant_id', '=', tenantId)
        .where('o.customer_id', '=', customerId)
        .where('o.status', '=', 'open')
        .where('l.stocked', '=', false)
        .whereRef('l.invoiced_quantity', '<', 'l.quantity')
        .orderBy('o.posting_date')
        .orderBy('o.document_number')
        .orderBy('l.line_no')
        .execute();
      return [
        ...delivered.map((row) => ({
          kind: 'delivery' as const,
          deliveryId: row.delivery_id,
          deliveryNumber: row.delivery_number,
          deliveryLineId: row.id,
          orderLineId: row.order_line_id,
          orderNumber: row.order_number,
          documentDate: row.posting_date,
          itemId: row.item_id,
          itemCode: row.code,
          description: row.description,
          uomCode: row.uom_code,
          quantity: row.quantity,
          invoicedQuantity: row.invoiced_quantity,
          openQuantity: formatMoney(parseMoney(row.quantity) - parseMoney(row.invoiced_quantity)),
          unitPrice: row.net_price,
        })),
        ...services.map((row) => ({
          kind: 'order' as const,
          deliveryId: null,
          deliveryNumber: null,
          deliveryLineId: null,
          orderLineId: row.id,
          orderNumber: row.order_number,
          documentDate: row.posting_date,
          itemId: row.item_id,
          itemCode: row.code,
          description: row.description,
          uomCode: row.uom_code,
          quantity: row.quantity,
          invoicedQuantity: row.invoiced_quantity,
          openQuantity: formatMoney(parseMoney(row.quantity) - parseMoney(row.invoiced_quantity)),
          unitPrice: row.net_price,
        })),
      ];
    });
  }

  private async taxRates(trx: Trx, tenantId: string, taxCodeIds: string[], date: string): Promise<Map<string, Money>> {
    if (taxCodeIds.length === 0) return new Map();
    const rows = await trx
      .selectFrom('tax_codes as t')
      .select(['t.id', 't.status', 't.purpose'])
      .select(
        sql<string | null>`(select r.rate::text from tax_code_rates r where r.tenant_id = t.tenant_id and r.tax_code_id = t.id and r.valid_from <= ${date} order by r.valid_from desc limit 1)`.as('rate'),
      )
      .where('t.tenant_id', '=', tenantId)
      .where('t.id', 'in', taxCodeIds)
      .execute();
    return new Map(rows.filter((row) => row.status === 'active' && row.purpose !== 'purchase' && row.rate !== null).map((row) => [row.id, parseMoney(row.rate as string)]));
  }

  async create(principal: TenantPrincipal, input: CreateArInvoiceRequest, correlationId: string): Promise<{ replayed: boolean; invoice: ArInvoice }> {
    const { idempotencyKey, ...payload } = input;
    const canOverride = principal.permissions.has('sal.invoice.override');
    if (payload.priceOverride && !canOverride) throw forbidden('You do not have permission to override invoice prices');
    return this.run(principal, async (trx) => {
      const tenantId = principal.tenantId;
      const existing = await claimIdempotencyKey(trx, tenantId, idempotencyKey, 'ar_invoice.create', payload);
      if (existing) return { replayed: true, invoice: await this.loadOrThrow(trx, tenantId, existing) };
      const customer = await trx
        .selectFrom('business_partners as c')
        .leftJoin('payment_terms as t', (join) => join.onRef('t.id', '=', 'c.payment_terms_id').onRef('t.tenant_id', '=', 'c.tenant_id'))
        .select(['c.id', 'c.partner_type', 'c.status', 'c.payment_terms_id', 't.due_days'])
        .where('c.tenant_id', '=', tenantId)
        .where('c.id', '=', payload.customerId)
        .executeTakeFirst();
      if (!customer || customer.partner_type !== 'customer' || customer.status !== 'active') {
        throw new AppError(400, 'VALIDATION_FAILED', 'Choose an active customer', [{ path: 'customerId', message: 'Choose an active customer' }]);
      }
      await this.posting.openPeriodFor(trx, tenantId, payload.postingDate);
      const documentDate = payload.documentDate ?? payload.postingDate;

      const deliveryLineIds = payload.lines.flatMap((line) => (line.kind === 'delivery' ? [line.deliveryLineId] : []));
      const orderLineIds = payload.lines.flatMap((line) => (line.kind === 'order' ? [line.orderLineId] : []));
      if (new Set(deliveryLineIds).size !== deliveryLineIds.length || new Set(orderLineIds).size !== orderLineIds.length) {
        throw new AppError(400, 'VALIDATION_FAILED', 'Each delivery or order line can appear only once on an invoice');
      }
      const deliveryLines = deliveryLineIds.length
        ? await trx
            .selectFrom('delivery_lines as l')
            .innerJoin('deliveries as d', (join) => join.onRef('d.id', '=', 'l.delivery_id').onRef('d.tenant_id', '=', 'l.tenant_id'))
            .select(['l.id', 'l.delivery_id', 'l.order_line_id', 'l.item_id', 'l.quantity', 'l.invoiced_quantity', 'l.net_price', 'd.customer_id', 'd.status', 'd.is_cancellation', 'd.posting_date', 'd.document_number', 'd.branch_id', 'd.order_id'])
            .where('l.tenant_id', '=', tenantId)
            .where('l.id', 'in', deliveryLineIds)
            .orderBy('l.id')
            .forUpdate('l')
            .execute()
        : [];
      const allOrderLineIds = [...new Set([...orderLineIds, ...deliveryLines.map((line) => line.order_line_id)])];
      const orderLines = allOrderLineIds.length
        ? await trx
            .selectFrom('sales_order_lines as l')
            .innerJoin('sales_orders as o', (join) => join.onRef('o.id', '=', 'l.order_id').onRef('o.tenant_id', '=', 'l.tenant_id'))
            .innerJoin('items as i', (join) => join.onRef('i.id', '=', 'l.item_id').onRef('i.tenant_id', '=', 'l.tenant_id'))
            .innerJoin('units_of_measure as u', (join) => join.onRef('u.id', '=', 'l.uom_id').onRef('u.tenant_id', '=', 'l.tenant_id'))
            .innerJoin('item_groups as g', (join) => join.onRef('g.id', '=', 'i.group_id').onRef('g.tenant_id', '=', 'i.tenant_id'))
            .select([
              'l.id',
              'l.order_id',
              'l.item_id',
              'l.stocked',
              'l.description',
              'l.quantity',
              'l.invoiced_quantity',
              'l.net_price',
              'o.customer_id',
              'o.status as order_status',
              'o.posting_date as order_date',
              'o.document_number as order_number',
              'o.branch_id',
              'i.code',
              'u.decimals',
              'g.revenue_account_id',
            ])
            .where('l.tenant_id', '=', tenantId)
            .where('l.id', 'in', allOrderLineIds)
            .orderBy('l.id')
            .forUpdate('l')
            .execute()
        : [];
      const revenueDefault = await trx.selectFrom('gl_determination').select('account_id').where('tenant_id', '=', tenantId).where('determination_key', '=', 'revenue').executeTakeFirst();
      const taxRates = await this.taxRates(trx, tenantId, [...new Set(payload.lines.map((line) => line.taxCodeId).filter((id): id is string => Boolean(id)))], payload.postingDate);
      const toleranceSetting = (await this.loadSettings(trx, tenantId)).priceTolerancePercent;
      const tolerance = toleranceSetting === null ? null : parseMoney(toleranceSetting);
      const variances: { line: number; itemCode: string; sourcePrice: string; unitPrice: string }[] = [];

      const plan: PlannedLine[] = payload.lines.map((line, index) => {
        const taxRate = line.taxCodeId ? taxRates.get(line.taxCodeId) : 0n;
        if (taxRate === undefined) throw lineError(index, 'taxCodeId', `Line ${index + 1}: choose an active sales tax code with a rate on ${payload.postingDate}`);
        let orderLine;
        let deliveryLine: (typeof deliveryLines)[number] | null = null;
        let open: Money;
        let basePrice: Money;
        if (line.kind === 'delivery') {
          deliveryLine = deliveryLines.find((candidate) => candidate.id === line.deliveryLineId) ?? null;
          if (!deliveryLine) throw lineError(index, 'deliveryLineId', `Line ${index + 1}: the delivery line was not found`, 404, 'NOT_FOUND');
          if (deliveryLine.customer_id !== customer.id) throw lineError(index, 'deliveryLineId', `Line ${index + 1}: delivery ${deliveryLine.document_number} belongs to another customer`);
          if (deliveryLine.status !== 'posted' || deliveryLine.is_cancellation) {
            throw lineError(index, 'deliveryLineId', `Line ${index + 1}: delivery ${deliveryLine.document_number} is cancelled`, 409, 'CONFLICT');
          }
          if (deliveryLine.posting_date > payload.postingDate) throw lineError(index, 'deliveryLineId', `Line ${index + 1}: the invoice cannot be dated before delivery ${deliveryLine.document_number}`);
          orderLine = orderLines.find((candidate) => candidate.id === deliveryLine?.order_line_id);
          open = parseMoney(deliveryLine.quantity) - parseMoney(deliveryLine.invoiced_quantity);
          basePrice = parseMoney(deliveryLine.net_price);
        } else {
          orderLine = orderLines.find((candidate) => candidate.id === line.orderLineId);
          if (!orderLine) throw lineError(index, 'orderLineId', `Line ${index + 1}: the sales order line was not found`, 404, 'NOT_FOUND');
          if (orderLine.customer_id !== customer.id) throw lineError(index, 'orderLineId', `Line ${index + 1}: sales order ${orderLine.order_number} belongs to another customer`);
          if (orderLine.stocked) throw lineError(index, 'orderLineId', `Line ${index + 1}: ${orderLine.code} is a stocked item; invoice it from its delivery`);
          if (orderLine.order_status !== 'open') throw lineError(index, 'orderLineId', `Line ${index + 1}: sales order ${orderLine.order_number} is ${orderLine.order_status}`, 409, 'CONFLICT');
          if (orderLine.order_date > payload.postingDate) throw lineError(index, 'orderLineId', `Line ${index + 1}: the invoice cannot be dated before sales order ${orderLine.order_number}`);
          open = parseMoney(orderLine.quantity) - parseMoney(orderLine.invoiced_quantity);
          basePrice = parseMoney(orderLine.net_price);
        }
        if (!orderLine) throw new Error('Order line missing for invoice line');
        if (decimalPlaces(line.quantity) > orderLine.decimals) throw lineError(index, 'quantity', `Line ${index + 1}: ${orderLine.code} allows ${orderLine.decimals} decimal places`);
        const quantity = parseMoney(line.quantity);
        if (quantity <= 0n) throw lineError(index, 'quantity', `Line ${index + 1}: quantity must be greater than zero`);
        if (quantity > open) throw lineError(index, 'quantity', `Line ${index + 1}: only ${formatMoney(open)} of ${orderLine.code} is still to be invoiced`, 422, 'OVER_INVOICE');
        const revenueAccountId = orderLine.revenue_account_id ?? revenueDefault?.account_id;
        if (!revenueAccountId) throw new AppError(422, 'MAPPING_MISSING', 'G/L account determination is missing the Revenue account');
        const unitPrice = line.unitPrice === undefined ? basePrice : parseMoney(line.unitPrice);
        if (tolerance !== null && unitPrice !== basePrice) {
          const difference = unitPrice > basePrice ? unitPrice - basePrice : basePrice - unitPrice;
          if (basePrice === 0n || difference * 1_000_000n > tolerance * basePrice) {
            variances.push({ line: index + 1, itemCode: orderLine.code, sourcePrice: formatMoney(basePrice), unitPrice: formatMoney(unitPrice) });
          }
        }
        const lineTotal = multiplyMoney(quantity, unitPrice);
        return {
          kind: line.kind,
          deliveryId: deliveryLine?.delivery_id ?? null,
          deliveryLineId: deliveryLine?.id ?? null,
          deliveryInvoiced: deliveryLine?.invoiced_quantity ?? null,
          orderId: orderLine.order_id,
          orderLineId: orderLine.id,
          itemId: orderLine.item_id,
          description: orderLine.description,
          quantity,
          unitPrice,
          sourcePrice: basePrice,
          lineTotal,
          revenueAccountId,
          taxCodeId: line.taxCodeId ?? null,
          taxRate,
          taxAmount: percentOf(lineTotal, taxRate),
          branchId: deliveryLine?.branch_id ?? orderLine.branch_id,
        };
      });
      if (tolerance !== null && variances.length > 0 && !payload.priceOverride) {
        throw new AppError(
          422,
          'PRICE_VARIANCE',
          `Invoice prices differ from the order or delivery beyond the ${formatMoney(tolerance)}% tolerance: ${variances.map((v) => `line ${v.line} (${v.itemCode}: ${v.sourcePrice} to ${v.unitPrice})`).join('; ')}. An authorized user can post with a price override.`,
          { tolerancePercent: formatMoney(tolerance), variances, canOverride },
        );
      }
      const baseOrderId = plan[0]?.orderId as string;
      const baseOrder = await trx
        .selectFrom('sales_orders as o')
        .leftJoin('payment_terms as t', (join) => join.onRef('t.id', '=', 'o.payment_terms_id').onRef('t.tenant_id', '=', 'o.tenant_id'))
        .select(['o.bill_to', 'o.payment_terms_id', 't.due_days'])
        .where('o.tenant_id', '=', tenantId)
        .where('o.id', '=', baseOrderId)
        .executeTakeFirstOrThrow();
      let paymentTermsId = baseOrder.payment_terms_id ?? customer.payment_terms_id;
      let dueDays = baseOrder.due_days ?? customer.due_days ?? 0;
      if (payload.paymentTermsId) {
        const terms = await trx.selectFrom('payment_terms').select(['id', 'due_days']).where('tenant_id', '=', tenantId).where('id', '=', payload.paymentTermsId).executeTakeFirst();
        if (!terms) throw new AppError(400, 'VALIDATION_FAILED', 'Choose valid payment terms', [{ path: 'paymentTermsId', message: 'Unknown payment terms' }]);
        paymentTermsId = terms.id;
        dueDays = terms.due_days;
      }
      let billTo = baseOrder.bill_to as OrderAddress | null;
      if (payload.billToAddressId) {
        const address = await trx
          .selectFrom('bp_addresses')
          .select(['address_name', 'street', 'city', 'state', 'zip_code', 'country'])
          .where('tenant_id', '=', tenantId)
          .where('partner_id', '=', customer.id)
          .where('address_type', '=', 'bill_to')
          .where('id', '=', payload.billToAddressId)
          .executeTakeFirst();
        if (!address) throw new AppError(400, 'VALIDATION_FAILED', "Choose one of the customer's bill-to addresses", [{ path: 'billToAddressId', message: 'Not an address of this customer' }]);
        billTo = { addressName: address.address_name, street: address.street, city: address.city, state: address.state, zipCode: address.zip_code, country: address.country };
      }
      const dueDate = payload.dueDate ?? ((await sql<{ due: string }>`select (${documentDate}::date + ${dueDays}::integer)::text as due`.execute(trx)).rows[0]?.due as string);
      if (dueDate < documentDate) throw new AppError(400, 'VALIDATION_FAILED', 'The due date cannot be before the document date', [{ path: 'dueDate', message: 'Before document date' }]);
      const subtotal = sumMoney(plan.map((line) => line.lineTotal));
      const taxTotal = sumMoney(plan.map((line) => line.taxAmount));
      const total = subtotal + taxTotal;
      const invoiceId = randomUUID();
      let journalId: string | null = null;
      if (total > 0n) {
        const credits = new Map<string, Money>();
        for (const line of plan) if (line.lineTotal > 0n) credits.set(line.revenueAccountId, (credits.get(line.revenueAccountId) ?? 0n) + line.lineTotal);
        if (taxTotal > 0n) {
          const outputTax = await trx.selectFrom('gl_determination').select('account_id').where('tenant_id', '=', tenantId).where('determination_key', '=', 'output_tax').executeTakeFirst();
          if (!outputTax) throw new AppError(422, 'MAPPING_MISSING', 'G/L account determination is missing the Output Tax account');
          credits.set(outputTax.account_id, (credits.get(outputTax.account_id) ?? 0n) + taxTotal);
        }
        const journalLines: PostingLine[] = [{ partnerId: customer.id, debit: total, credit: 0n }, ...[...credits.entries()].map(([accountId, amount]) => ({ accountId, debit: 0n, credit: amount }))];
        journalId = (
          await this.posting.post(trx, {
            tenantId,
            userId: principal.userId,
            sourceType: 'ar_invoice',
            sourceId: invoiceId,
            postingDate: payload.postingDate,
            documentDate,
            dueDate,
            memo: `A/R invoice${payload.customerReference ? ` ${payload.customerReference}` : ''}`,
            reference: payload.customerReference ?? null,
            lines: journalLines,
          })
        ).id;
      }
      const series = await this.posting.nextNumber(trx, tenantId, 'ar_invoice', payload.seriesId);
      const branchId = plan[0]?.branchId as string;
      const tenant = await trx.selectFrom('tenants').select('base_currency').where('id', '=', tenantId).executeTakeFirstOrThrow();
      await trx
        .insertInto('ar_invoices')
        .values({
          id: invoiceId,
          tenant_id: tenantId,
          series_id: series.seriesId,
          number: series.number,
          document_number: series.documentNumber,
          customer_id: customer.id,
          branch_id: branchId,
          posting_date: payload.postingDate,
          document_date: documentDate,
          due_date: dueDate,
          customer_reference: payload.customerReference ?? null,
          remarks: payload.remarks ?? null,
          currency: tenant.base_currency,
          subtotal: formatMoney(subtotal),
          tax_total: formatMoney(taxTotal),
          total: formatMoney(total),
          journal_id: journalId,
          price_override: variances.length > 0,
          print_snapshot: JSON.stringify(await this.printSnapshot(trx, tenantId, customer.id, billTo)),
          payment_terms_id: paymentTermsId,
          created_by: principal.userId,
        })
        .execute();
      await trx
        .insertInto('ar_invoice_lines')
        .values(
          plan.map((line, index) => ({
            tenant_id: tenantId,
            invoice_id: invoiceId,
            line_no: index + 1,
            line_kind: line.kind,
            delivery_id: line.deliveryId,
            delivery_line_id: line.deliveryLineId,
            order_line_id: line.orderLineId,
            item_id: line.itemId,
            description: line.description,
            quantity: formatMoney(line.quantity),
            unit_price: formatMoney(line.unitPrice),
            source_price: formatMoney(line.sourcePrice),
            line_total: formatMoney(line.lineTotal),
            revenue_account_id: line.revenueAccountId,
            tax_code_id: line.taxCodeId,
            tax_rate: formatMoney(line.taxRate),
            tax_amount: formatMoney(line.taxAmount),
          })),
        )
        .execute();
      await this.adjustInvoiced(trx, tenantId, plan.map((line) => ({ deliveryLineId: line.deliveryLineId, orderLineId: line.orderLineId, quantity: line.quantity })));
      await this.orders.refreshStatus(trx, tenantId, plan.map((line) => line.orderId));
      await this.credit.check(trx, principal, payload.customerId, input, 'ar_invoice', invoiceId, correlationId);
      await completeIdempotencyKey(trx, tenantId, idempotencyKey, invoiceId);
      const invoice = await this.loadOrThrow(trx, tenantId, invoiceId);
      await this.audit.record(trx, {
        tenantId,
        actor: { type: 'user', id: principal.userId },
        action: variances.length > 0 ? 'ar_invoice.posted_with_price_override' : 'ar_invoice.posted',
        entityType: 'ar_invoice',
        entityId: invoiceId,
        after: {
          documentNumber: invoice.documentNumber,
          customer: invoice.customerCode,
          subtotal: invoice.subtotal,
          taxTotal: invoice.taxTotal,
          total: invoice.total,
          journal: invoice.journalNumber,
          ...(tolerance !== null && variances.length > 0 ? { tolerancePercent: formatMoney(tolerance), variances } : {}),
        },
        correlationId,
      });
      return { replayed: false, invoice };
    });
  }

  private async adjustInvoiced(trx: Trx, tenantId: string, lines: { deliveryLineId: string | null; orderLineId: string; quantity: Money }[]): Promise<void> {
    for (const line of lines) {
      if (line.deliveryLineId) {
        const current = await trx.selectFrom('delivery_lines').select('invoiced_quantity').where('tenant_id', '=', tenantId).where('id', '=', line.deliveryLineId).forUpdate().executeTakeFirstOrThrow();
        await trx
          .updateTable('delivery_lines')
          .set({ invoiced_quantity: formatMoney(parseMoney(current.invoiced_quantity) + line.quantity) })
          .where('tenant_id', '=', tenantId)
          .where('id', '=', line.deliveryLineId)
          .execute();
      }
      const order = await trx.selectFrom('sales_order_lines').select('invoiced_quantity').where('tenant_id', '=', tenantId).where('id', '=', line.orderLineId).forUpdate().executeTakeFirstOrThrow();
      await trx
        .updateTable('sales_order_lines')
        .set({ invoiced_quantity: formatMoney(parseMoney(order.invoiced_quantity) + line.quantity) })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', line.orderLineId)
        .execute();
    }
  }

  async cancel(principal: TenantPrincipal, invoiceId: string, input: CancelSalesDocumentRequest, correlationId: string): Promise<{ replayed: boolean; invoice: ArInvoice }> {
    const { idempotencyKey, ...payload } = input;
    try {
      return await this.run(principal, async (trx) => {
        const tenantId = principal.tenantId;
        const existing = await claimIdempotencyKey(trx, tenantId, idempotencyKey, `ar_invoice.cancel:${invoiceId}`, payload);
        if (existing) return { replayed: true, invoice: await this.loadOrThrow(trx, tenantId, existing) };
        await lockTenantResource(trx, tenantId, `ar-invoice-cancel:${invoiceId}`);
        const header = await trx.selectFrom('ar_invoices').selectAll().where('tenant_id', '=', tenantId).where('id', '=', invoiceId).forUpdate().executeTakeFirst();
        if (!header) throw notFound();
        if (header.is_cancellation) throw conflict('A cancellation document cannot itself be cancelled');
        if (header.status === 'cancelled') throw conflict(`A/R invoice ${header.document_number} is already cancelled`);
        if (parseMoney(header.paid_amount) > 0n) {
          const blocking = await trx
            .selectFrom('payment_allocations as a')
            .innerJoin('payments as p', (join) => join.onRef('p.id', '=', 'a.payment_id').onRef('p.tenant_id', '=', 'a.tenant_id'))
            .select(['p.document_number', 'a.amount'])
            .where('a.tenant_id', '=', tenantId)
            .where('a.ar_invoice_id', '=', invoiceId)
            .where('a.event_type', '=', 'allocate')
            .where(({ not, exists, selectFrom }) =>
              not(exists(selectFrom('payment_allocations as u').select('u.id').whereRef('u.reverses_id', '=', 'a.id').whereRef('u.tenant_id', '=', 'a.tenant_id'))),
            )
            .orderBy('p.document_number')
            .execute();
          throw conflict(
            `Payments are applied to this invoice (${blocking.map((row) => `${row.document_number}: ${formatMoney(parseMoney(row.amount))}`).join(', ')}); unallocate them first`,
            { blockingPayments: blocking.map((row) => ({ documentNumber: row.document_number, amount: row.amount })) },
          );
        }
        if (payload.postingDate < header.posting_date) {
          throw new AppError(422, 'POSTING_REJECTED', 'The cancellation date cannot be earlier than the invoice date', [{ path: 'postingDate', message: 'Before the invoice date' }]);
        }
        await this.posting.openPeriodFor(trx, tenantId, payload.postingDate);
        const cancellationId = randomUUID();
        let journalId: string | null = null;
        if (header.journal_id) {
          const lines = await trx
            .selectFrom('journal_lines')
            .select(['account_id', 'partner_id', 'debit', 'credit', 'memo'])
            .where('tenant_id', '=', tenantId)
            .where('journal_id', '=', header.journal_id)
            .orderBy('line_no')
            .execute();
          journalId = (
            await this.posting.post(trx, {
              tenantId,
              userId: principal.userId,
              sourceType: 'ar_invoice_cancellation',
              sourceId: cancellationId,
              postingDate: payload.postingDate,
              memo: `Cancellation of A/R invoice ${header.document_number}`,
              reference: header.document_number,
              lines: lines.map((line) => ({ accountId: line.account_id, partnerId: line.partner_id, debit: parseMoney(line.credit), credit: parseMoney(line.debit), memo: line.memo })),
            })
          ).id;
        }
        const series = await this.posting.nextNumber(trx, tenantId, 'ar_invoice', header.series_id);
        await trx
          .insertInto('ar_invoices')
          .values({
            id: cancellationId,
            tenant_id: tenantId,
            series_id: series.seriesId,
            number: series.number,
            document_number: series.documentNumber,
            customer_id: header.customer_id,
            branch_id: header.branch_id,
            posting_date: payload.postingDate,
            document_date: payload.postingDate,
            due_date: payload.postingDate,
            customer_reference: header.customer_reference,
            remarks: `Cancellation of ${header.document_number}`,
            currency: header.currency,
            subtotal: header.subtotal,
            tax_total: header.tax_total,
            total: header.total,
            is_cancellation: true,
            cancellation_of_id: invoiceId,
            cancellation_reason: payload.reason,
            journal_id: journalId,
            print_snapshot: header.print_snapshot === null ? null : JSON.stringify(header.print_snapshot),
            payment_terms_id: header.payment_terms_id,
            created_by: principal.userId,
          })
          .execute();
        const lines = await trx.selectFrom('ar_invoice_lines').selectAll().where('tenant_id', '=', tenantId).where('invoice_id', '=', invoiceId).orderBy('line_no').execute();
        await trx
          .insertInto('ar_invoice_lines')
          .values(
            lines.map((line) => ({
              tenant_id: tenantId,
              invoice_id: cancellationId,
              line_no: line.line_no,
              line_kind: line.line_kind,
              delivery_id: line.delivery_id,
              delivery_line_id: line.delivery_line_id,
              order_line_id: line.order_line_id,
              item_id: line.item_id,
              description: line.description,
              quantity: line.quantity,
              unit_price: line.unit_price,
              source_price: line.source_price,
              line_total: line.line_total,
              revenue_account_id: line.revenue_account_id,
              tax_code_id: line.tax_code_id,
              tax_rate: line.tax_rate,
              tax_amount: line.tax_amount,
            })),
          )
          .execute();
        await this.adjustInvoiced(trx, tenantId, lines.map((line) => ({ deliveryLineId: line.delivery_line_id, orderLineId: line.order_line_id, quantity: -parseMoney(line.quantity) })));
        const orderIds = await trx.selectFrom('sales_order_lines').select('order_id').where('tenant_id', '=', tenantId).where('id', 'in', lines.map((line) => line.order_line_id)).execute();
        await this.orders.refreshStatus(trx, tenantId, orderIds.map((row) => row.order_id));
        await trx.updateTable('ar_invoices').set({ status: 'cancelled' }).where('tenant_id', '=', tenantId).where('id', '=', invoiceId).execute();
        await completeIdempotencyKey(trx, tenantId, idempotencyKey, cancellationId);
        const cancellation = await this.loadOrThrow(trx, tenantId, cancellationId);
        await this.audit.record(trx, {
          tenantId,
          actor: { type: 'user', id: principal.userId },
          action: 'ar_invoice.cancelled',
          entityType: 'ar_invoice',
          entityId: invoiceId,
          before: { documentNumber: header.document_number, status: 'posted' },
          after: { status: 'cancelled', cancellation: cancellation.documentNumber, reason: payload.reason, postingDate: payload.postingDate },
          correlationId,
        });
        return { replayed: false, invoice: cancellation };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'ar_invoices_single_cancellation_key')) throw conflict('This A/R invoice has already been cancelled');
      throw error;
    }
  }

  async list(principal: TenantPrincipal, query: ArInvoiceListQuery): Promise<Page<ArInvoiceSummary>> {
    return this.read(principal, async (trx) => {
      let base = trx
        .selectFrom('ar_invoices as a')
        .innerJoin('business_partners as c', (join) => join.onRef('c.id', '=', 'a.customer_id').onRef('c.tenant_id', '=', 'a.tenant_id'))
        .where('a.tenant_id', '=', principal.tenantId);
      if (query.search) {
        const pattern = `%${query.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
        base = base.where((eb) => eb.or([eb('a.document_number', 'ilike', pattern), eb('a.customer_reference', 'ilike', pattern), eb('c.name', 'ilike', pattern)]));
      }
      if (query.customerId) base = base.where('a.customer_id', '=', query.customerId);
      const total = await base.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
      const rows = await base
        .select(['a.id', 'a.document_number', 'c.name', 'a.customer_reference', 'a.posting_date', 'a.due_date', 'a.total', 'a.paid_amount', 'a.status', 'a.is_cancellation'])
        .orderBy('a.posted_at', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute();
      return {
        items: rows.map((row) => ({
          id: row.id,
          documentNumber: row.document_number,
          customerName: row.name,
          customerReference: row.customer_reference,
          postingDate: row.posting_date,
          dueDate: row.due_date,
          total: row.total,
          openAmount: row.status === 'posted' && !row.is_cancellation ? formatMoney(parseMoney(row.total) - parseMoney(row.paid_amount)) : '0.0000',
          status: row.status,
          isCancellation: row.is_cancellation,
        })),
        limit: query.limit,
        offset: query.offset,
        total: Number(total.count),
      };
    });
  }

  async get(principal: TenantPrincipal, invoiceId: string): Promise<ArInvoice> {
    return this.read(principal, (trx) => this.loadOrThrow(trx, principal.tenantId, invoiceId));
  }

  private async loadOrThrow(trx: Trx, tenantId: string, invoiceId: string): Promise<ArInvoice> {
    const invoice = await trx
      .selectFrom('ar_invoices as a')
      .innerJoin('business_partners as c', (join) => join.onRef('c.id', '=', 'a.customer_id').onRef('c.tenant_id', '=', 'a.tenant_id'))
      .innerJoin('branches as b', (join) => join.onRef('b.id', '=', 'a.branch_id').onRef('b.tenant_id', '=', 'a.tenant_id'))
      .leftJoin('journal_entries as je', (join) => join.onRef('je.id', '=', 'a.journal_id').onRef('je.tenant_id', '=', 'a.tenant_id'))
      .leftJoin('ar_invoices as x', (join) => join.onRef('x.cancellation_of_id', '=', 'a.id').onRef('x.tenant_id', '=', 'a.tenant_id'))
      .leftJoin('payment_terms as pt', (join) => join.onRef('pt.id', '=', 'a.payment_terms_id').onRef('pt.tenant_id', '=', 'a.tenant_id'))
      .selectAll('a')
      .select(['c.code as customer_code', 'c.name as customer_name', 'b.code as branch_code', 'je.document_number as journal_number', 'x.id as cancelled_by_id', 'pt.code as payment_terms_code'])
      .where('a.tenant_id', '=', tenantId)
      .where('a.id', '=', invoiceId)
      .executeTakeFirst();
    if (!invoice) throw notFound();
    const lines = await trx
      .selectFrom('ar_invoice_lines as l')
      .innerJoin('sales_order_lines as ol', (join) => join.onRef('ol.id', '=', 'l.order_line_id').onRef('ol.tenant_id', '=', 'l.tenant_id'))
      .innerJoin('sales_orders as o', (join) => join.onRef('o.id', '=', 'ol.order_id').onRef('o.tenant_id', '=', 'ol.tenant_id'))
      .innerJoin('items as i', (join) => join.onRef('i.id', '=', 'l.item_id').onRef('i.tenant_id', '=', 'l.tenant_id'))
      .innerJoin('units_of_measure as u', (join) => join.onRef('u.id', '=', 'ol.uom_id').onRef('u.tenant_id', '=', 'ol.tenant_id'))
      .innerJoin('accounts as acc', (join) => join.onRef('acc.id', '=', 'l.revenue_account_id').onRef('acc.tenant_id', '=', 'l.tenant_id'))
      .leftJoin('deliveries as d', (join) => join.onRef('d.id', '=', 'l.delivery_id').onRef('d.tenant_id', '=', 'l.tenant_id'))
      .leftJoin('tax_codes as t', (join) => join.onRef('t.id', '=', 'l.tax_code_id').onRef('t.tenant_id', '=', 'l.tenant_id'))
      .select([
        'l.id',
        'l.line_no',
        'l.line_kind',
        'l.delivery_id',
        'd.document_number as delivery_number',
        'l.delivery_line_id',
        'l.order_line_id',
        'o.document_number as order_number',
        'l.item_id',
        'i.code as item_code',
        'l.description',
        'u.code as uom_code',
        'l.quantity',
        'l.unit_price',
        'l.source_price',
        'l.line_total',
        'acc.code as revenue_code',
        't.code as tax_code',
        'l.tax_rate',
        'l.tax_amount',
      ])
      .where('l.tenant_id', '=', tenantId)
      .where('l.invoice_id', '=', invoiceId)
      .orderBy('l.line_no')
      .execute();
    const open = invoice.status === 'posted' && !invoice.is_cancellation ? parseMoney(invoice.total) - parseMoney(invoice.paid_amount) : 0n;
    return {
      id: invoice.id,
      documentNumber: invoice.document_number,
      customerId: invoice.customer_id,
      customerCode: invoice.customer_code,
      customerName: invoice.customer_name,
      branchCode: invoice.branch_code,
      postingDate: invoice.posting_date,
      documentDate: invoice.document_date,
      dueDate: invoice.due_date,
      customerReference: invoice.customer_reference,
      remarks: invoice.remarks,
      currency: invoice.currency,
      subtotal: invoice.subtotal,
      taxTotal: invoice.tax_total,
      total: invoice.total,
      paidAmount: invoice.paid_amount,
      openAmount: formatMoney(open),
      status: invoice.status,
      isCancellation: invoice.is_cancellation,
      cancellationOfId: invoice.cancellation_of_id,
      cancelledById: invoice.cancelled_by_id,
      cancellationReason: invoice.cancellation_reason,
      journalId: invoice.journal_id,
      journalNumber: invoice.journal_number,
      paymentTermsCode: invoice.payment_terms_code,
      priceOverride: invoice.price_override,
      postedAt: invoice.posted_at.toISOString(),
      lines: lines.map((line) => ({
        id: line.id,
        lineNo: line.line_no,
        lineKind: line.line_kind,
        deliveryId: line.delivery_id,
        deliveryNumber: line.delivery_number,
        deliveryLineId: line.delivery_line_id,
        orderLineId: line.order_line_id,
        orderNumber: line.order_number,
        itemId: line.item_id,
        itemCode: line.item_code,
        description: line.description,
        uomCode: line.uom_code,
        quantity: line.quantity,
        unitPrice: line.unit_price,
        sourcePrice: line.source_price,
        lineTotal: line.line_total,
        revenueAccountCode: line.revenue_code,
        taxCode: line.tax_code,
        taxRate: line.tax_rate,
        taxAmount: line.tax_amount,
      })),
    };
  }
}
