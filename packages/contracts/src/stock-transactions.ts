import { z } from 'zod';
import { moneyAmount } from './business-partners.js';

const isoDate = z.iso.date();
const idempotencyKey = z.string().trim().min(8).max(100);
const quantity = z.string().trim().regex(/^\d{1,15}(\.\d{1,4})?$/, 'Enter a quantity with up to 4 decimal places');
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();
const reason = z.string().trim().min(1).max(500);

export const ADJUSTMENT_DIRECTIONS = ['receipt', 'issue'] as const;
export type AdjustmentDirection = (typeof ADJUSTMENT_DIRECTIONS)[number];
export type InventoryDocumentDirection = AdjustmentDirection | 'opening';

export const createStockTransferRequest = z.object({
  idempotencyKey,
  fromWarehouseId: z.uuid(),
  toWarehouseId: z.uuid(),
  postingDate: isoDate,
  reason,
  remarks: optionalText(500),
  seriesId: z.uuid().optional(),
  lines: z
    .array(z.object({ itemId: z.uuid(), quantity }))
    .min(1)
    .max(500),
});
export type CreateStockTransferRequest = z.infer<typeof createStockTransferRequest>;

export const createInventoryAdjustmentRequest = z.object({
  idempotencyKey,
  direction: z.enum(ADJUSTMENT_DIRECTIONS),
  postingDate: isoDate,
  offsetAccountId: z.uuid().optional(),
  reason,
  remarks: optionalText(500),
  seriesId: z.uuid().optional(),
  lines: z
    .array(
      z.object({
        itemId: z.uuid(),
        warehouseId: z.uuid(),
        quantity,
        unitCost: moneyAmount.optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type CreateInventoryAdjustmentRequest = z.infer<typeof createInventoryAdjustmentRequest>;

export const createInventoryOpeningBalanceRequest = z.object({
  idempotencyKey,
  postingDate: isoDate,
  offsetAccountId: z.uuid().optional(),
  reason,
  remarks: optionalText(500),
  seriesId: z.uuid().optional(),
  lines: z
    .array(
      z.object({
        itemId: z.uuid(),
        warehouseId: z.uuid(),
        quantity,
        unitCost: moneyAmount,
      }),
    )
    .min(1)
    .max(500),
});
export type CreateInventoryOpeningBalanceRequest = z.infer<typeof createInventoryOpeningBalanceRequest>;

export const cancelStockDocumentRequest = z.object({
  idempotencyKey,
  postingDate: isoDate,
  reason,
});
export type CancelStockDocumentRequest = z.infer<typeof cancelStockDocumentRequest>;

export const stockDocumentListQuery = z.object({
  search: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type StockDocumentListQuery = z.infer<typeof stockDocumentListQuery>;

export const adjustmentListQuery = stockDocumentListQuery.extend({ direction: z.enum(ADJUSTMENT_DIRECTIONS).optional() });
export type AdjustmentListQuery = z.infer<typeof adjustmentListQuery>;

export interface StockDocumentHeader {
  id: string;
  documentNumber: string;
  postingDate: string;
  reason: string;
  remarks: string | null;
  totalValue: string;
  status: 'posted' | 'cancelled';
  isCancellation: boolean;
  cancellationOfId: string | null;
  cancelledById: string | null;
  cancellationReason: string | null;
  journalId: string | null;
  journalNumber: string | null;
  postedAt: string;
}

export interface StockTransferLine {
  id: string;
  lineNo: number;
  itemId: string;
  itemCode: string;
  itemName: string;
  uomCode: string;
  quantity: string;
  value: string;
}

export interface StockTransfer extends StockDocumentHeader {
  fromWarehouseId: string;
  fromWarehouseCode: string;
  toWarehouseId: string;
  toWarehouseCode: string;
  lines: StockTransferLine[];
}

export interface InventoryAdjustmentLine {
  id: string;
  lineNo: number;
  itemId: string;
  itemCode: string;
  itemName: string;
  uomCode: string;
  warehouseId: string;
  warehouseCode: string;
  inventoryAccountCode: string;
  quantity: string;
  unitCost: string;
  value: string;
}

export interface InventoryAdjustment extends StockDocumentHeader {
  direction: InventoryDocumentDirection;
  offsetAccountId: string;
  offsetAccountCode: string;
  offsetAccountName: string;
  lines: InventoryAdjustmentLine[];
}

export interface StockDocumentSummary {
  id: string;
  documentNumber: string;
  postingDate: string;
  description: string;
  reason: string;
  totalValue: string;
  status: 'posted' | 'cancelled';
  isCancellation: boolean;
}

export interface AdjustmentPreview {
  adjustment: InventoryAdjustment;
  journalLines: { accountCode: string; accountName: string; debit: string; credit: string }[];
  valuations: { itemCode: string; onHandBefore: string; onHandAfter: string; valueBefore: string; valueAfter: string; averageCostAfter: string }[];
}
