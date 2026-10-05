import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  InventoryStatusItem,
  InventoryStatusQuery,
  InventoryStatusReport,
  InventoryValuationAccount,
  InventoryValuationQuery,
  InventoryValuationReport,
} from '@nec/contracts';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService } from '../database/database.service.js';
import { averageCost, formatCost, formatMoney, parseMoney } from '../finance/money.js';

@Injectable()
export class InventoryReportsService {
  constructor(private readonly database: DatabaseService) {}

  async status(principal: TenantPrincipal, query: InventoryStatusQuery): Promise<InventoryStatusReport> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const tenantId = principal.tenantId;
      const tenant = await trx.selectFrom('tenants').select('display_name').where('id', '=', tenantId).executeTakeFirstOrThrow();
      const pattern = query.search ? `%${query.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : null;
      const items = await sql<{ id: string; code: string; name: string; group_code: string; uom_code: string; reorder_point: string | null }>`
        select i.id, i.code, i.name, g.code as group_code, u.code as uom_code, i.reorder_point::text as reorder_point
        from items i
        join item_groups g on g.tenant_id = i.tenant_id and g.id = i.group_id
        join units_of_measure u on u.tenant_id = i.tenant_id and u.id = i.uom_id
        where i.tenant_id = ${tenantId} and i.item_type = 'inventory'
          and (i.status = 'active' or exists (select 1 from item_warehouse_stock s where s.tenant_id = i.tenant_id and s.item_id = i.id and s.on_hand <> 0))
          and (${query.itemGroupId ?? null}::uuid is null or i.group_id = ${query.itemGroupId ?? null}::uuid)
          and (${pattern}::text is null or i.code ilike ${pattern} or i.name ilike ${pattern})
        order by i.code`.execute(trx);
      const figures = await sql<{ item_id: string; warehouse_id: string; warehouse_code: string; on_hand: string; committed: string; ordered: string }>`
        with stock as (
          select item_id, warehouse_id, on_hand as quantity, 0::numeric as committed, 0::numeric as ordered
          from item_warehouse_stock where tenant_id = ${tenantId}
          union all
          select l.item_id, l.warehouse_id, 0, l.quantity - l.delivered_quantity, 0
          from sales_order_lines l join sales_orders o on o.tenant_id = l.tenant_id and o.id = l.order_id
          where l.tenant_id = ${tenantId} and o.status = 'open' and l.stocked and l.quantity > l.delivered_quantity
          union all
          select l.item_id, l.warehouse_id, 0, 0, l.quantity - l.received_quantity
          from purchase_order_lines l join purchase_orders o on o.tenant_id = l.tenant_id and o.id = l.order_id
          where l.tenant_id = ${tenantId} and o.status = 'open' and l.warehouse_id is not null and l.quantity > l.received_quantity
        )
        select s.item_id, s.warehouse_id, w.code as warehouse_code, sum(s.quantity)::text as on_hand, sum(s.committed)::text as committed, sum(s.ordered)::text as ordered
        from stock s join warehouses w on w.tenant_id = ${tenantId} and w.id = s.warehouse_id
        where (${query.warehouseId ?? null}::uuid is null or s.warehouse_id = ${query.warehouseId ?? null}::uuid)
        group by s.item_id, s.warehouse_id, w.code
        having sum(s.quantity) <> 0 or sum(s.committed) <> 0 or sum(s.ordered) <> 0
        order by w.code`.execute(trx);
      const report: InventoryStatusItem[] = items.rows.map((item) => {
        const rows = figures.rows.filter((row) => row.item_id === item.id);
        const total = (pick: (row: (typeof rows)[number]) => string) => rows.reduce((sum, row) => sum + parseMoney(pick(row)), 0n);
        const onHand = total((row) => row.on_hand);
        const committed = total((row) => row.committed);
        const ordered = total((row) => row.ordered);
        const available = onHand - committed + ordered;
        return {
          itemId: item.id,
          itemCode: item.code,
          itemName: item.name,
          itemGroupCode: item.group_code,
          uomCode: item.uom_code,
          reorderPoint: item.reorder_point === null ? null : formatMoney(parseMoney(item.reorder_point)),
          onHand: formatMoney(onHand),
          committed: formatMoney(committed),
          ordered: formatMoney(ordered),
          available: formatMoney(available),
          belowReorderPoint: item.reorder_point !== null && available <= parseMoney(item.reorder_point),
          warehouses: rows.map((row) => ({
            warehouseId: row.warehouse_id,
            warehouseCode: row.warehouse_code,
            onHand: formatMoney(parseMoney(row.on_hand)),
            committed: formatMoney(parseMoney(row.committed)),
            ordered: formatMoney(parseMoney(row.ordered)),
            available: formatMoney(parseMoney(row.on_hand) - parseMoney(row.committed) + parseMoney(row.ordered)),
          })),
        };
      });
      return {
        tenantName: tenant.display_name,
        generatedAt: new Date().toISOString(),
        items: query.belowReorderPoint ? report.filter((item) => item.belowReorderPoint) : report,
      };
    });
  }

  async valuation(principal: TenantPrincipal, query: InventoryValuationQuery): Promise<InventoryValuationReport> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const tenantId = principal.tenantId;
      const tenant = await trx.selectFrom('tenants').select(['display_name', 'base_currency']).where('id', '=', tenantId).executeTakeFirstOrThrow();
      const rows = await sql<{ item_id: string; item_code: string; item_name: string; warehouse_code: string; account_id: string | null; quantity: string; value: string }>`
        select m.item_id, i.code as item_code, i.name as item_name, w.code as warehouse_code,
          coalesce(w.inventory_account_id, g.inventory_account_id, d.account_id) as account_id,
          sum(m.quantity)::text as quantity, sum(m.value)::text as value
        from stock_movements m
        join items i on i.tenant_id = m.tenant_id and i.id = m.item_id
        join item_groups g on g.tenant_id = i.tenant_id and g.id = i.group_id
        join warehouses w on w.tenant_id = m.tenant_id and w.id = m.warehouse_id
        left join gl_determination d on d.tenant_id = m.tenant_id and d.determination_key = 'inventory'
        where m.tenant_id = ${tenantId} and m.posting_date <= ${query.asOf}
          and (${query.warehouseId ?? null}::uuid is null or m.warehouse_id = ${query.warehouseId ?? null}::uuid)
          and (${query.itemGroupId ?? null}::uuid is null or i.group_id = ${query.itemGroupId ?? null}::uuid)
        group by m.item_id, i.code, i.name, w.code, coalesce(w.inventory_account_id, g.inventory_account_id, d.account_id)
        having sum(m.quantity) <> 0 or sum(m.value) <> 0
        order by i.code, w.code`.execute(trx);
      const accounts = await sql<{ id: string; code: string; name: string; balance: string }>`
        with inventory as (
          select inventory_account_id as account_id from warehouses where tenant_id = ${tenantId} and inventory_account_id is not null
          union select inventory_account_id from item_groups where tenant_id = ${tenantId} and inventory_account_id is not null
          union select account_id from gl_determination where tenant_id = ${tenantId} and determination_key = 'inventory'
        )
        select a.id, a.code, a.name,
          coalesce((select sum(l.debit - l.credit) from journal_lines l join journal_entries je on je.tenant_id = l.tenant_id and je.id = l.journal_id
            where l.tenant_id = ${tenantId} and l.account_id = a.id and je.posting_date <= ${query.asOf}), 0)::text as balance
        from accounts a join inventory x on x.account_id = a.id
        where a.tenant_id = ${tenantId}
        order by a.code`.execute(trx);
      const codes = new Map(accounts.rows.map((row) => [row.id, row.code]));
      const filtered = Boolean(query.warehouseId || query.itemGroupId);
      const reconciliation: InventoryValuationAccount[] = filtered
        ? []
        : accounts.rows.map((account) => {
            const stockValue = rows.rows.filter((row) => row.account_id === account.id).reduce((sum, row) => sum + parseMoney(row.value), 0n);
            const ledger = parseMoney(account.balance);
            return {
              accountId: account.id,
              accountCode: account.code,
              accountName: account.name,
              stockValue: formatMoney(stockValue),
              ledgerBalance: formatMoney(ledger),
              difference: formatMoney(ledger - stockValue),
            };
          });
      return {
        tenantName: tenant.display_name,
        currency: tenant.base_currency,
        asOf: query.asOf,
        generatedAt: new Date().toISOString(),
        filtered,
        rows: rows.rows.map((row) => ({
          itemId: row.item_id,
          itemCode: row.item_code,
          itemName: row.item_name,
          warehouseCode: row.warehouse_code,
          accountCode: row.account_id ? (codes.get(row.account_id) ?? '') : '',
          quantity: formatMoney(parseMoney(row.quantity)),
          value: formatMoney(parseMoney(row.value)),
          averageCost: formatCost(averageCost(parseMoney(row.value), parseMoney(row.quantity))),
        })),
        totalQuantity: formatMoney(rows.rows.reduce((sum, row) => sum + parseMoney(row.quantity), 0n)),
        totalValue: formatMoney(rows.rows.reduce((sum, row) => sum + parseMoney(row.value), 0n)),
        accounts: reconciliation,
      };
    });
  }
}
