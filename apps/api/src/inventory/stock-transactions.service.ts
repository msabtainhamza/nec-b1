import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  AdjustmentListQuery,
  AdjustmentPreview,
  CancelStockDocumentRequest,
  CreateInventoryAdjustmentRequest,
  CreateInventoryOpeningBalanceRequest,
  CreateStockTransferRequest,
  InventoryAdjustment,
  InventoryDocumentDirection,
  Page,
  StockDocumentListQuery,
  StockDocumentSummary,
  StockTransfer,
} from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { AppError, conflict, isUniqueViolation, notFound } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, lockTenantResource, type Trx } from '../database/database.service.js';
import { claimIdempotencyKey, completeIdempotencyKey } from '../finance/idempotency.js';
import { averageCost, decimalPlaces, formatCost, formatMoney, multiplyMoney, parseMoney, sumMoney, type Money } from '../finance/money.js';
import { PostingService, type PostingLine } from '../finance/posting.service.js';
import { StockService } from './stock.service.js';

const lineError = (index: number, field: string, message: string, status = 400, code = 'VALIDATION_FAILED') =>
  new AppError(status, code, message, [{ path: `lines.${index}.${field}`, message }]);

type InventoryDocumentInput = Omit<CreateInventoryAdjustmentRequest, 'direction'> & { direction: InventoryDocumentDirection };

const DOCUMENT_LABELS: Record<InventoryDocumentDirection, string> = { receipt: 'Goods receipt', issue: 'Goods issue', opening: 'Inventory opening balance' };
const SOURCE_TYPES: Record<InventoryDocumentDirection, 'inventory_adjustment' | 'inventory_opening_balance'> = {
  receipt: 'inventory_adjustment',
  issue: 'inventory_adjustment',
  opening: 'inventory_opening_balance',
};
const SERIES_TYPES: Record<InventoryDocumentDirection, string> = { receipt: 'stock_receipt', issue: 'stock_issue', opening: 'stock_opening' };

class PreviewRollback extends Error {
  constructor(readonly preview: AdjustmentPreview) {
    super('preview');
  }
}

interface ItemRow {
  id: string;
  code: string;
  item_type: string;
  status: string;
  group_id: string;
  decimals: number;
}

