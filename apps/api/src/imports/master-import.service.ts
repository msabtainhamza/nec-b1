import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import {
  createItemRequest,
  createPartnerRequest,
  MASTER_IMPORT_COLUMNS,
  MASTER_IMPORT_MAX_ROWS,
  moneyAmount,
  updateItemRequest,
  updatePartnerRequest,
  type BusinessPartner,
  type ImportRowError,
  type Item,
  type MasterImportKind,
  type MasterImportRequest,
  type MasterImportResult,
} from '@nec/contracts';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { BusinessPartnersService } from '../business-partners/business-partners.service.js';
import { importErrors, readCsvTable, type ImportErrors, type ImportRow } from '../common/csv-table.js';
import { AppError, forbidden } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, type Trx } from '../database/database.service.js';
import { claimIdempotencyKey, completeIdempotencyKey } from '../finance/idempotency.js';
import { InventoryService } from '../inventory/inventory.service.js';

const PARTNER_FIELDS: Record<string, string> = {
  code: 'BPCode',
  name: 'BPName',
  partnerType: 'BPType',
  groupId: 'GroupCode',
  foreignName: 'ForeignName',
  taxId: 'TaxId',
  phone: 'Phone',
  email: 'Email',
  website: 'Website',
  paymentTermsId: 'PaymentTermsCode',
  creditLimit: 'CreditLimit',
  status: 'Status',
  remarks: 'Remarks',
};

const ITEM_FIELDS: Record<string, string> = {
  code: 'ItemCode',
  name: 'ItemName',
  itemType: 'ItemType',
  groupId: 'GroupCode',
  uomId: 'UomCode',
  foreignName: 'ForeignName',
  isSalesItem: 'SalesItem',
  isPurchaseItem: 'PurchaseItem',
  barcode: 'Barcode',
  defaultWarehouseId: 'DefaultWarehouseCode',
  reorderPoint: 'ReorderPoint',
  preferredVendorId: 'PreferredVendorCode',
  status: 'Status',
  remarks: 'Remarks',
};

class Rollback extends Error {}

type Codes = Map<string, { id: string; extra?: string }>;

const lower = (value: string) => value.trim().toLowerCase();

@Injectable()
export class MasterImportService {
  constructor(
    private readonly database: DatabaseService,
    private readonly partners: BusinessPartnersService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
  ) {}

  async importPartners(principal: TenantPrincipal, input: MasterImportRequest, correlationId: string): Promise<MasterImportResult> {
    if (input.updateExisting && !principal.permissions.has('bp.partner.edit')) throw forbidden('Updating existing business partners requires the edit permission');
    return this.run(principal, 'partner', input, correlationId, true, (trx, rows, errors) => this.partnerRows(trx, principal, rows, errors, input.updateExisting, correlationId));
  }

  async importItems(principal: TenantPrincipal, input: MasterImportRequest, correlationId: string): Promise<MasterImportResult> {
    if (input.updateExisting && !principal.permissions.has('inv.item.edit')) throw forbidden('Updating existing items requires the edit permission');
    return this.run(principal, 'item', input, correlationId, false, (trx, rows, errors) => this.itemRows(trx, principal, rows, errors, input.updateExisting, correlationId));
  }

  async importPrices(principal: TenantPrincipal, input: MasterImportRequest, correlationId: string): Promise<MasterImportResult> {
    return this.run(principal, 'price', input, correlationId, false, (trx, rows, errors) => this.priceRows(trx, principal, rows, errors, correlationId));
  }

  private result(kind: MasterImportKind, mode: 'validate' | 'commit', rowCount: number, errors: ImportRowError[], counts = { created: 0, updated: 0 }): MasterImportResult {
    return {
      kind,
      mode,
      valid: errors.length === 0,
      committed: false,
      replayed: false,
      rowCount,
      created: errors.length === 0 ? counts.created : 0,
      updated: errors.length === 0 ? counts.updated : 0,
      errors: errors.sort((a, b) => (a.row ?? 0) - (b.row ?? 0) || this.columnIndex(kind, a.column) - this.columnIndex(kind, b.column)),
    };
  }

  private columnIndex(kind: MasterImportKind, column: string | null): number {
    const index = MASTER_IMPORT_COLUMNS[kind].findIndex((entry) => entry.name === column);
    return index === -1 ? MASTER_IMPORT_COLUMNS[kind].length : index;
  }

