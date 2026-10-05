import { Injectable } from '@nestjs/common';
import { CreditService } from './credit.service.js';
import { sql } from 'kysely';
import type {
  ChangeSalesOrderStatusRequest,
  CreateSalesOrderRequest,
  OrderAddress,
  OrderStockWarning,
  Page,
  SalesOrder,
  SalesOrderListQuery,
  SalesOrderSummary,
  SalesPriceQuery,
  SalesPrices,
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
export class SalesOrdersService {
  constructor(
    private readonly credit: CreditService,
    private readonly database: DatabaseService,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
  ) {}

  private run<T>(principal: TenantPrincipal, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId, serializeCredit: true }, fn);
  }

  private read<T>(principal: TenantPrincipal, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, fn);
  }

  async create(principal: TenantPrincipal, input: CreateSalesOrderRequest, correlationId: string): Promise<{ replayed: boolean; order: SalesOrder }> {
    return this.run(principal, (trx) => this.createWithin(trx, principal, input, correlationId));
  }

  async createWithin(trx: Trx, principal: TenantPrincipal, input: CreateSalesOrderRequest, correlationId: string, quotationId: string | null = null): Promise<{ replayed: boolean; order: SalesOrder }> {
    const { idempotencyKey, ...payload } = input;
    const tenantId = principal.tenantId;
    const existing = await claimIdempotencyKey(trx, tenantId, idempotencyKey, 'sales_order.create', payload);
    if (existing) return { replayed: true, order: await this.loadOrThrow(trx, tenantId, existing) };
    const { customer, tenant, branch, lines, priceList } = await this.prepare(trx, tenantId, payload);
    const header = await this.resolveHeader(trx, tenantId, customer.id, payload);
    const numbering = await this.posting.nextNumber(trx, tenantId, 'sales_order', payload.seriesId);
    const order = await trx
      .insertInto('sales_orders')
      .values({
        tenant_id: tenantId,
        quotation_id: quotationId,
        series_id: numbering.seriesId,
        number: numbering.number,
        document_number: numbering.documentNumber,
        customer_id: customer.id,
        branch_id: branch.id,
        posting_date: payload.postingDate,
        delivery_date: payload.deliveryDate,
        customer_reference: payload.customerReference ?? null,
        remarks: payload.remarks ?? null,
        currency: tenant.base_currency,
        total: formatMoney(sumMoney(lines.map((line) => line.lineTotal))),
        price_list_id: priceList?.id ?? null,
        payment_terms_id: header.paymentTermsId,
        bill_to: header.billTo ? JSON.stringify(header.billTo) : null,
        ship_to: header.shipTo ? JSON.stringify(header.shipTo) : null,
        created_by: principal.userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const sourceLines = quotationId ? await trx.selectFrom('sales_quotation_lines').select(['id', 'line_no']).where('tenant_id', '=', tenantId).where('quotation_id', '=', quotationId).execute() : [];
    await trx
      .insertInto('sales_order_lines')
      .values(
        lines.map((line, index) => ({
          tenant_id: tenantId,
          order_id: order.id,
          quotation_line_id: sourceLines.find((source) => source.line_no === index + 1)?.id ?? null,
          line_no: index + 1,
          item_id: line.item.id,
          description: line.description,
          uom_id: line.item.uom_id,
          stocked: line.stocked,
          warehouse_id: line.warehouseId,
          quantity: formatMoney(line.quantity),
          unit_price: formatMoney(line.unitPrice),
          discount_percent: formatMoney(line.discount),
          net_price: formatMoney(line.netPrice),
          line_total: formatMoney(line.lineTotal),
        })),
      )
      .execute();
    await this.credit.check(trx, principal, customer.id, input, 'sales_order', order.id, correlationId);
    await completeIdempotencyKey(trx, tenantId, idempotencyKey, order.id);
    const created = await this.loadOrThrow(trx, tenantId, order.id);
    await this.audit.record(trx, {
      tenantId,
      actor: { type: 'user', id: principal.userId },
      action: 'sales_order.created',
      entityType: 'sales_order',
      entityId: order.id,
      after: { documentNumber: created.documentNumber, customerId: customer.id, total: created.total, lines: created.lines.length },
      correlationId,
    });
    return { replayed: false, order: created };
  }

  private async priceList(trx: Trx, tenantId: string, postingDate: string, priceListId: string | undefined) {
    let query = trx
      .selectFrom('price_lists')
      .select(['id', 'code', 'name'])
      .where('tenant_id', '=', tenantId)
      .where('purpose', '=', 'sales')
      .where('status', '=', 'active')
      .where((eb) => eb.or([eb('valid_from', 'is', null), eb('valid_from', '<=', postingDate)]))
      .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>=', postingDate)]));
    query = priceListId ? query.where('id', '=', priceListId) : query.where('is_default', '=', true);
    const list = await query.executeTakeFirst();
    if (priceListId && !list) {
      throw new AppError(400, 'VALIDATION_FAILED', `Choose an active sales price list valid on ${postingDate}`, [{ path: 'priceListId', message: 'Not an active sales price list on the posting date' }]);
    }
    return list ?? null;
  }

  private async listPrices(trx: Trx, tenantId: string, priceListId: string | null, itemIds: string[]): Promise<Map<string, string>> {
    if (!priceListId || itemIds.length === 0) return new Map();
    const rows = await trx
      .selectFrom('item_prices')
      .select(['item_id', 'price'])
      .where('tenant_id', '=', tenantId)
      .where('price_list_id', '=', priceListId)
      .where('item_id', 'in', [...new Set(itemIds)])
      .execute();
    return new Map(rows.map((row) => [row.item_id, row.price]));
  }

  async prices(principal: TenantPrincipal, query: SalesPriceQuery): Promise<SalesPrices> {
    return this.read(principal, async (trx) => {
      const list = await this.priceList(trx, principal.tenantId, query.postingDate, query.priceListId);
      const prices = await this.listPrices(trx, principal.tenantId, list?.id ?? null, query.itemIds);
      return { priceList: list, prices: [...prices.entries()].map(([itemId, price]) => ({ itemId, price })) };
    });
  }

  private async resolveHeader(trx: Trx, tenantId: string, customerId: string, payload: Omit<CreateSalesOrderRequest, 'idempotencyKey'>) {
    const customer = await trx.selectFrom('business_partners').select('payment_terms_id').where('tenant_id', '=', tenantId).where('id', '=', customerId).executeTakeFirstOrThrow();
    const paymentTermsId = payload.paymentTermsId ?? customer.payment_terms_id;
    if (payload.paymentTermsId) {
      const terms = await trx.selectFrom('payment_terms').select('id').where('tenant_id', '=', tenantId).where('id', '=', payload.paymentTermsId).executeTakeFirst();
      if (!terms) throw new AppError(400, 'VALIDATION_FAILED', 'Choose valid payment terms', [{ path: 'paymentTermsId', message: 'Unknown payment terms' }]);
    }
    const address = async (type: 'bill_to' | 'ship_to', addressId: string | undefined, path: string): Promise<OrderAddress | null> => {
      let query = trx
        .selectFrom('bp_addresses')
        .select(['address_name', 'street', 'city', 'state', 'zip_code', 'country'])
        .where('tenant_id', '=', tenantId)
        .where('partner_id', '=', customerId)
        .where('address_type', '=', type);
      query = addressId ? query.where('id', '=', addressId) : query.orderBy('is_default', 'desc').orderBy('line_no');
      const row = await query.executeTakeFirst();
      if (addressId && !row) throw new AppError(400, 'VALIDATION_FAILED', `Choose one of the customer's ${type === 'bill_to' ? 'bill-to' : 'ship-to'} addresses`, [{ path, message: 'Not an address of this customer' }]);
      return row ? { addressName: row.address_name, street: row.street, city: row.city, state: row.state, zipCode: row.zip_code, country: row.country } : null;
    };
    return {
      paymentTermsId,
      billTo: await address('bill_to', payload.billToAddressId, 'billToAddressId'),
      shipTo: await address('ship_to', payload.shipToAddressId, 'shipToAddressId'),
    };
  }

  private async stockWarnings(trx: Trx, tenantId: string, orderId: string): Promise<OrderStockWarning[]> {
    const result = await sql<{ line_no: number; item_code: string; warehouse_code: string; open_quantity: string; order_total: string; available: string }>`
      with mine as (
        select l.line_no, l.item_id, l.warehouse_id, l.quantity - l.delivered_quantity as open_quantity
        from sales_order_lines l
        where l.tenant_id = ${tenantId} and l.order_id = ${orderId} and l.stocked and l.quantity > l.delivered_quantity
      )
      select m.line_no, i.code as item_code, w.code as warehouse_code, m.open_quantity::text as open_quantity,
        (sum(m.open_quantity) over (partition by m.item_id, m.warehouse_id))::text as order_total,
        (coalesce(s.on_hand, 0) - coalesce((
          select sum(ol.quantity - ol.delivered_quantity) from sales_order_lines ol
          join sales_orders o on o.tenant_id = ol.tenant_id and o.id = ol.order_id
          where ol.tenant_id = ${tenantId} and o.status = 'open' and ol.stocked and ol.order_id <> ${orderId}
            and ol.item_id = m.item_id and ol.warehouse_id = m.warehouse_id and ol.quantity > ol.delivered_quantity
        ), 0))::text as available
      from mine m
      join items i on i.tenant_id = ${tenantId} and i.id = m.item_id
      join warehouses w on w.tenant_id = ${tenantId} and w.id = m.warehouse_id
      left join item_warehouse_stock s on s.tenant_id = ${tenantId} and s.item_id = m.item_id and s.warehouse_id = m.warehouse_id
      order by m.line_no`.execute(trx);
    return result.rows
      .filter((row) => parseMoney(row.order_total) > parseMoney(row.available))
      .map((row) => ({ lineNo: row.line_no, itemCode: row.item_code, warehouseCode: row.warehouse_code, openQuantity: formatMoney(parseMoney(row.open_quantity)), available: formatMoney(parseMoney(row.available)) }));
  }

  async prepare(trx: Trx, tenantId: string, payload: Omit<CreateSalesOrderRequest, 'idempotencyKey'>) {
    if (payload.deliveryDate < payload.postingDate) {
      throw new AppError(400, 'VALIDATION_FAILED', 'The delivery date cannot be before the posting date', [{ path: 'deliveryDate', message: 'Before posting date' }]);
    }
    const customer = await trx
      .selectFrom('business_partners')
      .select(['id', 'partner_type', 'status'])
      .where('tenant_id', '=', tenantId)
      .where('id', '=', payload.customerId)
      .executeTakeFirst();
    if (!customer || customer.partner_type !== 'customer' || customer.status !== 'active') {
      throw new AppError(400, 'VALIDATION_FAILED', 'Choose an active customer', [{ path: 'customerId', message: 'Choose an active customer' }]);
    }
    const tenant = await trx.selectFrom('tenants').select(['default_branch_id', 'base_currency']).where('id', '=', tenantId).executeTakeFirstOrThrow();
    const branchId = payload.branchId ?? tenant.default_branch_id;
    const branch = branchId
      ? await trx.selectFrom('branches').select(['id', 'status', 'default_warehouse_id']).where('tenant_id', '=', tenantId).where('id', '=', branchId).executeTakeFirst()
      : undefined;
    if (!branch || branch.status !== 'active') {
      throw new AppError(400, 'VALIDATION_FAILED', 'Choose an active branch', [{ path: 'branchId', message: 'Choose an active branch' }]);
    }
    const items = await trx
      .selectFrom('items as i')
      .innerJoin('units_of_measure as u', (join) => join.onRef('u.id', '=', 'i.uom_id').onRef('u.tenant_id', '=', 'i.tenant_id'))
      .select(['i.id', 'i.code', 'i.name', 'i.item_type', 'i.is_sales_item', 'i.status', 'i.uom_id', 'i.default_warehouse_id', 'u.decimals'])
      .where('i.tenant_id', '=', tenantId)
      .where('i.id', 'in', [...new Set(payload.lines.map((line) => line.itemId))])
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
    const needsPrice = payload.lines.some((line) => line.unitPrice === undefined);
    const priceList = await this.priceList(trx, tenantId, payload.postingDate, payload.priceListId);
    const listPrices = needsPrice ? await this.listPrices(trx, tenantId, priceList?.id ?? null, payload.lines.map((line) => line.itemId)) : new Map<string, string>();
    const lines = payload.lines.map((line, index) => {
      const item = items.find((candidate) => candidate.id === line.itemId);
      if (!item || item.status !== 'active') throw lineError(index, 'itemId', `Line ${index + 1}: choose an active item`);
      if (!item.is_sales_item) throw lineError(index, 'itemId', `Line ${index + 1}: ${item.code} is not a sales item`);
      if (decimalPlaces(line.quantity) > item.decimals) throw lineError(index, 'quantity', `Line ${index + 1}: ${item.code} allows ${item.decimals} decimal places`);
      const quantity = parseMoney(line.quantity);
      if (quantity <= 0n) throw lineError(index, 'quantity', `Line ${index + 1}: quantity must be greater than zero`);
      const stocked = item.item_type === 'inventory';
      let warehouseId: string | null = null;
      if (stocked) {
        warehouseId = line.warehouseId ?? item.default_warehouse_id ?? branch.default_warehouse_id ?? null;
        const warehouse = warehouses.find((candidate) => candidate.id === warehouseId);
        if (!warehouse || warehouse.status !== 'active') throw lineError(index, 'warehouseId', `Line ${index + 1}: choose an active warehouse for ${item.code}`);
      } else if (line.warehouseId) {
        throw lineError(index, 'warehouseId', `Line ${index + 1}: ${item.code} is not stocked and has no warehouse`);
      }
      const listPrice = listPrices.get(item.id);
      if (line.unitPrice === undefined && listPrice === undefined) {
        throw lineError(
          index,
          'unitPrice',
          priceList ? `Line ${index + 1}: ${item.code} has no price in price list ${priceList.code}; enter a price` : `Line ${index + 1}: enter a price for ${item.code}; no sales price list applies on ${payload.postingDate}`,
        );
      }
      const unitPrice = parseMoney(line.unitPrice ?? (listPrice as string));
      const discount = parseMoney(line.discountPercent);
      const netPrice = applyDiscount(unitPrice, discount);
      return { item, stocked, description: line.description ?? item.name, warehouseId, quantity, unitPrice, discount, netPrice, lineTotal: multiplyMoney(quantity, netPrice) };
    });
    return { customer, tenant, branch, lines, priceList };
  }

  async changeStatus(principal: TenantPrincipal, orderId: string, input: ChangeSalesOrderStatusRequest, correlationId: string): Promise<SalesOrder> {
    return this.run(principal, async (trx) => {
      const order = await trx
        .selectFrom('sales_orders')
        .select(['id', 'status', 'version', 'document_number'])
        .where('tenant_id', '=', principal.tenantId)
        .where('id', '=', orderId)
        .forUpdate()
        .executeTakeFirst();
      if (!order) throw notFound();
      if (order.version !== input.version) throw versionConflict();
      if (order.status !== 'open') throw conflict(`Sales order ${order.document_number} is already ${order.status}`);
      if (input.status === 'cancelled') {
        const used = await trx
          .selectFrom('sales_order_lines')
          .select('id')
          .where('tenant_id', '=', principal.tenantId)
          .where('order_id', '=', orderId)
          .where((eb) => eb.or([eb('delivered_quantity', '>', '0'), eb('invoiced_quantity', '>', '0')]))
          .executeTakeFirst();
        if (used) throw conflict('A sales order with delivered or invoiced quantities cannot be cancelled; close it instead');
      }
      await trx
        .updateTable('sales_orders')
        .set({ status: input.status, closed_reason: input.status === 'closed' ? 'manual' : null, version: order.version + 1, updated_at: new Date() })
        .where('tenant_id', '=', principal.tenantId)
        .where('id', '=', orderId)
        .execute();
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: input.status === 'closed' ? 'sales_order.closed' : 'sales_order.cancelled',
        entityType: 'sales_order',
        entityId: orderId,
        before: { status: order.status },
        after: { status: input.status },
        correlationId,
      });
      return this.loadOrThrow(trx, principal.tenantId, orderId);
    });
  }

  async refreshStatus(trx: Trx, tenantId: string, orderIds: string[]): Promise<void> {
    for (const orderId of [...new Set(orderIds)]) {
      const order = await trx
        .selectFrom('sales_orders')
        .select(['id', 'status', 'closed_reason', 'version'])
        .where('tenant_id', '=', tenantId)
        .where('id', '=', orderId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const open = await trx
        .selectFrom('sales_order_lines')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('order_id', '=', orderId)
        .where((eb) =>
          eb.or([
            eb.and([eb('stocked', '=', true), eb('delivered_quantity', '<', eb.ref('quantity'))]),
            eb.and([eb('stocked', '=', false), eb('invoiced_quantity', '<', eb.ref('quantity'))]),
          ]),
        )
        .executeTakeFirst();
      if (!open && order.status === 'open') {
        await trx
          .updateTable('sales_orders')
          .set({ status: 'closed', closed_reason: 'fulfilled', version: order.version + 1, updated_at: new Date() })
          .where('tenant_id', '=', tenantId)
          .where('id', '=', orderId)
          .execute();
      } else if (open && order.status === 'closed' && order.closed_reason === 'fulfilled') {
        await trx
          .updateTable('sales_orders')
          .set({ status: 'open', closed_reason: null, version: order.version + 1, updated_at: new Date() })
          .where('tenant_id', '=', tenantId)
          .where('id', '=', orderId)
          .execute();
      }
    }
  }

  async list(principal: TenantPrincipal, query: SalesOrderListQuery): Promise<Page<SalesOrderSummary>> {
    return this.read(principal, async (trx) => {
      let base = trx
        .selectFrom('sales_orders as o')
        .innerJoin('business_partners as c', (join) => join.onRef('c.id', '=', 'o.customer_id').onRef('c.tenant_id', '=', 'o.tenant_id'))
        .where('o.tenant_id', '=', principal.tenantId);
      if (query.search) {
        const pattern = `%${query.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
        base = base.where((eb) => eb.or([eb('o.document_number', 'ilike', pattern), eb('c.name', 'ilike', pattern), eb('c.code', 'ilike', pattern)]));
      }
      if (query.status) base = base.where('o.status', '=', query.status);
      if (query.customerId) base = base.where('o.customer_id', '=', query.customerId);
      const total = await base.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
      const rows = await base
        .select(['o.id', 'o.document_number', 'c.code', 'c.name', 'o.posting_date', 'o.delivery_date', 'o.total', 'o.status'])
        .orderBy('o.posting_date', 'desc')
        .orderBy('o.number', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute();
      return {
        items: rows.map((row) => ({
          id: row.id,
          documentNumber: row.document_number,
          customerCode: row.code,
          customerName: row.name,
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

  async get(principal: TenantPrincipal, orderId: string): Promise<SalesOrder> {
    return this.read(principal, (trx) => this.loadOrThrow(trx, principal.tenantId, orderId));
  }

  async loadOrThrow(trx: Trx, tenantId: string, orderId: string): Promise<SalesOrder> {
    const order = await trx
      .selectFrom('sales_orders as o')
      .innerJoin('business_partners as c', (join) => join.onRef('c.id', '=', 'o.customer_id').onRef('c.tenant_id', '=', 'o.tenant_id'))
      .innerJoin('branches as b', (join) => join.onRef('b.id', '=', 'o.branch_id').onRef('b.tenant_id', '=', 'o.tenant_id'))
      .leftJoin('sales_quotations as q', (join) => join.onRef('q.id', '=', 'o.quotation_id').onRef('q.tenant_id', '=', 'o.tenant_id'))
      .leftJoin('price_lists as pl', (join) => join.onRef('pl.id', '=', 'o.price_list_id').onRef('pl.tenant_id', '=', 'o.tenant_id'))
      .leftJoin('payment_terms as pt', (join) => join.onRef('pt.id', '=', 'o.payment_terms_id').onRef('pt.tenant_id', '=', 'o.tenant_id'))
      .selectAll('o')
      .select(['q.document_number as quotation_number', 'pl.code as price_list_code', 'pt.code as payment_terms_code'])
      .select(['c.code as customer_code', 'c.name as customer_name', 'b.code as branch_code'])
      .where('o.tenant_id', '=', tenantId)
      .where('o.id', '=', orderId)
      .executeTakeFirst();
    if (!order) throw notFound();
    const lines = await trx
      .selectFrom('sales_order_lines as l')
      .innerJoin('items as i', (join) => join.onRef('i.id', '=', 'l.item_id').onRef('i.tenant_id', '=', 'l.tenant_id'))
      .innerJoin('units_of_measure as u', (join) => join.onRef('u.id', '=', 'l.uom_id').onRef('u.tenant_id', '=', 'l.tenant_id'))
      .leftJoin('warehouses as w', (join) => join.onRef('w.id', '=', 'l.warehouse_id').onRef('w.tenant_id', '=', 'l.tenant_id'))
      .selectAll('l')
      .select(['i.code as item_code', 'i.item_type', 'u.code as uom_code', 'w.code as warehouse_code'])
      .where('l.tenant_id', '=', tenantId)
      .where('l.order_id', '=', orderId)
      .orderBy('l.line_no')
      .execute();
    const deliveries = await trx
      .selectFrom('deliveries')
      .select(['id', 'document_number', 'posting_date', 'status', 'is_cancellation'])
      .where('tenant_id', '=', tenantId)
      .where('order_id', '=', orderId)
      .orderBy('posted_at')
      .execute();
    return {
      id: order.id,
      quotationId: order.quotation_id,
      quotationNumber: order.quotation_number,
      documentNumber: order.document_number,
      customerId: order.customer_id,
      customerCode: order.customer_code,
      customerName: order.customer_name,
      branchId: order.branch_id,
      branchCode: order.branch_code,
      postingDate: order.posting_date,
      deliveryDate: order.delivery_date,
      customerReference: order.customer_reference,
      remarks: order.remarks,
      currency: order.currency,
      total: order.total,
      status: order.status,
      closedReason: order.closed_reason,
      version: order.version,
      createdAt: order.created_at.toISOString(),
      priceListId: order.price_list_id,
      priceListCode: order.price_list_code,
      paymentTermsId: order.payment_terms_id,
      paymentTermsCode: order.payment_terms_code,
      billTo: order.bill_to as OrderAddress | null,
      shipTo: order.ship_to as OrderAddress | null,
      stockWarnings: order.status === 'open' ? await this.stockWarnings(trx, tenantId, orderId) : [],
      lines: lines.map((line) => ({
        id: line.id,
        quotationLineId: line.quotation_line_id,
        lineNo: line.line_no,
        itemId: line.item_id,
        itemCode: line.item_code,
        itemType: line.item_type,
        stocked: line.stocked,
        description: line.description,
        uomCode: line.uom_code,
        warehouseId: line.warehouse_id,
        warehouseCode: line.warehouse_code,
        quantity: line.quantity,
        deliveredQuantity: line.delivered_quantity,
        invoicedQuantity: line.invoiced_quantity,
        openQuantity: formatMoney(parseMoney(line.quantity) - parseMoney(line.stocked ? line.delivered_quantity : line.invoiced_quantity)),
        unitPrice: line.unit_price,
        discountPercent: line.discount_percent,
        netPrice: line.net_price,
        lineTotal: line.line_total,
      })),
      deliveries: deliveries.map((delivery) => ({
        id: delivery.id,
        documentNumber: delivery.document_number,
        postingDate: delivery.posting_date,
        status: delivery.status,
        isCancellation: delivery.is_cancellation,
      })),
    };
  }
}
