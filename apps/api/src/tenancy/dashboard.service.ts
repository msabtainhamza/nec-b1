import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Dashboard, DashboardCount, DashboardPeriod } from '@nec/contracts';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, type Trx } from '../database/database.service.js';
import { formatMoney, parseMoney } from '../finance/money.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { InventoryReportsService } from '../inventory/inventory-reports.service.js';

const MONTHS = 6;

@Injectable()
export class DashboardService {
  constructor(
    private readonly database: DatabaseService,
    private readonly inventory: InventoryReportsService,
    private readonly approvals: ApprovalsService,
  ) {}

  private count(row: { count: string; amount: string } | undefined): DashboardCount {
    return { count: Number(row?.count ?? 0), amount: formatMoney(parseMoney(row?.amount ?? '0')) };
  }

  private async overdue(trx: Trx, table: 'ar_invoices' | 'ap_invoices', tenantId: string, today: string): Promise<DashboardCount> {
    const result = await sql<{ count: string; amount: string }>`
      select count(*)::text as count, coalesce(sum(total - paid_amount), 0)::text as amount from ${sql.table(table)}
      where tenant_id = ${tenantId} and status = 'posted' and not is_cancellation and total > paid_amount and due_date < ${today}`.execute(trx);
    return this.count(result.rows[0]);
  }

  async dashboard(principal: TenantPrincipal): Promise<Dashboard> {
    const can = (permission: Parameters<typeof principal.permissions.has>[0]) => principal.permissions.has(permission) && principal.modules.has(permission.split('.')[0] as string);
    const lowStock = can('inv.stock.view') ? (await this.inventory.status(principal, { belowReorderPoint: true })).items.length : null;
    const pendingApprovals = principal.permissions.has('admin.approval.view') ? (await this.approvals.list(principal, { scope: 'to_decide' })).length : null;
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const tenantId = principal.tenantId;
      const tenant = await sql<{ currency: string; today: string }>`select base_currency as currency, (current_timestamp at time zone time_zone)::date::text as today from tenants where id = ${tenantId}`.execute(trx);
      const { currency, today } = tenant.rows[0] as { currency: string; today: string };
      const openSalesOrders = can('sal.order.view')
        ? this.count(
            (
              await sql<{ count: string; amount: string }>`
                select count(distinct o.id)::text as count,
                  coalesce(sum(round((l.quantity - case when l.stocked then l.delivered_quantity else l.invoiced_quantity end) * l.net_price, 4)), 0)::text as amount
                from sales_orders o join sales_order_lines l on l.tenant_id = o.tenant_id and l.order_id = o.id
                where o.tenant_id = ${tenantId} and o.status = 'open'`.execute(trx)
            ).rows[0],
          )
        : null;
      const openPurchaseOrders = can('pur.order.view')
        ? this.count(
            (
              await sql<{ count: string; amount: string }>`
                select count(distinct o.id)::text as count, coalesce(sum(round((l.quantity - l.received_quantity) * l.net_price, 4)), 0)::text as amount
                from purchase_orders o join purchase_order_lines l on l.tenant_id = o.tenant_id and l.order_id = o.id
                where o.tenant_id = ${tenantId} and o.status = 'open'`.execute(trx)
            ).rows[0],
          )
        : null;
      const overdueReceivables = can('sal.invoice.view') ? await this.overdue(trx, 'ar_invoices', tenantId, today) : null;
      const overduePayables = can('pur.invoice.view') ? await this.overdue(trx, 'ap_invoices', tenantId, today) : null;
      const totals = async (table: 'ar_invoices' | 'ap_invoices') => {
        const result = await sql<{ month: string; amount: string }>`
          select to_char(date_trunc('month', posting_date), 'YYYY-MM') as month, sum(subtotal)::text as amount from ${sql.table(table)}
          where tenant_id = ${tenantId} and status = 'posted' and not is_cancellation
            and posting_date >= (date_trunc('month', ${today}::date) - interval '${sql.raw(String(MONTHS - 1))} months')
            and posting_date <= ${today}
          group by 1`.execute(trx);
        return new Map(result.rows.map((row) => [row.month, formatMoney(parseMoney(row.amount))]));
      };
      const sales = can('sal.invoice.view') ? await totals('ar_invoices') : null;
      const purchases = can('pur.invoice.view') ? await totals('ap_invoices') : null;
      const periods: DashboardPeriod[] = [];
      const [year, month] = today.split('-').map(Number) as [number, number];
      for (let offset = MONTHS - 1; offset >= 0; offset -= 1) {
        const date = new Date(Date.UTC(year, month - 1 - offset, 1));
        const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
        periods.push({ month: key, sales: sales ? (sales.get(key) ?? '0.0000') : null, purchases: purchases ? (purchases.get(key) ?? '0.0000') : null });
      }
      return { currency, asOf: today, openSalesOrders, openPurchaseOrders, overdueReceivables, overduePayables, lowStockItems: lowStock, pendingApprovals, periods };
    });
  }
}