@Injectable()
export class StockTransactionsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly posting: PostingService,
    private readonly stock: StockService,
    private readonly audit: AuditService,
  ) {}

  private run<T>(principal: TenantPrincipal, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, fn);
  }

  private async loadItems(trx: Trx, tenantId: string, itemIds: string[]): Promise<ItemRow[]> {
    return trx
      .selectFrom('items as i')
      .innerJoin('units_of_measure as u', (join) => join.onRef('u.id', '=', 'i.uom_id').onRef('u.tenant_id', '=', 'i.tenant_id'))
      .select(['i.id', 'i.code', 'i.item_type', 'i.status', 'i.group_id', 'u.decimals'])
      .where('i.tenant_id', '=', tenantId)
      .where('i.id', 'in', [...new Set(itemIds)])
      .execute();
  }

  private checkItem(items: ItemRow[], itemId: string, quantity: string, index: number): { item: ItemRow; quantity: Money } {
    const item = items.find((candidate) => candidate.id === itemId);
    if (!item || item.status !== 'active') throw lineError(index, 'itemId', `Line ${index + 1}: choose an active item`);
    if (item.item_type !== 'inventory') throw lineError(index, 'itemId', `Line ${index + 1}: ${item.code} is not an inventory item`);
    if (decimalPlaces(quantity) > item.decimals) throw lineError(index, 'quantity', `Line ${index + 1}: ${item.code} allows ${item.decimals} decimal places`);
    const parsed = parseMoney(quantity);
    if (parsed <= 0n) throw lineError(index, 'quantity', `Line ${index + 1}: quantity must be greater than zero`);
    return { item, quantity: parsed };
  }

  private async accountResolver(trx: Trx, tenantId: string, warehouseIds: string[], groupIds: string[]) {
    const warehouses = warehouseIds.length
      ? await trx
          .selectFrom('warehouses')
          .select(['id', 'code', 'status', 'inventory_account_id'])
          .where('tenant_id', '=', tenantId)
          .where('id', 'in', [...new Set(warehouseIds)])
          .execute()
      : [];
    const groups = groupIds.length
      ? await trx
          .selectFrom('item_groups')
          .select(['id', 'inventory_account_id'])
          .where('tenant_id', '=', tenantId)
          .where('id', 'in', [...new Set(groupIds)])
          .execute()
      : [];
    const fallback = await trx
      .selectFrom('gl_determination')
      .select('account_id')
      .where('tenant_id', '=', tenantId)
      .where('determination_key', '=', 'inventory')
      .executeTakeFirst();
    return {
      warehouse: (id: string) => warehouses.find((row) => row.id === id),
      inventoryAccount: (warehouseId: string, groupId: string) => {
        const account =
          warehouses.find((row) => row.id === warehouseId)?.inventory_account_id ?? groups.find((row) => row.id === groupId)?.inventory_account_id ?? fallback?.account_id;
        if (!account) throw new AppError(422, 'MAPPING_MISSING', 'G/L account determination is missing the Inventory account');
        return account;
      },
    };
  }

  private journalLines(debits: Map<string, Money>, credits: Map<string, Money>): PostingLine[] {
    return [
      ...[...debits.entries()].filter(([, amount]) => amount > 0n).map(([accountId, amount]) => ({ accountId, debit: amount, credit: 0n })),
      ...[...credits.entries()].filter(([, amount]) => amount > 0n).map(([accountId, amount]) => ({ accountId, debit: 0n, credit: amount })),
    ];
  }

  async createTransfer(principal: TenantPrincipal, input: CreateStockTransferRequest, correlationId: string): Promise<{ replayed: boolean; transfer: StockTransfer }> {
    const { idempotencyKey, ...payload } = input;
    return this.run(principal, async (trx) => {
      const tenantId = principal.tenantId;
      const existing = await claimIdempotencyKey(trx, tenantId, idempotencyKey, 'stock_transfer.create', payload);
      if (existing) return { replayed: true, transfer: await this.loadTransfer(trx, tenantId, existing) };
      if (payload.fromWarehouseId === payload.toWarehouseId) {
        throw new AppError(400, 'VALIDATION_FAILED', 'The source and destination warehouses must differ', [{ path: 'toWarehouseId', message: 'Same as the source warehouse' }]);
      }
      await this.posting.openPeriodFor(trx, tenantId, payload.postingDate);
      const items = await this.loadItems(trx, tenantId, payload.lines.map((line) => line.itemId));
      const accounts = await this.accountResolver(trx, tenantId, [payload.fromWarehouseId, payload.toWarehouseId], items.map((item) => item.group_id));
      for (const [path, id] of [['fromWarehouseId', payload.fromWarehouseId], ['toWarehouseId', payload.toWarehouseId]] as const) {
        const warehouse = accounts.warehouse(id);
        if (!warehouse || warehouse.status !== 'active') throw new AppError(400, 'VALIDATION_FAILED', 'Choose an active warehouse', [{ path, message: 'Choose an active warehouse' }]);
      }
      const checked = payload.lines.map((line, index) => this.checkItem(items, line.itemId, line.quantity, index));
      await this.stock.lockValuations(trx, tenantId, checked.map((line) => line.item.id));
      const plan: { item: ItemRow; quantity: Money; value: Money }[] = [];
      for (const line of checked) {
        const state = await this.stock.valuation(trx, tenantId, line.item.id);
        plan.push({ ...line, value: this.stock.issueValue(state, line.quantity) });
      }
      const debits = new Map<string, Money>();
      const credits = new Map<string, Money>();
      for (const line of plan) {
        const from = accounts.inventoryAccount(payload.fromWarehouseId, line.item.group_id);
        const to = accounts.inventoryAccount(payload.toWarehouseId, line.item.group_id);
        if (from === to || line.value === 0n) continue;
        debits.set(to, (debits.get(to) ?? 0n) + line.value);
        credits.set(from, (credits.get(from) ?? 0n) + line.value);
      }
      const transferId = randomUUID();
      const lines = this.journalLines(debits, credits);
      const journalId =
        lines.length >= 2
          ? (
              await this.posting.post(trx, {
                tenantId,
                userId: principal.userId,
                sourceType: 'stock_transfer',
                sourceId: transferId,
                postingDate: payload.postingDate,
                memo: `Inventory transfer: ${payload.reason}`,
                lines,
              })
            ).id
          : null;
      const series = await this.posting.nextNumber(trx, tenantId, 'stock_transfer', payload.seriesId);
      await trx
        .insertInto('stock_transfers')
        .values({
          id: transferId,
          tenant_id: tenantId,
          series_id: series.seriesId,
          number: series.number,
          document_number: series.documentNumber,
          from_warehouse_id: payload.fromWarehouseId,
          to_warehouse_id: payload.toWarehouseId,
          posting_date: payload.postingDate,
          reason: payload.reason,
          remarks: payload.remarks ?? null,
          total_value: formatMoney(sumMoney(plan.map((line) => line.value))),
          journal_id: journalId,
          created_by: principal.userId,
        })
        .execute();
      const inserted = await trx
        .insertInto('stock_transfer_lines')
        .values(
          plan.map((line, index) => ({
            tenant_id: tenantId,
            transfer_id: transferId,
            line_no: index + 1,
            item_id: line.item.id,
            quantity: formatMoney(line.quantity),
            value: formatMoney(line.value),
          })),
        )
        .returning(['id', 'line_no'])
        .execute();
      for (const [index, line] of plan.entries()) {
        const sourceLineId = inserted.find((row) => row.line_no === index + 1)?.id ?? null;
        const common = { tenantId, userId: principal.userId, itemId: line.item.id, sourceType: 'stock_transfer', sourceId: transferId, sourceLineId, postingDate: payload.postingDate, journalId };
        await this.stock.record(trx, { ...common, warehouseId: payload.fromWarehouseId, quantity: -line.quantity, value: -line.value });
        await this.stock.record(trx, { ...common, warehouseId: payload.toWarehouseId, quantity: line.quantity, value: line.value });
      }
      await completeIdempotencyKey(trx, tenantId, idempotencyKey, transferId);
      const transfer = await this.loadTransfer(trx, tenantId, transferId);
      await this.audit.record(trx, {
        tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'stock_transfer.posted',
        entityType: 'stock_transfer',
        entityId: transferId,
        after: {
          documentNumber: transfer.documentNumber,
          from: transfer.fromWarehouseCode,
          to: transfer.toWarehouseCode,
          reason: transfer.reason,
          totalValue: transfer.totalValue,
          journal: transfer.journalNumber,
        },
        correlationId,
      });
      return { replayed: false, transfer };
    });
  }

  async previewOpening(principal: TenantPrincipal, input: CreateInventoryOpeningBalanceRequest): Promise<AdjustmentPreview> {
    return this.previewAdjustment(principal, { ...input, direction: 'opening' });
  }

  async createOpening(
    principal: TenantPrincipal,
    input: CreateInventoryOpeningBalanceRequest,
    correlationId: string,
    source?: Record<string, unknown>,
  ): Promise<{ replayed: boolean; adjustment: InventoryAdjustment }> {
    return this.run(principal, (trx) => this.postAdjustment(trx, principal, { ...input, direction: 'opening' }, correlationId, false, source));
  }

  async previewAdjustment(principal: TenantPrincipal, input: InventoryDocumentInput): Promise<AdjustmentPreview> {
    try {
      await this.run(principal, (trx) => this.postAdjustment(trx, principal, input, null, true));
    } catch (error) {
      if (error instanceof PreviewRollback) return error.preview;
      throw error;
    }
    throw new Error('Adjustment preview did not roll back');
  }

  async createAdjustment(principal: TenantPrincipal, input: CreateInventoryAdjustmentRequest, correlationId: string): Promise<{ replayed: boolean; adjustment: InventoryAdjustment }> {
    return this.run(principal, (trx) => this.postAdjustment(trx, principal, input, correlationId, false));
  }

  private async postAdjustment(
    trx: Trx,
    principal: TenantPrincipal,
    input: InventoryDocumentInput,
    correlationId: string | null,
    preview: boolean,
    source?: Record<string, unknown>,
  ): Promise<{ replayed: boolean; adjustment: InventoryAdjustment }> {
    const { idempotencyKey, ...payload } = input;
    const tenantId = principal.tenantId;
    const opening = payload.direction === 'opening';
    const inbound = payload.direction !== 'issue';
    if (!preview) {
      const existing = await claimIdempotencyKey(trx, tenantId, idempotencyKey, opening ? 'inventory_opening_balance.create' : 'inventory_adjustment.create', payload);
      if (existing) return { replayed: true, adjustment: await this.loadAdjustment(trx, tenantId, existing, payload.direction) };
    }
    await this.posting.openPeriodFor(trx, tenantId, payload.postingDate);
    const offsetAccountId = await this.offsetAccount(trx, tenantId, payload.offsetAccountId, opening ? 'opening_balance' : 'inventory_adjustment');
    const items = await this.loadItems(trx, tenantId, payload.lines.map((line) => line.itemId));
    const accounts = await this.accountResolver(
      trx,
      tenantId,
      payload.lines.map((line) => line.warehouseId),
      items.map((item) => item.group_id),
    );
    const checked = payload.lines.map((line, index) => {
      const result = this.checkItem(items, line.itemId, line.quantity, index);
      const warehouse = accounts.warehouse(line.warehouseId);
      if (!warehouse || warehouse.status !== 'active') throw lineError(index, 'warehouseId', `Line ${index + 1}: choose an active warehouse`);
      if (payload.direction === 'issue' && line.unitCost !== undefined) throw lineError(index, 'unitCost', `Line ${index + 1}: goods issues are valued at the average cost`);
      if (opening && line.unitCost === undefined) throw lineError(index, 'unitCost', `Line ${index + 1}: enter the unit cost of the opening stock`);
      if (opening && payload.lines.findIndex((other) => other.itemId === line.itemId && other.warehouseId === line.warehouseId) !== index) {
        throw lineError(index, 'itemId', `Line ${index + 1}: ${result.item.code} appears more than once for the same warehouse`);
      }
      const inventoryAccountId = accounts.inventoryAccount(line.warehouseId, result.item.group_id);
      if (inventoryAccountId === offsetAccountId) throw lineError(index, 'warehouseId', `Line ${index + 1}: the offset account cannot be the inventory account`);
      return { ...result, warehouseId: line.warehouseId, unitCost: line.unitCost, inventoryAccountId };
    });
    await this.stock.lockValuations(trx, tenantId, checked.map((line) => line.item.id));
    if (opening) await this.assertNoPriorStock(trx, tenantId, checked);
    const before = new Map<string, { onHand: Money; totalValue: Money }>();
    for (const line of checked) if (!before.has(line.item.id)) before.set(line.item.id, await this.stock.valuation(trx, tenantId, line.item.id));
    const running = new Map([...before.entries()].map(([id, state]) => [id, { ...state }]));
    const plan = checked.map((line, index) => {
      const state = running.get(line.item.id) as { onHand: Money; totalValue: Money };
      let value: Money;
      if (payload.direction === 'issue') {
        if (line.quantity > state.onHand) {
          throw lineError(index, 'quantity', `Line ${index + 1}: only ${formatMoney(state.onHand)} of ${line.item.code} is in stock`, 422, 'INSUFFICIENT_STOCK');
        }
        value = this.stock.issueValue(state, line.quantity);
        state.onHand -= line.quantity;
        state.totalValue -= value;
      } else {
        if (line.unitCost !== undefined) {
          value = multiplyMoney(line.quantity, parseMoney(line.unitCost));
        } else if (state.onHand > 0n) {
          value = (2n * state.totalValue * line.quantity + state.onHand) / (2n * state.onHand);
        } else {
          throw lineError(index, 'unitCost', `Line ${index + 1}: ${line.item.code} has no stock, so enter a unit cost`);
        }
        state.onHand += line.quantity;
        state.totalValue += value;
      }
      return { ...line, value };
    });

    const debits = new Map<string, Money>();
    const credits = new Map<string, Money>();
    const inventorySide = inbound ? debits : credits;
    const offsetSide = inbound ? credits : debits;
    for (const line of plan) inventorySide.set(line.inventoryAccountId, (inventorySide.get(line.inventoryAccountId) ?? 0n) + line.value);
    const total = sumMoney(plan.map((line) => line.value));
    offsetSide.set(offsetAccountId, total);
    const adjustmentId = randomUUID();
    const lines = this.journalLines(debits, credits);
    const journalId =
      total > 0n
        ? (
            await this.posting.post(trx, {
              tenantId,
              userId: principal.userId,
              sourceType: SOURCE_TYPES[payload.direction],
              sourceId: adjustmentId,
              postingDate: payload.postingDate,
              memo: `${DOCUMENT_LABELS[payload.direction]}: ${payload.reason}`,
              lines,
            })
          ).id
        : null;
    const series = await this.posting.nextNumber(trx, tenantId, SERIES_TYPES[payload.direction], payload.seriesId);
    await trx
      .insertInto('inventory_adjustments')
      .values({
        id: adjustmentId,
        tenant_id: tenantId,
        series_id: series.seriesId,
        number: series.number,
        document_number: series.documentNumber,
        direction: payload.direction,
        posting_date: payload.postingDate,
        offset_account_id: offsetAccountId,
        reason: payload.reason,
        remarks: payload.remarks ?? null,
        total_value: formatMoney(total),
        journal_id: journalId,
        created_by: principal.userId,
      })
      .execute();
    const inserted = await trx
      .insertInto('inventory_adjustment_lines')
      .values(
        plan.map((line, index) => ({
          tenant_id: tenantId,
          adjustment_id: adjustmentId,
          line_no: index + 1,
          item_id: line.item.id,
          warehouse_id: line.warehouseId,
          inventory_account_id: line.inventoryAccountId,
          quantity: formatMoney(line.quantity),
          unit_cost: formatCost(averageCost(line.value, line.quantity)),
          value: formatMoney(line.value),
        })),
      )
      .returning(['id', 'line_no'])
      .execute();
    const sign = inbound ? 1n : -1n;
    for (const [index, line] of plan.entries()) {
      await this.stock.record(trx, {
        tenantId,
        userId: principal.userId,
        itemId: line.item.id,
        warehouseId: line.warehouseId,
        quantity: sign * line.quantity,
        value: sign * line.value,
        sourceType: SOURCE_TYPES[payload.direction],
        sourceId: adjustmentId,
        sourceLineId: inserted.find((row) => row.line_no === index + 1)?.id ?? null,
        postingDate: payload.postingDate,
        journalId,
      });
    }
    const adjustment = await this.loadAdjustment(trx, tenantId, adjustmentId, payload.direction);
    if (preview) {
      const accountRows = await trx
        .selectFrom('accounts')
        .select(['id', 'code', 'name'])
        .where('tenant_id', '=', tenantId)
        .where('id', 'in', lines.length ? lines.map((line) => line.accountId as string) : [offsetAccountId])
        .execute();
      const after = new Map<string, { onHand: Money; totalValue: Money }>();
      for (const itemId of before.keys()) after.set(itemId, await this.stock.valuation(trx, tenantId, itemId));
      throw new PreviewRollback({
        adjustment,
        journalLines: lines.map((line) => {
          const account = accountRows.find((row) => row.id === line.accountId);
          return { accountCode: account?.code ?? '', accountName: account?.name ?? '', debit: formatMoney(line.debit), credit: formatMoney(line.credit) };
        }),
        valuations: [...before.entries()].map(([itemId, state]) => {
          const next = after.get(itemId) as { onHand: Money; totalValue: Money };
          return {
            itemCode: items.find((item) => item.id === itemId)?.code ?? itemId,
            onHandBefore: formatMoney(state.onHand),
            onHandAfter: formatMoney(next.onHand),
            valueBefore: formatMoney(state.totalValue),
            valueAfter: formatMoney(next.totalValue),
            averageCostAfter: formatCost(averageCost(next.totalValue, next.onHand)),
          };
        }),
      });
    }
    await completeIdempotencyKey(trx, tenantId, idempotencyKey, adjustmentId);
    await this.audit.record(trx, {
      tenantId,
      actor: { type: 'user', id: principal.userId },
      action: opening ? 'inventory_opening_balance.posted' : `inventory_adjustment.${payload.direction}_posted`,
      entityType: 'inventory_adjustment',
      entityId: adjustmentId,
      after: {
        documentNumber: adjustment.documentNumber,
        reason: adjustment.reason,
        offsetAccount: adjustment.offsetAccountCode,
        totalValue: adjustment.totalValue,
        journal: adjustment.journalNumber,
        ...(source ? { source } : {}),
      },
      correlationId,
    });
    return { replayed: false, adjustment };
  }

  private async assertNoPriorStock(trx: Trx, tenantId: string, lines: { item: ItemRow; warehouseId: string }[]): Promise<void> {
    const prior = await trx
      .selectFrom('stock_movements as m')
      .select(['m.item_id', 'm.warehouse_id'])
      .where('m.tenant_id', '=', tenantId)
      .where('m.item_id', 'in', [...new Set(lines.map((line) => line.item.id))])
      .where('m.warehouse_id', 'in', [...new Set(lines.map((line) => line.warehouseId))])
      .where(({ and, eb, exists, not, selectFrom }) =>
        not(
          and([
            eb('m.source_type', 'in', ['inventory_opening_balance', 'inventory_opening_balance_cancellation']),
            exists(
              selectFrom('inventory_adjustments as a')
                .select('a.id')
                .whereRef('a.id', '=', 'm.source_id')
                .whereRef('a.tenant_id', '=', 'm.tenant_id')
                .where((inner) => inner.or([inner('a.status', '=', 'cancelled'), inner('a.is_cancellation', '=', true)])),
            ),
          ]),
        ),
      )
      .execute();
    for (const [index, line] of lines.entries()) {
      if (prior.some((row) => row.item_id === line.item.id && row.warehouse_id === line.warehouseId)) {
        throw lineError(
          index,
          'itemId',
          `Line ${index + 1}: ${line.item.code} already has stock transactions in this warehouse; use Goods Receipt or Goods Issue instead`,
          409,
          'OPENING_BALANCE_EXISTS',
        );
      }
    }
  }

  private async offsetAccount(trx: Trx, tenantId: string, requested: string | undefined, key: 'inventory_adjustment' | 'opening_balance'): Promise<string> {
    let accountId = requested;
    if (!accountId) {
      const row = await trx
        .selectFrom('gl_determination')
        .select('account_id')
        .where('tenant_id', '=', tenantId)
        .where('determination_key', '=', key)
        .executeTakeFirst();
      if (!row) throw new AppError(422, 'MAPPING_MISSING', `G/L account determination is missing the ${key === 'opening_balance' ? 'Opening Balance Offset' : 'Inventory Adjustment'} account`);
      accountId = row.account_id;
    }
    const account = await trx
      .selectFrom('accounts')
      .select(['id', 'is_title', 'status', 'control_kind'])
      .where('tenant_id', '=', tenantId)
      .where('id', '=', accountId)
      .executeTakeFirst();
    if (!account || account.is_title || account.status !== 'active' || account.control_kind) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Choose an active, postable, non-control offset account', [
        { path: 'offsetAccountId', message: 'Choose an active, postable, non-control account' },
      ]);
    }
    return account.id;
  }

  async cancelTransfer(principal: TenantPrincipal, transferId: string, input: CancelStockDocumentRequest, correlationId: string): Promise<{ replayed: boolean; transfer: StockTransfer }> {
    const { idempotencyKey, ...payload } = input;
    try {
      return await this.run(principal, async (trx) => {
        const tenantId = principal.tenantId;
        const existing = await claimIdempotencyKey(trx, tenantId, idempotencyKey, `stock_transfer.cancel:${transferId}`, payload);
        if (existing) return { replayed: true, transfer: await this.loadTransfer(trx, tenantId, existing) };
        await lockTenantResource(trx, tenantId, `stock-transfer-cancel:${transferId}`);
        const original = await this.loadTransfer(trx, tenantId, transferId);
        this.checkCancellable(original, payload.postingDate, 'Inventory transfer');
        await this.posting.openPeriodFor(trx, tenantId, payload.postingDate);
        const header = await trx.selectFrom('stock_transfers').selectAll().where('tenant_id', '=', tenantId).where('id', '=', transferId).executeTakeFirstOrThrow();
        const cancellationId = randomUUID();
        const journalId = await this.reverseEffects(trx, principal, 'stock_transfer', transferId, cancellationId, original, payload.postingDate, (itemId) =>
          original.lines.find((line) => line.itemId === itemId)?.itemCode ?? itemId,
        );
        const series = await this.posting.nextNumber(trx, tenantId, 'stock_transfer', header.series_id);
        await trx
          .insertInto('stock_transfers')
          .values({
            id: cancellationId,
            tenant_id: tenantId,
            series_id: series.seriesId,
            number: series.number,
            document_number: series.documentNumber,
            from_warehouse_id: header.from_warehouse_id,
            to_warehouse_id: header.to_warehouse_id,
            posting_date: payload.postingDate,
            reason: header.reason,
            remarks: `Cancellation of ${original.documentNumber}`,
            total_value: header.total_value,
            is_cancellation: true,
            cancellation_of_id: transferId,
            cancellation_reason: payload.reason,
            journal_id: journalId,
            created_by: principal.userId,
          })
          .execute();
        await trx
          .insertInto('stock_transfer_lines')
          .values(
            original.lines.map((line) => ({
              tenant_id: tenantId,
              transfer_id: cancellationId,
              line_no: line.lineNo,
              item_id: line.itemId,
              quantity: line.quantity,
              value: line.value,
            })),
          )
          .execute();
        await trx.updateTable('stock_transfers').set({ status: 'cancelled' }).where('tenant_id', '=', tenantId).where('id', '=', transferId).execute();
        await completeIdempotencyKey(trx, tenantId, idempotencyKey, cancellationId);
        const cancellation = await this.loadTransfer(trx, tenantId, cancellationId);
        await this.audit.record(trx, {
          tenantId,
          actor: { type: 'user', id: principal.userId },
          action: 'stock_transfer.cancelled',
          entityType: 'stock_transfer',
          entityId: transferId,
          before: { documentNumber: original.documentNumber, status: 'posted' },
          after: { status: 'cancelled', cancellation: cancellation.documentNumber, reason: payload.reason, postingDate: payload.postingDate },
          correlationId,
        });
        return { replayed: false, transfer: cancellation };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'stock_transfers_single_cancellation_key')) throw conflict('This inventory transfer has already been cancelled');
      throw error;
    }
  }

  async cancelOpening(principal: TenantPrincipal, adjustmentId: string, input: CancelStockDocumentRequest, correlationId: string): Promise<{ replayed: boolean; adjustment: InventoryAdjustment }> {
    return this.cancelAdjustment(principal, adjustmentId, input, correlationId, 'opening');
  }

  async cancelAdjustment(
    principal: TenantPrincipal,
    adjustmentId: string,
    input: CancelStockDocumentRequest,
    correlationId: string,
    kind: 'adjustment' | 'opening' = 'adjustment',
  ): Promise<{ replayed: boolean; adjustment: InventoryAdjustment }> {
    const { idempotencyKey, ...payload } = input;
    try {
      return await this.run(principal, async (trx) => {
        const tenantId = principal.tenantId;
        const existing = await claimIdempotencyKey(trx, tenantId, idempotencyKey, `inventory_adjustment.cancel:${adjustmentId}`, payload);
        if (existing) return { replayed: true, adjustment: await this.loadAdjustment(trx, tenantId, existing) };
        await lockTenantResource(trx, tenantId, `inventory-adjustment-cancel:${adjustmentId}`);
        const original = await this.loadAdjustment(trx, tenantId, adjustmentId, kind === 'opening' ? 'opening' : 'receipt');
        this.checkCancellable(original, payload.postingDate, DOCUMENT_LABELS[original.direction]);
        await this.posting.openPeriodFor(trx, tenantId, payload.postingDate);
        const header = await trx.selectFrom('inventory_adjustments').selectAll().where('tenant_id', '=', tenantId).where('id', '=', adjustmentId).executeTakeFirstOrThrow();
        const cancellationId = randomUUID();
        const journalId = await this.reverseEffects(trx, principal, SOURCE_TYPES[original.direction], adjustmentId, cancellationId, original, payload.postingDate, (itemId) =>
          original.lines.find((line) => line.itemId === itemId)?.itemCode ?? itemId,
        );
        const series = await this.posting.nextNumber(trx, tenantId, SERIES_TYPES[header.direction], header.series_id);
        await trx
          .insertInto('inventory_adjustments')
          .values({
            id: cancellationId,
            tenant_id: tenantId,
            series_id: series.seriesId,
            number: series.number,
            document_number: series.documentNumber,
            direction: header.direction,
            posting_date: payload.postingDate,
            offset_account_id: header.offset_account_id,
            reason: header.reason,
            remarks: `Cancellation of ${original.documentNumber}`,
            total_value: header.total_value,
            is_cancellation: true,
            cancellation_of_id: adjustmentId,
            cancellation_reason: payload.reason,
            journal_id: journalId,
            created_by: principal.userId,
          })
          .execute();
        const lines = await trx.selectFrom('inventory_adjustment_lines').selectAll().where('tenant_id', '=', tenantId).where('adjustment_id', '=', adjustmentId).execute();
        await trx
          .insertInto('inventory_adjustment_lines')
          .values(
            lines.map((line) => ({
              tenant_id: tenantId,
              adjustment_id: cancellationId,
              line_no: line.line_no,
              item_id: line.item_id,
              warehouse_id: line.warehouse_id,
              inventory_account_id: line.inventory_account_id,
              quantity: line.quantity,
              unit_cost: line.unit_cost,
              value: line.value,
            })),
          )
          .execute();
        await trx.updateTable('inventory_adjustments').set({ status: 'cancelled' }).where('tenant_id', '=', tenantId).where('id', '=', adjustmentId).execute();
        await completeIdempotencyKey(trx, tenantId, idempotencyKey, cancellationId);
        const cancellation = await this.loadAdjustment(trx, tenantId, cancellationId);
        await this.audit.record(trx, {
          tenantId,
          actor: { type: 'user', id: principal.userId },
          action: original.direction === 'opening' ? 'inventory_opening_balance.cancelled' : 'inventory_adjustment.cancelled',
          entityType: 'inventory_adjustment',
          entityId: adjustmentId,
          before: { documentNumber: original.documentNumber, status: 'posted' },
          after: { status: 'cancelled', cancellation: cancellation.documentNumber, reason: payload.reason, postingDate: payload.postingDate },
          correlationId,
        });
        return { replayed: false, adjustment: cancellation };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'inventory_adjustments_single_cancellation_key')) throw conflict('This document has already been cancelled');
      throw error;
    }
  }

  private checkCancellable(original: { isCancellation: boolean; status: string; documentNumber: string; postingDate: string }, postingDate: string, label: string): void {
    if (original.isCancellation) throw conflict('A cancellation document cannot itself be cancelled');
    if (original.status === 'cancelled') throw conflict(`${label} ${original.documentNumber} is already cancelled`);
    if (postingDate < original.postingDate) {
      throw new AppError(422, 'POSTING_REJECTED', 'The cancellation date cannot be earlier than the document date', [{ path: 'postingDate', message: 'Before the document date' }]);
    }
  }

  private async reverseEffects(
    trx: Trx,
    principal: TenantPrincipal,
    sourceType: 'stock_transfer' | 'inventory_adjustment' | 'inventory_opening_balance',
    sourceId: string,
    cancellationId: string,
    original: { documentNumber: string; journalId: string | null },
    postingDate: string,
    itemCode: (itemId: string) => string,
  ): Promise<string | null> {
    const tenantId = principal.tenantId;
    const movements = await trx
      .selectFrom('stock_movements')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('source_type', '=', sourceType)
      .where('source_id', '=', sourceId)
      .orderBy('created_at', 'desc')
      .execute();
    await this.stock.lockValuations(trx, tenantId, movements.map((movement) => movement.item_id));
    await this.stock.assertDocumentIsLatest(trx, tenantId, movements, itemCode);
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
          sourceType: `${sourceType}_cancellation`,
          sourceId: cancellationId,
          postingDate,
          memo: `Cancellation of ${original.documentNumber}`,
          reference: original.documentNumber,
          lines: lines.map((line) => ({ accountId: line.account_id, partnerId: line.partner_id, debit: parseMoney(line.credit), credit: parseMoney(line.debit), memo: line.memo })),
        })
      ).id;
    }
    for (const movement of movements) {
      await this.stock.record(trx, {
        tenantId,
        userId: principal.userId,
        itemId: movement.item_id,
        warehouseId: movement.warehouse_id,
        quantity: -parseMoney(movement.quantity),
        value: -parseMoney(movement.value),
        sourceType: `${sourceType}_cancellation`,
        sourceId: cancellationId,
        sourceLineId: null,
        postingDate,
        journalId,
      });
    }
    return journalId;
  }

  async listTransfers(principal: TenantPrincipal, query: StockDocumentListQuery): Promise<Page<StockDocumentSummary>> {
    return this.run(principal, async (trx) => {
      let base = trx
        .selectFrom('stock_transfers as t')
        .innerJoin('warehouses as f', (join) => join.onRef('f.id', '=', 't.from_warehouse_id').onRef('f.tenant_id', '=', 't.tenant_id'))
        .innerJoin('warehouses as d', (join) => join.onRef('d.id', '=', 't.to_warehouse_id').onRef('d.tenant_id', '=', 't.tenant_id'))
        .where('t.tenant_id', '=', principal.tenantId);
      if (query.search) {
        const pattern = `%${query.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
        base = base.where((eb) => eb.or([eb('t.document_number', 'ilike', pattern), eb('t.reason', 'ilike', pattern)]));
      }
      const total = await base.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
      const rows = await base
        .select(['t.id', 't.document_number', 't.posting_date', 'f.code as from_code', 'd.code as to_code', 't.reason', 't.total_value', 't.status', 't.is_cancellation'])
        .orderBy('t.posted_at', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute();
      return {
        items: rows.map((row) => ({
          id: row.id,
          documentNumber: row.document_number,
          postingDate: row.posting_date,
          description: `${row.from_code} → ${row.to_code}`,
          reason: row.reason,
          totalValue: row.total_value,
          status: row.status,
          isCancellation: row.is_cancellation,
        })),
        limit: query.limit,
        offset: query.offset,
        total: Number(total.count),
      };
    });
  }

  async listOpenings(principal: TenantPrincipal, query: StockDocumentListQuery): Promise<Page<StockDocumentSummary>> {
    return this.listDocuments(principal, query, ['opening']);
  }

  async listAdjustments(principal: TenantPrincipal, query: AdjustmentListQuery): Promise<Page<StockDocumentSummary>> {
    return this.listDocuments(principal, query, query.direction ? [query.direction] : ['receipt', 'issue']);
  }

  private async listDocuments(principal: TenantPrincipal, query: StockDocumentListQuery, directions: InventoryDocumentDirection[]): Promise<Page<StockDocumentSummary>> {
    return this.run(principal, async (trx) => {
      let base = trx
        .selectFrom('inventory_adjustments as a')
        .innerJoin('accounts as acc', (join) => join.onRef('acc.id', '=', 'a.offset_account_id').onRef('acc.tenant_id', '=', 'a.tenant_id'))
        .where('a.tenant_id', '=', principal.tenantId)
        .where('a.direction', 'in', directions);
      if (query.search) {
        const pattern = `%${query.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
        base = base.where((eb) => eb.or([eb('a.document_number', 'ilike', pattern), eb('a.reason', 'ilike', pattern)]));
      }
      const total = await base.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
      const rows = await base
        .select(['a.id', 'a.document_number', 'a.posting_date', 'a.direction', 'acc.code', 'a.reason', 'a.total_value', 'a.status', 'a.is_cancellation'])
        .orderBy('a.posted_at', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute();
      return {
        items: rows.map((row) => ({
          id: row.id,
          documentNumber: row.document_number,
          postingDate: row.posting_date,
          description: `${DOCUMENT_LABELS[row.direction]} / ${row.code}`,
          reason: row.reason,
          totalValue: row.total_value,
          status: row.status,
          isCancellation: row.is_cancellation,
        })),
        limit: query.limit,
        offset: query.offset,
        total: Number(total.count),
      };
    });
  }

  async getTransfer(principal: TenantPrincipal, id: string): Promise<StockTransfer> {
    return this.run(principal, (trx) => this.loadTransfer(trx, principal.tenantId, id));
  }

  async getAdjustment(principal: TenantPrincipal, id: string): Promise<InventoryAdjustment> {
    return this.run(principal, (trx) => this.loadAdjustment(trx, principal.tenantId, id, 'receipt'));
  }

  async getOpening(principal: TenantPrincipal, id: string): Promise<InventoryAdjustment> {
    return this.run(principal, (trx) => this.loadAdjustment(trx, principal.tenantId, id, 'opening'));
  }

  private async loadTransfer(trx: Trx, tenantId: string, id: string): Promise<StockTransfer> {
    const row = await trx
      .selectFrom('stock_transfers as t')
      .innerJoin('warehouses as f', (join) => join.onRef('f.id', '=', 't.from_warehouse_id').onRef('f.tenant_id', '=', 't.tenant_id'))
      .innerJoin('warehouses as d', (join) => join.onRef('d.id', '=', 't.to_warehouse_id').onRef('d.tenant_id', '=', 't.tenant_id'))
      .leftJoin('journal_entries as je', (join) => join.onRef('je.id', '=', 't.journal_id').onRef('je.tenant_id', '=', 't.tenant_id'))
      .leftJoin('stock_transfers as c', (join) => join.onRef('c.cancellation_of_id', '=', 't.id').onRef('c.tenant_id', '=', 't.tenant_id'))
      .selectAll('t')
      .select(['f.code as from_code', 'd.code as to_code', 'je.document_number as journal_number', 'c.id as cancelled_by_id'])
      .where('t.tenant_id', '=', tenantId)
      .where('t.id', '=', id)
      .executeTakeFirst();
    if (!row) throw notFound();
    const lines = await trx
      .selectFrom('stock_transfer_lines as l')
      .innerJoin('items as i', (join) => join.onRef('i.id', '=', 'l.item_id').onRef('i.tenant_id', '=', 'l.tenant_id'))
      .innerJoin('units_of_measure as u', (join) => join.onRef('u.id', '=', 'i.uom_id').onRef('u.tenant_id', '=', 'i.tenant_id'))
      .select(['l.id', 'l.line_no', 'l.item_id', 'i.code', 'i.name', 'u.code as uom_code', 'l.quantity', 'l.value'])
      .where('l.tenant_id', '=', tenantId)
      .where('l.transfer_id', '=', id)
      .orderBy('l.line_no')
      .execute();
    return {
      id: row.id,
      documentNumber: row.document_number,
      postingDate: row.posting_date,
      reason: row.reason,
      remarks: row.remarks,
      totalValue: row.total_value,
      status: row.status,
      isCancellation: row.is_cancellation,
      cancellationOfId: row.cancellation_of_id,
      cancelledById: row.cancelled_by_id,
      cancellationReason: row.cancellation_reason,
      journalId: row.journal_id,
      journalNumber: row.journal_number,
      postedAt: row.posted_at.toISOString(),
      fromWarehouseId: row.from_warehouse_id,
      fromWarehouseCode: row.from_code,
      toWarehouseId: row.to_warehouse_id,
      toWarehouseCode: row.to_code,
      lines: lines.map((line) => ({
        id: line.id,
        lineNo: line.line_no,
        itemId: line.item_id,
        itemCode: line.code,
        itemName: line.name,
        uomCode: line.uom_code,
        quantity: line.quantity,
        value: line.value,
      })),
    };
  }

  private async loadAdjustment(trx: Trx, tenantId: string, id: string, expected?: InventoryDocumentDirection): Promise<InventoryAdjustment> {
    const row = await trx
      .selectFrom('inventory_adjustments as a')
      .innerJoin('accounts as acc', (join) => join.onRef('acc.id', '=', 'a.offset_account_id').onRef('acc.tenant_id', '=', 'a.tenant_id'))
      .leftJoin('journal_entries as je', (join) => join.onRef('je.id', '=', 'a.journal_id').onRef('je.tenant_id', '=', 'a.tenant_id'))
      .leftJoin('inventory_adjustments as c', (join) => join.onRef('c.cancellation_of_id', '=', 'a.id').onRef('c.tenant_id', '=', 'a.tenant_id'))
      .selectAll('a')
      .select(['acc.code as account_code', 'acc.name as account_name', 'je.document_number as journal_number', 'c.id as cancelled_by_id'])
      .where('a.tenant_id', '=', tenantId)
      .where('a.id', '=', id)
      .executeTakeFirst();
    if (!row || (expected !== undefined && (expected === 'opening') !== (row.direction === 'opening'))) throw notFound();
    const lines = await trx
      .selectFrom('inventory_adjustment_lines as l')
      .innerJoin('items as i', (join) => join.onRef('i.id', '=', 'l.item_id').onRef('i.tenant_id', '=', 'l.tenant_id'))
      .innerJoin('units_of_measure as u', (join) => join.onRef('u.id', '=', 'i.uom_id').onRef('u.tenant_id', '=', 'i.tenant_id'))
      .innerJoin('warehouses as w', (join) => join.onRef('w.id', '=', 'l.warehouse_id').onRef('w.tenant_id', '=', 'l.tenant_id'))
      .innerJoin('accounts as ia', (join) => join.onRef('ia.id', '=', 'l.inventory_account_id').onRef('ia.tenant_id', '=', 'l.tenant_id'))
      .select(['l.id', 'l.line_no', 'l.item_id', 'i.code', 'i.name', 'u.code as uom_code', 'l.warehouse_id', 'w.code as warehouse_code', 'ia.code as account_code', 'l.quantity', 'l.unit_cost', 'l.value'])
      .where('l.tenant_id', '=', tenantId)
      .where('l.adjustment_id', '=', id)
      .orderBy('l.line_no')
      .execute();
    return {
      id: row.id,
      documentNumber: row.document_number,
      postingDate: row.posting_date,
      reason: row.reason,
      remarks: row.remarks,
      totalValue: row.total_value,
      status: row.status,
      isCancellation: row.is_cancellation,
      cancellationOfId: row.cancellation_of_id,
      cancelledById: row.cancelled_by_id,
      cancellationReason: row.cancellation_reason,
      journalId: row.journal_id,
      journalNumber: row.journal_number,
      postedAt: row.posted_at.toISOString(),
      direction: row.direction,
      offsetAccountId: row.offset_account_id,
      offsetAccountCode: row.account_code,
      offsetAccountName: row.account_name,
      lines: lines.map((line) => ({
        id: line.id,
        lineNo: line.line_no,
        itemId: line.item_id,
        itemCode: line.code,
        itemName: line.name,
        uomCode: line.uom_code,
        warehouseId: line.warehouse_id,
        warehouseCode: line.warehouse_code,
        inventoryAccountCode: line.account_code,
        quantity: line.quantity,
        unitCost: line.unit_cost,
        value: line.value,
      })),
    };
  }
}
