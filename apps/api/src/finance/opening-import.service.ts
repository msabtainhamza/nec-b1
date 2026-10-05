import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import {
  OPENING_IMPORT_COLUMNS,
  OPENING_IMPORT_MAX_ROWS,
  type ImportRowError,
  type InventoryOpeningImportRequest,
  type OpeningBalanceImportRequest,
  type OpeningImportKind,
  type OpeningImportResult,
} from '@nec/contracts';
import { AppError } from '../common/errors.js';
import { importErrors, readCsvTable, validImportDate, type ImportErrors, type ImportRow } from '../common/csv-table.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService } from '../database/database.service.js';
import { StockTransactionsService } from '../inventory/stock-transactions.service.js';
import { formatMoney, parseMoney, sumMoney } from './money.js';
import { OpeningBalancesService } from './opening-balances.service.js';

const FIELD_COLUMNS: Record<string, string> = {
  accountId: 'AccountCode',
  partnerId: 'BPCode',
  reference: 'Reference',
  documentDate: 'DocumentDate',
  dueDate: 'DueDate',
  debit: 'Debit',
  credit: 'Credit',
  itemId: 'ItemCode',
  warehouseId: 'WarehouseCode',
  quantity: 'Quantity',
  unitCost: 'UnitCost',
};

const AMOUNT = /^\d{1,15}(\.\d{1,4})?$/;
function amountField(row: ImportRow, column: string, errors: ImportErrors): string | null {
  const raw = (row.fields[column] ?? '').replace(/[\s,]/g, '');
  if (raw === '') return '0';
  if (!AMOUNT.test(raw)) {
    errors.add(row.row, column, 'Enter a non-negative amount with up to 4 decimal places');
    return null;
  }
  return raw;
}

function toRowErrors(error: AppError, rows: number[]): ImportRowError[] {
  const details = Array.isArray(error.details) ? (error.details as { path?: unknown; message?: unknown }[]) : [];
  const lineDetails = details.filter((detail) => typeof detail.path === 'string' && /^lines\.\d+/.test(detail.path));
  if (lineDetails.length === 0) {
    const path = typeof details[0]?.path === 'string' ? details[0].path : null;
    return [{ row: null, column: path, message: error.message }];
  }
  return lineDetails.map((detail) => {
    const match = /^lines\.(\d+)\.?(\w*)/.exec(detail.path as string) as RegExpExecArray;
    const message = typeof detail.message === 'string' ? detail.message : error.message;
    return { row: rows[Number(match[1])] ?? null, column: FIELD_COLUMNS[match[2] ?? ''] ?? null, message: message.replace(/^Line \d+: /, '') };
  });
}

@Injectable()
export class OpeningImportService {
  constructor(
    private readonly database: DatabaseService,
    private readonly openingBalances: OpeningBalancesService,
    private readonly stock: StockTransactionsService,
  ) {}

  private read(kind: OpeningImportKind, csv: string, errors: ImportErrors): ImportRow[] {
    return readCsvTable(csv, OPENING_IMPORT_COLUMNS[kind], OPENING_IMPORT_MAX_ROWS, errors);
  }

