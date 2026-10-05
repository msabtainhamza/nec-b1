import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { ItemStock, Page, StockMovement, StockMovementQuery } from '@nec/contracts';
import { AppError, notFound } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, type Trx } from '../database/database.service.js';
import { averageCost, formatCost, formatMoney, parseMoney, type Money } from '../finance/money.js';

export interface MovementInput {
  tenantId: string;
  userId: string | null;
  itemId: string;
  warehouseId: string;
  quantity: Money;
  value: Money;
  sourceType: string;
  sourceId: string;
  sourceLineId: string | null;
  postingDate: string;
  journalId: string | null;
}

export interface RecordedMovement {
  id: string;
  quantity: Money;
  value: Money;
}

@Injectable()
export class StockService {
  constructor(private readonly database: DatabaseService) {}

  async lockValuations(trx: Trx, tenantId: string, itemIds: string[]): Promise<void> {
    const unique = [...new Set(itemIds)].sort();
    if (unique.length === 0) return;
    await trx
      .insertInto('item_valuations')
      .values(unique.map((itemId) => ({ tenant_id: tenantId, item_id: itemId })))
      .onConflict((oc) => oc.columns(['tenant_id', 'item_id']).doNothing())
      .execute();
    await trx
      .selectFrom('item_valuations')
      .select('item_id')
      .where('tenant_id', '=', tenantId)
      .where('item_id', 'in', unique)
      .orderBy('item_id')
      .forUpdate()
      .execute();
  }

