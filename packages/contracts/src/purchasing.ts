import { z } from 'zod';
import { moneyAmount } from './business-partners.js';

const isoDate = z.iso.date();
const idempotencyKey = z.string().trim().min(8).max(100);
export const quantityAmount = z.string().trim().regex(/^\d{1,15}(\.\d{1,4})?$/, 'Enter a quantity with up to 4 decimal places');
const discount = z.string().trim().regex(/^(100(\.0{1,4})?|\d{1,2}(\.\d{1,4})?)$/, 'Enter a discount between 0 and 100');
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

export const purchaseOrderLineInput = z.object({
  itemId: z.uuid(),
  description: optionalText(200),
  quantity: quantityAmount,
  unitPrice: moneyAmount,
  discountPercent: discount.default('0'),
  warehouseId: z.uuid().nullable().optional(),
});

export const createPurchaseOrderRequest = z.object({
  idempotencyKey,
  vendorId: z.uuid(),
  branchId: z.uuid().optional(),
  postingDate: isoDate,
  deliveryDate: isoDate,
  vendorReference: optionalText(60),
  remarks: optionalText(500),
  seriesId: z.uuid().optional(),
  lines: z.array(purchaseOrderLineInput).min(1).max(500),
});
export type CreatePurchaseOrderRequest = z.infer<typeof createPurchaseOrderRequest>;

export const changeOrderStatusRequest = z.object({
  status: z.enum(['closed', 'cancelled']),
  version: z.number().int().positive(),
});
export type ChangeOrderStatusRequest = z.infer<typeof changeOrderStatusRequest>;

export interface PurchaseOrderLine {
  id: string;
  lineNo: number;
  itemId: string;
  itemCode: string;
  itemType: 'inventory' | 'non_inventory' | 'service';
  description: string;
  uomCode: string;
  warehouseId: string | null;
  warehouseCode: string | null;
  quantity: string;
  receivedQuantity: string;
  openQuantity: string;
  unitPrice: string;
  discountPercent: string;
  netPrice: string;
  lineTotal: string;
}

export interface PurchaseOrder {
  id: string;
  documentNumber: string;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  branchId: string;
  branchCode: string;
  postingDate: string;
  deliveryDate: string;
  vendorReference: string | null;
  remarks: string | null;
  currency: string;
  total: string;
  status: 'open' | 'closed' | 'cancelled';
  closedReason: 'fully_received' | 'manual' | null;
  version: number;
  createdAt: string;
  lines: PurchaseOrderLine[];
  receipts: { id: string; documentNumber: string; postingDate: string; status: string; isCancellation: boolean }[];
}

export interface PurchaseOrderSummary {
  id: string;
  documentNumber: string;
  vendorCode: string;
  vendorName: string;
  postingDate: string;
  deliveryDate: string;
  total: string;
  status: 'open' | 'closed' | 'cancelled';
}