  private async codes<T extends { id: string; code: string }>(principal: TenantPrincipal, table: 'accounts' | 'business_partners' | 'items' | 'warehouses', values: string[]): Promise<Map<string, T>> {
    const unique = [...new Set(values.filter(Boolean).map((value) => value.toLowerCase()))];
    if (unique.length === 0) return new Map();
    const rows = await this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, (trx) =>
      trx.selectFrom(table).select(['id', 'code']).where('tenant_id', '=', principal.tenantId).where(sql<string>`lower(code)`, 'in', unique).execute(),
    );
    return new Map(rows.map((row) => [row.code.toLowerCase(), row as T]));
  }

  private result(kind: OpeningImportKind, mode: 'validate' | 'commit', rowCount: number, errors: ImportRowError[]): OpeningImportResult {
    return {
      kind,
      mode,
      valid: errors.length === 0,
      committed: false,
      replayed: false,
      rowCount,
      errors: errors.sort((a, b) => (a.row ?? 0) - (b.row ?? 0)),
      totalDebit: '0.0000',
      totalCredit: '0.0000',
      documentId: null,
      documentNumber: null,
      journalNumber: null,
    };
  }

  async importBalances(principal: TenantPrincipal, input: OpeningBalanceImportRequest, correlationId: string): Promise<OpeningImportResult> {
    const { kind, mode, csv, fileName, ...header } = input;
    const errors = importErrors();
    const rows = this.read(kind, csv, errors);
    if (errors.errors.length > 0) return this.result(kind, mode, rows.length, errors.errors);
    const lookup = kind === 'account' ? await this.codes(principal, 'accounts', rows.map((row) => row.fields.AccountCode ?? '')) : await this.codes(principal, 'business_partners', rows.map((row) => row.fields.BPCode ?? ''));
    const codeColumn = kind === 'account' ? 'AccountCode' : 'BPCode';
    const seen = new Map<string, number>();
    const lines = rows.map((row) => {
      const code = row.fields[codeColumn] ?? '';
      const target = lookup.get(code.toLowerCase());
      if (code && !target) errors.add(row.row, codeColumn, `${kind === 'account' ? 'G/L account' : 'Business partner'} ${code} does not exist`);
      if (kind === 'account' && target) {
        const first = seen.get(target.id);
        if (first !== undefined) errors.add(row.row, codeColumn, `Account ${code} also appears on row ${first}`);
        else seen.set(target.id, row.row);
      }
      const debit = amountField(row, 'Debit', errors);
      const credit = amountField(row, 'Credit', errors);
      if (debit !== null && credit !== null && (parseMoney(debit) > 0n) === (parseMoney(credit) > 0n)) {
        errors.add(row.row, 'Debit', 'Enter either a debit or a credit amount');
      }
      for (const column of ['DocumentDate', 'DueDate']) {
        const value = row.fields[column];
        if (value && !validImportDate(value)) errors.add(row.row, column, 'Enter the date as YYYY-MM-DD');
      }
      const reference = row.fields.Reference ?? '';
      if (reference.length > 60) errors.add(row.row, 'Reference', 'The reference is longer than 60 characters');
      return { targetId: target?.id ?? '', debit: debit ?? '0', credit: credit ?? '0', reference, documentDate: row.fields.DocumentDate || undefined, dueDate: row.fields.DueDate || undefined };
    });
    if (errors.errors.length > 0) return this.result(kind, mode, rows.length, errors.errors);
    const source = { import: true, fileName: fileName ?? null, rows: rows.length };
    const options = { dryRun: mode === 'validate', source };
    try {
      const outcome =
        kind === 'account'
          ? await this.openingBalances.createAccounts(principal, { ...header, lines: lines.map((line) => ({ accountId: line.targetId, debit: line.debit, credit: line.credit })) }, correlationId, options)
          : await this.openingBalances.createPartners(
              principal,
              {
                ...header,
                lines: lines.map((line) => ({
                  partnerId: line.targetId,
                  reference: line.reference || null,
                  documentDate: line.documentDate,
                  dueDate: line.dueDate,
                  debit: line.debit,
                  credit: line.credit,
                })),
              },
              correlationId,
              options,
            );
      const document = outcome.openingBalance;
      return {
        ...this.result(kind, mode, rows.length, []),
        committed: mode === 'commit',
        replayed: outcome.replayed,
        totalDebit: document.totalDebit,
        totalCredit: document.totalCredit,
        documentId: mode === 'commit' ? document.id : null,
        documentNumber: mode === 'commit' ? document.documentNumber : null,
        journalNumber: mode === 'commit' ? document.journalNumber : null,
      };
    } catch (error) {
      if (error instanceof AppError && error.status < 500 && (error.status !== 409 || Array.isArray(error.details))) {
        return this.result(kind, mode, rows.length, toRowErrors(error, rows.map((row) => row.row)));
      }
      throw error;
    }
  }

  async importInventory(principal: TenantPrincipal, input: InventoryOpeningImportRequest, correlationId: string): Promise<OpeningImportResult> {
    const { mode, csv, fileName, ...header } = input;
    const errors = importErrors();
    const rows = this.read('inventory', csv, errors);
    if (errors.errors.length > 0) return this.result('inventory', mode, rows.length, errors.errors);
    const items = await this.codes(principal, 'items', rows.map((row) => row.fields.ItemCode ?? ''));
    const warehouses = await this.codes(principal, 'warehouses', rows.map((row) => row.fields.WarehouseCode ?? ''));
    const seen = new Map<string, number>();
    const lines = rows.map((row) => {
      const item = items.get((row.fields.ItemCode ?? '').toLowerCase());
      const warehouse = warehouses.get((row.fields.WarehouseCode ?? '').toLowerCase());
      if (row.fields.ItemCode && !item) errors.add(row.row, 'ItemCode', `Item ${row.fields.ItemCode} does not exist`);
      if (row.fields.WarehouseCode && !warehouse) errors.add(row.row, 'WarehouseCode', `Warehouse ${row.fields.WarehouseCode} does not exist`);
      if (item && warehouse) {
        const key = `${item.id}:${warehouse.id}`;
        const first = seen.get(key);
        if (first !== undefined) errors.add(row.row, 'ItemCode', `Item ${row.fields.ItemCode} in ${row.fields.WarehouseCode} also appears on row ${first}`);
        else seen.set(key, row.row);
      }
      const quantity = (row.fields.Quantity ?? '').replace(/[\s,]/g, '');
      if (quantity && (!AMOUNT.test(quantity) || parseMoney(quantity) <= 0n)) errors.add(row.row, 'Quantity', 'Enter a quantity greater than zero with up to 4 decimal places');
      const unitCost = (row.fields.UnitCost ?? '').replace(/[\s,]/g, '');
      if (unitCost && !AMOUNT.test(unitCost)) errors.add(row.row, 'UnitCost', 'Enter a non-negative unit cost with up to 4 decimal places');
      return { itemId: item?.id ?? '', warehouseId: warehouse?.id ?? '', quantity, unitCost };
    });
    if (errors.errors.length > 0) return this.result('inventory', mode, rows.length, errors.errors);
    const request = { ...header, lines };
    try {
      if (mode === 'validate') {
        const preview = await this.stock.previewOpening(principal, request);
        const total = sumMoney(preview.journalLines.map((line) => parseMoney(line.debit)));
        return { ...this.result('inventory', mode, rows.length, []), totalDebit: formatMoney(total), totalCredit: formatMoney(total) };
      }
      const outcome = await this.stock.createOpening(principal, request, correlationId, { import: true, fileName: fileName ?? null, rows: rows.length });
      return {
        ...this.result('inventory', mode, rows.length, []),
        committed: true,
        replayed: outcome.replayed,
        totalDebit: outcome.adjustment.totalValue,
        totalCredit: outcome.adjustment.totalValue,
        documentId: outcome.adjustment.id,
        documentNumber: outcome.adjustment.documentNumber,
        journalNumber: outcome.adjustment.journalNumber,
      };
    } catch (error) {
      if (error instanceof AppError && error.status < 500 && (error.status !== 409 || Array.isArray(error.details))) {
        return this.result('inventory', mode, rows.length, toRowErrors(error, rows.map((row) => row.row)));
      }
      throw error;
    }
  }
}