  async record(trx: Trx, input: MovementInput): Promise<RecordedMovement> {
    if (input.quantity === 0n && input.value === 0n) {
      throw new Error('A stock movement needs a non-zero quantity or value');
    }
    const valuation = await trx
      .selectFrom('item_valuations')
      .select(['on_hand', 'total_value'])
      .where('tenant_id', '=', input.tenantId)
      .where('item_id', '=', input.itemId)
      .forUpdate()
      .executeTakeFirst();
    if (!valuation) {
      throw new Error('Item valuation must be locked before recording a movement');
    }
    const onHand = parseMoney(valuation.on_hand) + input.quantity;
    const totalValue = parseMoney(valuation.total_value) + input.value;
    if (onHand < 0n || totalValue < 0n || (onHand === 0n && totalValue !== 0n)) {
      throw new AppError(422, 'STOCK_VALUATION_REJECTED', 'The movement would leave negative stock or an invalid stock value');
    }
    const absoluteQuantity = input.quantity < 0n ? -input.quantity : input.quantity;
    const absoluteValue = input.value < 0n ? -input.value : input.value;
    const movement = await trx
      .insertInto('stock_movements')
      .values({
        tenant_id: input.tenantId,
        item_id: input.itemId,
        warehouse_id: input.warehouseId,
        quantity: formatMoney(input.quantity),
        value: formatMoney(input.value),
        unit_cost: formatCost(averageCost(absoluteValue, absoluteQuantity)),
        source_type: input.sourceType,
        source_id: input.sourceId,
        source_line_id: input.sourceLineId,
        posting_date: input.postingDate,
        journal_id: input.journalId,
        created_by: input.userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('item_valuations')
      .set({
        on_hand: formatMoney(onHand),
        total_value: formatMoney(totalValue),
        average_cost: formatCost(averageCost(totalValue, onHand)),
        last_movement_id: movement.id,
        updated_at: new Date(),
      })
      .where('tenant_id', '=', input.tenantId)
      .where('item_id', '=', input.itemId)
      .execute();
    if (input.quantity === 0n) {
      return { id: movement.id, quantity: input.quantity, value: input.value };
    }
    if (input.quantity > 0n) {
      await trx
        .insertInto('item_warehouse_stock')
        .values({ tenant_id: input.tenantId, item_id: input.itemId, warehouse_id: input.warehouseId, on_hand: formatMoney(input.quantity) })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'item_id', 'warehouse_id']).doUpdateSet({
            on_hand: sql`item_warehouse_stock.on_hand + excluded.on_hand`,
            updated_at: new Date(),
          }),
        )
        .execute();
    } else {
      const current = await trx
        .selectFrom('item_warehouse_stock')
        .select('on_hand')
        .where('tenant_id', '=', input.tenantId)
        .where('item_id', '=', input.itemId)
        .where('warehouse_id', '=', input.warehouseId)
        .forUpdate()
        .executeTakeFirst();
      if (!current || parseMoney(current.on_hand) + input.quantity < 0n) {
        throw new AppError(422, 'INSUFFICIENT_STOCK', 'The warehouse does not have enough stock for this movement');
      }
      await trx
        .updateTable('item_warehouse_stock')
        .set({ on_hand: formatMoney(parseMoney(current.on_hand) + input.quantity), updated_at: new Date() })
        .where('tenant_id', '=', input.tenantId)
        .where('item_id', '=', input.itemId)
        .where('warehouse_id', '=', input.warehouseId)
        .execute();
    }
    return { id: movement.id, quantity: input.quantity, value: input.value };
  }

  async valuation(trx: Trx, tenantId: string, itemId: string): Promise<{ onHand: Money; totalValue: Money }> {
    const row = await trx
      .selectFrom('item_valuations')
      .select(['on_hand', 'total_value'])
      .where('tenant_id', '=', tenantId)
      .where('item_id', '=', itemId)
      .executeTakeFirst();
    return { onHand: parseMoney(row?.on_hand ?? '0'), totalValue: parseMoney(row?.total_value ?? '0') };
  }

  async assertDocumentIsLatest(trx: Trx, tenantId: string, movements: { id: string; item_id: string }[], itemCode: (itemId: string) => string): Promise<void> {
    const itemIds = [...new Set(movements.map((movement) => movement.item_id))];
    if (itemIds.length === 0) return;
    const ownIds = new Set(movements.map((movement) => movement.id));
    const valuations = await trx
      .selectFrom('item_valuations')
      .select(['item_id', 'last_movement_id'])
      .where('tenant_id', '=', tenantId)
      .where('item_id', 'in', itemIds)
      .forUpdate()
      .execute();
    for (const itemId of itemIds) {
      const last = valuations.find((row) => row.item_id === itemId)?.last_movement_id;
      if (!last || !ownIds.has(last)) {
        throw new AppError(
          409,
          'VALUATION_BLOCKED',
          `Item ${itemCode(itemId)} has later stock transactions, so this document cannot be reversed automatically without recosting. Use an approved correction instead.`,
        );
      }
    }
  }

  issueValue(state: { onHand: Money; totalValue: Money }, quantity: Money): Money {
    if (quantity >= state.onHand) return state.totalValue;
    return (2n * state.totalValue * quantity + state.onHand) / (2n * state.onHand);
  }

  async itemInUse(trx: Trx, tenantId: string, itemId: string): Promise<boolean> {
    const row = await sql<{ used: boolean }>`select
        exists (select 1 from stock_movements where tenant_id = ${tenantId} and item_id = ${itemId})
        or exists (select 1 from purchase_order_lines where tenant_id = ${tenantId} and item_id = ${itemId})
        or exists (select 1 from sales_quotation_lines where tenant_id = ${tenantId} and item_id = ${itemId})
        or exists (select 1 from sales_order_lines where tenant_id = ${tenantId} and item_id = ${itemId}) as used`.execute(trx);
    return Boolean(row.rows[0]?.used);
  }

  async itemStock(principal: TenantPrincipal, itemId: string): Promise<ItemStock> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const item = await trx.selectFrom('items').select('id').where('tenant_id', '=', principal.tenantId).where('id', '=', itemId).executeTakeFirst();
      if (!item) throw notFound();
      const valuation = await trx
        .selectFrom('item_valuations')
        .select(['on_hand', 'total_value', 'average_cost'])
        .where('tenant_id', '=', principal.tenantId)
        .where('item_id', '=', itemId)
        .executeTakeFirst();
      const warehouses = await trx
        .selectFrom('warehouses as w')
        .leftJoin('item_warehouse_stock as s', (join) =>
          join.onRef('s.warehouse_id', '=', 'w.id').onRef('s.tenant_id', '=', 'w.tenant_id').on('s.item_id', '=', itemId),
        )
        .select(['w.id', 'w.code', 'w.name', 's.on_hand'])
        .select(
          sql<string>`coalesce((select sum(l.quantity - l.received_quantity) from purchase_order_lines l
            join purchase_orders o on o.id = l.order_id and o.tenant_id = l.tenant_id
            where l.tenant_id = w.tenant_id and l.item_id = ${itemId} and l.warehouse_id = w.id and o.status = 'open'), 0)::text`.as('on_order'),
        )
        .where('w.tenant_id', '=', principal.tenantId)
        .orderBy('w.code')
        .execute();
      const onHand = parseMoney(valuation?.on_hand ?? '0');
      const onOrder = warehouses.reduce((sum, row) => sum + parseMoney(row.on_order), 0n);
      const committedRow = await sql<{ committed: string }>`select coalesce(sum(l.quantity - l.delivered_quantity), 0)::text as committed
        from sales_order_lines l join sales_orders o on o.id = l.order_id and o.tenant_id = l.tenant_id
        where l.tenant_id = ${principal.tenantId} and l.item_id = ${itemId} and l.stocked and o.status = 'open'`.execute(trx);
      const committed = parseMoney(committedRow.rows[0]?.committed ?? '0');
      return {
        itemId,
        onHand: formatMoney(onHand),
        onOrder: formatMoney(onOrder),
        committed: formatMoney(committed),
        available: formatMoney(onHand + onOrder - committed),
        averageCost: valuation?.average_cost ?? '0.000000',
        totalValue: valuation?.total_value ?? '0.0000',
        warehouses: warehouses
          .filter((row) => row.on_hand !== null || parseMoney(row.on_order) !== 0n)
          .map((row) => ({
            warehouseId: row.id,
            warehouseCode: row.code,
            warehouseName: row.name,
            onHand: row.on_hand ?? '0.0000',
            onOrder: formatMoney(parseMoney(row.on_order)),
          })),
      };
    });
  }

  async movements(principal: TenantPrincipal, query: StockMovementQuery): Promise<Page<StockMovement>> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      let base = trx
        .selectFrom('stock_movements as m')
        .innerJoin('items as i', (join) => join.onRef('i.id', '=', 'm.item_id').onRef('i.tenant_id', '=', 'm.tenant_id'))
        .innerJoin('warehouses as w', (join) => join.onRef('w.id', '=', 'm.warehouse_id').onRef('w.tenant_id', '=', 'm.tenant_id'))
        .leftJoin('goods_receipts as gr', (join) => join.onRef('gr.id', '=', 'm.source_id').onRef('gr.tenant_id', '=', 'm.tenant_id'))
        .leftJoin('ap_invoices as ap', (join) => join.onRef('ap.id', '=', 'm.source_id').onRef('ap.tenant_id', '=', 'm.tenant_id'))
        .leftJoin('stock_transfers as st', (join) => join.onRef('st.id', '=', 'm.source_id').onRef('st.tenant_id', '=', 'm.tenant_id'))
        .leftJoin('inventory_adjustments as ia', (join) => join.onRef('ia.id', '=', 'm.source_id').onRef('ia.tenant_id', '=', 'm.tenant_id'))
        .leftJoin('deliveries as dn', (join) => join.onRef('dn.id', '=', 'm.source_id').onRef('dn.tenant_id', '=', 'm.tenant_id'))
        .where('m.tenant_id', '=', principal.tenantId);
      if (query.itemId) base = base.where('m.item_id', '=', query.itemId);
      if (query.warehouseId) base = base.where('m.warehouse_id', '=', query.warehouseId);
      if (query.from) base = base.where('m.posting_date', '>=', query.from);
      if (query.to) base = base.where('m.posting_date', '<=', query.to);
      const total = await base.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
      const rows = await base
        .select(['m.id', 'm.posting_date', 'm.created_at', 'i.code as item_code', 'i.name as item_name', 'w.code as warehouse_code', 'm.source_type', 'm.quantity', 'm.value', 'm.unit_cost'])
        .select(sql<string | null>`coalesce(gr.document_number, ap.document_number, st.document_number, ia.document_number, dn.document_number)`.as('document_number'))
        .orderBy('m.created_at', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute();
      return {
        items: rows.map((row) => ({
          id: row.id,
          postingDate: row.posting_date,
          createdAt: row.created_at.toISOString(),
          itemCode: row.item_code,
          itemName: row.item_name,
          warehouseCode: row.warehouse_code,
          sourceType: row.source_type,
          sourceNumber: row.document_number,
          quantity: row.quantity,
          value: row.value,
          unitCost: row.unit_cost,
        })),
        limit: query.limit,
        offset: query.offset,
        total: Number(total.count),
      };
    });
  }
}
