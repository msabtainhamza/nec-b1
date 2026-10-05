import { z } from 'zod';
import { creditDecisionFields } from './credit.js';
import { moneyAmount } from './business-partners.js';
import { quantityAmount } from './purchasing.js';
import type { PostalAddress } from './company.js';

const isoDate = z.iso.date();
const idempotencyKey = z.string().trim().min(8).max(100);
const discount = z.string().trim().regex(/^(100(\.0{1,4})?|\d{1,2}(\.\d{1,4})?)$/, 'Enter a discount between 0 and 100');
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();
const reason = z.string().trim().min(1).max(500);
const listFields = {
  search: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

export const createSalesOrderRequest = z.object({
  ...creditDecisionFields,
  idempotencyKey,
  customerId: z.uuid(),
  branchId: z.uuid().optional(),
  postingDate: isoDate,
  deliveryDate: isoDate,
  customerReference: optionalText(60),
  remarks: optionalText(500),
  seriesId: z.uuid().optional(),
  priceListId: z.uuid().optional(),
  paymentTermsId: z.uuid().optional(),
  billToAddressId: z.uuid().optional(),
  shipToAddressId: z.uuid().optional(),
  lines: z
    .array(
      z.object({
        itemId: z.uuid(),
        description: optionalText(200),
        quantity: quantityAmount,
        unitPrice: moneyAmount.optional(),
        discountPercent: discount.default('0'),
        warehouseId: z.uuid().nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type CreateSalesOrderRequest = z.infer<typeof createSalesOrderRequest>;

export const changeSalesOrderStatusRequest = z.object({
  status: z.enum(['closed', 'cancelled']),
  version: z.number().int().positive(),
});
export type ChangeSalesOrderStatusRequest = z.infer<typeof changeSalesOrderStatusRequest>;

export interface SalesOrderLine {
  quotationLineId: string | null;
  id: string;
  lineNo: number;
  itemId: string;
  itemCode: string;
  itemType: 'inventory' | 'non_inventory' | 'service';
  stocked: boolean;
  description: string;
  uomCode: string;
  warehouseId: string | null;
  warehouseCode: string | null;
  quantity: string;
  deliveredQuantity: string;
  invoicedQuantity: string;
  openQuantity: string;
  unitPrice: string;
  discountPercent: string;
  netPrice: string;
  lineTotal: string;
}

export interface OrderAddress extends PostalAddress {
  addressName: string;
}

export interface OrderStockWarning {
  lineNo: number;
  itemCode: string;
  warehouseCode: string;
  openQuantity: string;
  available: string;
}

export interface SalesOrder {
  quotationId: string | null;
  quotationNumber: string | null;
  id: string;
  documentNumber: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  branchId: string;
  branchCode: string;
  postingDate: string;
  deliveryDate: string;
  customerReference: string | null;
  remarks: string | null;
  currency: string;
  total: string;
  status: 'open' | 'closed' | 'cancelled';
  closedReason: 'fulfilled' | 'manual' | null;
  version: number;
  createdAt: string;
  priceListId: string | null;
  priceListCode: string | null;
  paymentTermsId: string | null;
  paymentTermsCode: string | null;
  billTo: OrderAddress | null;
  shipTo: OrderAddress | null;
  stockWarnings: OrderStockWarning[];
  lines: SalesOrderLine[];
  deliveries: { id: string; documentNumber: string; postingDate: string; status: string; isCancellation: boolean }[];
}

export interface SalesOrderSummary {
  id: string;
  documentNumber: string;
  customerCode: string;
  customerName: string;
  postingDate: string;
  deliveryDate: string;
  total: string;
  status: 'open' | 'closed' | 'cancelled';
}

export const salesOrderListQuery = z.object({
  ...listFields,
  status: z.enum(['open', 'closed', 'cancelled']).optional(),
  customerId: z.uuid().optional(),
});
export type SalesOrderListQuery = z.infer<typeof salesOrderListQuery>;

export const createDeliveryRequest = z.object({
  ...creditDecisionFields,
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
export type CreateDeliveryRequest = z.infer<typeof createDeliveryRequest>;

export const cancelSalesDocumentRequest = z.object({
  idempotencyKey,
  postingDate: isoDate,
  reason,
});
export type CancelSalesDocumentRequest = z.infer<typeof cancelSalesDocumentRequest>;

export interface DeliveryLine {
  id: string;
  lineNo: number;
  orderLineId: string;
  itemId: string;
  itemCode: string;
  description: string;
  uomCode: string;
  warehouseId: string;
  warehouseCode: string;
  quantity: string;
  invoicedQuantity: string;
  netPrice: string;
  lineTotal: string;
  costValue: string;
}

export interface Delivery {
  id: string;
  documentNumber: string;
  orderId: string;
  orderNumber: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  branchCode: string;
  postingDate: string;
  remarks: string | null;
  currency: string;
  total: string;
  costTotal: string;
  status: 'posted' | 'cancelled';
  isCancellation: boolean;
  cancellationOfId: string | null;
  cancelledById: string | null;
  cancellationReason: string | null;
  journalId: string | null;
  journalNumber: string | null;
  postedAt: string;
  lines: DeliveryLine[];
}

export interface DeliverySummary {
  id: string;
  documentNumber: string;
  orderNumber: string;
  customerName: string;
  postingDate: string;
  total: string;
  status: 'posted' | 'cancelled';
  isCancellation: boolean;
}

export const deliveryListQuery = z.object({ ...listFields, orderId: z.uuid().optional() });
export type DeliveryListQuery = z.infer<typeof deliveryListQuery>;

const arInvoiceLine = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('delivery'),
    deliveryLineId: z.uuid(),
    quantity: quantityAmount,
    unitPrice: moneyAmount.optional(),
    taxCodeId: z.uuid().nullable().optional(),
  }),
  z.object({
    kind: z.literal('order'),
    orderLineId: z.uuid(),
    quantity: quantityAmount,
    unitPrice: moneyAmount.optional(),
    taxCodeId: z.uuid().nullable().optional(),
  }),
]);

export const createArInvoiceRequest = z.object({
  ...creditDecisionFields,
  idempotencyKey,
  customerId: z.uuid(),
  postingDate: isoDate,
  documentDate: isoDate.optional(),
  dueDate: isoDate.optional(),
  customerReference: optionalText(60),
  remarks: optionalText(500),
  seriesId: z.uuid().optional(),
  paymentTermsId: z.uuid().optional(),
  billToAddressId: z.uuid().optional(),
  priceOverride: z.boolean().default(false),
  lines: z.array(arInvoiceLine).min(1).max(500),
});
export type CreateArInvoiceRequest = z.infer<typeof createArInvoiceRequest>;

export interface ArInvoiceLine {
  id: string;
  lineNo: number;
  lineKind: 'delivery' | 'order';
  deliveryId: string | null;
  deliveryNumber: string | null;
  deliveryLineId: string | null;
  orderLineId: string;
  orderNumber: string;
  itemId: string;
  itemCode: string;
  description: string;
  uomCode: string;
  quantity: string;
  unitPrice: string;
  sourcePrice: string;
  lineTotal: string;
  revenueAccountCode: string;
  taxCode: string | null;
  taxRate: string;
  taxAmount: string;
}

export interface ArInvoice {
  id: string;
  documentNumber: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  branchCode: string;
  postingDate: string;
  documentDate: string;
  dueDate: string;
  customerReference: string | null;
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
  journalId: string | null;
  journalNumber: string | null;
  paymentTermsCode: string | null;
  priceOverride: boolean;
  postedAt: string;
  lines: ArInvoiceLine[];
}

export interface ArInvoiceSummary {
  id: string;
  documentNumber: string;
  customerName: string;
  customerReference: string | null;
  postingDate: string;
  dueDate: string;
  total: string;
  openAmount: string;
  status: 'posted' | 'cancelled';
  isCancellation: boolean;
}

export const arInvoiceListQuery = z.object({ ...listFields, customerId: z.uuid().optional() });
export type ArInvoiceListQuery = z.infer<typeof arInvoiceListQuery>;

export interface InvoiceableSalesLine {
  kind: 'delivery' | 'order';
  deliveryId: string | null;
  deliveryNumber: string | null;
  deliveryLineId: string | null;
  orderLineId: string;
  orderNumber: string;
  documentDate: string;
  itemId: string;
  itemCode: string;
  description: string;
  uomCode: string;
  quantity: string;
  invoicedQuantity: string;
  openQuantity: string;
  unitPrice: string;
}

export interface SalesSettings {
  priceTolerancePercent: string | null;
  version: number;
}

export const updateSalesSettingsRequest = z.object({
  priceTolerancePercent: discount.nullable(),
  version: z.number().int().min(0),
});
export type UpdateSalesSettingsRequest = z.infer<typeof updateSalesSettingsRequest>;

export interface InvoicePartySnapshot {
  name: string;
  code: string | null;
  taxNumber: string | null;
  phone: string | null;
  email: string | null;
  address: PostalAddress | null;
}

export interface InvoicePrintSnapshot {
  seller: InvoicePartySnapshot;
  buyer: InvoicePartySnapshot;
  footer: string | null;
}

export interface InvoiceTaxSummary {
  taxCode: string | null;
  taxRate: string;
  base: string;
  taxAmount: string;
}

export interface ArInvoiceDocument {
  invoice: ArInvoice;
  seller: InvoicePartySnapshot;
  buyer: InvoicePartySnapshot;
  footer: string | null;
  taxSummary: InvoiceTaxSummary[];
  cancellationOfNumber: string | null;
  cancelledByNumber: string | null;
  snapshotTaken: boolean;
  generatedAt: string;
}

export const salesPriceQuery = z.object({
  postingDate: isoDate,
  priceListId: z.uuid().optional(),
  itemIds: z
    .string()
    .transform((value) => value.split(',').map((id) => id.trim()).filter(Boolean))
    .pipe(z.array(z.uuid()).min(1).max(500)),
});
export type SalesPriceQuery = z.infer<typeof salesPriceQuery>;

export interface SalesPrices {
  priceList: { id: string; code: string; name: string } | null;
  prices: { itemId: string; price: string }[];
}