  private async run(
    principal: TenantPrincipal,
    kind: MasterImportKind,
    input: MasterImportRequest,
    correlationId: string,
    serializeCredit: boolean,
    apply: (trx: Trx, rows: ImportRow[], errors: ImportErrors) => Promise<{ created: number; updated: number }>,
  ): Promise<MasterImportResult> {
    const errors = importErrors();
    const rows = readCsvTable(input.csv, MASTER_IMPORT_COLUMNS[kind], MASTER_IMPORT_MAX_ROWS, errors);
    const code = kind === 'partner' ? 'BPCode' : 'ItemCode';
    if (kind !== 'price') {
      const seen = new Map<string, number>();
      for (const row of rows) {
        const value = lower(row.fields[code] ?? '');
        if (!value) continue;
        const first = seen.get(value);
        if (first !== undefined) errors.add(row.row, code, `${row.fields[code]} already appears on row ${first}`);
        else seen.set(value, row.row);
      }
    }
    if (errors.errors.length > 0) return this.result(kind, input.mode, rows.length, errors.errors);
    let outcome: MasterImportResult | null = null;
    try {
      await this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId, serializeCredit }, async (trx) => {
        if (input.mode === 'commit') {
          const existing = await claimIdempotencyKey(trx, principal.tenantId, input.idempotencyKey, `master_import.${kind}`, { csv: input.csv, updateExisting: input.updateExisting });
          if (existing) {
            const event = await trx
              .selectFrom('audit_events')
              .select('after_data')
              .where('tenant_id', '=', principal.tenantId)
              .where('entity_id', '=', existing)
              .where('action', '=', 'master_data.imported')
              .executeTakeFirstOrThrow();
            const data = event.after_data as { rowCount: number; created: number; updated: number };
            outcome = { ...this.result(kind, 'commit', data.rowCount, []), committed: true, replayed: true, created: data.created, updated: data.updated };
            return;
          }
        }
        const counts = await apply(trx, rows, errors);
        outcome = this.result(kind, input.mode, rows.length, errors.errors, counts);
        if (input.mode === 'validate' || errors.errors.length > 0) throw new Rollback();
        const batchId = randomUUID();
        await this.audit.record(trx, {
          tenantId: principal.tenantId,
          actor: { type: 'user', id: principal.userId },
          action: 'master_data.imported',
          entityType: 'master_import',
          entityId: batchId,
          after: { kind, fileName: input.fileName ?? null, rowCount: rows.length, created: counts.created, updated: counts.updated, updateExisting: input.updateExisting },
          correlationId,
        });
        await completeIdempotencyKey(trx, principal.tenantId, input.idempotencyKey, batchId);
        outcome = { ...outcome, committed: true };
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    return outcome as unknown as MasterImportResult;
  }

  private async attempt(trx: Trx, row: number, errors: ImportErrors, columns: Record<string, string>, action: () => Promise<void>): Promise<boolean> {
    await sql`savepoint import_row`.execute(trx);
    try {
      await action();
      await sql`release savepoint import_row`.execute(trx);
      return true;
    } catch (error) {
      await sql`rollback to savepoint import_row`.execute(trx);
      if (!(error instanceof AppError)) throw error;
      const details = Array.isArray(error.details) ? (error.details as { path?: unknown; message?: unknown }[]) : [];
      if (details.length === 0) errors.add(row, null, error.message);
      for (const detail of details) {
        const path = typeof detail.path === 'string' ? detail.path.split('.')[0] ?? '' : '';
        errors.add(row, columns[path] ?? null, typeof detail.message === 'string' ? detail.message : error.message);
      }
      return false;
    }
  }

  private parse<S extends z.ZodType>(schema: S, value: unknown, row: number, errors: ImportErrors, columns: Record<string, string>): z.infer<S> | null {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    for (const issue of parsed.error.issues) errors.add(row, columns[String(issue.path[0] ?? '')] ?? null, issue.message);
    return null;
  }

  private async codes(trx: Trx, tenantId: string, table: 'bp_groups' | 'payment_terms' | 'item_groups' | 'units_of_measure' | 'warehouses' | 'price_lists' | 'items' | 'business_partners'): Promise<Codes> {
    const rows = await sql<{ id: string; code: string; extra: string | null }>`select id, code, ${
      table === 'bp_groups' ? sql`partner_type` : table === 'business_partners' ? sql`partner_type` : sql`null`
    }::text as extra from ${sql.table(table)} where tenant_id = ${tenantId}`.execute(trx);
    return new Map(rows.rows.map((row) => [row.code.toLowerCase(), { id: row.id, extra: row.extra ?? undefined }]));
  }

  private resolve(codes: Codes, value: string, row: number, column: string, label: string, errors: ImportErrors): string | null | undefined {
    if (!value) return undefined;
    const found = codes.get(lower(value));
    if (!found) {
      errors.add(row, column, `Unknown ${label} ${value}`);
      return null;
    }
    return found.id;
  }

  private flag(value: string, row: number, column: string, errors: ImportErrors): boolean | undefined {
    if (!value) return undefined;
    const normalized = lower(value);
    if (['y', 'yes', 'true', '1'].includes(normalized)) return true;
    if (['n', 'no', 'false', '0'].includes(normalized)) return false;
    errors.add(row, column, 'Use Y or N');
    return undefined;
  }

  private async partnerRows(trx: Trx, principal: TenantPrincipal, rows: ImportRow[], errors: ImportErrors, updateExisting: boolean, correlationId: string) {
    const tenantId = principal.tenantId;
    const [groups, terms, existing] = await Promise.all([this.codes(trx, tenantId, 'bp_groups'), this.codes(trx, tenantId, 'payment_terms'), this.codes(trx, tenantId, 'business_partners')]);
    const counts = { created: 0, updated: 0 };
    for (const row of rows) {
      const f = row.fields;
      const before = errors.errors.length;
      for (const prefix of ['BillTo', 'ShipTo']) {
        const country = f[`${prefix}Country`] ?? '';
        if (country && !/^[A-Za-z]{2}$/.test(country)) errors.add(row.row, `${prefix}Country`, 'Use a two-letter country code');
      }
      const groupId = this.resolve(groups, f.GroupCode ?? '', row.row, 'GroupCode', 'business partner group', errors);
      const paymentTermsId = this.resolve(terms, f.PaymentTermsCode ?? '', row.row, 'PaymentTermsCode', 'payment terms', errors);
      if (errors.errors.length > before) continue;
      const header: Record<string, unknown> = {};
      const set = (key: string, value: unknown) => {
        if (value !== undefined && value !== '') header[key] = value;
      };
      set('name', f.BPName);
      set('partnerType', f.BPType ? lower(f.BPType) : undefined);
      set('groupId', groupId);
      set('foreignName', f.ForeignName);
      set('taxId', f.TaxId);
      set('phone', f.Phone);
      set('email', f.Email);
      set('website', f.Website);
      set('paymentTermsId', paymentTermsId);
      set('creditLimit', f.CreditLimit ? f.CreditLimit.replace(/[\s,]/g, '') : undefined);
      set('status', f.Status ? lower(f.Status) : undefined);
      set('remarks', f.Remarks);
      const address = (prefix: 'BillTo' | 'ShipTo') => {
        const values = { street: f[`${prefix}Street`] ?? '', city: f[`${prefix}City`] ?? '', zipCode: f[`${prefix}ZipCode`] ?? '', country: f[`${prefix}Country`] ?? '' };
        return Object.values(values).some(Boolean) ? values : null;
      };
      const match = existing.get(lower(f.BPCode ?? ''));
      if (match && !updateExisting) {
        errors.add(row.row, 'BPCode', `Business partner ${f.BPCode} already exists; choose Update existing records to change it`);
        continue;
      }
      if (!match) {
        const addresses = (['BillTo', 'ShipTo'] as const).flatMap((prefix) => {
          const values = address(prefix);
          return values ? [{ addressType: prefix === 'BillTo' ? 'bill_to' : 'ship_to', addressName: prefix === 'BillTo' ? 'Bill to' : 'Ship to', ...values, isDefault: true }] : [];
        });
        const request = this.parse(createPartnerRequest, { code: f.BPCode, ...header, addresses }, row.row, errors, PARTNER_FIELDS);
        if (!request) continue;
        if (await this.attempt(trx, row.row, errors, PARTNER_FIELDS, async () => void (await this.partners.createWithin(trx, principal, request, correlationId)))) counts.created += 1;
        continue;
      }
      const current = (await this.partners.load(trx, tenantId, match.id)) as BusinessPartner;
      const addresses = current.addresses.map(({ addressType, addressName, street, city, state, zipCode, country, isDefault }) => ({ addressType, addressName, street, city, state, zipCode, country, isDefault }));
      for (const prefix of ['BillTo', 'ShipTo'] as const) {
        const values = address(prefix);
        if (!values) continue;
        const type = prefix === 'BillTo' ? 'bill_to' : 'ship_to';
        const target = addresses.find((entry) => entry.addressType === type && entry.isDefault) ?? addresses.find((entry) => entry.addressType === type);
        const changes = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''));
        if (target) Object.assign(target, changes);
        else addresses.push({ addressType: type, addressName: prefix === 'BillTo' ? 'Bill to' : 'Ship to', street: null, city: null, state: null, zipCode: null, country: null, isDefault: true, ...changes });
      }
      const request = this.parse(
        updatePartnerRequest,
        {
          version: current.version,
          partnerType: current.partnerType,
          name: current.name,
          foreignName: current.foreignName,
          groupId: current.groupId,
          currency: current.currency,
          taxId: current.taxId,
          phone: current.phone,
          email: current.email,
          website: current.website,
          paymentTermsId: current.paymentTermsId,
          creditLimit: current.creditLimit,
          status: current.status,
          remarks: current.remarks,
          contacts: current.contacts.map(({ name, position, phone, email, isDefault }) => ({ name, position, phone, email, isDefault })),
          ...header,
          addresses,
        },
        row.row,
        errors,
        PARTNER_FIELDS,
      );
      if (!request) continue;
      if (await this.attempt(trx, row.row, errors, PARTNER_FIELDS, async () => void (await this.partners.updateWithin(trx, principal, match.id, request, correlationId)))) counts.updated += 1;
    }
    return counts;
  }

  private async itemRows(trx: Trx, principal: TenantPrincipal, rows: ImportRow[], errors: ImportErrors, updateExisting: boolean, correlationId: string) {
    const tenantId = principal.tenantId;
    const [groups, units, warehouses, partners, existing] = await Promise.all([
      this.codes(trx, tenantId, 'item_groups'),
      this.codes(trx, tenantId, 'units_of_measure'),
      this.codes(trx, tenantId, 'warehouses'),
      this.codes(trx, tenantId, 'business_partners'),
      this.codes(trx, tenantId, 'items'),
    ]);
    const counts = { created: 0, updated: 0 };
    for (const row of rows) {
      const f = row.fields;
      const before = errors.errors.length;
      const groupId = this.resolve(groups, f.GroupCode ?? '', row.row, 'GroupCode', 'item group', errors);
      const uomId = this.resolve(units, f.UomCode ?? '', row.row, 'UomCode', 'unit of measure', errors);
      const defaultWarehouseId = this.resolve(warehouses, f.DefaultWarehouseCode ?? '', row.row, 'DefaultWarehouseCode', 'warehouse', errors);
      const preferredVendorId = this.resolve(partners, f.PreferredVendorCode ?? '', row.row, 'PreferredVendorCode', 'business partner', errors);
      const isSalesItem = this.flag(f.SalesItem ?? '', row.row, 'SalesItem', errors);
      const isPurchaseItem = this.flag(f.PurchaseItem ?? '', row.row, 'PurchaseItem', errors);
      if (errors.errors.length > before) continue;
      const fields: Record<string, unknown> = {};
      const set = (key: string, value: unknown) => {
        if (value !== undefined && value !== '') fields[key] = value;
      };
      set('name', f.ItemName);
      set('itemType', f.ItemType ? lower(f.ItemType) : undefined);
      set('groupId', groupId);
      set('uomId', uomId);
      set('foreignName', f.ForeignName);
      set('isSalesItem', isSalesItem);
      set('isPurchaseItem', isPurchaseItem);
      set('barcode', f.Barcode);
      set('defaultWarehouseId', defaultWarehouseId);
      set('reorderPoint', f.ReorderPoint ? f.ReorderPoint.replace(/[\s,]/g, '') : undefined);
      set('preferredVendorId', preferredVendorId);
      set('status', f.Status ? lower(f.Status) : undefined);
      set('remarks', f.Remarks);
      const match = existing.get(lower(f.ItemCode ?? ''));
      if (match && !updateExisting) {
        errors.add(row.row, 'ItemCode', `Item ${f.ItemCode} already exists; choose Update existing records to change it`);
        continue;
      }
      if (!match) {
        const request = this.parse(createItemRequest, { code: f.ItemCode, ...fields }, row.row, errors, ITEM_FIELDS);
        if (!request) continue;
        if (await this.attempt(trx, row.row, errors, ITEM_FIELDS, async () => void (await this.inventory.createItemWithin(trx, principal, request, correlationId)))) counts.created += 1;
        continue;
      }
      const current = (await this.inventory.loadItem(trx, tenantId, match.id)) as Item;
      const request = this.parse(
        updateItemRequest,
        {
          version: current.version,
          name: current.name,
          foreignName: current.foreignName,
          itemType: current.itemType,
          isSalesItem: current.isSalesItem,
          isPurchaseItem: current.isPurchaseItem,
          groupId: current.groupId,
          uomId: current.uomId,
          barcode: current.barcode,
          defaultWarehouseId: current.defaultWarehouseId,
          reorderPoint: current.reorderPoint,
          preferredVendorId: current.preferredVendorId,
          status: current.status,
          remarks: current.remarks,
          prices: current.prices,
          ...fields,
        },
        row.row,
        errors,
        ITEM_FIELDS,
      );
      if (!request) continue;
      if (await this.attempt(trx, row.row, errors, ITEM_FIELDS, async () => void (await this.inventory.updateItemWithin(trx, principal, match.id, request, correlationId)))) counts.updated += 1;
    }
    return counts;
  }

  private async priceRows(trx: Trx, principal: TenantPrincipal, rows: ImportRow[], errors: ImportErrors, correlationId: string) {
    const tenantId = principal.tenantId;
    const [lists, items] = await Promise.all([this.codes(trx, tenantId, 'price_lists'), this.codes(trx, tenantId, 'items')]);
    const byList = new Map<string, { rows: number[]; prices: { itemId: string; price: string | null }[] }>();
    const seen = new Map<string, number>();
    for (const row of rows) {
      const f = row.fields;
      const before = errors.errors.length;
      const listId = this.resolve(lists, f.PriceListCode ?? '', row.row, 'PriceListCode', 'price list', errors);
      const itemId = this.resolve(items, f.ItemCode ?? '', row.row, 'ItemCode', 'item', errors);
      const raw = (f.Price ?? '').replace(/[\s,]/g, '');
      if (raw && !moneyAmount.safeParse(raw).success) errors.add(row.row, 'Price', 'Enter a non-negative price with up to 4 decimal places');
      if (errors.errors.length > before || !listId || !itemId) continue;
      const key = `${listId}:${itemId}`;
      const first = seen.get(key);
      if (first !== undefined) {
        errors.add(row.row, 'ItemCode', `${f.ItemCode} already appears for price list ${f.PriceListCode} on row ${first}`);
        continue;
      }
      seen.set(key, row.row);
      const group = byList.get(listId) ?? { rows: [], prices: [] };
      group.rows.push(row.row);
      group.prices.push({ itemId, price: raw || null });
      byList.set(listId, group);
    }
    const counts = { created: 0, updated: 0 };
    if (errors.errors.length > 0) return counts;
    for (const [listId, group] of byList) {
      const current = await trx.selectFrom('item_prices').select('item_id').where('tenant_id', '=', tenantId).where('price_list_id', '=', listId).execute();
      const priced = new Set(current.map((row) => row.item_id));
      const ok = await this.attempt(trx, group.rows[0] as number, errors, { prices: 'Price' }, () => this.inventory.setPricesWithin(trx, principal, listId, { prices: group.prices }, correlationId));
      if (!ok) {
        const failure = errors.errors[errors.errors.length - 1] as ImportRowError;
        for (const row of group.rows.slice(1)) errors.add(row, failure.column, failure.message);
        continue;
      }
      for (const price of group.prices) {
        if (priced.has(price.itemId)) counts.updated += 1;
        else if (price.price !== null) counts.created += 1;
      }
    }
    return counts;
  }
}
