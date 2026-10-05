import { Injectable } from '@nestjs/common';
import type {
  ChangeOrderStatusRequest,
  CreatePurchaseOrderRequest,
  Page,
  PurchaseOrder,
  PurchaseOrderListQuery,
  PurchaseOrderSummary,
} from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { AppError, conflict, notFound, versionConflict } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, type Trx } from '../database/database.service.js';
import { claimIdempotencyKey, completeIdempotencyKey } from '../finance/idempotency.js';
import { applyDiscount, decimalPlaces, formatMoney, multiplyMoney, parseMoney, sumMoney } from '../finance/money.js';
import { PostingService } from '../finance/posting.service.js';

const lineError = (index: number, field: string, message: string) =>
  new AppError(400, 'VALIDATION_FAILED', message, [{ path: `lines.${index}.${field}`, message }]);

@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
  ) {}

  private run<T>(principal: TenantPrincipal, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, fn);
  }

  async create(principal: TenantPrincipal, input: CreatePurchaseOrderRequest, correlationId: string): Promise<{ replayed: boolean; order: PurchaseOrder }> {
    const { idempotencyKey, ...payload } = input;
    return this.run(principal, async (trx) => {
      const existing = await claimIdempotencyKey(trx, principal.tenantId, idempotencyKey, 'purchase_order.create', payload);
      if (existing) {
        return { replayed: true, order: await this.loadOrThrow(trx, principal.tenantId, existing) };
      }
      const { vendor, tenant, branch, lines } = await this.prepare(trx, principal.tenantId, payload);
      const numbering = await this.posting.nextNumber(trx, principal.tenantId, 'purchase_order', payload.seriesId);
      const order = await trx
        .insertInto('purchase_orders')
        .values({
          tenant_id: principal.tenantId,
          series_id: numbering.seriesId,
          number: numbering.number,
          document_number: numbering.documentNumber,
          vendor_id: vendor.id,
          branch_id: branch.id,
          posting_date: payload.postingDate,
          delivery_date: payload.deliveryDate,
          vendor_reference: payload.vendorReference ?? null,
          remarks: payload.remarks ?? null,
          currency: tenant.base_currency,
          total: formatMoney(sumMoney(lines.map((line) => line.lineTotal))),
          created_by: principal.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('purchase_order_lines')
        .values(
          lines.map((line, index) => ({
            tenant_id: principal.tenantId,
            order_id: order.id,
            line_no: index + 1,
            item_id: line.item.id,
            description: line.description,
            uom_id: line.item.uom_id,
            warehouse_id: line.warehouseId,
            quantity: formatMoney(line.quantity),
            unit_price: formatMoney(line.unitPrice),
            discount_percent: formatMoney(line.discount),
            net_price: formatMoney(line.netPrice),
            line_total: formatMoney(line.lineTotal),
          })),
        )
        .execute();
      await completeIdempotencyKey(trx, principal.tenantId, idempotencyKey, order.id);
      const created = await this.loadOrThrow(trx, principal.tenantId, order.id);
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'purchase_order.created',
        entityType: 'purchase_order',
        entityId: order.id,
        after: { documentNumber: created.documentNumber, vendorId: vendor.id, total: created.total, lines: created.lines.length },
        correlationId,
      });
      return { replayed: false, order: created };
    });
  }

  async prepare(trx: Trx, tenantId: string, payload: Omit<CreatePurchaseOrderRequest, 'idempotencyKey'>) {
    if (payload.deliveryDate < payload.postingDate) {
      throw new AppError(400, 'VALIDATION_FAILED', 'The delivery date cannot be before the posting date', [{ path: 'deliveryDate', message: 'Before posting date' }]);
    }
    const vendor = await trx
      .selectFrom('business_partners')
      .select(['id', 'partner_type', 'status'])
      .where('tenant_id', '=', tenantId)
      .where('id', '=', payload.vendorId)
      .executeTakeFirst();
    if (!vendor || vendor.partner_type !== 'supplier' || vendor.status !== 'active') {
      throw new AppError(400, 'VALIDATION_FAILED', 'Choose an active vendor', [{ path: 'vendorId', message: 'Choose an active vendor' }]);
    }
    const tenant = await trx.selectFrom('tenants').select(['default_branch_id', 'base_currency']).where('id', '=', tenantId).executeTakeFirstOrThrow();
    const branchId = payload.branchId ?? tenant.default_branch_id;
    const branch = branchId
      ? await trx.selectFrom('branches').select(['id', 'status', 'default_warehouse_id']).where('tenant_id', '=', tenantId).where('id', '=', branchId).executeTakeFirst()
      : undefined;
    if (!branch || branch.status !== 'active') {
      throw new AppError(400, 'VALIDATION_FAILED', 'Choose an active branch', [{ path: 'branchId', message: 'Choose an active branch' }]);
    }
    const itemIds = [...new Set(payload.lines.map((line) => line.itemId))];
    const items = await trx
      .selectFrom('items as i')
      .innerJoin('units_of_measure as u', (join) => join.onRef('u.id', '=', 'i.uom_id').onRef('u.tenant_id', '=', 'i.tenant_id'))
      .select(['i.id', 'i.code', 'i.name', 'i.item_type', 'i.is_purchase_item', 'i.status', 'i.uom_id', 'i.default_warehouse_id', 'u.decimals'])
      .where('i.tenant_id', '=', tenantId)
      .where('i.id', 'in', itemIds)
      .execute();
    const warehouseIds = [
      ...new Set(
        [...payload.lines.map((line) => line.warehouseId), ...items.map((item) => item.default_warehouse_id), branch.default_warehouse_id].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ];
    const warehouses = warehouseIds.length
      ? await trx.selectFrom('warehouses').select(['id', 'status']).where('tenant_id', '=', tenantId).where('id', 'in', warehouseIds).execute()
      : [];
    const lines = payload.lines.map((line, index) => {
      const item = items.find((candidate) => candidate.id === line.itemId);
      if (!item || item.status !== 'active') throw lineError(index, 'itemId', `Line ${index + 1}: choose an active item`);
      if (!item.is_purchase_item) throw lineError(index, 'itemId', `Line ${index + 1}: ${item.code} is not a purchase item`);
      if (decimalPlaces(line.quantity) > item.decimals) {
        throw lineError(index, 'quantity', `Line ${index + 1}: ${item.code} allows ${item.decimals} decimal places`);
      }
      const quantity = parseMoney(line.quantity);
      if (quantity <= 0n) throw lineError(index, 'quantity', `Line ${index + 1}: quantity must be greater than zero`);
      let warehouseId: string | null = null;
      if (item.item_type === 'inventory') {
        warehouseId = line.warehouseId ?? item.default_warehouse_id ?? branch.default_warehouse_id ?? null;
        const warehouse = warehouses.find((candidate) => candidate.id === warehouseId);
        if (!warehouse || warehouse.status !== 'active') throw lineError(index, 'warehouseId', `Line ${index + 1}: choose an active warehouse for ${item.code}`);
      } else if (line.warehouseId) {
        throw lineError(index, 'warehouseId', `Line ${index + 1}: ${item.code} is not stocked and has no warehouse`);
      }
      const unitPrice = parseMoney(line.unitPrice);
      const netPrice = applyDiscount(unitPrice, parseMoney(line.discountPercent));
      return {
        item,
        description: line.description ?? item.name,
        warehouseId,
        quantity,
        unitPrice,
        discount: parseMoney(line.discountPercent),
        netPrice,
        lineTotal: multiplyMoney(quantity, netPrice),
      };
    });
    return { vendor, tenant, branch, lines };
  }

  async changeStatus(principal: TenantPrincipal, orderId: string, input: ChangeOrderStatusRequest, correlationId: string): Promise<PurchaseOrder> {
    return this.run(principal, async (trx) => {
      const order = await trx
        .selectFrom('purchase_orders')
        .select(['id', 'status', 'version', 'document_number'])
        .where('tenant_id', '=', principal.tenantId)
        .where('id', '=', orderId)
        .forUpdate()
        .executeTakeFirst();
      if (!order) throw notFound();
      if (order.version !== input.version) throw versionConflict();
      if (order.status !== 'open') throw conflict(`Purchase order ${order.document_number} is already ${order.status}`);
      if (input.status === 'cancelled') {
        const received = await trx
          .selectFrom('purchase_order_lines')
          .select('id')
          .where('tenant_id', '=', principal.tenantId)
          .where('order_id', '=', orderId)
          .where('received_quantity', '>', '0')
          .executeTakeFirst();
        if (received) throw conflict('A purchase order with received quantities cannot be cancelled; close it instead');
      }
      await trx
        .updateTable('purchase_orders')
        .set({
          status: input.status,
          closed_reason: input.status === 'closed' ? 'manual' : null,
          version: order.version + 1,
          updated_at: new Date(),
        })
        .where('id', '=', orderId)
        .execute();
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: input.status === 'closed' ? 'purchase_order.closed' : 'purchase_order.cancelled',
        entityType: 'purchase_order',
        entityId: orderId,
        before: { status: order.status },
        after: { status: input.status },
        correlationId,
      });
      return this.loadOrThrow(trx, principal.tenantId, orderId);
    });
  }

  async list(principal: TenantPrincipal, query: PurchaseOrderListQuery): Promise<Page<PurchaseOrderSummary>> {
    return this.run(principal, async (trx) => {
      let base = trx
        .selectFrom('purchase_orders as o')
        .innerJoin('business_partners as v', (join) => join.onRef('v.id', '=', 'o.vendor_id').onRef('v.tenant_id', '=', 'o.tenant_id'))
        .where('o.tenant_id', '=', principal.tenantId);
      if (query.search) {
        const pattern = `%${query.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
        base = base.where((eb) => eb.or([eb('o.document_number', 'ilike', pattern), eb('v.name', 'ilike', pattern), eb('v.code', 'ilike', pattern)]));
      }
      if (query.status) base = base.where('o.status', '=', query.status);
      if (query.vendorId) base = base.where('o.vendor_id', '=', query.vendorId);
      const total = await base.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
      const rows = await base
        .select(['o.id', 'o.document_number', 'v.code', 'v.name', 'o.posting_date', 'o.delivery_date', 'o.total', 'o.status'])
        .orderBy('o.posting_date', 'desc')
        .orderBy('o.number', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute();
      return {
        items: rows.map((row) => ({
          id: row.id,
          documentNumber: row.document_number,
          vendorCode: row.code,
          vendorName: row.name,
          postingDate: row.posting_date,
          deliveryDate: row.delivery_date,
          total: row.total,
          status: row.status,
        })),
        limit: query.limit,
        offset: query.offset,
        total: Number(total.count),
      };
    });
  }

  async get(principal: TenantPrincipal, orderId: string): Promise<PurchaseOrder> {
    return this.run(principal, (trx) => this.loadOrThrow(trx, principal.tenantId, orderId));
  }

  async loadOrThrow(trx: Trx, tenantId: string, orderId: string): Promise<PurchaseOrder> {
    const order = await trx
      .selectFrom('purchase_orders as o')
      .innerJoin('business_partners as v', (join) => join.onRef('v.id', '=', 'o.vendor_id').onRef('v.tenant_id', '=', 'o.tenant_id'))
      .innerJoin('branches as b', (join) => join.onRef('b.id', '=', 'o.branch_id').onRef('b.tenant_id', '=', 'o.tenant_id'))
      .selectAll('o')
      .select(['v.code as vendor_code', 'v.name as vendor_name', 'b.code as branch_code'])
      .where('o.tenant_id', '=', tenantId)
      .where('o.id', '=', orderId)
      .executeTakeFirst();
    if (!order) throw notFound();
    const lines = await trx
      .selectFrom('purchase_order_lines as l')
      .innerJoin('items as i', (join) => join.onRef('i.id', '=', 'l.item_id').onRef('i.tenant_id', '=', 'l.tenant_id'))
      .innerJoin('units_of_measure as u', (join) => join.onRef('u.id', '=', 'l.uom_id').onRef('u.tenant_id', '=', 'l.tenant_id'))
      .leftJoin('warehouses as w', (join) => join.onRef('w.id', '=', 'l.warehouse_id').onRef('w.tenant_id', '=', 'l.tenant_id'))
      .selectAll('l')
      .select(['i.code as item_code', 'i.item_type', 'u.code as uom_code', 'w.code as warehouse_code'])
      .where('l.tenant_id', '=', tenantId)
      .where('l.order_id', '=', orderId)
      .orderBy('l.line_no')
      .execute();
    const receipts = await trx
      .selectFrom('goods_receipts')
      .select(['id', 'document_number', 'posting_date', 'status', 'is_cancellation'])
      .where('tenant_id', '=', tenantId)
      .where('order_id', '=', orderId)
      .orderBy('posted_at')
      .execute();
    return {
      id: order.id,
      documentNumber: order.document_number,
      vendorId: order.vendor_id,
      vendorCode: order.vendor_code,
      vendorName: order.vendor_name,
      branchId: order.branch_id,
      branchCode: order.branch_code,
      postingDate: order.posting_date,
      deliveryDate: order.delivery_date,
      vendorReference: order.vendor_reference,
      remarks: order.remarks,
      currency: order.currency,
      total: order.total,
      status: order.status,
      closedReason: order.closed_reason,
      version: order.version,
      createdAt: order.created_at.toISOString(),
      lines: lines.map((line) => ({
        id: line.id,
        lineNo: line.line_no,
        itemId: line.item_id,
        itemCode: line.item_code,
        itemType: line.item_type,
        description: line.description,
        uomCode: line.uom_code,
        warehouseId: line.warehouse_id,
        warehouseCode: line.warehouse_code,
        quantity: line.quantity,
        receivedQuantity: line.received_quantity,
        openQuantity: formatMoney(parseMoney(line.quantity) - parseMoney(line.received_quantity)),
        unitPrice: line.unit_price,
        discountPercent: line.discount_percent,
        netPrice: line.net_price,
        lineTotal: line.line_total,
      })),
      receipts: receipts.map((receipt) => ({
        id: receipt.id,
        documentNumber: receipt.document_number,
        postingDate: receipt.posting_date,
        status: receipt.status,
        isCancellation: receipt.is_cancellation,
      })),
    };
  }
}
