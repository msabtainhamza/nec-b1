import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { CreditService } from './credit.service.js';
import type { CancelSalesDocumentRequest, CreateDeliveryRequest, Delivery, DeliveryListQuery, DeliverySummary, Page } from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { AppError, conflict, isUniqueViolation, notFound } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, lockTenantResource, type Trx } from '../database/database.service.js';
import { claimIdempotencyKey, completeIdempotencyKey } from '../finance/idempotency.js';
import { decimalPlaces, formatMoney, multiplyMoney, parseMoney, sumMoney, type Money } from '../finance/money.js';
import { PostingService, type PostingLine } from '../finance/posting.service.js';
import { StockService } from '../inventory/stock.service.js';
import { SalesOrdersService } from './sales-orders.service.js';

const lineError = (index: number, field: string, message: string, status = 400, code = 'VALIDATION_FAILED') =>
  new AppError(status, code, message, [{ path: `lines.${index}.${field}`, message }]);

@Injectable()
export class DeliveriesService {
  constructor(
    private readonly credit: CreditService,
    private readonly database: DatabaseService,
    private readonly posting: PostingService,
    private readonly stock: StockService,
    private readonly orders: SalesOrdersService,
    private readonly audit: AuditService,
  ) {}

  private run<T>(principal: TenantPrincipal, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId, serializeCredit: true }, fn);
  }

  private read<T>(principal: TenantPrincipal, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, fn);
  }

  private async determination(trx: Trx, tenantId: string): Promise<Map<string, string>> {
    const rows = await trx
      .selectFrom('gl_determination')
      .select(['determination_key', 'account_id'])
      .where('tenant_id', '=', tenantId)
      .where('determination_key', 'in', ['inventory', 'cogs'])
      .execute();
    return new Map(rows.map((row) => [row.determination_key, row.account_id]));
  }

  async create(principal: TenantPrincipal, input: CreateDeliveryRequest, correlationId: string): Promise<{ replayed: boolean; delivery: Delivery }> {
    const { idempotencyKey, ...payload } = input;
    return this.run(principal, async (trx) => {
      const tenantId = principal.tenantId;
      const existing = await claimIdempotencyKey(trx, tenantId, idempotencyKey, 'delivery.create', payload);
      if (existing) return { replayed: true, delivery: await this.loadOrThrow(trx, tenantId, existing) };
      const order = await trx
        .selectFrom('sales_orders')
        .select(['id', 'status', 'customer_id', 'branch_id', 'currency', 'document_number', 'posting_date'])
        .where('tenant_id', '=', tenantId)
        .where('id', '=', payload.orderId)
        .forUpdate()
        .executeTakeFirst();
      if (!order) throw notFound('The sales order was not found');
      if (order.status !== 'open') throw conflict(`Sales order ${order.document_number} is ${order.status} and cannot be delivered`);
      if (payload.postingDate < order.posting_date) {
        throw new AppError(400, 'VALIDATION_FAILED', 'The delivery date cannot be before the order date', [{ path: 'postingDate', message: 'Before order date' }]);
      }
      await this.posting.openPeriodFor(trx, tenantId, payload.postingDate);
      const orderLineIds = payload.lines.map((line) => line.orderLineId);
      if (new Set(orderLineIds).size !== orderLineIds.length) throw new AppError(400, 'VALIDATION_FAILED', 'Each order line can appear only once in a delivery');
      const orderLines = await trx
        .selectFrom('sales_order_lines as l')
        .innerJoin('items as i', (join) => join.onRef('i.id', '=', 'l.item_id').onRef('i.tenant_id', '=', 'l.tenant_id'))
        .innerJoin('units_of_measure as u', (join) => join.onRef('u.id', '=', 'l.uom_id').onRef('u.tenant_id', '=', 'l.tenant_id'))
        .innerJoin('item_groups as g', (join) => join.onRef('g.id', '=', 'i.group_id').onRef('g.tenant_id', '=', 'i.tenant_id'))
        .select([
          'l.id',
          'l.item_id',
          'l.stocked',
          'l.warehouse_id',
          'l.quantity',
          'l.delivered_quantity',
          'l.net_price',
          'i.code',
          'u.decimals',
          'g.inventory_account_id as group_inventory',
          'g.cogs_account_id as group_cogs',
        ])
        .where('l.tenant_id', '=', tenantId)
        .where('l.order_id', '=', order.id)
        .forUpdate('l')
        .execute();
      const warehouseIds = [
        ...new Set([...payload.lines.map((line) => line.warehouseId), ...orderLines.map((line) => line.warehouse_id)].filter((id): id is string => Boolean(id))),
      ];
      const warehouses = warehouseIds.length
        ? await trx.selectFrom('warehouses').select(['id', 'status', 'inventory_account_id']).where('tenant_id', '=', tenantId).where('id', 'in', warehouseIds).execute()
        : [];
      const determination = await this.determination(trx, tenantId);
      const checked = payload.lines.map((line, index) => {
        const orderLine = orderLines.find((candidate) => candidate.id === line.orderLineId);
        if (!orderLine) throw lineError(index, 'orderLineId', `Line ${index + 1} does not belong to sales order ${order.document_number}`);
        if (!orderLine.stocked) throw lineError(index, 'orderLineId', `Line ${index + 1}: ${orderLine.code} is not stocked; invoice it directly from the sales order`);
        if (decimalPlaces(line.quantity) > orderLine.decimals) throw lineError(index, 'quantity', `Line ${index + 1}: ${orderLine.code} allows ${orderLine.decimals} decimal places`);
        const quantity = parseMoney(line.quantity);
        if (quantity <= 0n) throw lineError(index, 'quantity', `Line ${index + 1}: quantity must be greater than zero`);
        const open = parseMoney(orderLine.quantity) - parseMoney(orderLine.delivered_quantity);
        if (quantity > open) throw lineError(index, 'quantity', `Line ${index + 1}: ${orderLine.code} has only ${formatMoney(open)} open on the order`, 422, 'OVER_DELIVERY');
        const warehouseId = line.warehouseId ?? orderLine.warehouse_id;
        const warehouse = warehouses.find((candidate) => candidate.id === warehouseId);
        if (!warehouse || warehouse.status !== 'active') throw lineError(index, 'warehouseId', `Line ${index + 1}: choose an active warehouse for ${orderLine.code}`);
        const inventoryAccountId = warehouse.inventory_account_id ?? orderLine.group_inventory ?? determination.get('inventory');
        if (!inventoryAccountId) throw new AppError(422, 'MAPPING_MISSING', 'G/L account determination is missing the Inventory account');
        const cogsAccountId = orderLine.group_cogs ?? determination.get('cogs');
        if (!cogsAccountId) throw new AppError(422, 'MAPPING_MISSING', 'G/L account determination is missing the Cost of Goods Sold account');
        const netPrice = parseMoney(orderLine.net_price);
        return { orderLine, warehouseId: warehouse.id, quantity, netPrice, lineTotal: multiplyMoney(quantity, netPrice), inventoryAccountId, cogsAccountId };
      });

      await this.stock.lockValuations(trx, tenantId, checked.map((line) => line.orderLine.item_id));
      const running = new Map<string, { onHand: Money; totalValue: Money }>();
      const byWarehouse = new Map<string, Money>();
      const stockRows = await trx
        .selectFrom('item_warehouse_stock')
        .select(['item_id', 'warehouse_id', 'on_hand'])
        .where('tenant_id', '=', tenantId)
        .where('item_id', 'in', [...new Set(checked.map((line) => line.orderLine.item_id))])
        .execute();
      const plan = [];
      for (const [index, line] of checked.entries()) {
        const itemId = line.orderLine.item_id;
        if (!running.has(itemId)) running.set(itemId, await this.stock.valuation(trx, tenantId, itemId));
        const state = running.get(itemId) as { onHand: Money; totalValue: Money };
        const key = `${itemId}:${line.warehouseId}`;
        const available = byWarehouse.get(key) ?? parseMoney(stockRows.find((row) => row.item_id === itemId && row.warehouse_id === line.warehouseId)?.on_hand ?? '0');
        if (line.quantity > available) {
          throw lineError(index, 'quantity', `Line ${index + 1}: only ${formatMoney(available)} of ${line.orderLine.code} is in stock in this warehouse`, 422, 'INSUFFICIENT_STOCK');
        }
        byWarehouse.set(key, available - line.quantity);
        const costValue = this.stock.issueValue(state, line.quantity);
        state.onHand -= line.quantity;
        state.totalValue -= costValue;
        plan.push({ ...line, costValue });
      }

      const deliveryId = randomUUID();
      const costTotal = sumMoney(plan.map((line) => line.costValue));
      let journalId: string | null = null;
      if (costTotal > 0n) {
        const debits = new Map<string, Money>();
        const credits = new Map<string, Money>();
        for (const line of plan) {
          if (line.costValue === 0n) continue;
          debits.set(line.cogsAccountId, (debits.get(line.cogsAccountId) ?? 0n) + line.costValue);
          credits.set(line.inventoryAccountId, (credits.get(line.inventoryAccountId) ?? 0n) + line.costValue);
        }
        const journalLines: PostingLine[] = [
          ...[...debits.entries()].map(([accountId, amount]) => ({ accountId, debit: amount, credit: 0n })),
          ...[...credits.entries()].map(([accountId, amount]) => ({ accountId, debit: 0n, credit: amount })),
        ];
        journalId = (
          await this.posting.post(trx, {
            tenantId,
            userId: principal.userId,
            sourceType: 'delivery',
            sourceId: deliveryId,
            postingDate: payload.postingDate,
            memo: `Delivery for ${order.document_number}`,
            reference: order.document_number,
            lines: journalLines,
          })
        ).id;
      }
      const series = await this.posting.nextNumber(trx, tenantId, 'delivery', payload.seriesId);
      await trx
        .insertInto('deliveries')
        .values({
          id: deliveryId,
          tenant_id: tenantId,
          series_id: series.seriesId,
          number: series.number,
          document_number: series.documentNumber,
          order_id: order.id,
          customer_id: order.customer_id,
          branch_id: order.branch_id,
          posting_date: payload.postingDate,
          remarks: payload.remarks ?? null,
          currency: order.currency,
          total: formatMoney(sumMoney(plan.map((line) => line.lineTotal))),
          cost_total: formatMoney(costTotal),
          journal_id: journalId,
          created_by: principal.userId,
        })
        .execute();
      const inserted = await trx
        .insertInto('delivery_lines')
        .values(
          plan.map((line, index) => ({
            tenant_id: tenantId,
            delivery_id: deliveryId,
            line_no: index + 1,
            order_line_id: line.orderLine.id,
            item_id: line.orderLine.item_id,
            warehouse_id: line.warehouseId,
            quantity: formatMoney(line.quantity),
            net_price: formatMoney(line.netPrice),
            line_total: formatMoney(line.lineTotal),
            cost_value: formatMoney(line.costValue),
          })),
        )
        .returning(['id', 'line_no'])
        .execute();
      for (const [index, line] of plan.entries()) {
        await this.stock.record(trx, {
          tenantId,
          userId: principal.userId,
          itemId: line.orderLine.item_id,
          warehouseId: line.warehouseId,
          quantity: -line.quantity,
          value: -line.costValue,
          sourceType: 'delivery',
          sourceId: deliveryId,
          sourceLineId: inserted.find((row) => row.line_no === index + 1)?.id ?? null,
          postingDate: payload.postingDate,
          journalId,
        });
        await trx
          .updateTable('sales_order_lines')
          .set({ delivered_quantity: formatMoney(parseMoney(line.orderLine.delivered_quantity) + line.quantity) })
          .where('tenant_id', '=', tenantId)
          .where('id', '=', line.orderLine.id)
          .execute();
      }
      await this.orders.refreshStatus(trx, tenantId, [order.id]);
      await this.credit.check(trx, principal, order.customer_id, input, 'delivery', deliveryId, correlationId);
      await completeIdempotencyKey(trx, tenantId, idempotencyKey, deliveryId);
      const delivery = await this.loadOrThrow(trx, tenantId, deliveryId);
      await this.audit.record(trx, {
        tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'delivery.posted',
        entityType: 'delivery',
        entityId: deliveryId,
        after: { documentNumber: delivery.documentNumber, order: order.document_number, total: delivery.total, costTotal: delivery.costTotal, journal: delivery.journalNumber },
        correlationId,
      });
      return { replayed: false, delivery };
    });
  }

  async cancel(principal: TenantPrincipal, deliveryId: string, input: CancelSalesDocumentRequest, correlationId: string): Promise<{ replayed: boolean; delivery: Delivery }> {
    const { idempotencyKey, ...payload } = input;
    try {
      return await this.run(principal, async (trx) => {
        const tenantId = principal.tenantId;
        const existing = await claimIdempotencyKey(trx, tenantId, idempotencyKey, `delivery.cancel:${deliveryId}`, payload);
        if (existing) return { replayed: true, delivery: await this.loadOrThrow(trx, tenantId, existing) };
        await lockTenantResource(trx, tenantId, `delivery-cancel:${deliveryId}`);
        const original = await this.loadOrThrow(trx, tenantId, deliveryId);
        if (original.isCancellation) throw conflict('A cancellation document cannot itself be cancelled');
        if (original.status === 'cancelled') throw conflict(`Delivery ${original.documentNumber} is already cancelled`);
        const invoiced = await trx
          .selectFrom('ar_invoice_lines as l')
          .innerJoin('ar_invoices as a', (join) => join.onRef('a.id', '=', 'l.invoice_id').onRef('a.tenant_id', '=', 'l.tenant_id'))
          .innerJoin('delivery_lines as d', (join) => join.onRef('d.id', '=', 'l.delivery_line_id').onRef('d.tenant_id', '=', 'l.tenant_id'))
          .select('a.document_number')
          .distinct()
          .where('l.tenant_id', '=', tenantId)
          .where('l.delivery_id', '=', deliveryId)
          .where('a.status', '=', 'posted')
          .where('a.is_cancellation', '=', false)
          .where('d.invoiced_quantity', '>', '0')
          .execute();
        if (invoiced.length > 0) {
          throw conflict(`A/R invoices are based on this delivery (${invoiced.map((row) => row.document_number).join(', ')}); cancel them first`, {
            blockingInvoices: invoiced.map((row) => row.document_number),
          });
        }
        if (payload.postingDate < original.postingDate) {
          throw new AppError(422, 'POSTING_REJECTED', 'The cancellation date cannot be earlier than the delivery date', [{ path: 'postingDate', message: 'Before the delivery date' }]);
        }
        await this.posting.openPeriodFor(trx, tenantId, payload.postingDate);
        const movements = await trx.selectFrom('stock_movements').selectAll().where('tenant_id', '=', tenantId).where('source_type', '=', 'delivery').where('source_id', '=', deliveryId).execute();
        await this.stock.lockValuations(trx, tenantId, movements.map((movement) => movement.item_id));
        await this.stock.assertDocumentIsLatest(trx, tenantId, movements, (itemId) => original.lines.find((line) => line.itemId === itemId)?.itemCode ?? itemId);
        const cancellationId = randomUUID();
        let journalId: string | null = null;
        if (original.journalId) {
          const lines = await trx
            .selectFrom('journal_lines')
            .select(['account_id', 'partner_id', 'debit', 'credit', 'memo'])
            .where('tenant_id', '=', tenantId)
            .where('journal_id', '=', original.journalId)
            .orderBy('line_no')
            .execute();
          journalId = (
            await this.posting.post(trx, {
              tenantId,
              userId: principal.userId,
              sourceType: 'delivery_cancellation',
              sourceId: cancellationId,
              postingDate: payload.postingDate,
              memo: `Cancellation of delivery ${original.documentNumber}`,
              reference: original.documentNumber,
              lines: lines.map((line) => ({ accountId: line.account_id, partnerId: line.partner_id, debit: parseMoney(line.credit), credit: parseMoney(line.debit), memo: line.memo })),
            })
          ).id;
        }
        const header = await trx.selectFrom('deliveries').selectAll().where('tenant_id', '=', tenantId).where('id', '=', deliveryId).executeTakeFirstOrThrow();
        const series = await this.posting.nextNumber(trx, tenantId, 'delivery', header.series_id);
        await trx
          .insertInto('deliveries')
          .values({
            id: cancellationId,
            tenant_id: tenantId,
            series_id: series.seriesId,
            number: series.number,
            document_number: series.documentNumber,
            order_id: header.order_id,
            customer_id: header.customer_id,
            branch_id: header.branch_id,
            posting_date: payload.postingDate,
            remarks: `Cancellation of ${original.documentNumber}`,
            currency: header.currency,
            total: header.total,
            cost_total: header.cost_total,
            is_cancellation: true,
            cancellation_of_id: deliveryId,
            cancellation_reason: payload.reason,
            journal_id: journalId,
            created_by: principal.userId,
          })
          .execute();
        const copied = await trx
          .insertInto('delivery_lines')
          .values(
            original.lines.map((line) => ({
              tenant_id: tenantId,
              delivery_id: cancellationId,
              line_no: line.lineNo,
              order_line_id: line.orderLineId,
              item_id: line.itemId,
              warehouse_id: line.warehouseId,
              quantity: line.quantity,
              net_price: line.netPrice,
              line_total: line.lineTotal,
              cost_value: line.costValue,
            })),
          )
          .returning(['id', 'line_no'])
          .execute();
        for (const movement of movements) {
          const line = original.lines.find((candidate) => candidate.id === movement.source_line_id);
          await this.stock.record(trx, {
            tenantId,
            userId: principal.userId,
            itemId: movement.item_id,
            warehouseId: movement.warehouse_id,
            quantity: -parseMoney(movement.quantity),
            value: -parseMoney(movement.value),
            sourceType: 'delivery_cancellation',
            sourceId: cancellationId,
            sourceLineId: copied.find((row) => row.line_no === line?.lineNo)?.id ?? null,
            postingDate: payload.postingDate,
            journalId,
          });
        }
        for (const line of original.lines) {
          const current = await trx
            .selectFrom('sales_order_lines')
            .select('delivered_quantity')
            .where('tenant_id', '=', tenantId)
            .where('id', '=', line.orderLineId)
            .forUpdate()
            .executeTakeFirstOrThrow();
          await trx
            .updateTable('sales_order_lines')
            .set({ delivered_quantity: formatMoney(parseMoney(current.delivered_quantity) - parseMoney(line.quantity)) })
            .where('tenant_id', '=', tenantId)
            .where('id', '=', line.orderLineId)
            .execute();
        }
        await this.orders.refreshStatus(trx, tenantId, [header.order_id]);
        await trx.updateTable('deliveries').set({ status: 'cancelled' }).where('tenant_id', '=', tenantId).where('id', '=', deliveryId).execute();
        await completeIdempotencyKey(trx, tenantId, idempotencyKey, cancellationId);
        const cancellation = await this.loadOrThrow(trx, tenantId, cancellationId);
        await this.audit.record(trx, {
          tenantId,
          actor: { type: 'user', id: principal.userId },
          action: 'delivery.cancelled',
          entityType: 'delivery',
          entityId: deliveryId,
          before: { documentNumber: original.documentNumber, status: 'posted' },
          after: { status: 'cancelled', cancellation: cancellation.documentNumber, reason: payload.reason, postingDate: payload.postingDate },
          correlationId,
        });
        return { replayed: false, delivery: cancellation };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'deliveries_single_cancellation_key')) throw conflict('This delivery has already been cancelled');
      throw error;
    }
  }

  async list(principal: TenantPrincipal, query: DeliveryListQuery): Promise<Page<DeliverySummary>> {
    return this.read(principal, async (trx) => {
      let base = trx
        .selectFrom('deliveries as d')
        .innerJoin('sales_orders as o', (join) => join.onRef('o.id', '=', 'd.order_id').onRef('o.tenant_id', '=', 'd.tenant_id'))
        .innerJoin('business_partners as c', (join) => join.onRef('c.id', '=', 'd.customer_id').onRef('c.tenant_id', '=', 'd.tenant_id'))
        .where('d.tenant_id', '=', principal.tenantId);
      if (query.search) {
        const pattern = `%${query.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
        base = base.where((eb) => eb.or([eb('d.document_number', 'ilike', pattern), eb('o.document_number', 'ilike', pattern), eb('c.name', 'ilike', pattern)]));
      }
      if (query.orderId) base = base.where('d.order_id', '=', query.orderId);
      const total = await base.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
      const rows = await base
        .select(['d.id', 'd.document_number', 'o.document_number as order_number', 'c.name', 'd.posting_date', 'd.total', 'd.status', 'd.is_cancellation'])
        .orderBy('d.posted_at', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute();
      return {
        items: rows.map((row) => ({
          id: row.id,
          documentNumber: row.document_number,
          orderNumber: row.order_number,
          customerName: row.name,
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

  async get(principal: TenantPrincipal, deliveryId: string): Promise<Delivery> {
    return this.read(principal, (trx) => this.loadOrThrow(trx, principal.tenantId, deliveryId));
  }

  private async loadOrThrow(trx: Trx, tenantId: string, deliveryId: string): Promise<Delivery> {
    const row = await trx
      .selectFrom('deliveries as d')
      .innerJoin('sales_orders as o', (join) => join.onRef('o.id', '=', 'd.order_id').onRef('o.tenant_id', '=', 'd.tenant_id'))
      .innerJoin('business_partners as c', (join) => join.onRef('c.id', '=', 'd.customer_id').onRef('c.tenant_id', '=', 'd.tenant_id'))
      .innerJoin('branches as b', (join) => join.onRef('b.id', '=', 'd.branch_id').onRef('b.tenant_id', '=', 'd.tenant_id'))
      .leftJoin('journal_entries as je', (join) => join.onRef('je.id', '=', 'd.journal_id').onRef('je.tenant_id', '=', 'd.tenant_id'))
      .leftJoin('deliveries as x', (join) => join.onRef('x.cancellation_of_id', '=', 'd.id').onRef('x.tenant_id', '=', 'd.tenant_id'))
      .selectAll('d')
      .select(['o.document_number as order_number', 'c.code as customer_code', 'c.name as customer_name', 'b.code as branch_code', 'je.document_number as journal_number', 'x.id as cancelled_by_id'])
      .where('d.tenant_id', '=', tenantId)
      .where('d.id', '=', deliveryId)
      .executeTakeFirst();
    if (!row) throw notFound();
    const lines = await trx
      .selectFrom('delivery_lines as l')
      .innerJoin('sales_order_lines as ol', (join) => join.onRef('ol.id', '=', 'l.order_line_id').onRef('ol.tenant_id', '=', 'l.tenant_id'))
      .innerJoin('items as i', (join) => join.onRef('i.id', '=', 'l.item_id').onRef('i.tenant_id', '=', 'l.tenant_id'))
      .innerJoin('units_of_measure as u', (join) => join.onRef('u.id', '=', 'ol.uom_id').onRef('u.tenant_id', '=', 'ol.tenant_id'))
      .innerJoin('warehouses as w', (join) => join.onRef('w.id', '=', 'l.warehouse_id').onRef('w.tenant_id', '=', 'l.tenant_id'))
      .select(['l.id', 'l.line_no', 'l.order_line_id', 'l.item_id', 'i.code as item_code', 'ol.description', 'u.code as uom_code', 'l.warehouse_id', 'w.code as warehouse_code', 'l.quantity', 'l.invoiced_quantity', 'l.net_price', 'l.line_total', 'l.cost_value'])
      .where('l.tenant_id', '=', tenantId)
      .where('l.delivery_id', '=', deliveryId)
      .orderBy('l.line_no')
      .execute();
    return {
      id: row.id,
      documentNumber: row.document_number,
      orderId: row.order_id,
      orderNumber: row.order_number,
      customerId: row.customer_id,
      customerCode: row.customer_code,
      customerName: row.customer_name,
      branchCode: row.branch_code,
      postingDate: row.posting_date,
      remarks: row.remarks,
      currency: row.currency,
      total: row.total,
      costTotal: row.cost_total,
      status: row.status,
      isCancellation: row.is_cancellation,
      cancellationOfId: row.cancellation_of_id,
      cancelledById: row.cancelled_by_id,
      cancellationReason: row.cancellation_reason,
      journalId: row.journal_id,
      journalNumber: row.journal_number,
      postedAt: row.posted_at.toISOString(),
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
        invoicedQuantity: line.invoiced_quantity,
        netPrice: line.net_price,
        lineTotal: line.line_total,
        costValue: line.cost_value,
      })),
    };
  }
}
