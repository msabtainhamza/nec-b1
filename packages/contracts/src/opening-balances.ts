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
const reason = z.string().trim().min(1).max(500);

export const OPENING_BALANCE_KINDS = ['account', 'partner'] as const;
export type OpeningBalanceKind = (typeof OPENING_BALANCE_KINDS)[number];

const header = {
  idempotencyKey,
  postingDate: isoDate,
  offsetAccountId: z.uuid().optional(),
  reason,
  remarks: optionalText(500),
  seriesId: z.uuid().optional(),
};

export const createAccountOpeningBalanceRequest = z.object({
  ...header,
  lines: z
    .array(
      z.object({
        accountId: z.uuid(),
        debit: moneyAmount.default('0'),
        credit: moneyAmount.default('0'),
      }),
    )
    .min(1)
    .max(500),
});
export type CreateAccountOpeningBalanceRequest = z.infer<typeof createAccountOpeningBalanceRequest>;

export const createPartnerOpeningBalanceRequest = z.object({
  ...header,
  lines: z
    .array(
      z.object({
        partnerId: z.uuid(),
        reference: optionalText(60),
        documentDate: isoDate.optional(),
        dueDate: isoDate.optional(),
        debit: moneyAmount.default('0'),
        credit: moneyAmount.default('0'),
      }),
    )
    .min(1)
    .max(500),
});
export type CreatePartnerOpeningBalanceRequest = z.infer<typeof createPartnerOpeningBalanceRequest>;

export const cancelOpeningBalanceRequest = z.object({
  idempotencyKey,
  postingDate: isoDate,
  reason,
});
export type CancelOpeningBalanceRequest = z.infer<typeof cancelOpeningBalanceRequest>;

export const openingBalanceListQuery = z.object({
  kind: z.enum(OPENING_BALANCE_KINDS).optional(),
  search: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type OpeningBalanceListQuery = z.infer<typeof openingBalanceListQuery>;

export interface OpeningBalanceLine {
  id: string;
  lineNo: number;
  accountId: string | null;
  accountCode: string;
  accountName: string;
  partnerId: string | null;
  partnerCode: string | null;
  partnerName: string | null;
  partnerType: 'customer' | 'supplier' | null;
  reference: string | null;
  documentDate: string | null;
  dueDate: string | null;
  debit: string;
  credit: string;
  paidAmount: string;
  openAmount: string;
}

export interface OpeningBalance {
  id: string;
  documentNumber: string;
  kind: OpeningBalanceKind;
  postingDate: string;
  offsetAccountId: string;
  offsetAccountCode: string;
  offsetAccountName: string;
  reason: string;
  remarks: string | null;
  totalDebit: string;
  totalCredit: string;
  offsetDebit: string;
  offsetCredit: string;
  status: 'posted' | 'cancelled';
  isCancellation: boolean;
  cancellationOfId: string | null;
  cancelledById: string | null;
  cancellationReason: string | null;
  journalId: string;
  journalNumber: string;
  postedAt: string;
  lines: OpeningBalanceLine[];
}

export interface OpeningBalanceSummary {
  id: string;
  documentNumber: string;
  kind: OpeningBalanceKind;
  postingDate: string;
  reason: string;
  totalDebit: string;
  totalCredit: string;
  status: 'posted' | 'cancelled';
  isCancellation: boolean;
}

export const OPENING_IMPORT_KINDS = ['account', 'partner', 'inventory'] as const;
export type OpeningImportKind = (typeof OPENING_IMPORT_KINDS)[number];

export const OPENING_IMPORT_MAX_ROWS = 2000;

export const OPENING_IMPORT_COLUMNS: Record<OpeningImportKind, { name: string; required: boolean }[]> = {
  account: [
    { name: 'AccountCode', required: true },
    { name: 'Debit', required: false },
    { name: 'Credit', required: false },
  ],
  partner: [
    { name: 'BPCode', required: true },
    { name: 'Reference', required: false },
    { name: 'DocumentDate', required: false },
    { name: 'DueDate', required: false },
    { name: 'Debit', required: false },
    { name: 'Credit', required: false },
  ],
  inventory: [
    { name: 'ItemCode', required: true },
    { name: 'WarehouseCode', required: true },
    { name: 'Quantity', required: true },
    { name: 'UnitCost', required: true },
  ],
};

export const OPENING_IMPORT_TEMPLATES: Record<OpeningImportKind, { fileName: string; content: string }> = {
  account: { fileName: 'gl-opening-balances.csv', content: 'AccountCode,Debit,Credit\r\n1100,1000.00,\r\n2300,,250.00\r\n' },
  partner: {
    fileName: 'bp-opening-balances.csv',
    content: 'BPCode,Reference,DocumentDate,DueDate,Debit,Credit\r\nV1000,LEG-100,2025-12-15,2026-01-14,,500.00\r\nC2000,INV-77,2025-12-20,,200.00,\r\n',
  },
  inventory: { fileName: 'inventory-opening-balances.csv', content: 'ItemCode,WarehouseCode,Quantity,UnitCost\r\nA-100,WH01,25,4.20\r\n' },
};

const importHeader = {
  idempotencyKey,
  mode: z.enum(['validate', 'commit']),
  fileName: z.string().trim().max(200).optional(),
  csv: z.string().min(1).max(2_000_000),
  postingDate: isoDate,
  offsetAccountId: z.uuid().optional(),
  reason,
  remarks: optionalText(500),
};

export const openingBalanceImportRequest = z.object({ ...importHeader, kind: z.enum(['account', 'partner']) });
export type OpeningBalanceImportRequest = z.infer<typeof openingBalanceImportRequest>;

export const inventoryOpeningImportRequest = z.object(importHeader);
export type InventoryOpeningImportRequest = z.infer<typeof inventoryOpeningImportRequest>;

export interface ImportRowError {
  row: number | null;
  column: string | null;
  message: string;
}

export interface OpeningImportResult {
  kind: OpeningImportKind;
  mode: 'validate' | 'commit';
  valid: boolean;
  committed: boolean;
  replayed: boolean;
  rowCount: number;
  errors: ImportRowError[];
  totalDebit: string;
  totalCredit: string;
  documentId: string | null;
  documentNumber: string | null;
  journalNumber: string | null;
}
