import { sql } from 'kysely';
import type { CreditExposure } from '@nec/contracts';
import { notFound } from '../common/errors.js';
import type { Trx } from '../database/database.service.js';
import { formatMoney, parseMoney } from '../finance/money.js';

export async function customerCreditExposure(trx: Trx, tenantId: string, customerId: string): Promise<CreditExposure> {
  const result = await sql<{ credit_limit: string; balance: string; orders: string; deliveries: string }>`select p.credit_limit::text,
    (select coalesce(sum(j.debit - j.credit), 0)::text from journal_lines j
     where j.tenant_id = p.tenant_id and j.partner_id = p.id) as balance,
    (select coalesce(sum(round((l.quantity - case when l.stocked then l.delivered_quantity else l.invoiced_quantity end) * l.net_price, 4)), 0)::text
     from sales_order_lines l join sales_orders o on o.tenant_id = l.tenant_id and o.id = l.order_id
     where o.tenant_id = p.tenant_id and o.customer_id = p.id and o.status = 'open') as orders,
    (select coalesce(sum(round((l.quantity - l.invoiced_quantity) * l.net_price, 4)), 0)::text
     from delivery_lines l join deliveries d on d.tenant_id = l.tenant_id and d.id = l.delivery_id
     where d.tenant_id = p.tenant_id and d.customer_id = p.id and d.status = 'posted' and not d.is_cancellation) as deliveries
    from business_partners p where p.tenant_id = ${tenantId} and p.id = ${customerId} and p.partner_type = 'customer'`.execute(trx);
  const row = result.rows[0];
  if (!row) throw notFound('The customer was not found');
  const total = parseMoney(row.balance) + parseMoney(row.orders) + parseMoney(row.deliveries);
  return { balance: formatMoney(parseMoney(row.balance)), openOrders: formatMoney(parseMoney(row.orders)), uninvoicedDeliveries: formatMoney(parseMoney(row.deliveries)), total: formatMoney(total), creditLimit: row.credit_limit, remaining: formatMoney(parseMoney(row.credit_limit) - total) };
}