export const purchaseOrderListQuery = z.object({
  search: z.string().trim().max(60).optional(),
  status: z.enum(['open', 'closed', 'cancelled']).optional(),
  vendorId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PurchaseOrderListQuery = z.infer<typeof purchaseOrderListQuery>;

export const createGoodsReceiptRequest = z.object({
  idempotencyKey,
  orderId: z.uuid(),
  postingDate: isoDate,
  remarks: optionalText(500),
  seriesId: z.uuid().optional(),
  lines: z
    .array(
      z.object({
        orderLineId: z.uuid(),
        quantity: quantityAmount,
        warehouseId: z.uuid().nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type CreateGoodsReceiptRequest = z.infer<typeof createGoodsReceiptRequest>;

export const cancelGoodsReceiptRequest = z.object({
  idempotencyKey,
  postingDate: isoDate,
  reason: z.string().trim().min(1).max(500),
});
export type CancelGoodsReceiptRequest = z.infer<typeof cancelGoodsReceiptRequest>;

export interface GoodsReceiptLine {
  id: string;
  lineNo: number;
  orderLineId: string;
  itemId: string;
  itemCode: string;
  description: string;
  uomCode: string;
  warehouseId: string | null;
  warehouseCode: string | null;
  quantity: string;
  netPrice: string;
  lineTotal: string;
}

export interface GoodsReceipt {
  id: string;
  documentNumber: string;
  orderId: string;
  orderNumber: string;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  branchCode: string;
  postingDate: string;
  remarks: string | null;
  currency: string;
  total: string;
  status: 'posted' | 'cancelled';
  isCancellation: boolean;
  cancellationOfId: string | null;
  cancelledById: string | null;
  cancellationReason: string | null;
  journalId: string | null;
  journalNumber: string | null;
  postedAt: string;
  lines: GoodsReceiptLine[];
}

export interface GoodsReceiptSummary {
  id: string;
  documentNumber: string;
  orderNumber: string;
  vendorName: string;
  postingDate: string;
  total: string;
  status: 'posted' | 'cancelled';
  isCancellation: boolean;
}

export const goodsReceiptListQuery = z.object({
  search: z.string().trim().max(60).optional(),
  orderId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type GoodsReceiptListQuery = z.infer<typeof goodsReceiptListQuery>;

export interface ItemStock {
  itemId: string;
  onHand: string;
  onOrder: string;
  committed: string;
  available: string;
  averageCost: string;
  totalValue: string;
  warehouses: { warehouseId: string; warehouseCode: string; warehouseName: string; onHand: string; onOrder: string }[];
}

export interface StockMovement {
  id: string;
  postingDate: string;
  createdAt: string;
  itemCode: string;
  itemName: string;
  warehouseCode: string;
  sourceType: string;
  sourceNumber: string | null;
  quantity: string;
  value: string;
  unitCost: string;
}

export const stockMovementQuery = z.object({
  itemId: z.uuid().optional(),
  warehouseId: z.uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type StockMovementQuery = z.infer<typeof stockMovementQuery>;

const invoiceLine = z.preprocess(
  (value) => (value && typeof value === 'object' && !('kind' in value) ? { ...value, kind: 'receipt' } : value),
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('receipt'),
      receiptLineId: z.uuid(),
      quantity: quantityAmount,
      unitPrice: moneyAmount,
      taxCodeId: z.uuid().nullable().optional(),
    }),
    z.object({
      kind: z.literal('item'),
      itemId: z.uuid(),
      description: optionalText(200),
      quantity: quantityAmount,
      unitPrice: moneyAmount,
      warehouseId: z.uuid().nullable().optional(),
      taxCodeId: z.uuid().nullable().optional(),
    }),
    z.object({
      kind: z.literal('account'),
      accountId: z.uuid(),
      description: z.string().trim().min(1).max(200),
      amount: moneyAmount,
      taxCodeId: z.uuid().nullable().optional(),
    }),
  ]),
);

export const createApInvoiceRequest = z.object({
  idempotencyKey,
  documentType: z.enum(['item', 'service']).default('item'),
  vendorId: z.uuid(),
  postingDate: isoDate,
  documentDate: isoDate.optional(),
  dueDate: isoDate.optional(),
  vendorReference: optionalText(60),
  remarks: optionalText(500),
  seriesId: z.uuid().optional(),
  priceOverride: z.boolean().default(false),
  lines: z.array(invoiceLine).min(1).max(500),
});
export type CreateApInvoiceRequest = z.infer<typeof createApInvoiceRequest>;

export const cancelApInvoiceRequest = z.object({
  idempotencyKey,
  postingDate: isoDate,
  reason: z.string().trim().min(1).max(500),
});
export type CancelApInvoiceRequest = z.infer<typeof cancelApInvoiceRequest>;

export interface ApInvoiceLine {
  id: string;
  lineNo: number;
  lineKind: 'receipt' | 'item' | 'account';
  receiptId: string | null;
  receiptNumber: string | null;
  receiptLineId: string | null;
  itemId: string | null;
  itemCode: string | null;
  accountId: string | null;
  accountCode: string | null;
  description: string;
  uomCode: string | null;
  warehouseCode: string | null;
  stocked: boolean;
  quantity: string;
  receiptPrice: string | null;
  unitPrice: string;
  lineTotal: string;
  taxCode: string | null;
  taxRate: string;
  taxAmount: string;
  stockRevaluation: string;
  priceDifference: string;
}

export interface ApInvoice {
  id: string;
  documentNumber: string;
  documentType: 'item' | 'service';
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  branchCode: string;
  postingDate: string;
  documentDate: string;
  dueDate: string;
  vendorReference: string | null;
  remarks: string | null;
  currency: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  paidAmount: string;
  openAmount: string;
  status: 'posted' | 'cancelled';
  isCancellation: boolean;
  cancellationOfId: string | null;
  cancelledById: string | null;
  cancellationReason: string | null;
  priceOverride: boolean;
  journalId: string | null;
  journalNumber: string | null;
  postedAt: string;
  lines: ApInvoiceLine[];
}

export interface ApInvoiceSummary {
  id: string;
  documentNumber: string;
  vendorName: string;
  vendorReference: string | null;
  postingDate: string;
  dueDate: string;
  total: string;
  openAmount: string;
  status: 'posted' | 'cancelled';
  isCancellation: boolean;
}

export const apInvoiceListQuery = z.object({
  search: z.string().trim().max(60).optional(),
  vendorId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ApInvoiceListQuery = z.infer<typeof apInvoiceListQuery>;

export interface InvoiceableReceiptLine {
  receiptId: string;
  receiptNumber: string;
  receiptDate: string;
  orderNumber: string;
  receiptLineId: string;
  itemId: string;
  itemCode: string;
  description: string;
  uomCode: string;
  stocked: boolean;
  receivedQuantity: string;
  invoicedQuantity: string;
  openQuantity: string;
  receiptPrice: string;
}

export interface PurchasingSettings {
  priceTolerancePercent: string;
  version: number;
}

export const updatePurchasingSettingsRequest = z.object({
  priceTolerancePercent: discount,
  version: z.number().int().positive(),
});
export type UpdatePurchasingSettingsRequest = z.infer<typeof updatePurchasingSettingsRequest>;

export interface PartnerBalance {
  creditExposure?: { openOrders: string; uninvoicedDeliveries: string; total: string; creditLimit: string; remaining: string };
  partnerId: string;
  currency: string;
  balance: string;
  openInvoices: number;
}

export interface TaxCode {
  id: string;
  code: string;
  name: string;
  purpose: 'purchase' | 'sales' | 'both';
  status: 'active' | 'inactive';
  currentRate: string | null;
  rates: { validFrom: string; rate: string }[];
  version: number;
}

export const createTaxCodeRequest = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/),
  name: z.string().trim().min(1).max(120),
  purpose: z.enum(['purchase', 'sales', 'both']),
  rate: discount,
  validFrom: isoDate,
});
export type CreateTaxCodeRequest = z.infer<typeof createTaxCodeRequest>;

export const addTaxRateRequest = z.object({
  rate: discount,
  validFrom: isoDate,
});
export type AddTaxRateRequest = z.infer<typeof addTaxRateRequest>;
