import { z } from 'zod';
import { moneyAmount } from './business-partners.js';

const code = (max: number) => z.string().trim().regex(new RegExp(`^[A-Za-z0-9][A-Za-z0-9_-]{0,${max - 1}}$`), `Use letters, digits, dash or underscore (max ${max})`);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();
const quantity = z.string().trim().regex(/^\d{1,15}(\.\d{1,4})?$/, 'Enter a quantity with up to 4 decimal places');
const isoDate = z.iso.date();

export const ITEM_TYPES = ['inventory', 'non_inventory', 'service'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export interface UnitOfMeasure {
  id: string;
  code: string;
  name: string;
  decimals: number;
  status: 'active' | 'inactive';
}

export const createUnitRequest = z.object({
  code: code(10),
  name: z.string().trim().min(1).max(60),
  decimals: z.number().int().min(0).max(4).default(0),
});
export type CreateUnitRequest = z.infer<typeof createUnitRequest>;

export interface ItemGroup {
  id: string;
  code: string;
  name: string;
  inventoryAccountId: string | null;
  cogsAccountId: string | null;
  revenueAccountId: string | null;
  status: 'active' | 'inactive';
  version: number;
}

export const createItemGroupRequest = z.object({
  code: code(20),
  name: z.string().trim().min(1).max(120),
  inventoryAccountId: z.uuid().nullable().optional(),
  cogsAccountId: z.uuid().nullable().optional(),
  revenueAccountId: z.uuid().nullable().optional(),
});
export type CreateItemGroupRequest = z.infer<typeof createItemGroupRequest>;

export interface Warehouse {
  id: string;
  code: string;
  name: string;
  branchId: string;
  branchCode: string;
  inventoryAccountId: string | null;
  status: 'active' | 'inactive';
  isBranchDefault: boolean;
  version: number;
}

export const createWarehouseRequest = z.object({
  code: code(20),
  name: z.string().trim().min(1).max(120),
  branchId: z.uuid(),
  inventoryAccountId: z.uuid().nullable().optional(),
});
export type CreateWarehouseRequest = z.infer<typeof createWarehouseRequest>;

export const updateWarehouseRequest = z.object({
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  inventoryAccountId: z.uuid().nullable().optional(),
  status: z.enum(['active', 'inactive']),
});
export type UpdateWarehouseRequest = z.infer<typeof updateWarehouseRequest>;

export interface PriceList {
  id: string;
  code: string;
  name: string;
  purpose: 'sales' | 'purchase';
  currency: string;
  validFrom: string | null;
  validTo: string | null;
  isDefault: boolean;
  status: 'active' | 'inactive';
  version: number;
}

export const createPriceListRequest = z.object({
  code: code(20),
  name: z.string().trim().min(1).max(120),
  purpose: z.enum(['sales', 'purchase']),
  validFrom: isoDate.nullable().optional(),
  validTo: isoDate.nullable().optional(),
});
export type CreatePriceListRequest = z.infer<typeof createPriceListRequest>;

export const updatePriceListRequest = z.object({
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  validFrom: isoDate.nullable().optional(),
  validTo: isoDate.nullable().optional(),
  status: z.enum(['active', 'inactive']),
});
export type UpdatePriceListRequest = z.infer<typeof updatePriceListRequest>;

export const setPricesRequest = z.object({
  prices: z
    .array(z.object({ itemId: z.uuid(), price: moneyAmount.nullable() }))
    .min(1)
    .max(500),
});
export type SetPricesRequest = z.infer<typeof setPricesRequest>;

export interface PriceListEntry {
  itemId: string;
  itemCode: string;
  itemName: string;
  uomCode: string;
  price: string | null;
}

const itemFields = {
  name: z.string().trim().min(1).max(200),
  foreignName: optionalText(200),
  itemType: z.enum(ITEM_TYPES),
  isSalesItem: z.boolean().default(true),
  isPurchaseItem: z.boolean().default(true),
  groupId: z.uuid(),
  uomId: z.uuid(),
  barcode: optionalText(60),
  defaultWarehouseId: z.uuid().nullable().optional(),
  reorderPoint: quantity.nullable().optional(),
  preferredVendorId: z.uuid().nullable().optional(),
  status: z.enum(['active', 'inactive']).default('active'),
  remarks: optionalText(2000),
  prices: z
    .array(z.object({ priceListId: z.uuid(), price: moneyAmount.nullable() }))
    .max(50)
    .default([]),
};

export const createItemRequest = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$/, 'Use letters, digits, dot, slash, dash or underscore (max 40)'),
  ...itemFields,
});
export type CreateItemRequest = z.infer<typeof createItemRequest>;

export const updateItemRequest = z.object({
  version: z.number().int().positive(),
  ...itemFields,
});
export type UpdateItemRequest = z.infer<typeof updateItemRequest>;

export const itemListQuery = z.object({
  search: z.string().trim().max(100).optional(),
  itemType: z.enum(ITEM_TYPES).optional(),
  groupId: z.uuid().optional(),
  status: z.enum(['active', 'inactive']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ItemListQuery = z.infer<typeof itemListQuery>;

export interface ItemSummary {
  id: string;
  code: string;
  name: string;
  itemType: ItemType;
  groupName: string;
  uomCode: string;
  status: 'active' | 'inactive';
}

export interface Item {
  id: string;
  code: string;
  name: string;
  foreignName: string | null;
  itemType: ItemType;
  isSalesItem: boolean;
  isPurchaseItem: boolean;
  groupId: string;
  uomId: string;
  barcode: string | null;
  defaultWarehouseId: string | null;
  reorderPoint: string | null;
  preferredVendorId: string | null;
  status: 'active' | 'inactive';
  remarks: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  prices: { priceListId: string; price: string }[];
}

export const inventoryStatusQuery = z.object({
  warehouseId: z.uuid().optional(),
  itemGroupId: z.uuid().optional(),
  search: z.string().trim().max(100).optional(),
  belowReorderPoint: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
export type InventoryStatusQuery = z.infer<typeof inventoryStatusQuery>;

export interface InventoryStatusWarehouse {
  warehouseId: string;
  warehouseCode: string;
  onHand: string;
  committed: string;
  ordered: string;
  available: string;
}

export interface InventoryStatusItem {
  itemId: string;
  itemCode: string;
  itemName: string;
  itemGroupCode: string;
  uomCode: string;
  reorderPoint: string | null;
  onHand: string;
  committed: string;
  ordered: string;
  available: string;
  belowReorderPoint: boolean;
  warehouses: InventoryStatusWarehouse[];
}

export interface InventoryStatusReport {
  tenantName: string;
  generatedAt: string;
  items: InventoryStatusItem[];
}

export const inventoryValuationQuery = z.object({
  asOf: isoDate,
  warehouseId: z.uuid().optional(),
  itemGroupId: z.uuid().optional(),
});
export type InventoryValuationQuery = z.infer<typeof inventoryValuationQuery>;

export interface InventoryValuationRow {
  itemId: string;
  itemCode: string;
  itemName: string;
  warehouseCode: string;
  accountCode: string;
  quantity: string;
  value: string;
  averageCost: string;
}

export interface InventoryValuationAccount {
  accountId: string;
  accountCode: string;
  accountName: string;
  stockValue: string;
  ledgerBalance: string;
  difference: string;
}

export interface InventoryValuationReport {
  tenantName: string;
  currency: string;
  asOf: string;
  generatedAt: string;
  filtered: boolean;
  rows: InventoryValuationRow[];
  totalQuantity: string;
  totalValue: string;
  accounts: InventoryValuationAccount[];
}
