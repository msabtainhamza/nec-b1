import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  CreateItemGroupRequest,
  CreateItemRequest,
  CreatePriceListRequest,
  CreateUnitRequest,
  CreateWarehouseRequest,
  Item,
  ItemGroup,
  ItemListQuery,
  ItemSummary,
  Page,
  PriceList,
  PriceListEntry,
  SetPricesRequest,
  UnitOfMeasure,
  UpdateItemRequest,
  UpdatePriceListRequest,
  UpdateWarehouseRequest,
  Warehouse,
} from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { AppError, conflict, isUniqueViolation, notFound, versionConflict } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, type Trx } from '../database/database.service.js';
import { StockService } from './stock.service.js';

type ItemFields = Omit<CreateItemRequest, 'code'>;

const fieldError = (path: string, message: string) => new AppError(400, 'VALIDATION_FAILED', message, [{ path, message }]);

const escapeLike = (value: string) => `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

@Injectable()
export class InventoryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly stock: StockService,
  ) {}

  private run<T>(principal: TenantPrincipal, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, fn);
  }

  private record(trx: Trx, principal: TenantPrincipal, action: string, entityType: string, entityId: string | null, correlationId: string, after?: Record<string, unknown>, before?: Record<string, unknown>) {
    return this.audit.record(trx, {
      tenantId: principal.tenantId,
      actor: { type: 'user', id: principal.userId },
      action,
      entityType,
      entityId,
      before: before ?? null,
      after: after ?? null,
      correlationId,
    });
  }

  async units(principal: TenantPrincipal): Promise<UnitOfMeasure[]> {
    const rows = await this.run(principal, (trx) =>
      trx.selectFrom('units_of_measure').select(['id', 'code', 'name', 'decimals', 'status']).where('tenant_id', '=', principal.tenantId).orderBy('code').execute(),
    );
    return rows;
  }

  async createUnit(principal: TenantPrincipal, input: CreateUnitRequest, correlationId: string): Promise<UnitOfMeasure> {
    return this.run(principal, async (trx) => {
      try {
        const row = await trx
          .insertInto('units_of_measure')
          .values({ tenant_id: principal.tenantId, code: input.code, name: input.name, decimals: input.decimals })
          .returning(['id', 'code', 'name', 'decimals', 'status'])
          .executeTakeFirstOrThrow();
        await this.record(trx, principal, 'unit_of_measure.created', 'unit_of_measure', row.id, correlationId, { ...input });
        return row;
      } catch (error) {
        if (isUniqueViolation(error, 'units_of_measure_tenant_id_code_key')) {
          throw conflict(`Unit ${input.code} already exists`);
        }
        throw error;
      }
    });
  }

  async groups(principal: TenantPrincipal): Promise<ItemGroup[]> {
    const rows = await this.run(principal, (trx) =>
      trx.selectFrom('item_groups').selectAll().where('tenant_id', '=', principal.tenantId).orderBy('name').execute(),
    );
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      inventoryAccountId: row.inventory_account_id,
      cogsAccountId: row.cogs_account_id,
      revenueAccountId: row.revenue_account_id,
      status: row.status,
      version: row.version,
    }));
  }

  async createGroup(principal: TenantPrincipal, input: CreateItemGroupRequest, correlationId: string): Promise<ItemGroup> {
    const id = await this.run(principal, async (trx) => {
      await this.assertAccount(trx, principal.tenantId, input.inventoryAccountId, ['asset'], 'inventoryAccountId');
      await this.assertAccount(trx, principal.tenantId, input.cogsAccountId, ['expense'], 'cogsAccountId');
      await this.assertAccount(trx, principal.tenantId, input.revenueAccountId, ['income'], 'revenueAccountId');
      try {
        const row = await trx
          .insertInto('item_groups')
          .values({
            tenant_id: principal.tenantId,
            code: input.code,
            name: input.name,
            inventory_account_id: input.inventoryAccountId ?? null,
            cogs_account_id: input.cogsAccountId ?? null,
            revenue_account_id: input.revenueAccountId ?? null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await this.record(trx, principal, 'item_group.created', 'item_group', row.id, correlationId, { ...input });
        return row.id;
      } catch (error) {
        if (isUniqueViolation(error, 'item_groups_tenant_id_code_key')) {
          throw conflict(`Item group ${input.code} already exists`);
        }
        throw error;
      }
    });
    const group = (await this.groups(principal)).find((row) => row.id === id);
    if (!group) throw notFound();
    return group;
  }

  private async assertAccount(trx: Trx, tenantId: string, accountId: string | null | undefined, types: string[], path: string): Promise<void> {
    if (!accountId) return;
    const account = await trx
      .selectFrom('accounts')
      .select(['code', 'account_type', 'is_title', 'status', 'control_kind'])
      .where('tenant_id', '=', tenantId)
      .where('id', '=', accountId)
      .executeTakeFirst();
    if (!account) throw fieldError(path, 'The account was not found');
    if (account.is_title || account.status !== 'active' || account.control_kind) {
      throw fieldError(path, `${account.code} must be an active, postable, non-control account`);
    }
    if (!types.includes(account.account_type)) {
      throw fieldError(path, `${account.code} must be a ${types.join(' or ')} account`);
    }
  }

  async warehouses(principal: TenantPrincipal): Promise<Warehouse[]> {
    const rows = await this.run(principal, (trx) =>
      trx
        .selectFrom('warehouses as w')
        .innerJoin('branches as b', (join) => join.onRef('b.id', '=', 'w.branch_id').onRef('b.tenant_id', '=', 'w.tenant_id'))
        .select(['w.id', 'w.code', 'w.name', 'w.branch_id', 'b.code as branch_code', 'w.inventory_account_id', 'w.status', 'w.version'])
        .select(sql<boolean>`b.default_warehouse_id = w.id`.as('is_branch_default'))
        .where('w.tenant_id', '=', principal.tenantId)
        .orderBy('w.code')
        .execute(),
    );
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      branchId: row.branch_id,
      branchCode: row.branch_code,
      inventoryAccountId: row.inventory_account_id,
      status: row.status,
      isBranchDefault: Boolean(row.is_branch_default),
      version: row.version,
    }));
  }

  async createWarehouse(principal: TenantPrincipal, input: CreateWarehouseRequest, correlationId: string): Promise<Warehouse> {
    const id = await this.run(principal, async (trx) => {
      const branch = await trx
        .selectFrom('branches')
        .select(['id', 'status', 'default_warehouse_id'])
        .where('tenant_id', '=', principal.tenantId)
        .where('id', '=', input.branchId)
        .executeTakeFirst();
      if (!branch) throw fieldError('branchId', 'The branch was not found');
      if (branch.status !== 'active') throw fieldError('branchId', 'The branch is disabled');
      await this.assertAccount(trx, principal.tenantId, input.inventoryAccountId, ['asset'], 'inventoryAccountId');
      try {
        const row = await trx
          .insertInto('warehouses')
          .values({
            tenant_id: principal.tenantId,
            code: input.code,
            name: input.name,
            branch_id: input.branchId,
            inventory_account_id: input.inventoryAccountId ?? null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        if (!branch.default_warehouse_id) {
          await trx.updateTable('branches').set({ default_warehouse_id: row.id }).where('tenant_id', '=', principal.tenantId).where('id', '=', branch.id).execute();
        }
        await this.record(trx, principal, 'warehouse.created', 'warehouse', row.id, correlationId, { ...input });
        return row.id;
      } catch (error) {
        if (isUniqueViolation(error, 'warehouses_tenant_id_code_key')) {
          throw conflict(`Warehouse ${input.code} already exists`);
        }
        throw error;
      }
    });
    const warehouse = (await this.warehouses(principal)).find((row) => row.id === id);
    if (!warehouse) throw notFound();
    return warehouse;
  }

  async updateWarehouse(principal: TenantPrincipal, warehouseId: string, input: UpdateWarehouseRequest, correlationId: string): Promise<Warehouse> {
    await this.run(principal, async (trx) => {
      const current = await trx
        .selectFrom('warehouses')
        .selectAll()
        .where('tenant_id', '=', principal.tenantId)
        .where('id', '=', warehouseId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw notFound();
      if (current.version !== input.version) throw versionConflict();
      await this.assertAccount(trx, principal.tenantId, input.inventoryAccountId, ['asset'], 'inventoryAccountId');
      if (input.status === 'inactive' && current.status === 'active') {
        const defaultFor = await trx
          .selectFrom('branches')
          .select('code')
          .where('tenant_id', '=', principal.tenantId)
          .where('default_warehouse_id', '=', warehouseId)
          .executeTakeFirst();
        if (defaultFor) throw conflict(`Warehouse ${current.code} is the default warehouse of branch ${defaultFor.code}`);
        const item = await trx
          .selectFrom('items')
          .select('code')
          .where('tenant_id', '=', principal.tenantId)
          .where('default_warehouse_id', '=', warehouseId)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (item) throw conflict(`Warehouse ${current.code} is the default warehouse of item ${item.code}`);
        const stocked = await trx
          .selectFrom('item_warehouse_stock')
          .select('item_id')
          .where('tenant_id', '=', principal.tenantId)
          .where('warehouse_id', '=', warehouseId)
          .where('on_hand', '>', '0')
          .executeTakeFirst();
        if (stocked) throw conflict(`Warehouse ${current.code} still holds stock and cannot be deactivated`);
      }
      await trx
        .updateTable('warehouses')
        .set({
          name: input.name,
          inventory_account_id: input.inventoryAccountId === undefined ? current.inventory_account_id : input.inventoryAccountId,
          status: input.status,
          version: current.version + 1,
          updated_at: new Date(),
        })
        .where('id', '=', warehouseId)
        .execute();
      await this.record(trx, principal, 'warehouse.updated', 'warehouse', warehouseId, correlationId, { name: input.name, status: input.status }, { name: current.name, status: current.status });
    });
    const warehouse = (await this.warehouses(principal)).find((row) => row.id === warehouseId);
    if (!warehouse) throw notFound();
    return warehouse;
  }

  async priceLists(principal: TenantPrincipal): Promise<PriceList[]> {
    const rows = await this.run(principal, (trx) =>
      trx.selectFrom('price_lists').selectAll().where('tenant_id', '=', principal.tenantId).orderBy('purpose', 'desc').orderBy('code').execute(),
    );
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      purpose: row.purpose,
      currency: row.currency,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      isDefault: row.is_default,
      status: row.status,
      version: row.version,
    }));
  }

  async createPriceList(principal: TenantPrincipal, input: CreatePriceListRequest, correlationId: string): Promise<PriceList> {
    this.assertValidity(input.validFrom, input.validTo);
    const id = await this.run(principal, async (trx) => {
      const tenant = await trx.selectFrom('tenants').select('base_currency').where('id', '=', principal.tenantId).executeTakeFirstOrThrow();
      try {
        const row = await trx
          .insertInto('price_lists')
          .values({
            tenant_id: principal.tenantId,
            code: input.code,
            name: input.name,
            purpose: input.purpose,
            currency: tenant.base_currency,
            valid_from: input.validFrom ?? null,
            valid_to: input.validTo ?? null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await this.record(trx, principal, 'price_list.created', 'price_list', row.id, correlationId, { ...input });
        return row.id;
      } catch (error) {
        if (isUniqueViolation(error, 'price_lists_tenant_id_code_key')) {
          throw conflict(`Price list ${input.code} already exists`);
        }
        throw error;
      }
    });
    const list = (await this.priceLists(principal)).find((row) => row.id === id);
    if (!list) throw notFound();
    return list;
  }

  async updatePriceList(principal: TenantPrincipal, listId: string, input: UpdatePriceListRequest, correlationId: string): Promise<PriceList> {
    this.assertValidity(input.validFrom, input.validTo);
    await this.run(principal, async (trx) => {
      const current = await trx
        .selectFrom('price_lists')
        .selectAll()
        .where('tenant_id', '=', principal.tenantId)
        .where('id', '=', listId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw notFound();
      if (current.version !== input.version) throw versionConflict();
      if (input.status === 'inactive' && current.is_default) {
        throw conflict('The default price list cannot be deactivated');
      }
      await trx
        .updateTable('price_lists')
        .set({
          name: input.name,
          valid_from: input.validFrom ?? null,
          valid_to: input.validTo ?? null,
          status: input.status,
          version: current.version + 1,
          updated_at: new Date(),
        })
        .where('id', '=', listId)
        .execute();
      await this.record(
        trx,
        principal,
        'price_list.updated',
        'price_list',
        listId,
        correlationId,
        { name: input.name, validFrom: input.validFrom ?? null, validTo: input.validTo ?? null, status: input.status },
        { name: current.name, validFrom: current.valid_from, validTo: current.valid_to, status: current.status },
      );
    });
    const list = (await this.priceLists(principal)).find((row) => row.id === listId);
    if (!list) throw notFound();
    return list;
  }

  private assertValidity(from?: string | null, to?: string | null): void {
    if (from && to && to < from) {
      throw fieldError('validTo', 'The end date must be on or after the start date');
    }
  }

  async priceListEntries(principal: TenantPrincipal, listId: string, search: string | undefined, limit: number, offset: number): Promise<Page<PriceListEntry>> {
    return this.run(principal, async (trx) => {
      const list = await trx.selectFrom('price_lists').select('id').where('tenant_id', '=', principal.tenantId).where('id', '=', listId).executeTakeFirst();
      if (!list) throw notFound();
      let base = trx
        .selectFrom('items as i')
        .innerJoin('units_of_measure as u', (join) => join.onRef('u.id', '=', 'i.uom_id').onRef('u.tenant_id', '=', 'i.tenant_id'))
        .leftJoin('item_prices as p', (join) =>
          join.onRef('p.item_id', '=', 'i.id').onRef('p.tenant_id', '=', 'i.tenant_id').on('p.price_list_id', '=', listId),
        )
        .where('i.tenant_id', '=', principal.tenantId);
      if (search) {
        const pattern = escapeLike(search);
        base = base.where((eb) => eb.or([eb('i.code', 'ilike', pattern), eb('i.name', 'ilike', pattern)]));
      }
      const total = await base.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
      const rows = await base
        .select(['i.id', 'i.code', 'i.name', 'u.code as uom_code', 'p.price'])
        .orderBy('i.code')
        .limit(limit)
        .offset(offset)
        .execute();
      return {
        items: rows.map((row) => ({ itemId: row.id, itemCode: row.code, itemName: row.name, uomCode: row.uom_code, price: row.price })),
        limit,
        offset,
        total: Number(total.count),
      };
    });
  }

  async setPrices(principal: TenantPrincipal, listId: string, input: SetPricesRequest, correlationId: string): Promise<void> {
    await this.run(principal, async (trx) => {
      const list = await trx
        .selectFrom('price_lists')
        .select(['id', 'status'])
        .where('tenant_id', '=', principal.tenantId)
        .where('id', '=', listId)
        .executeTakeFirst();
      if (!list) throw notFound();
      if (list.status !== 'active') throw conflict('Prices cannot be changed on an inactive price list');
      const itemIds = [...new Set(input.prices.map((row) => row.itemId))];
      const found = await trx.selectFrom('items').select('id').where('tenant_id', '=', principal.tenantId).where('id', 'in', itemIds).execute();
      if (found.length !== itemIds.length) throw fieldError('prices', 'One or more items were not found');
      await this.writePrices(trx, principal.tenantId, input.prices.map((row) => ({ priceListId: listId, itemId: row.itemId, price: row.price })));
      await this.record(trx, principal, 'price_list.prices_changed', 'price_list', listId, correlationId, { changed: input.prices.length });
    });
  }

  private async writePrices(trx: Trx, tenantId: string, rows: { priceListId: string; itemId: string; price: string | null }[]): Promise<void> {
    for (const row of rows) {
      if (row.price === null) {
        await trx
          .deleteFrom('item_prices')
          .where('tenant_id', '=', tenantId)
          .where('price_list_id', '=', row.priceListId)
          .where('item_id', '=', row.itemId)
          .execute();
      } else {
        await trx
          .insertInto('item_prices')
          .values({ tenant_id: tenantId, price_list_id: row.priceListId, item_id: row.itemId, price: row.price })
          .onConflict((oc) => oc.columns(['tenant_id', 'price_list_id', 'item_id']).doUpdateSet({ price: row.price as string, updated_at: new Date() }))
          .execute();
      }
    }
  }

  async items(principal: TenantPrincipal, query: ItemListQuery): Promise<Page<ItemSummary>> {
    return this.run(principal, async (trx) => {
      let base = trx
        .selectFrom('items as i')
        .innerJoin('item_groups as g', (join) => join.onRef('g.id', '=', 'i.group_id').onRef('g.tenant_id', '=', 'i.tenant_id'))
        .innerJoin('units_of_measure as u', (join) => join.onRef('u.id', '=', 'i.uom_id').onRef('u.tenant_id', '=', 'i.tenant_id'))
        .where('i.tenant_id', '=', principal.tenantId);
      if (query.search) {
        const pattern = escapeLike(query.search);
        base = base.where((eb) => eb.or([eb('i.code', 'ilike', pattern), eb('i.name', 'ilike', pattern), eb('i.barcode', 'ilike', pattern)]));
      }
      if (query.itemType) base = base.where('i.item_type', '=', query.itemType);
      if (query.groupId) base = base.where('i.group_id', '=', query.groupId);
      if (query.status) base = base.where('i.status', '=', query.status);
      const total = await base.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
      const rows = await base
        .select(['i.id', 'i.code', 'i.name', 'i.item_type', 'g.name as group_name', 'u.code as uom_code', 'i.status'])
        .orderBy('i.code')
        .limit(query.limit)
        .offset(query.offset)
        .execute();
      return {
        items: rows.map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          itemType: row.item_type,
          groupName: row.group_name,
          uomCode: row.uom_code,
          status: row.status,
        })),
        limit: query.limit,
        offset: query.offset,
        total: Number(total.count),
      };
    });
  }

  async item(principal: TenantPrincipal, itemId: string): Promise<Item> {
    return this.run(principal, async (trx) => {
      const item = await this.loadItem(trx, principal.tenantId, itemId);
      if (!item) throw notFound();
      return item;
    });
  }

  async createItem(principal: TenantPrincipal, input: CreateItemRequest, correlationId: string): Promise<Item> {
    return this.run(principal, async (trx) => {
      await this.validateItem(trx, principal.tenantId, input);
      let created: { id: string };
      try {
        created = await trx
          .insertInto('items')
          .values({ tenant_id: principal.tenantId, code: input.code, ...this.itemValues(input), created_by: principal.userId })
          .returning('id')
          .executeTakeFirstOrThrow();
      } catch (error) {
        this.mapItemConflict(error, input.code);
        throw error;
      }
      await this.writePrices(trx, principal.tenantId, input.prices.map((row) => ({ ...row, itemId: created.id })));
      const item = await this.loadItem(trx, principal.tenantId, created.id);
      if (!item) throw new Error('Created item could not be read back');
      await this.record(trx, principal, 'item.created', 'item', item.id, correlationId, this.auditItem(item));
      return item;
    });
  }

  async updateItem(principal: TenantPrincipal, itemId: string, input: UpdateItemRequest, correlationId: string): Promise<Item> {
    return this.run(principal, async (trx) => {
      const current = await trx
        .selectFrom('items')
        .select(['id', 'version', 'code', 'item_type', 'uom_id'])
        .where('tenant_id', '=', principal.tenantId)
        .where('id', '=', itemId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw notFound();
      if (current.version !== input.version) throw versionConflict();
      if ((current.item_type !== input.itemType || current.uom_id !== input.uomId) && (await this.stock.itemInUse(trx, principal.tenantId, itemId))) {
        throw conflict(`Item ${current.code} is used in documents; its item type and unit of measure can no longer change`);
      }
      const before = await this.loadItem(trx, principal.tenantId, itemId);
      await this.validateItem(trx, principal.tenantId, input);
      try {
        await trx
          .updateTable('items')
          .set({ ...this.itemValues(input), version: current.version + 1, updated_at: new Date() })
          .where('tenant_id', '=', principal.tenantId)
          .where('id', '=', itemId)
          .execute();
      } catch (error) {
        this.mapItemConflict(error, current.code);
        throw error;
      }
      const listed = new Set(input.prices.map((row) => row.priceListId));
      const removed = (before?.prices ?? []).filter((row) => !listed.has(row.priceListId)).map((row) => ({ priceListId: row.priceListId, itemId, price: null }));
      await this.writePrices(trx, principal.tenantId, [...input.prices.map((row) => ({ ...row, itemId })), ...removed]);
      const after = await this.loadItem(trx, principal.tenantId, itemId);
      if (!before || !after) throw new Error('Item could not be read back');
      await this.record(trx, principal, 'item.updated', 'item', itemId, correlationId, this.auditItem(after), this.auditItem(before));
      return after;
    });
  }

  private mapItemConflict(error: unknown, code: string): void {
    if (isUniqueViolation(error, 'items_tenant_id_code_key')) throw conflict(`Item ${code} already exists`);
    if (isUniqueViolation(error, 'items_barcode_key')) throw conflict('Another item already uses this barcode');
  }

  private auditItem(item: Item): Record<string, unknown> {
    return {
      code: item.code,
      name: item.name,
      itemType: item.itemType,
      groupId: item.groupId,
      uomId: item.uomId,
      status: item.status,
      defaultWarehouseId: item.defaultWarehouseId,
      reorderPoint: item.reorderPoint,
      prices: item.prices,
    };
  }

  private itemValues(input: ItemFields) {
    const stocked = input.itemType === 'inventory';
    return {
      name: input.name,
      foreign_name: input.foreignName ?? null,
      item_type: input.itemType,
      is_sales_item: input.isSalesItem,
      is_purchase_item: input.isPurchaseItem,
      group_id: input.groupId,
      uom_id: input.uomId,
      barcode: input.barcode ?? null,
      default_warehouse_id: stocked ? (input.defaultWarehouseId ?? null) : null,
      reorder_point: stocked ? (input.reorderPoint ?? null) : null,
      preferred_vendor_id: input.preferredVendorId ?? null,
      status: input.status,
      remarks: input.remarks ?? null,
    };
  }

  private async validateItem(trx: Trx, tenantId: string, input: ItemFields): Promise<void> {
    if (!input.isSalesItem && !input.isPurchaseItem) {
      throw fieldError('isSalesItem', 'An item must be a sales item, a purchase item or both');
    }
    if (input.itemType !== 'inventory' && (input.defaultWarehouseId || input.reorderPoint)) {
      throw fieldError('defaultWarehouseId', 'Only inventory items have a default warehouse or reorder point');
    }
    const group = await trx.selectFrom('item_groups').select('status').where('tenant_id', '=', tenantId).where('id', '=', input.groupId).executeTakeFirst();
    if (!group || group.status !== 'active') throw fieldError('groupId', 'Choose an active item group');
    const unit = await trx.selectFrom('units_of_measure').select(['status', 'decimals']).where('tenant_id', '=', tenantId).where('id', '=', input.uomId).executeTakeFirst();
    if (!unit || unit.status !== 'active') throw fieldError('uomId', 'Choose an active unit of measure');
    if (input.reorderPoint) {
      const decimals = input.reorderPoint.split('.')[1]?.length ?? 0;
      if (decimals > unit.decimals) throw fieldError('reorderPoint', `This unit allows ${unit.decimals} decimal places`);
    }
    if (input.defaultWarehouseId) {
      const warehouse = await trx.selectFrom('warehouses').select('status').where('tenant_id', '=', tenantId).where('id', '=', input.defaultWarehouseId).executeTakeFirst();
      if (!warehouse || warehouse.status !== 'active') throw fieldError('defaultWarehouseId', 'Choose an active warehouse');
    }
    if (input.preferredVendorId) {
      const vendor = await trx
        .selectFrom('business_partners')
        .select(['partner_type', 'status'])
        .where('tenant_id', '=', tenantId)
        .where('id', '=', input.preferredVendorId)
        .executeTakeFirst();
      if (!vendor || vendor.partner_type !== 'supplier' || vendor.status !== 'active') {
        throw fieldError('preferredVendorId', 'Choose an active vendor');
      }
    }
    const listIds = [...new Set(input.prices.map((row) => row.priceListId))];
    if (listIds.length !== input.prices.length) throw fieldError('prices', 'Each price list can appear only once');
    if (listIds.length > 0) {
      const lists = await trx.selectFrom('price_lists').select(['id', 'status']).where('tenant_id', '=', tenantId).where('id', 'in', listIds).execute();
      if (lists.length !== listIds.length || lists.some((list) => list.status !== 'active')) {
        throw fieldError('prices', 'Prices can only be set on active price lists of this company');
      }
    }
  }

  private async loadItem(trx: Trx, tenantId: string, itemId: string): Promise<Item | null> {
    const row = await trx.selectFrom('items').selectAll().where('tenant_id', '=', tenantId).where('id', '=', itemId).executeTakeFirst();
    if (!row) return null;
    const prices = await trx
      .selectFrom('item_prices')
      .select(['price_list_id', 'price'])
      .where('tenant_id', '=', tenantId)
      .where('item_id', '=', itemId)
      .orderBy('price_list_id')
      .execute();
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      foreignName: row.foreign_name,
      itemType: row.item_type,
      isSalesItem: row.is_sales_item,
      isPurchaseItem: row.is_purchase_item,
      groupId: row.group_id,
      uomId: row.uom_id,
      barcode: row.barcode,
      defaultWarehouseId: row.default_warehouse_id,
      reorderPoint: row.reorder_point,
      preferredVendorId: row.preferred_vendor_id,
      status: row.status,
      remarks: row.remarks,
      version: row.version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      prices: prices.map((price) => ({ priceListId: price.price_list_id, price: price.price })),
    };
  }
}
