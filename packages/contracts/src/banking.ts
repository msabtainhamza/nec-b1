import { z } from 'zod';
import { moneyAmount } from './business-partners.js';

const isoDate = z.iso.date();
const idempotencyKey = z.string().trim().min(8).max(100);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

export const PAYMENT_MEANS = ['cash', 'bank_transfer', 'cheque'] as const;
export type PaymentMeans = (typeof PAYMENT_MEANS)[number];

export const PAYMENT_DIRECTIONS = ['outgoing', 'incoming'] as const;
export type PaymentDirection = (typeof PAYMENT_DIRECTIONS)[number];

export const paymentAllocationInput = z
  .object({
    invoiceId: z.uuid().optional(),
    openingLineId: z.uuid().optional(),
    amount: moneyAmount,
  })
  .refine((allocation) => Boolean(allocation.invoiceId) !== Boolean(allocation.openingLineId), {
    message: 'Choose either an A/P invoice or an opening balance line',
    path: ['invoiceId'],
  });

export const incomingAllocationInput = z
  .object({
    arInvoiceId: z.uuid().optional(),
    openingLineId: z.uuid().optional(),
    amount: moneyAmount,
  })
  .refine((allocation) => Boolean(allocation.arInvoiceId) !== Boolean(allocation.openingLineId), {
    message: 'Choose either an A/R invoice or an opening balance line',
    path: ['arInvoiceId'],
  });

export const PAYABLE_DOCUMENT_TYPES = ['ap_invoice', 'ar_invoice', 'opening_balance'] as const;
export type PayableDocumentType = (typeof PAYABLE_DOCUMENT_TYPES)[number];

const paymentFields = {
  idempotencyKey,
  postingDate: isoDate,
  documentDate: isoDate.optional(),
  paymentMeans: z.enum(PAYMENT_MEANS),
  accountId: z.uuid().optional(),
  amount: moneyAmount,
  reference: optionalText(60),
  remarks: optionalText(500),
  seriesId: z.uuid().optional(),
};

export const createOutgoingPaymentRequest = z.object({
  ...paymentFields,
  vendorId: z.uuid(),
  allocations: z.array(paymentAllocationInput).max(500).default([]),
});
export type CreateOutgoingPaymentRequest = z.infer<typeof createOutgoingPaymentRequest>;

export const createIncomingPaymentRequest = z.object({
  ...paymentFields,
  customerId: z.uuid(),
  allocations: z.array(incomingAllocationInput).max(500).default([]),
});
export type CreateIncomingPaymentRequest = z.infer<typeof createIncomingPaymentRequest>;

export const allocatePaymentRequest = z.object({
  idempotencyKey,
  allocationDate: isoDate,
  allocations: z.array(paymentAllocationInput).min(1).max(500),
});
export type AllocatePaymentRequest = z.infer<typeof allocatePaymentRequest>;

export const allocateIncomingPaymentRequest = z.object({
  idempotencyKey,
  allocationDate: isoDate,
  allocations: z.array(incomingAllocationInput).min(1).max(500),
});
export type AllocateIncomingPaymentRequest = z.infer<typeof allocateIncomingPaymentRequest>;

export const unallocatePaymentRequest = z.object({
  idempotencyKey,
  unallocationDate: isoDate,
  reason: z.string().trim().min(1).max(500),
});
export type UnallocatePaymentRequest = z.infer<typeof unallocatePaymentRequest>;

export const cancelOutgoingPaymentRequest = z.object({
  idempotencyKey,
  postingDate: isoDate,
  reason: z.string().trim().min(1).max(500),
});
export type CancelOutgoingPaymentRequest = z.infer<typeof cancelOutgoingPaymentRequest>;
export const cancelPaymentRequest = cancelOutgoingPaymentRequest;
export type CancelPaymentRequest = CancelOutgoingPaymentRequest;

export interface PaymentAllocation {
  id: string;
  documentType: PayableDocumentType;
  invoiceId: string | null;
  openingLineId: string | null;
  invoiceNumber: string;
  reference: string | null;
  vendorReference: string | null;
  amount: string;
  allocationDate: string;
  active: boolean;
  unallocationId: string | null;
  unallocationDate: string | null;
  unallocationReason: string | null;
}

export interface Payment {
  id: string;
  direction: PaymentDirection;
  documentNumber: string;
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  branchCode: string;
  postingDate: string;
  documentDate: string;
  paymentMeans: PaymentMeans;
  accountId: string;
  accountCode: string;
  accountName: string;
  reference: string | null;
  remarks: string | null;
  currency: string;
  amount: string;
  allocatedAmount: string;
  unappliedAmount: string;
  status: 'posted' | 'cancelled';
  isCancellation: boolean;
  cancellationOfId: string | null;
  cancelledById: string | null;
  cancellationReason: string | null;
  journalId: string;
  journalNumber: string;
  postedAt: string;
  allocations: PaymentAllocation[];
}

export interface OutgoingPayment extends Payment {
  vendorId: string;
  vendorCode: string;
  vendorName: string;
}

export interface IncomingPayment extends Payment {
  customerId: string;
  customerCode: string;
  customerName: string;
}

export interface PaymentSummary {
  id: string;
  documentNumber: string;
  partnerName: string;
  postingDate: string;
  paymentMeans: PaymentMeans;
  reference: string | null;
  amount: string;
  unappliedAmount: string;
  status: 'posted' | 'cancelled';
  isCancellation: boolean;
}

export interface OutgoingPaymentSummary extends PaymentSummary {
  vendorName: string;
}

export interface IncomingPaymentSummary extends PaymentSummary {
  customerName: string;
}

const listFields = {
  search: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

export const outgoingPaymentListQuery = z.object({ ...listFields, vendorId: z.uuid().optional() });
export type OutgoingPaymentListQuery = z.infer<typeof outgoingPaymentListQuery>;

export const incomingPaymentListQuery = z.object({ ...listFields, customerId: z.uuid().optional() });
export type IncomingPaymentListQuery = z.infer<typeof incomingPaymentListQuery>;

export interface OpenPayableInvoice {
  documentType: PayableDocumentType;
  invoiceId: string | null;
  openingLineId: string | null;
  documentNumber: string;
  vendorReference: string | null;
  postingDate: string;
  dueDate: string;
  total: string;
  paidAmount: string;
  openAmount: string;
}

export type OpenPaymentItem = OpenPayableInvoice;
