import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  CancelGoodsReceiptRequest,
  CreateGoodsReceiptRequest,
  GoodsReceipt,
  GoodsReceiptListQuery,
  GoodsReceiptSummary,
  Page,
} from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { AppError, conflict, isUniqueViolation, notFound } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, lockTenantResource, type Trx } from '../database/database.service.js';
import { claimIdempotencyKey, completeIdempotencyKey } from '../finance/idempotency.js';
import { decimalPlaces, formatMoney, multiplyMoney, parseMoney, sumMoney, type Money } from '../finance/money.js';
import { PostingService } from '../finance/posting.service.js';
import { StockService } from '../inventory/stock.service.js';

const lineError = (index: number, field: string, message: string) =>
  new AppError(400, 'VALIDATION_FAILED', message, [{ path: `lines.${index}.${field}`, message }]);

interface ReceiptLinePlan {
  orderLineId: string;
  itemId: string;
  itemCode: string;
  stocked: boolean;
  warehouseId: string | null;
  quantity: Money;
  netPrice: Money;
  lineTotal: Money;
  inventoryAccountId: string | null;
}

@Injectable()
export class GoodsReceiptsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly posting: PostingService,
    private readonly stock: StockService,
    private readonly audit: AuditService,
  ) {}

  private run<T>(principal: TenantPrincipal, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, fn);
  }

  async create(principal: TenantPrincipal, input: CreateGoodsReceiptRequest, correlationId: string): Promise<{ replayed: boolean; receipt: GoodsReceipt }> {
    const { idempotencyKey, ...payload } = input;
    return this.run(principal, async (trx) => {
      const existing = await claimIdempotencyKey(trx, principal.tenantId, idempotencyKey, 'goods_receipt.create', payload);
      if (existing) {
        return { replayed: true, receipt: await this.loadOrThrow(trx, principal.tenantId, existing) };
      }
      const tenantId = principal.tenantId;
      const order = await trx
        .selectFrom('purchase_orders')
        .select(['id', 'status', 'vendor_id', 'branch_id', 'currency', 'document_number', 'version', 'posting_date'])
        .where('tenant_id', '=', tenantId)
        .where('id', '=', payload.orderId)
        .forUpdate()
        .executeTakeFirst();
      if (!order) throw notFound('The purchase order was not found');
      if (order.status !== 'open') throw conflict(`Purchase order ${order.document_number} is ${order.status} and cannot be received`);
      if (payload.postingDate < order.posting_date) {
        throw new AppError(400, 'VALIDATION_FAILED', 'The receipt date cannot be before the order date', [{ path: 'postingDate', message: 'Before order date' }]);
      }
      await this.posting.openPeriodFor(trx, tenantId, payload.postingDate);
      const orderLineIds = payload.lines.map((line) => line.orderLineId);
      if (new Set(orderLineIds).size !== orderLineIds.length) {
        throw new AppError(400, 'VALIDATION_FAILED', 'Each order line can appear only once in a receipt');
      }
      const orderLines = await trx
        .selectFrom('purchase_order_lines as l')
        .innerJoin('items as i', (join) => join.onRef('i.id', '=', 'l.item_id').onRef('i.tenant_id', '=', 'l.tenant_id'))
        .innerJoin('units_of_measure as u', (join) => join.onRef('u.id', '=', 'l.uom_id').onRef('u.tenant_id', '=', 'l.tenant_id'))
        .innerJoin('item_groups as g', (join) => join.onRef('g.id', '=', 'i.group_id').onRef('g.tenant_id', '=', 'i.tenant_id'))
        .select(['l.id', 'l.item_id', 'l.warehouse_id', 'l.quantity', 'l.received_quantity', 'l.net_price', 'i.code', 'i.item_type', 'u.decimals', 'g.inventory_account_id as group_account'])
        .where('l.tenant_id', '=', tenantId)
        .where('l.order_id', '=', order.id)
        .forUpdate()
        .execute();
      const warehouseIds = [
        ...new Set([...payload.lines.map((line) => line.warehouseId), ...orderLines.map((line) => line.warehouse_id)].filter((id): id is string => Boolean(id))),
      ];
      const warehouses = warehouseIds.length
        ? await trx.selectFrom('warehouses').select(['id', 'status', 'inventory_account_id']).where('tenant_id', '=', tenantId).where('id', 'in', warehouseIds).execute()
        : [];
      const plan: ReceiptLinePlan[] = payload.lines.map((line, index) => {
        const orderLine = orderLines.find((candidate) => candidate.id === line.orderLineId);
        if (!orderLine) throw lineError(index, 'orderLineId', `Line ${index + 1} does not belong to purchase order ${order.document_number}`);
        if (decimalPlaces(line.quantity) > orderLine.decimals) {
          throw lineError(index, 'quantity', `Line ${index + 1}: ${orderLine.code} allows ${orderLine.decimals} decimal places`);
        }
        const quantity = parseMoney(line.quantity);
        const open = parseMoney(orderLine.quantity) - parseMoney(orderLine.received_quantity);
        if (quantity <= 0n) throw lineError(index, 'quantity', `Line ${index + 1}: quantity must be greater than zero`);
        if (quantity > open) {
          throw new AppError(422, 'OVER_RECEIPT', `Line ${index + 1}: ${orderLine.code} has only ${formatMoney(open)} open on the order`, [
            { path: `lines.${index}.quantity`, message: 'Exceeds open quantity' },
          ]);
        }
        const stocked = orderLine.item_type === 'inventory';
        const warehouseId = stocked ? (line.warehouseId ?? orderLine.warehouse_id) : null;
        const warehouse = warehouses.find((candidate) => candidate.id === warehouseId);
        if (stocked && (!warehouse || warehouse.status !== 'active')) {
          throw lineError(index, 'warehouseId', `Line ${index + 1}: choose an active warehouse for ${orderLine.code}`);
        }
        if (!stocked && line.warehouseId) throw lineError(index, 'warehouseId', `Line ${index + 1}: ${orderLine.code} is not stocked`);
        const netPrice = parseMoney(orderLine.net_price);
        return {
          orderLineId: orderLine.id,
          itemId: orderLine.item_id,
          itemCode: orderLine.code,
          stocked,
          warehouseId,
          quantity,
          netPrice,
          lineTotal: multiplyMoney(quantity, netPrice),
          inventoryAccountId: warehouse?.inventory_account_id ?? orderLine.group_account ?? null,
        };
      });

      const receiptId = randomUUID();
      const stockedLines = plan.filter((line) => line.stocked && line.lineTotal >= 0n);
      let journalId: string | null = null;
      const stockValue = sumMoney(stockedLines.map((line) => line.lineTotal));
      if (stockValue > 0n) {
        const determination = await this.determination(trx, tenantId, ['inventory', 'goods_received_not_invoiced']);
        const grni = determination.get('goods_received_not_invoiced');
        if (!grni) throw new AppError(422, 'MAPPING_MISSING', 'G/L account determination is missing the Goods Received Not Invoiced account');
        const debits = new Map<string, Money>();
        for (const line of stockedLines) {
          const account = line.inventoryAccountId ?? determination.get('inventory');
          if (!account) throw new AppError(422, 'MAPPING_MISSING', 'G/L account determination is missing the Inventory account');
          if (line.lineTotal > 0n) debits.set(account, (debits.get(account) ?? 0n) + line.lineTotal);
        }
        const journal = await this.posting.post(trx, {
          tenantId,
          userId: principal.userId,
          sourceType: 'goods_receipt',
          sourceId: receiptId,
          postingDate: payload.postingDate,
          memo: `Goods receipt for ${order.document_number}`,
          reference: order.document_number,
          lines: [
            ...[...debits.entries()].map(([accountId, amount]) => ({ accountId, debit: amount, credit: 0n })),
            { accountId: grni, debit: 0n, credit: stockValue },
          ],
        });
        journalId = journal.id;
      }

      const series = await this.posting.nextNumber(trx, tenantId, 'goods_receipt', payload.seriesId);
      await trx
        .insertInto('goods_receipts')
        .values({
          id: receiptId,
          tenant_id: tenantId,
          series_id: series.seriesId,
          number: series.number,
          document_number: series.documentNumber,
          order_id: order.id,
          vendor_id: order.vendor_id,
          branch_id: order.branch_id,
          posting_date: payload.postingDate,
          remarks: payload.remarks ?? null,
          currency: order.currency,
          total: formatMoney(sumMoney(plan.map((line) => line.lineTotal))),
          journal_id: journalId,
          created_by: principal.userId,
        })
        .execute();
      const insertedLines = await trx
        .insertInto('goods_receipt_lines')
        .values(
          plan.map((line, index) => ({
            tenant_id: tenantId,
            receipt_id: receiptId,
            line_no: index + 1,
            order_line_id: line.orderLineId,
            item_id: line.itemId,
            warehouse_id: line.warehouseId,
            quantity: formatMoney(line.quantity),
            net_price: formatMoney(line.netPrice),
            line_total: formatMoney(line.lineTotal),
          })),
        )
        .returning(['id', 'line_no'])
        .execute();
      await this.stock.lockValuations(trx, tenantId, stockedLines.map((line) => line.itemId));
      for (const [index, line] of plan.entries()) {
        if (!line.stocked || !line.warehouseId) continue;
        await this.stock.record(trx, {
          tenantId,
          userId: principal.userId,
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          quantity: line.quantity,
          value: line.lineTotal,
          sourceType: 'goods_receipt',
          sourceId: receiptId,
          sourceLineId: insertedLines.find((row) => row.line_no === index + 1)?.id ?? null,
          postingDate: payload.postingDate,
          journalId,
        });
      }
      for (const line of plan) {
        const orderLine = orderLines.find((candidate) => candidate.id === line.orderLineId);
        if (!orderLine) continue;
        await trx
          .updateTable('purchase_order_lines')
          .set({ received_quantity: formatMoney(parseMoney(orderLine.received_quantity) + line.quantity) })
          .where('tenant_id', '=', tenantId)
          .where('id', '=', line.orderLineId)
          .execute();
      }
      await this.refreshOrderStatus(trx, tenantId, order.id, order.version);
      await completeIdempotencyKey(trx, tenantId, idempotencyKey, receiptId);
      const receipt = await this.loadOrThrow(trx, tenantId, receiptId);
      await this.audit.record(trx, {
        tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'goods_receipt.posted',
        entityType: 'goods_receipt',
        entityId: receiptId,
        after: { documentNumber: receipt.documentNumber, order: order.document_number, total: receipt.total, journal: receipt.journalNumber },
        correlationId,
      });
      return { replayed: false, receipt };
    });
  }

  async cancel(
    principal: TenantPrincipal,
    receiptId: string,
    input: CancelGoodsReceiptRequest,
    correlationId: string,
  ): Promise<{ replayed: boolean; receipt: GoodsReceipt }> {
    const { idempotencyKey, ...payload } = input;
    try {
      return await this.run(principal, async (trx) => {
        const tenantId = principal.tenantId;
        const existing = await claimIdempotencyKey(trx, tenantId, idempotencyKey, `goods_receipt.cancel:${receiptId}`, payload);
        if (existing) {
          return { replayed: true, receipt: await this.loadOrThrow(trx, tenantId, existing) };
        }
        await lockTenantResource(trx, tenantId, `goods-receipt-cancel:${receiptId}`);
        const original = await this.loadOrThrow(trx, tenantId, receiptId);
        if (original.isCancellation) throw conflict('A cancellation document cannot itself be cancelled');
        if (original.status === 'cancelled') throw conflict(`Goods receipt ${original.documentNumber} is already cancelled`);
        if (payload.postingDate < original.postingDate) {
          throw new AppError(422, 'POSTING_REJECTED', 'The cancellation date cannot be earlier than the receipt date', [
            { path: 'postingDate', message: 'Before the receipt date' },
          ]);
        }
        await this.posting.openPeriodFor(trx, tenantId, payload.postingDate);
        const invoiced = await trx
          .selectFrom('goods_receipt_lines')
          .select('id')
          .where('tenant_id', '=', tenantId)
          .where('receipt_id', '=', receiptId)
          .where('invoiced_quantity', '>', '0')
          .executeTakeFirst();
        if (invoiced) throw conflict('Supplier invoices are based on this receipt; reverse or cancel them first');
        const movements = await trx
          .selectFrom('stock_movements')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('source_type', '=', 'goods_receipt')
          .where('source_id', '=', receiptId)
          .execute();
        const order = await trx
          .selectFrom('purchase_orders')
          .select(['id', 'status', 'closed_reason', 'version', 'document_number'])
          .where('tenant_id', '=', tenantId)
          .where('id', '=', original.orderId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        await this.stock.lockValuations(trx, tenantId, movements.map((movement) => movement.item_id));
        await this.stock.assertDocumentIsLatest(trx, tenantId, movements, (itemId) => original.lines.find((line) => line.itemId === itemId)?.itemCode ?? itemId);

        const cancellationId = randomUUID();
        let journalId: string | null = null;
        if (original.journalId) {
          const journalLines = await trx
            .selectFrom('journal_lines')
            .select(['account_id', 'partner_id', 'debit', 'credit', 'memo'])
            .where('tenant_id', '=', tenantId)
            .where('journal_id', '=', original.journalId)
            .orderBy('line_no')
            .execute();
          const journal = await this.posting.post(trx, {
            tenantId,
            userId: principal.userId,
            sourceType: 'goods_receipt_cancellation',
            sourceId: cancellationId,
            postingDate: payload.postingDate,
            memo: `Cancellation of goods receipt ${original.documentNumber}`,
            reference: original.documentNumber,
            lines: journalLines.map((line) => ({
              accountId: line.account_id,
              partnerId: line.partner_id,
              debit: parseMoney(line.credit),
              credit: parseMoney(line.debit),
              memo: line.memo,
            })),
          });
          journalId = journal.id;
        }
        const header = await trx
          .selectFrom('goods_receipts')
          .select(['series_id', 'vendor_id', 'branch_id', 'currency', 'total'])
          .where('tenant_id', '=', tenantId)
          .where('id', '=', receiptId)
          .executeTakeFirstOrThrow();
        const series = await this.posting.nextNumber(trx, tenantId, 'goods_receipt', header.series_id);
        await trx
          .insertInto('goods_receipts')
          .values({
            id: cancellationId,
            tenant_id: tenantId,
            series_id: series.seriesId,
            number: series.number,
            document_number: series.documentNumber,
            order_id: original.orderId,
            vendor_id: header.vendor_id,
            branch_id: header.branch_id,
            posting_date: payload.postingDate,
            remarks: `Cancellation of ${original.documentNumber}`,
            currency: header.currency,
            total: header.total,
            is_cancellation: true,
            cancellation_of_id: receiptId,
            cancellation_reason: payload.reason,
            journal_id: journalId,
            created_by: principal.userId,
          })
          .execute();
        const cancellationLines = await trx
          .insertInto('goods_receipt_lines')
          .values(
            original.lines.map((line) => ({
              tenant_id: tenantId,
              receipt_id: cancellationId,
              line_no: line.lineNo,
              order_line_id: line.orderLineId,
              item_id: line.itemId,
              warehouse_id: line.warehouseId,
              quantity: line.quantity,
              net_price: line.netPrice,
              line_total: line.lineTotal,
            })),
          )
          .returning(['id', 'line_no'])
          .execute();
        for (const movement of movements) {
          const originalLine = original.lines.find((candidate) => candidate.id === movement.source_line_id);
          await this.stock.record(trx, {
            tenantId,
            userId: principal.userId,
            itemId: movement.item_id,
            warehouseId: movement.warehouse_id,
            quantity: -parseMoney(movement.quantity),
            value: -parseMoney(movement.value),
            sourceType: 'goods_receipt_cancellation',
            sourceId: cancellationId,
            sourceLineId: cancellationLines.find((row) => row.line_no === originalLine?.lineNo)?.id ?? null,
            postingDate: payload.postingDate,
            journalId,
          });
        }
        for (const line of original.lines) {
          const current = await trx
            .selectFrom('purchase_order_lines')
            .select('received_quantity')
            .where('tenant_id', '=', tenantId)
            .where('id', '=', line.orderLineId)
            .forUpdate()
            .executeTakeFirstOrThrow();
          await trx
            .updateTable('purchase_order_lines')
            .set({ received_quantity: formatMoney(parseMoney(current.received_quantity) - parseMoney(line.quantity)) })
            .where('tenant_id', '=', tenantId)
            .where('id', '=', line.orderLineId)
            .execute();
        }
        if (order.status === 'closed' && order.closed_reason === 'fully_received') {
          await trx
            .updateTable('purchase_orders')
            .set({ status: 'open', closed_reason: null, version: order.version + 1, updated_at: new Date() })
            .where('tenant_id', '=', tenantId)
            .where('id', '=', order.id)
            .execute();
        }
        await trx.updateTable('goods_receipts').set({ status: 'cancelled' }).where('tenant_id', '=', tenantId).where('id', '=', receiptId).execute();
        await completeIdempotencyKey(trx, tenantId, idempotencyKey, cancellationId);
        const cancellation = await this.loadOrThrow(trx, tenantId, cancellationId);
        await this.audit.record(trx, {
          tenantId,
          actor: { type: 'user', id: principal.userId },
          action: 'goods_receipt.cancelled',
          entityType: 'goods_receipt',
          entityId: receiptId,
          before: { documentNumber: original.documentNumber, status: 'posted' },
          after: { status: 'cancelled', cancellation: cancellation.documentNumber, reason: payload.reason, postingDate: payload.postingDate },
          correlationId,
        });
        return { replayed: false, receipt: cancellation };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'goods_receipts_single_cancellation_key')) {
        throw conflict('This goods receipt has already been cancelled');
      }
      throw error;
    }
  }

  private async refreshOrderStatus(trx: Trx, tenantId: string, orderId: string, version: number): Promise<void> {
    const open = await trx
      .selectFrom('purchase_order_lines')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('order_id', '=', orderId)
      .whereRef('received_quantity', '<', 'quantity')
      .executeTakeFirst();
    if (!open) {
      await trx
        .updateTable('purchase_orders')
        .set({ status: 'closed', closed_reason: 'fully_received', version: version + 1, updated_at: new Date() })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', orderId)
        .execute();
    }
  }

  private async determination(trx: Trx, tenantId: string, keys: string[]): Promise<Map<string, string>> {
    const rows = await trx
      .selectFrom('gl_determination')
      .select(['determination_key', 'account_id'])
      .where('tenant_id', '=', tenantId)
      .where('determination_key', 'in', keys)
      .execute();
    return new Map(rows.map((row) => [row.determination_key, row.account_id]));
  }

  async list(principal: TenantPrincipal, query: GoodsReceiptListQuery): Promise<Page<GoodsReceiptSummary>> {
    return this.run(principal, async (trx) => {
      let base = trx
        .selectFrom('goods_receipts as r')
        .innerJoin('purchase_orders as o', (join) => join.onRef('o.id', '=', 'r.order_id').onRef('o.tenant_id', '=', 'r.tenant_id'))
        .innerJoin('business_partners as v', (join) => join.onRef('v.id', '=', 'r.vendor_id').onRef('v.tenant_id', '=', 'r.tenant_id'))
        .where('r.tenant_id', '=', principal.tenantId);
      if (query.search) {
        const pattern = `%${query.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
        base = base.where((eb) => eb.or([eb('r.document_number', 'ilike', pattern), eb('o.document_number', 'ilike', pattern), eb('v.name', 'ilike', pattern)]));
      }
      if (query.orderId) base = base.where('r.order_id', '=', query.orderId);
      const total = await base.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
      const rows = await base
        .select(['r.id', 'r.document_number', 'o.document_number as order_number', 'v.name', 'r.posting_date', 'r.total', 'r.status', 'r.is_cancellation'])
        .orderBy('r.posted_at', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute();
      return {
        items: rows.map((row) => ({
          id: row.id,
          documentNumber: row.document_number,
          orderNumber: row.order_number,
          vendorName: row.name,
          postingDate: row.posting_date,
          total: row.total,
          status: row.status,
          isCancellation: row.is_cancellation,
        })),
        limit: query.limit,
        offset: query.offset,
        total: Number(total.count),
      };
    });
  }

  async get(principal: TenantPrincipal, receiptId: string): Promise<GoodsReceipt> {
    return this.run(principal, (trx) => this.loadOrThrow(trx, principal.tenantId, receiptId));
  }

  private async loadOrThrow(trx: Trx, tenantId: string, receiptId: string): Promise<GoodsReceipt> {
    const receipt = await trx
      .selectFrom('goods_receipts as r')
      .innerJoin('purchase_orders as o', (join) => join.onRef('o.id', '=', 'r.order_id').onRef('o.tenant_id', '=', 'r.tenant_id'))
      .innerJoin('business_partners as v', (join) => join.onRef('v.id', '=', 'r.vendor_id').onRef('v.tenant_id', '=', 'r.tenant_id'))
      .innerJoin('branches as b', (join) => join.onRef('b.id', '=', 'r.branch_id').onRef('b.tenant_id', '=', 'r.tenant_id'))
      .leftJoin('journal_entries as je', (join) => join.onRef('je.id', '=', 'r.journal_id').onRef('je.tenant_id', '=', 'r.tenant_id'))
      .leftJoin('goods_receipts as c', (join) => join.onRef('c.cancellation_of_id', '=', 'r.id').onRef('c.tenant_id', '=', 'r.tenant_id'))
      .selectAll('r')
      .select(['o.document_number as order_number', 'v.code as vendor_code', 'v.name as vendor_name', 'b.code as branch_code', 'je.document_number as journal_number', 'c.id as cancelled_by_id'])
      .where('r.tenant_id', '=', tenantId)
      .where('r.id', '=', receiptId)
      .executeTakeFirst();
    if (!receipt) throw notFound();
    const lines = await trx
      .selectFrom('goods_receipt_lines as l')
      .innerJoin('purchase_order_lines as ol', (join) => join.onRef('ol.id', '=', 'l.order_line_id').onRef('ol.tenant_id', '=', 'l.tenant_id'))
      .innerJoin('items as i', (join) => join.onRef('i.id', '=', 'l.item_id').onRef('i.tenant_id', '=', 'l.tenant_id'))
      .innerJoin('units_of_measure as u', (join) => join.onRef('u.id', '=', 'ol.uom_id').onRef('u.tenant_id', '=', 'ol.tenant_id'))
      .leftJoin('warehouses as w', (join) => join.onRef('w.id', '=', 'l.warehouse_id').onRef('w.tenant_id', '=', 'l.tenant_id'))
      .select(['l.id', 'l.line_no', 'l.order_line_id', 'l.item_id', 'i.code as item_code', 'ol.description', 'u.code as uom_code', 'l.warehouse_id', 'w.code as warehouse_code', 'l.quantity', 'l.net_price', 'l.line_total'])
      .where('l.tenant_id', '=', tenantId)
      .where('l.receipt_id', '=', receiptId)
      .orderBy('l.line_no')
      .execute();
    return {
      id: receipt.id,
      documentNumber: receipt.document_number,
      orderId: receipt.order_id,
      orderNumber: receipt.order_number,
      vendorId: receipt.vendor_id,
      vendorCode: receipt.vendor_code,
      vendorName: receipt.vendor_name,
      branchCode: receipt.branch_code,
      postingDate: receipt.posting_date,
      remarks: receipt.remarks,
      currency: receipt.currency,
      total: receipt.total,
      status: receipt.status,
      isCancellation: receipt.is_cancellation,
      cancellationOfId: receipt.cancellation_of_id,
      cancelledById: receipt.cancelled_by_id,
      cancellationReason: receipt.cancellation_reason,
      journalId: receipt.journal_id,
      journalNumber: receipt.journal_number,
      postedAt: receipt.posted_at.toISOString(),
      lines: lines.map((line) => ({
        id: line.id,
        lineNo: line.line_no,
        orderLineId: line.order_line_id,
        itemId: line.item_id,
        itemCode: line.item_code,
        description: line.description,
        uomCode: line.uom_code,
        warehouseId: line.warehouse_id,
        warehouseCode: line.warehouse_code,
        quantity: line.quantity,
        netPrice: line.net_price,
        lineTotal: line.line_total,
      })),
    };
  }
}
