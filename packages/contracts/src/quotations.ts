import { z } from 'zod';
import { creditDecisionFields } from './credit.js';
import { createSalesOrderRequest, salesOrderListQuery, type SalesOrder, type SalesOrderLine } from './sales.js';

export const createQuotationRequest = createSalesOrderRequest.omit({ deliveryDate: true, creditAcknowledged: true, creditOverrideReason: true, priceListId: true, paymentTermsId: true, billToAddressId: true, shipToAddressId: true }).extend({ validUntil: z.iso.date() });
export type CreateQuotationRequest = z.infer<typeof createQuotationRequest>;
export const updateQuotationRequest = createQuotationRequest.omit({ idempotencyKey: true, seriesId: true }).extend({ version: z.number().int().positive() });
export type UpdateQuotationRequest = z.infer<typeof updateQuotationRequest>;
export const quotationStatusRequest = z.object({ status: z.enum(['issued', 'closed', 'cancelled']), version: z.number().int().positive() });
export type QuotationStatusRequest = z.infer<typeof quotationStatusRequest>;
export const convertQuotationRequest = z.object({
  ...creditDecisionFields,
  idempotencyKey: createSalesOrderRequest.shape.idempotencyKey,
  version: z.number().int().positive(),
  postingDate: z.iso.date(),
  deliveryDate: z.iso.date(),
});
export type ConvertQuotationRequest = z.infer<typeof convertQuotationRequest>;
export const quotationListQuery = salesOrderListQuery.omit({ status: true }).extend({ status: z.enum(['draft', 'issued', 'expired', 'closed', 'cancelled']).optional() });
export type QuotationListQuery = z.infer<typeof quotationListQuery>;
export type QuotationLine = Omit<SalesOrderLine, 'quotationLineId' | 'deliveredQuantity' | 'invoicedQuantity' | 'openQuantity'>;
export interface SalesQuotation extends Omit<SalesOrder, 'quotationId' | 'quotationNumber' | 'deliveryDate' | 'status' | 'closedReason' | 'lines' | 'deliveries' | 'priceListId' | 'priceListCode' | 'paymentTermsId' | 'paymentTermsCode' | 'billTo' | 'shipTo' | 'stockWarnings'> {
  validUntil: string;
  status: 'draft' | 'issued' | 'expired' | 'closed' | 'cancelled';
  lines: QuotationLine[];
  orderId: string | null;
  orderNumber: string | null;
}
export type QuotationSummary = Pick<SalesQuotation, 'id' | 'documentNumber' | 'customerCode' | 'customerName' | 'postingDate' | 'validUntil' | 'total' | 'status'>;
