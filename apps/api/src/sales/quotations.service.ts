import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { ConvertQuotationRequest, CreateQuotationRequest, Page, QuotationListQuery, QuotationStatusRequest, QuotationSummary, SalesQuotation, UpdateQuotationRequest } from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { AppError, conflict, notFound, versionConflict } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, type Trx } from '../database/database.service.js';
import { claimIdempotencyKey, completeIdempotencyKey } from '../finance/idempotency.js';
import { formatMoney, sumMoney } from '../finance/money.js';
import { PostingService } from '../finance/posting.service.js';
import { SalesOrdersService } from './sales-orders.service.js';

@Injectable()
export class QuotationsService {
  constructor(private readonly database: DatabaseService, private readonly orders: SalesOrdersService, private readonly posting: PostingService, private readonly audit: AuditService) {}

  private run<T>(principal: TenantPrincipal, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId, serializeCredit: true }, fn);
  }

  private read<T>(principal: TenantPrincipal, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, fn);
  }

  private async companyDate(trx: Trx, tenantId: string): Promise<string> {
    const result = await sql<{ today: string }>`select (current_timestamp at time zone time_zone)::date as today from tenants where id = ${tenantId}`.execute(trx);
    return result.rows[0]!.today;
  }

  private async prepare(trx: Trx, tenantId: string, input: Omit<CreateQuotationRequest, 'idempotencyKey'>) {
    if (input.validUntil < input.postingDate) throw new AppError(400, 'VALIDATION_FAILED', 'Valid until cannot be before the quotation date');
    const prepared = await this.orders.prepare(trx, tenantId, { ...input, deliveryDate: input.validUntil });
    return {
      header: {
        customer_id: prepared.customer.id, branch_id: prepared.branch.id, posting_date: input.postingDate,
        valid_until: input.validUntil, customer_reference: input.customerReference ?? null, remarks: input.remarks ?? null,
        currency: prepared.tenant.base_currency, total: formatMoney(sumMoney(prepared.lines.map((line) => line.lineTotal))),
      },
      lines: prepared.lines.map((line, index) => ({
        tenant_id: tenantId, line_no: index + 1, item_id: line.item.id, description: line.description,
        uom_id: line.item.uom_id, stocked: line.stocked, warehouse_id: line.warehouseId,
        quantity: formatMoney(line.quantity), unit_price: formatMoney(line.unitPrice), discount_percent: formatMoney(line.discount),
        net_price: formatMoney(line.netPrice), line_total: formatMoney(line.lineTotal),
      })),
    };
  }

  async create(principal: TenantPrincipal, input: CreateQuotationRequest, correlationId: string) {
    return this.read(principal, async (trx) => {
      const { idempotencyKey, ...payload } = input;
      const tenantId = principal.tenantId;
      const existing = await claimIdempotencyKey(trx, tenantId, idempotencyKey, 'sales_quotation.create', payload);
      if (existing) return { replayed: true, quotation: await this.load(trx, tenantId, existing) };
      const prepared = await this.prepare(trx, tenantId, payload);
      const number = await this.posting.nextNumber(trx, tenantId, 'sales_quotation', input.seriesId);
      const row = await trx.insertInto('sales_quotations').values({
        ...prepared.header, tenant_id: tenantId, series_id: number.seriesId, number: number.number,
        document_number: number.documentNumber, created_by: principal.userId,
      }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('sales_quotation_lines').values(prepared.lines.map((line) => ({ ...line, quotation_id: row.id }))).execute();
      await completeIdempotencyKey(trx, tenantId, idempotencyKey, row.id);
      const quotation = await this.load(trx, tenantId, row.id);
      await this.record(trx, principal, quotation, 'created', correlationId);
      return { replayed: false, quotation };
    });
  }

  private async lock(trx: Trx, tenantId: string, id: string, version: number) {
    const row = await trx.selectFrom('sales_quotations').selectAll().where('tenant_id', '=', tenantId).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!row) throw notFound();
    if (row.version !== version) throw versionConflict();
    return row;
  }

  async update(principal: TenantPrincipal, id: string, input: UpdateQuotationRequest, correlationId: string): Promise<SalesQuotation> {
    return this.read(principal, async (trx) => {
      const row = await this.lock(trx, principal.tenantId, id, input.version);
      if (row.status !== 'draft') throw conflict('Only draft quotations can be edited');
      const prepared = await this.prepare(trx, principal.tenantId, input);
      await trx.updateTable('sales_quotations').set({ ...prepared.header, version: row.version + 1, updated_at: new Date() }).where('tenant_id', '=', principal.tenantId).where('id', '=', id).execute();
      await trx.deleteFrom('sales_quotation_lines').where('tenant_id', '=', principal.tenantId).where('quotation_id', '=', id).execute();
      await trx.insertInto('sales_quotation_lines').values(prepared.lines.map((line) => ({ ...line, quotation_id: id }))).execute();
      const quotation = await this.load(trx, principal.tenantId, id);
      await this.record(trx, principal, quotation, 'updated', correlationId);
      return quotation;
    });
  }

  async changeStatus(principal: TenantPrincipal, id: string, input: QuotationStatusRequest, correlationId: string): Promise<SalesQuotation> {
    return this.read(principal, async (trx) => {
      const row = await this.lock(trx, principal.tenantId, id, input.version);
      if (row.status !== 'draft' && row.status !== 'issued') throw conflict('This quotation is already closed or cancelled');
      if (input.status === 'issued') {
        if (row.status !== 'draft') throw conflict('Only drafts can be issued');
        if (row.valid_until < await this.companyDate(trx, principal.tenantId)) throw conflict('This quotation has expired; update the draft validity before issuing');
      }
      await trx.updateTable('sales_quotations').set({ status: input.status, version: row.version + 1, updated_at: new Date() }).where('tenant_id', '=', principal.tenantId).where('id', '=', id).execute();
      const quotation = await this.load(trx, principal.tenantId, id);
      await this.record(trx, principal, quotation, input.status, correlationId);
      return quotation;
    });
  }

  async convert(principal: TenantPrincipal, id: string, input: ConvertQuotationRequest, correlationId: string) {
    return this.run(principal, async (trx) => {
      const { idempotencyKey, ...payload } = input;
      const tenantId = principal.tenantId;
      const existing = await claimIdempotencyKey(trx, tenantId, idempotencyKey, 'sales_quotation.convert', { id, ...payload });
      if (existing) return { replayed: true, order: await this.orders.loadOrThrow(trx, tenantId, existing) };
      const row = await this.lock(trx, tenantId, id, input.version);
      if (row.status !== 'issued') throw conflict('Only issued quotations can be copied to an order');
      if (row.valid_until < await this.companyDate(trx, tenantId) || input.postingDate > row.valid_until) throw conflict('This quotation has expired');
      if (input.postingDate < row.posting_date) throw new AppError(400, 'VALIDATION_FAILED', 'Order date cannot be before the quotation date');
      const quotation = await this.load(trx, tenantId, id);
      const result = await this.orders.createWithin(trx, principal, {
        creditAcknowledged: input.creditAcknowledged, creditOverrideReason: input.creditOverrideReason,
        idempotencyKey: randomUUID(), customerId: quotation.customerId, branchId: quotation.branchId,
        postingDate: input.postingDate, deliveryDate: input.deliveryDate,
        customerReference: quotation.customerReference, remarks: quotation.remarks,
        lines: quotation.lines.map((line) => ({ itemId: line.itemId, description: line.description, warehouseId: line.warehouseId, quantity: line.quantity, unitPrice: line.unitPrice, discountPercent: line.discountPercent })),
      }, correlationId, id);
      await trx.updateTable('sales_quotations').set({ status: 'closed', version: row.version + 1, updated_at: new Date() }).where('tenant_id', '=', tenantId).where('id', '=', id).execute();
      await completeIdempotencyKey(trx, tenantId, idempotencyKey, result.order.id);
      await this.record(trx, principal, await this.load(trx, tenantId, id), 'converted', correlationId);
      return result;
    });
  }

  private async record(trx: Trx, principal: TenantPrincipal, quotation: SalesQuotation, action: string, correlationId: string) {
    await this.audit.record(trx, {
      tenantId: principal.tenantId, actor: { type: 'user', id: principal.userId }, action: `sales_quotation.${action}`,
      entityType: 'sales_quotation', entityId: quotation.id, after: { ...quotation }, correlationId,
    });
  }

  async get(principal: TenantPrincipal, id: string): Promise<SalesQuotation> {
    return this.read(principal, (trx) => this.load(trx, principal.tenantId, id));
  }

  async list(principal: TenantPrincipal, query: QuotationListQuery): Promise<Page<QuotationSummary>> {
    return this.read(principal, async (trx) => {
      const today = await this.companyDate(trx, principal.tenantId);
      let base = trx.selectFrom('sales_quotations as q')
        .innerJoin('business_partners as c', (j) => j.onRef('c.id', '=', 'q.customer_id').onRef('c.tenant_id', '=', 'q.tenant_id'))
        .where('q.tenant_id', '=', principal.tenantId);
      if (query.customerId) base = base.where('q.customer_id', '=', query.customerId);
      if (query.search) {
        const pattern = `%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        base = base.where((eb) => eb.or([eb('q.document_number', 'ilike', pattern), eb('c.code', 'ilike', pattern), eb('c.name', 'ilike', pattern)]));
      }
      if (query.status === 'expired') base = base.where('q.status', '=', 'issued').where('q.valid_until', '<', today);
      else if (query.status) {
        base = base.where('q.status', '=', query.status);
        if (query.status === 'issued') base = base.where('q.valid_until', '>=', today);
      }
      const count = await base.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
      const rows = await base.select(['q.id', 'q.document_number', 'c.code', 'c.name', 'q.posting_date', 'q.valid_until', 'q.total', 'q.status']).orderBy('q.created_at', 'desc').orderBy('q.id').limit(query.limit).offset(query.offset).execute();
      return { total: Number(count.count), limit: query.limit, offset: query.offset, items: rows.map((r) => ({
        id: r.id, documentNumber: r.document_number, customerCode: r.code, customerName: r.name, postingDate: r.posting_date,
        validUntil: r.valid_until, total: r.total, status: r.status === 'issued' && r.valid_until < today ? 'expired' : r.status,
      })) };
    });
  }

  private async load(trx: Trx, tenantId: string, id: string): Promise<SalesQuotation> {
    const row = await trx.selectFrom('sales_quotations as q')
      .innerJoin('business_partners as c', (j) => j.onRef('c.id', '=', 'q.customer_id').onRef('c.tenant_id', '=', 'q.tenant_id'))
      .innerJoin('branches as b', (j) => j.onRef('b.id', '=', 'q.branch_id').onRef('b.tenant_id', '=', 'q.tenant_id'))
      .leftJoin('sales_orders as o', (j) => j.onRef('o.quotation_id', '=', 'q.id').onRef('o.tenant_id', '=', 'q.tenant_id'))
      .selectAll('q').select(['c.code as customer_code', 'c.name as customer_name', 'b.code as branch_code', 'o.id as order_id', 'o.document_number as order_number'])
      .where('q.tenant_id', '=', tenantId).where('q.id', '=', id).executeTakeFirst();
    if (!row) throw notFound();
    const lines = await trx.selectFrom('sales_quotation_lines as l')
      .innerJoin('items as i', (j) => j.onRef('i.id', '=', 'l.item_id').onRef('i.tenant_id', '=', 'l.tenant_id'))
      .innerJoin('units_of_measure as u', (j) => j.onRef('u.id', '=', 'l.uom_id').onRef('u.tenant_id', '=', 'l.tenant_id'))
      .leftJoin('warehouses as w', (j) => j.onRef('w.id', '=', 'l.warehouse_id').onRef('w.tenant_id', '=', 'l.tenant_id'))
      .selectAll('l').select(['i.code as item_code', 'i.item_type', 'u.code as uom_code', 'w.code as warehouse_code'])
      .where('l.tenant_id', '=', tenantId).where('l.quotation_id', '=', id).orderBy('l.line_no').execute();
    const today = await this.companyDate(trx, tenantId);
    return {
      id, documentNumber: row.document_number, customerId: row.customer_id, customerCode: row.customer_code, customerName: row.customer_name,
      branchId: row.branch_id, branchCode: row.branch_code, postingDate: row.posting_date, validUntil: row.valid_until,
      customerReference: row.customer_reference, remarks: row.remarks, currency: row.currency, total: row.total,
      status: row.status === 'issued' && row.valid_until < today ? 'expired' : row.status, version: row.version, createdAt: row.created_at.toISOString(),
      orderId: row.order_id, orderNumber: row.order_number,
      lines: lines.map((l) => ({ id: l.id, lineNo: l.line_no, itemId: l.item_id, itemCode: l.item_code, itemType: l.item_type, stocked: l.stocked,
        description: l.description, uomCode: l.uom_code, warehouseId: l.warehouse_id, warehouseCode: l.warehouse_code,
        quantity: l.quantity, unitPrice: l.unit_price, discountPercent: l.discount_percent, netPrice: l.net_price, lineTotal: l.line_total })),
    };
  }
}
