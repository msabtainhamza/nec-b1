import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  ApInvoice,
  ApInvoiceListQuery,
  ApInvoiceSummary,
  CancelApInvoiceRequest,
  CreateApInvoiceRequest,
  InvoiceableReceiptLine,
  Page,
  PurchasingSettings,
  UpdatePurchasingSettingsRequest,
} from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { AppError, conflict, forbidden, isUniqueViolation, notFound, versionConflict } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, lockTenantResource, type Trx } from '../database/database.service.js';
import { claimIdempotencyKey, completeIdempotencyKey } from '../finance/idempotency.js';
import { decimalPlaces, formatMoney, multiplyMoney, parseMoney, sumMoney, type Money } from '../finance/money.js';
import { PostingService, type PostingLine } from '../finance/posting.service.js';
import { StockService } from '../inventory/stock.service.js';

const lineError = (index: number, field: string, message: string, status = 400, code = 'VALIDATION_FAILED') =>
  new AppError(status, code, message, [{ path: `lines.${index}.${field}`, message }]);

@Injectable()
export class ApInvoicesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly posting: PostingService,
    private readonly stock: StockService,
    private readonly audit: AuditService,
  ) {}

  private run<T>(principal: TenantPrincipal, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, fn);
  }

  async settings(principal: TenantPrincipal): Promise<PurchasingSettings> {
    return this.run(principal, async (trx) => {
      const row = await this.loadSettings(trx, principal.tenantId);
      return { priceTolerancePercent: row.price_tolerance_percent, version: row.version };
    });
  }

  async updateSettings(principal: TenantPrincipal, input: UpdatePurchasingSettingsRequest, correlationId: string): Promise<PurchasingSettings> {
    return this.run(principal, async (trx) => {
      const current = await this.loadSettings(trx, principal.tenantId);
      if (current.version !== input.version) throw versionConflict();
      const next = formatMoney(parseMoney(input.priceTolerancePercent));
      await trx
        .updateTable('purchasing_settings')
        .set({ price_tolerance_percent: next, version: current.version + 1, updated_at: new Date() })
        .where('tenant_id', '=', principal.tenantId)
        .execute();
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'purchasing_settings.changed',
        entityType: 'purchasing_settings',
        entityId: null,
        before: { priceTolerancePercent: current.price_tolerance_percent },
        after: { priceTolerancePercent: next },
        correlationId,
      });
      return { priceTolerancePercent: next, version: current.version + 1 };
    });
  }

  private async loadSettings(trx: Trx, tenantId: string) {
    await trx.insertInto('purchasing_settings').values({ tenant_id: tenantId }).onConflict((oc) => oc.column('tenant_id').doNothing()).execute();
    return trx.selectFrom('purchasing_settings').selectAll().where('tenant_id', '=', tenantId).executeTakeFirstOrThrow();
  }

  async invoiceable(principal: TenantPrincipal, vendorId: string): Promise<InvoiceableReceiptLine[]> {
    return this.run(principal, async (trx) => {
      const rows = await trx
        .selectFrom('goods_receipt_lines as l')
        .innerJoin('goods_receipts as r', (join) => join.onRef('r.id', '=', 'l.receipt_id').onRef('r.tenant_id', '=', 'l.tenant_id'))
        .innerJoin('purchase_orders as o', (join) => join.onRef('o.id', '=', 'r.order_id').onRef('o.tenant_id', '=', 'r.tenant_id'))
        .innerJoin('purchase_order_lines as ol', (join) => join.onRef('ol.id', '=', 'l.order_line_id').onRef('ol.tenant_id', '=', 'l.tenant_id'))
        .innerJoin('items as i', (join) => join.onRef('i.id', '=', 'l.item_id').onRef('i.tenant_id', '=', 'l.tenant_id'))
        .innerJoin('units_of_measure as u', (join) => join.onRef('u.id', '=', 'ol.uom_id').onRef('u.tenant_id', '=', 'ol.tenant_id'))
        .select([
          'r.id as receipt_id',
          'r.document_number as receipt_number',
          'r.posting_date as receipt_date',
          'o.document_number as order_number',
          'l.id',
          'l.item_id',
          'i.code as item_code',
          'ol.description',
          'u.code as uom_code',
          'i.item_type',
          'l.quantity',
          'l.invoiced_quantity',
          'l.net_price',
        ])
        .where('l.tenant_id', '=', principal.tenantId)
        .where('r.vendor_id', '=', vendorId)
        .where('r.status', '=', 'posted')
        .where('r.is_cancellation', '=', false)
        .whereRef('l.invoiced_quantity', '<', 'l.quantity')
        .orderBy('r.posting_date')
        .orderBy('r.document_number')
        .orderBy('l.line_no')
        .execute();
      return rows.map((row) => ({
        receiptId: row.receipt_id,
        receiptNumber: row.receipt_number,
        receiptDate: row.receipt_date,
        orderNumber: row.order_number,
        receiptLineId: row.id,
        itemId: row.item_id,
        itemCode: row.item_code,
        description: row.description,
        uomCode: row.uom_code,
        stocked: row.item_type === 'inventory',
        receivedQuantity: row.quantity,
        invoicedQuantity: row.invoiced_quantity,
        openQuantity: formatMoney(parseMoney(row.quantity) - parseMoney(row.invoiced_quantity)),
        receiptPrice: row.net_price,
      }));
    });
  }

  async create(principal: TenantPrincipal, input: CreateApInvoiceRequest, correlationId: string): Promise<{ replayed: boolean; invoice: ApInvoice }> {
    const { idempotencyKey, ...payload } = input;
    if (payload.priceOverride && !principal.permissions.has('pur.invoice.override')) {
      throw forbidden('You do not have permission to override price differences');
    }
    try {
      return await this.run(principal, async (trx) => {
        const tenantId = principal.tenantId;
        const existing = await claimIdempotencyKey(trx, tenantId, idempotencyKey, 'ap_invoice.create', payload);
        if (existing) return { replayed: true, invoice: await this.loadOrThrow(trx, tenantId, existing) };

        const vendor = await trx
          .selectFrom('business_partners as v')
          .leftJoin('payment_terms as t', (join) => join.onRef('t.id', '=', 'v.payment_terms_id').onRef('t.tenant_id', '=', 'v.tenant_id'))
          .select(['v.id', 'v.partner_type', 'v.status', 't.due_days'])
          .where('v.tenant_id', '=', tenantId)
          .where('v.id', '=', payload.vendorId)
          .executeTakeFirst();
        if (!vendor || vendor.partner_type !== 'supplier' || vendor.status !== 'active') {
          throw new AppError(400, 'VALIDATION_FAILED', 'Choose an active vendor', [{ path: 'vendorId', message: 'Choose an active vendor' }]);
        }
        await this.posting.openPeriodFor(trx, tenantId, payload.postingDate);
        const documentDate = payload.documentDate ?? payload.postingDate;
        const dueDate =
          payload.dueDate ??
          ((await sql<{ due: string }>`select (${documentDate}::date + ${vendor.due_days ?? 0}::integer)::text as due`.execute(trx)).rows[0]?.due as string);
        if (dueDate < documentDate) {
          throw new AppError(400, 'VALIDATION_FAILED', 'The due date cannot be before the document date', [{ path: 'dueDate', message: 'Before document date' }]);
        }
        payload.lines.forEach((line, index) => {
          const allowed = payload.documentType === 'service' ? line.kind === 'account' : line.kind !== 'account';
          if (!allowed) {
            throw lineError(index, 'kind', `Line ${index + 1}: ${payload.documentType === 'service' ? 'service invoices use G/L account lines' : 'item invoices use item or goods receipt lines'}`);
          }
        });
        const receiptLineIds = payload.lines.flatMap((line) => (line.kind === 'receipt' ? [line.receiptLineId] : []));
        if (new Set(receiptLineIds).size !== receiptLineIds.length) {
          throw new AppError(400, 'VALIDATION_FAILED', 'Each receipt line can appear only once on an invoice');
        }
        const receiptLines = receiptLineIds.length
          ? await trx
              .selectFrom('goods_receipt_lines as l')
              .innerJoin('goods_receipts as r', (join) => join.onRef('r.id', '=', 'l.receipt_id').onRef('r.tenant_id', '=', 'l.tenant_id'))
              .innerJoin('purchase_order_lines as ol', (join) => join.onRef('ol.id', '=', 'l.order_line_id').onRef('ol.tenant_id', '=', 'l.tenant_id'))
              .innerJoin('items as i', (join) => join.onRef('i.id', '=', 'l.item_id').onRef('i.tenant_id', '=', 'l.tenant_id'))
              .innerJoin('units_of_measure as u', (join) => join.onRef('u.id', '=', 'ol.uom_id').onRef('u.tenant_id', '=', 'ol.tenant_id'))
              .select([
                'l.id',
                'l.receipt_id',
                'l.order_line_id',
                'l.item_id',
                'l.warehouse_id',
                'l.quantity',
                'l.invoiced_quantity',
                'l.net_price',
                'r.vendor_id',
                'r.status',
                'r.is_cancellation',
                'r.posting_date as receipt_date',
                'r.branch_id',
                'r.document_number as receipt_number',
                'ol.description',
                'i.code',
                'i.item_type',
                'i.group_id',
                'u.decimals',
              ])
              .where('l.tenant_id', '=', tenantId)
              .where('l.id', 'in', receiptLineIds)
              .forUpdate('l')
              .execute()
          : [];
        const directItemIds = payload.lines.flatMap((line) => (line.kind === 'item' ? [line.itemId] : []));
        const tenant = await trx.selectFrom('tenants').select(['base_currency', 'default_branch_id']).where('id', '=', tenantId).executeTakeFirstOrThrow();
        const defaultBranch = tenant.default_branch_id
          ? await trx.selectFrom('branches').select(['id', 'default_warehouse_id']).where('tenant_id', '=', tenantId).where('id', '=', tenant.default_branch_id).executeTakeFirst()
          : undefined;
        const directItems = directItemIds.length
          ? await trx
              .selectFrom('items as i')
              .innerJoin('units_of_measure as u', (join) => join.onRef('u.id', '=', 'i.uom_id').onRef('u.tenant_id', '=', 'i.tenant_id'))
              .select(['i.id', 'i.code', 'i.name', 'i.item_type', 'i.status', 'i.is_purchase_item', 'i.default_warehouse_id', 'i.group_id', 'u.decimals'])
              .where('i.tenant_id', '=', tenantId)
              .where('i.id', 'in', directItemIds)
              .execute()
          : [];
        const accountIds = payload.lines.flatMap((line) => (line.kind === 'account' ? [line.accountId] : []));
        const glAccounts = accountIds.length
          ? await trx
              .selectFrom('accounts')
              .select(['id', 'code', 'is_title', 'status', 'control_kind'])
              .where('tenant_id', '=', tenantId)
              .where('id', 'in', accountIds)
              .execute()
          : [];
        const taxCodeIds = [...new Set(payload.lines.map((line) => line.taxCodeId).filter((id): id is string => Boolean(id)))];
        const taxRates = await this.taxRates(trx, tenantId, taxCodeIds, payload.postingDate);
        const warehouseIds = [
          ...new Set(
            [
              ...receiptLines.map((line) => line.warehouse_id),
              ...payload.lines.flatMap((line) => (line.kind === 'item' ? [line.warehouseId] : [])),
              ...directItems.map((item) => item.default_warehouse_id),
              defaultBranch?.default_warehouse_id,
            ].filter((id): id is string => Boolean(id)),
          ),
        ];
        const warehouses = warehouseIds.length
          ? await trx.selectFrom('warehouses').select(['id', 'status', 'inventory_account_id']).where('tenant_id', '=', tenantId).where('id', 'in', warehouseIds).execute()
          : [];
        const groupIds = [...new Set([...receiptLines.map((line) => line.group_id), ...directItems.map((item) => item.group_id)])];
        const itemGroups = groupIds.length
          ? await trx.selectFrom('item_groups').select(['id', 'inventory_account_id']).where('tenant_id', '=', tenantId).where('id', 'in', groupIds).execute()
          : [];
        const settings = await this.loadSettings(trx, tenantId);
        const tolerance = parseMoney(settings.price_tolerance_percent);
        const determination = await this.determination(trx, tenantId);
        const required = (key: string, label: string) => {
          const account = determination.get(key);
          if (!account) throw new AppError(422, 'MAPPING_MISSING', `G/L account determination is missing the ${label} account`);
          return account;
        };
        const inventoryAccount = (warehouseId: string | null, groupId: string) =>
          warehouses.find((warehouse) => warehouse.id === warehouseId)?.inventory_account_id ??
          itemGroups.find((group) => group.id === groupId)?.inventory_account_id ??
          required('inventory', 'Inventory');

        const variances: string[] = [];
        const plan = payload.lines.map((line, index) => {
          const tax = line.taxCodeId ? taxRates.get(line.taxCodeId) : undefined;
          if (line.taxCodeId && !tax) throw lineError(index, 'taxCodeId', `Line ${index + 1}: choose an active purchase tax code with a rate on ${payload.postingDate}`);
          const taxRate = tax?.rate ?? 0n;
          if (line.kind === 'receipt') {
            const receiptLine = receiptLines.find((candidate) => candidate.id === line.receiptLineId);
            if (!receiptLine) throw lineError(index, 'receiptLineId', `Line ${index + 1}: the goods receipt line was not found`, 404, 'NOT_FOUND');
            if (receiptLine.vendor_id !== vendor.id) throw lineError(index, 'receiptLineId', `Line ${index + 1}: receipt ${receiptLine.receipt_number} belongs to another vendor`);
            if (receiptLine.status !== 'posted' || receiptLine.is_cancellation) {
              throw lineError(index, 'receiptLineId', `Line ${index + 1}: receipt ${receiptLine.receipt_number} is cancelled`, 409, 'CONFLICT');
            }
            if (receiptLine.receipt_date > payload.postingDate) {
              throw lineError(index, 'receiptLineId', `Line ${index + 1}: the invoice cannot be dated before receipt ${receiptLine.receipt_number}`);
            }
            if (decimalPlaces(line.quantity) > receiptLine.decimals) {
              throw lineError(index, 'quantity', `Line ${index + 1}: ${receiptLine.code} allows ${receiptLine.decimals} decimal places`);
            }
            const quantity = parseMoney(line.quantity);
            const open = parseMoney(receiptLine.quantity) - parseMoney(receiptLine.invoiced_quantity);
            if (quantity <= 0n) throw lineError(index, 'quantity', `Line ${index + 1}: quantity must be greater than zero`);
            if (quantity > open) {
              throw lineError(index, 'quantity', `Line ${index + 1}: only ${formatMoney(open)} of ${receiptLine.code} is still to be invoiced`, 422, 'OVER_INVOICE');
            }
            const receiptPrice = parseMoney(receiptLine.net_price);
            const unitPrice = parseMoney(line.unitPrice);
            if (unitPrice !== receiptPrice) {
              const difference = unitPrice > receiptPrice ? unitPrice - receiptPrice : receiptPrice - unitPrice;
              if (receiptPrice === 0n || difference * 1_000_000n > tolerance * receiptPrice) {
                variances.push(`line ${index + 1} (${receiptLine.code}: receipt ${formatMoney(receiptPrice)}, invoice ${formatMoney(unitPrice)})`);
              }
            }
            const lineTotal = multiplyMoney(quantity, unitPrice);
            const stocked = receiptLine.item_type === 'inventory';
            return {
              kind: 'receipt' as const,
              receiptLine,
              itemId: receiptLine.item_id,
              description: receiptLine.description,
              warehouseId: receiptLine.warehouse_id,
              accountId: null,
              stocked,
              debitAccount: stocked ? required('goods_received_not_invoiced', 'Goods Received Not Invoiced') : required('purchase_expense', 'Purchased Services and Supplies'),
              inventoryAccountId: stocked ? inventoryAccount(receiptLine.warehouse_id, receiptLine.group_id) : null,
              quantity,
              receiptPrice,
              unitPrice,
              lineTotal,
              baseValue: stocked ? multiplyMoney(quantity, receiptPrice) : lineTotal,
              taxCodeId: line.taxCodeId ?? null,
              taxRate,
              taxAmount: percentOf(lineTotal, taxRate),
            };
          }
          if (line.kind === 'item') {
            const item = directItems.find((candidate) => candidate.id === line.itemId);
            if (!item || item.status !== 'active') throw lineError(index, 'itemId', `Line ${index + 1}: choose an active item`);
            if (!item.is_purchase_item) throw lineError(index, 'itemId', `Line ${index + 1}: ${item.code} is not a purchase item`);
            if (decimalPlaces(line.quantity) > item.decimals) throw lineError(index, 'quantity', `Line ${index + 1}: ${item.code} allows ${item.decimals} decimal places`);
            const quantity = parseMoney(line.quantity);
            if (quantity <= 0n) throw lineError(index, 'quantity', `Line ${index + 1}: quantity must be greater than zero`);
            const stocked = item.item_type === 'inventory';
            let warehouseId: string | null = null;
            if (stocked) {
              warehouseId = line.warehouseId ?? item.default_warehouse_id ?? defaultBranch?.default_warehouse_id ?? null;
              const warehouse = warehouses.find((candidate) => candidate.id === warehouseId);
              if (!warehouse || warehouse.status !== 'active') throw lineError(index, 'warehouseId', `Line ${index + 1}: choose an active warehouse for ${item.code}`);
            } else if (line.warehouseId) {
              throw lineError(index, 'warehouseId', `Line ${index + 1}: ${item.code} is not stocked and has no warehouse`);
            }
            const unitPrice = parseMoney(line.unitPrice);
            const lineTotal = multiplyMoney(quantity, unitPrice);
            return {
              kind: 'item' as const,
              receiptLine: null,
              itemId: item.id,
              description: line.description ?? item.name,
              warehouseId,
              accountId: null,
              stocked,
              debitAccount: stocked ? inventoryAccount(warehouseId, item.group_id) : required('purchase_expense', 'Purchased Services and Supplies'),
              inventoryAccountId: null,
              quantity,
              receiptPrice: null,
              unitPrice,
              lineTotal,
              baseValue: lineTotal,
              taxCodeId: line.taxCodeId ?? null,
              taxRate,
              taxAmount: percentOf(lineTotal, taxRate),
            };
          }
          const account = glAccounts.find((candidate) => candidate.id === line.accountId);
          if (!account) throw lineError(index, 'accountId', `Line ${index + 1}: the G/L account was not found`);
          if (account.is_title || account.status !== 'active' || account.control_kind) {
            throw lineError(index, 'accountId', `Line ${index + 1}: ${account.code} must be an active, postable, non-control account`);
          }
          const amount = parseMoney(line.amount);
          return {
            kind: 'account' as const,
            receiptLine: null,
            itemId: null,
            description: line.description,
            warehouseId: null,
            accountId: account.id,
            stocked: false,
            debitAccount: account.id,
            inventoryAccountId: null,
            quantity: parseMoney('1'),
            receiptPrice: null,
            unitPrice: amount,
            lineTotal: amount,
            baseValue: amount,
            taxCodeId: line.taxCodeId ?? null,
            taxRate,
            taxAmount: percentOf(amount, taxRate),
          };
        });
        if (variances.length > 0 && !payload.priceOverride) {
          throw new AppError(
            422,
            'PRICE_VARIANCE',
            `Invoice prices differ from the goods receipt beyond the ${formatMoney(tolerance)}% tolerance: ${variances.join('; ')}. An authorized user can post with a price override.`,
          );
        }

        const stockedItemIds = plan.filter((line) => line.stocked && line.itemId).map((line) => line.itemId as string);
        await this.stock.lockValuations(trx, tenantId, stockedItemIds);
        const running = new Map<string, { onHand: Money; totalValue: Money }>();
        for (const itemId of new Set(stockedItemIds)) running.set(itemId, await this.stock.valuation(trx, tenantId, itemId));
        const allocations = plan.map((line) => {
          if (!line.stocked || !line.itemId) return { revaluation: 0n, priceDifference: 0n };
          const state = running.get(line.itemId) as { onHand: Money; totalValue: Money };
          if (line.kind === 'item') {
            state.onHand += line.quantity;
            state.totalValue += line.lineTotal;
            return { revaluation: 0n, priceDifference: 0n };
          }
          const difference = line.lineTotal - line.baseValue;
          if (difference === 0n) return { revaluation: 0n, priceDifference: 0n };
          const covered = state.onHand < line.quantity ? state.onHand : line.quantity;
          let revaluation = covered > 0n ? divideRounded(difference * covered, line.quantity) : 0n;
          if (state.totalValue + revaluation < 0n || (state.onHand === 0n && revaluation !== 0n)) revaluation = 0n;
          state.totalValue += revaluation;
          return { revaluation, priceDifference: difference - revaluation };
        });

        const debits = new Map<string, Money>();
        const credits = new Map<string, Money>();
        const add = (map: Map<string, Money>, account: string, amount: Money) => {
          if (amount !== 0n) map.set(account, (map.get(account) ?? 0n) + amount);
        };
        plan.forEach((line, index) => {
          const allocation = allocations[index] as { revaluation: Money; priceDifference: Money };
          add(debits, line.debitAccount, line.baseValue);
          if (allocation.revaluation > 0n) add(debits, line.inventoryAccountId as string, allocation.revaluation);
          if (allocation.revaluation < 0n) add(credits, line.inventoryAccountId as string, -allocation.revaluation);
          if (allocation.priceDifference > 0n) add(debits, required('price_difference', 'Price Difference'), allocation.priceDifference);
          if (allocation.priceDifference < 0n) add(credits, required('price_difference', 'Price Difference'), -allocation.priceDifference);
          if (line.kind === 'receipt' && !line.stocked && line.lineTotal !== line.baseValue) add(debits, line.debitAccount, line.lineTotal - line.baseValue);
        });
        const taxTotal = sumMoney(plan.map((line) => line.taxAmount));
        if (taxTotal > 0n) add(debits, required('input_tax', 'Input Tax'), taxTotal);
        const subtotal = sumMoney(plan.map((line) => line.lineTotal));
        const total = subtotal + taxTotal;

        const invoiceId = randomUUID();
        const journalLines: PostingLine[] = [
          ...[...debits.entries()].filter(([, amount]) => amount > 0n).map(([accountId, amount]) => ({ accountId, debit: amount, credit: 0n })),
          ...[...credits.entries()].filter(([, amount]) => amount > 0n).map(([accountId, amount]) => ({ accountId, debit: 0n, credit: amount })),
        ];
        if (total > 0n) journalLines.push({ partnerId: vendor.id, debit: 0n, credit: total });
        let journalId: string | null = null;
        if (journalLines.length >= 2) {
          const journal = await this.posting.post(trx, {
            tenantId,
            userId: principal.userId,
            sourceType: 'ap_invoice',
            sourceId: invoiceId,
            postingDate: payload.postingDate,
            documentDate,
            dueDate,
            memo: `A/P invoice${payload.vendorReference ? ` ${payload.vendorReference}` : ''}`,
            reference: payload.vendorReference ?? null,
            lines: journalLines,
          });
          journalId = journal.id;
        }
        const branchId = plan.find((line) => line.receiptLine)?.receiptLine?.branch_id ?? tenant.default_branch_id;
        if (!branchId) throw new AppError(422, 'VALIDATION_FAILED', 'The company has no default branch');
        const series = await this.posting.nextNumber(trx, tenantId, 'ap_invoice', payload.seriesId);
        await trx
          .insertInto('ap_invoices')
          .values({
            id: invoiceId,
            tenant_id: tenantId,
            series_id: series.seriesId,
            number: series.number,
            document_number: series.documentNumber,
            document_type: payload.documentType,
            vendor_id: vendor.id,
            branch_id: branchId,
            posting_date: payload.postingDate,
            document_date: documentDate,
            due_date: dueDate,
            vendor_reference: payload.vendorReference ?? null,
            remarks: payload.remarks ?? null,
            currency: tenant.base_currency,
            subtotal: formatMoney(subtotal),
            tax_total: formatMoney(taxTotal),
            total: formatMoney(total),
            price_override: variances.length > 0,
            journal_id: journalId,
            created_by: principal.userId,
          })
          .execute();
        const inserted = await trx
          .insertInto('ap_invoice_lines')
          .values(
            plan.map((line, index) => ({
              tenant_id: tenantId,
              invoice_id: invoiceId,
              line_no: index + 1,
              line_kind: line.kind,
              receipt_id: line.receiptLine?.receipt_id ?? null,
              receipt_line_id: line.receiptLine?.id ?? null,
              order_line_id: line.receiptLine?.order_line_id ?? null,
              item_id: line.itemId,
              account_id: line.accountId,
              warehouse_id: line.warehouseId,
              description: line.description,
              stocked: line.stocked,
              quantity: formatMoney(line.quantity),
              receipt_price: line.receiptPrice === null ? null : formatMoney(line.receiptPrice),
              unit_price: formatMoney(line.unitPrice),
              line_total: formatMoney(line.lineTotal),
              tax_code_id: line.taxCodeId,
              tax_rate: formatMoney(line.taxRate),
              tax_amount: formatMoney(line.taxAmount),
              stock_revaluation: formatMoney(allocations[index]?.revaluation ?? 0n),
              price_difference: formatMoney(allocations[index]?.priceDifference ?? 0n),
            })),
          )
          .returning(['id', 'line_no'])
          .execute();
        for (const [index, line] of plan.entries()) {
          const allocation = allocations[index] as { revaluation: Money; priceDifference: Money };
          const lineId = inserted.find((row) => row.line_no === index + 1)?.id ?? null;
          if (line.stocked && line.itemId && line.warehouseId && (line.kind === 'item' || allocation.revaluation !== 0n)) {
            await this.stock.record(trx, {
              tenantId,
              userId: principal.userId,
              itemId: line.itemId,
              warehouseId: line.warehouseId,
              quantity: line.kind === 'item' ? line.quantity : 0n,
              value: line.kind === 'item' ? line.lineTotal : allocation.revaluation,
              sourceType: 'ap_invoice',
              sourceId: invoiceId,
              sourceLineId: lineId,
              postingDate: payload.postingDate,
              journalId,
            });
          }
          if (line.receiptLine) {
            await trx
              .updateTable('goods_receipt_lines')
              .set({ invoiced_quantity: formatMoney(parseMoney(line.receiptLine.invoiced_quantity) + line.quantity) })
              .where('tenant_id', '=', tenantId)
              .where('id', '=', line.receiptLine.id)
              .execute();
          }
        }
        await completeIdempotencyKey(trx, tenantId, idempotencyKey, invoiceId);
        const invoice = await this.loadOrThrow(trx, tenantId, invoiceId);
        await this.audit.record(trx, {
          tenantId,
          actor: { type: 'user', id: principal.userId },
          action: variances.length > 0 ? 'ap_invoice.posted_with_price_override' : 'ap_invoice.posted',
          entityType: 'ap_invoice',
          entityId: invoiceId,
          after: {
            documentNumber: invoice.documentNumber,
            documentType: payload.documentType,
            vendorReference: invoice.vendorReference,
            subtotal: invoice.subtotal,
            taxTotal: invoice.taxTotal,
            total: invoice.total,
            stockRevaluation: formatMoney(sumMoney(allocations.map((row) => row.revaluation))),
            priceDifference: formatMoney(sumMoney(allocations.map((row) => row.priceDifference))),
            variances,
            journal: invoice.journalNumber,
          },
          correlationId,
        });
        return { replayed: false, invoice };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'ap_invoices_vendor_reference_key')) {
        throw conflict('This vendor invoice number has already been posted for this vendor');
      }
      throw error;
    }
  }

  private async taxRates(trx: Trx, tenantId: string, taxCodeIds: string[], date: string): Promise<Map<string, { rate: Money }>> {
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
    return new Map(
      rows.filter((row) => row.status === 'active' && row.purpose !== 'sales' && row.rate !== null).map((row) => [row.id, { rate: parseMoney(row.rate as string) }]),
    );
  }

  async cancel(principal: TenantPrincipal, invoiceId: string, input: CancelApInvoiceRequest, correlationId: string): Promise<{ replayed: boolean; invoice: ApInvoice }> {
    const { idempotencyKey, ...payload } = input;
    try {
      return await this.run(principal, async (trx) => {
        const tenantId = principal.tenantId;
        const existing = await claimIdempotencyKey(trx, tenantId, idempotencyKey, `ap_invoice.cancel:${invoiceId}`, payload);
        if (existing) return { replayed: true, invoice: await this.loadOrThrow(trx, tenantId, existing) };
        await lockTenantResource(trx, tenantId, `ap-invoice-cancel:${invoiceId}`);
        const original = await this.loadOrThrow(trx, tenantId, invoiceId);
        if (original.isCancellation) throw conflict('A cancellation document cannot itself be cancelled');
        if (original.status === 'cancelled') throw conflict(`A/P invoice ${original.documentNumber} is already cancelled`);
        if (parseMoney(original.paidAmount) > 0n) throw conflict('Payments are applied to this invoice; unallocate them first');
        if (payload.postingDate < original.postingDate) {
          throw new AppError(422, 'POSTING_REJECTED', 'The cancellation date cannot be earlier than the invoice date', [{ path: 'postingDate', message: 'Before the invoice date' }]);
        }
        await this.posting.openPeriodFor(trx, tenantId, payload.postingDate);
        const movements = await trx
          .selectFrom('stock_movements')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('source_type', '=', 'ap_invoice')
          .where('source_id', '=', invoiceId)
          .execute();
        await this.stock.lockValuations(trx, tenantId, movements.map((movement) => movement.item_id));
        for (const movement of movements) {
          const line = original.lines.find((candidate) => candidate.id === movement.source_line_id);
          await this.stock.assertLatestMovement(trx, tenantId, movement.item_id, movement.id, line?.itemCode ?? movement.item_id);
        }
        const header = await trx
          .selectFrom('ap_invoices')
          .select(['series_id', 'vendor_id', 'branch_id', 'currency', 'subtotal', 'tax_total', 'total', 'vendor_reference', 'document_type'])
          .where('tenant_id', '=', tenantId)
          .where('id', '=', invoiceId)
          .executeTakeFirstOrThrow();
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
          const journal = await this.posting.post(trx, {
            tenantId,
            userId: principal.userId,
            sourceType: 'ap_invoice_cancellation',
            sourceId: cancellationId,
            postingDate: payload.postingDate,
            memo: `Cancellation of A/P invoice ${original.documentNumber}`,
            reference: original.documentNumber,
            lines: lines.map((line) => ({
              accountId: line.account_id,
              partnerId: line.partner_id,
              debit: parseMoney(line.credit),
              credit: parseMoney(line.debit),
              memo: line.memo,
            })),
          });
          journalId = journal.id;
        }
        const series = await this.posting.nextNumber(trx, tenantId, 'ap_invoice', header.series_id);
        await trx
          .insertInto('ap_invoices')
          .values({
            id: cancellationId,
            tenant_id: tenantId,
            series_id: series.seriesId,
            number: series.number,
            document_number: series.documentNumber,
            document_type: header.document_type,
            vendor_id: header.vendor_id,
            branch_id: header.branch_id,
            posting_date: payload.postingDate,
            document_date: payload.postingDate,
            due_date: payload.postingDate,
            vendor_reference: header.vendor_reference,
            remarks: `Cancellation of ${original.documentNumber}`,
            currency: header.currency,
            subtotal: header.subtotal,
            tax_total: header.tax_total,
            total: header.total,
            is_cancellation: true,
            cancellation_of_id: invoiceId,
            cancellation_reason: payload.reason,
            journal_id: journalId,
            created_by: principal.userId,
          })
          .execute();
        const originalLines = await trx.selectFrom('ap_invoice_lines').selectAll().where('tenant_id', '=', tenantId).where('invoice_id', '=', invoiceId).orderBy('line_no').execute();
        const copied = await trx
          .insertInto('ap_invoice_lines')
          .values(
            originalLines.map((line) => ({
              tenant_id: tenantId,
              invoice_id: cancellationId,
              line_no: line.line_no,
              line_kind: line.line_kind,
              receipt_id: line.receipt_id,
              receipt_line_id: line.receipt_line_id,
              order_line_id: line.order_line_id,
              item_id: line.item_id,
              account_id: line.account_id,
              warehouse_id: line.warehouse_id,
              description: line.description,
              stocked: line.stocked,
              quantity: line.quantity,
              receipt_price: line.receipt_price,
              unit_price: line.unit_price,
              line_total: line.line_total,
              tax_code_id: line.tax_code_id,
              tax_rate: line.tax_rate,
              tax_amount: line.tax_amount,
              stock_revaluation: line.stock_revaluation,
              price_difference: line.price_difference,
            })),
          )
          .returning(['id', 'line_no'])
          .execute();
        for (const movement of movements) {
          const originalLine = originalLines.find((line) => line.id === movement.source_line_id);
          await this.stock.record(trx, {
            tenantId,
            userId: principal.userId,
            itemId: movement.item_id,
            warehouseId: movement.warehouse_id,
            quantity: -parseMoney(movement.quantity),
            value: -parseMoney(movement.value),
            sourceType: 'ap_invoice_cancellation',
            sourceId: cancellationId,
            sourceLineId: copied.find((row) => row.line_no === originalLine?.line_no)?.id ?? null,
            postingDate: payload.postingDate,
            journalId,
          });
        }
        for (const line of originalLines) {
          if (!line.receipt_line_id) continue;
          const current = await trx
            .selectFrom('goods_receipt_lines')
            .select('invoiced_quantity')
            .where('tenant_id', '=', tenantId)
            .where('id', '=', line.receipt_line_id)
            .forUpdate()
            .executeTakeFirstOrThrow();
          await trx
            .updateTable('goods_receipt_lines')
            .set({ invoiced_quantity: formatMoney(parseMoney(current.invoiced_quantity) - parseMoney(line.quantity)) })
            .where('tenant_id', '=', tenantId)
            .where('id', '=', line.receipt_line_id)
            .execute();
        }
        await trx.updateTable('ap_invoices').set({ status: 'cancelled' }).where('tenant_id', '=', tenantId).where('id', '=', invoiceId).execute();
        await completeIdempotencyKey(trx, tenantId, idempotencyKey, cancellationId);
        const cancellation = await this.loadOrThrow(trx, tenantId, cancellationId);
        await this.audit.record(trx, {
          tenantId,
          actor: { type: 'user', id: principal.userId },
          action: 'ap_invoice.cancelled',
          entityType: 'ap_invoice',
          entityId: invoiceId,
          before: { documentNumber: original.documentNumber, status: 'posted' },
          after: { status: 'cancelled', cancellation: cancellation.documentNumber, reason: payload.reason, postingDate: payload.postingDate },
          correlationId,
        });
        return { replayed: false, invoice: cancellation };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'ap_invoices_single_cancellation_key')) {
        throw conflict('This A/P invoice has already been cancelled');
      }
      throw error;
    }
  }

  private async determination(trx: Trx, tenantId: string): Promise<Map<string, string>> {
    const rows = await trx
      .selectFrom('gl_determination')
      .select(['determination_key', 'account_id'])
      .where('tenant_id', '=', tenantId)
      .where('determination_key', 'in', ['goods_received_not_invoiced', 'price_difference', 'purchase_expense', 'inventory', 'input_tax'])
      .execute();
    return new Map(rows.map((row) => [row.determination_key, row.account_id]));
  }

  async list(principal: TenantPrincipal, query: ApInvoiceListQuery): Promise<Page<ApInvoiceSummary>> {
    return this.run(principal, async (trx) => {
      let base = trx
        .selectFrom('ap_invoices as a')
        .innerJoin('business_partners as v', (join) => join.onRef('v.id', '=', 'a.vendor_id').onRef('v.tenant_id', '=', 'a.tenant_id'))
        .where('a.tenant_id', '=', principal.tenantId);
      if (query.search) {
        const pattern = `%${query.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
        base = base.where((eb) => eb.or([eb('a.document_number', 'ilike', pattern), eb('a.vendor_reference', 'ilike', pattern), eb('v.name', 'ilike', pattern)]));
      }
      if (query.vendorId) base = base.where('a.vendor_id', '=', query.vendorId);
      const total = await base.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
      const rows = await base
        .select(['a.id', 'a.document_number', 'v.name', 'a.vendor_reference', 'a.posting_date', 'a.due_date', 'a.total', 'a.paid_amount', 'a.status', 'a.is_cancellation'])
        .orderBy('a.posted_at', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute();
      return {
        items: rows.map((row) => ({
          id: row.id,
          documentNumber: row.document_number,
          vendorName: row.name,
          vendorReference: row.vendor_reference,
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

  async get(principal: TenantPrincipal, invoiceId: string): Promise<ApInvoice> {
    return this.run(principal, (trx) => this.loadOrThrow(trx, principal.tenantId, invoiceId));
  }

  private async loadOrThrow(trx: Trx, tenantId: string, invoiceId: string): Promise<ApInvoice> {
    const invoice = await trx
      .selectFrom('ap_invoices as a')
      .innerJoin('business_partners as v', (join) => join.onRef('v.id', '=', 'a.vendor_id').onRef('v.tenant_id', '=', 'a.tenant_id'))
      .innerJoin('branches as b', (join) => join.onRef('b.id', '=', 'a.branch_id').onRef('b.tenant_id', '=', 'a.tenant_id'))
      .leftJoin('journal_entries as je', (join) => join.onRef('je.id', '=', 'a.journal_id').onRef('je.tenant_id', '=', 'a.tenant_id'))
      .leftJoin('ap_invoices as c', (join) => join.onRef('c.cancellation_of_id', '=', 'a.id').onRef('c.tenant_id', '=', 'a.tenant_id'))
      .selectAll('a')
      .select(['v.code as vendor_code', 'v.name as vendor_name', 'b.code as branch_code', 'je.document_number as journal_number', 'c.id as cancelled_by_id'])
      .where('a.tenant_id', '=', tenantId)
      .where('a.id', '=', invoiceId)
      .executeTakeFirst();
    if (!invoice) throw notFound();
    const lines = await trx
      .selectFrom('ap_invoice_lines as l')
      .leftJoin('goods_receipts as r', (join) => join.onRef('r.id', '=', 'l.receipt_id').onRef('r.tenant_id', '=', 'l.tenant_id'))
      .leftJoin('items as i', (join) => join.onRef('i.id', '=', 'l.item_id').onRef('i.tenant_id', '=', 'l.tenant_id'))
      .leftJoin('units_of_measure as u', (join) => join.onRef('u.id', '=', 'i.uom_id').onRef('u.tenant_id', '=', 'i.tenant_id'))
      .leftJoin('accounts as acc', (join) => join.onRef('acc.id', '=', 'l.account_id').onRef('acc.tenant_id', '=', 'l.tenant_id'))
      .leftJoin('warehouses as w', (join) => join.onRef('w.id', '=', 'l.warehouse_id').onRef('w.tenant_id', '=', 'l.tenant_id'))
      .leftJoin('tax_codes as t', (join) => join.onRef('t.id', '=', 'l.tax_code_id').onRef('t.tenant_id', '=', 'l.tenant_id'))
      .select([
        'l.id',
        'l.line_no',
        'l.line_kind',
        'l.receipt_id',
        'r.document_number as receipt_number',
        'l.receipt_line_id',
        'l.item_id',
        'i.code as item_code',
        'l.account_id',
        'acc.code as account_code',
        'l.description',
        'u.code as uom_code',
        'w.code as warehouse_code',
        'l.stocked',
        'l.quantity',
        'l.receipt_price',
        'l.unit_price',
        'l.line_total',
        't.code as tax_code',
        'l.tax_rate',
        'l.tax_amount',
        'l.stock_revaluation',
        'l.price_difference',
      ])
      .where('l.tenant_id', '=', tenantId)
      .where('l.invoice_id', '=', invoiceId)
      .orderBy('l.line_no')
      .execute();
    const open = invoice.status === 'posted' && !invoice.is_cancellation ? parseMoney(invoice.total) - parseMoney(invoice.paid_amount) : 0n;
    return {
      id: invoice.id,
      documentNumber: invoice.document_number,
      documentType: invoice.document_type,
      vendorId: invoice.vendor_id,
      vendorCode: invoice.vendor_code,
      vendorName: invoice.vendor_name,
      branchCode: invoice.branch_code,
      postingDate: invoice.posting_date,
      documentDate: invoice.document_date,
      dueDate: invoice.due_date,
      vendorReference: invoice.vendor_reference,
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
      priceOverride: invoice.price_override,
      journalId: invoice.journal_id,
      journalNumber: invoice.journal_number,
      postedAt: invoice.posted_at.toISOString(),
      lines: lines.map((line) => ({
        id: line.id,
        lineNo: line.line_no,
        lineKind: line.line_kind,
        receiptId: line.receipt_id,
        receiptNumber: line.receipt_number,
        receiptLineId: line.receipt_line_id,
        itemId: line.item_id,
        itemCode: line.item_code,
        accountId: line.account_id,
        accountCode: line.account_code,
        description: line.description,
        uomCode: line.uom_code,
        warehouseCode: line.warehouse_code,
        stocked: line.stocked,
        quantity: line.quantity,
        receiptPrice: line.receipt_price,
        unitPrice: line.unit_price,
        lineTotal: line.line_total,
        taxCode: line.tax_code,
        taxRate: line.tax_rate,
        taxAmount: line.tax_amount,
        stockRevaluation: line.stock_revaluation,
        priceDifference: line.price_difference,
      })),
    };
  }
}

function divideRounded(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const result = (2n * n + d) / (2n * d);
  return negative ? -result : result;
}

function percentOf(amount: bigint, ratePercent: bigint): bigint {
  return divideRounded(amount * ratePercent, 100n * 10000n);
}
