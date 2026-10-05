import { z } from 'zod';
import { moneyAmount } from './business-partners.js';

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

const isoDate = z.iso.date();
const idempotencyKey = z.string().trim().min(8).max(100);

export interface Account {
  id: string;
  code: string;
  name: string;
  accountType: AccountType;
  parentId: string | null;
  isTitle: boolean;
  controlKind: 'receivable' | 'payable' | null;
  status: 'active' | 'inactive';
  level: number;
  hasPostings: boolean;
  version: number;
}

export const createAccountRequest = z.object({
  code: z.string().trim().regex(/^[0-9A-Za-z][0-9A-Za-z._-]{0,19}$/),
  name: z.string().trim().min(1).max(120),
  accountType: z.enum(ACCOUNT_TYPES),
  parentId: z.uuid().nullable().optional(),
  isTitle: z.boolean().default(false),
  controlKind: z.enum(['receivable', 'payable']).nullable().optional(),
});
export type CreateAccountRequest = z.infer<typeof createAccountRequest>;

export const updateAccountRequest = z.object({
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  parentId: z.uuid().nullable().optional(),
  status: z.enum(['active', 'inactive']),
});
export type UpdateAccountRequest = z.infer<typeof updateAccountRequest>;

export const DETERMINATION_KEYS = {
  cash: { label: 'Cash', accountTypes: ['asset'] },
  bank: { label: 'Bank', accountTypes: ['asset'] },
  receivable_control: { label: 'Accounts Receivable (control)', accountTypes: ['asset'] },
  payable_control: { label: 'Accounts Payable (control)', accountTypes: ['liability'] },
  inventory: { label: 'Inventory', accountTypes: ['asset'] },
  goods_received_not_invoiced: { label: 'Goods Received Not Invoiced (allocation)', accountTypes: ['liability'] },
  cogs: { label: 'Cost of Goods Sold', accountTypes: ['expense'] },
  revenue: { label: 'Revenue', accountTypes: ['income'] },
  output_tax: { label: 'Output Tax', accountTypes: ['liability'] },
  input_tax: { label: 'Input Tax', accountTypes: ['asset'] },
  price_difference: { label: 'Price Difference', accountTypes: ['expense', 'income'] },
  inventory_adjustment: { label: 'Inventory Adjustment', accountTypes: ['expense', 'income'] },
  rounding: { label: 'Rounding', accountTypes: ['expense', 'income'] },
  opening_balance: { label: 'Opening Balance Offset', accountTypes: ['equity'] },
  purchase_expense: { label: 'Purchased Services and Supplies (expense)', accountTypes: ['expense'] },
} as const satisfies Record<string, { label: string; accountTypes: readonly AccountType[] }>;
export type DeterminationKey = keyof typeof DETERMINATION_KEYS;
const determinationKeys = Object.keys(DETERMINATION_KEYS) as [DeterminationKey, ...DeterminationKey[]];

export interface GlDetermination {
  key: DeterminationKey;
  label: string;
  accountId: string | null;
  accountCode: string | null;
  accountName: string | null;
}

export const updateDeterminationRequest = z.object({
  mappings: z.array(z.object({ key: z.enum(determinationKeys), accountId: z.uuid() })).min(1).max(50),
});
export type UpdateDeterminationRequest = z.infer<typeof updateDeterminationRequest>;

export interface PostingPeriod {
  id: string;
  fiscalYearCode: string;
  code: string;
  name: string;
  startDate: string;
  endDate: string;
  status: 'open' | 'closed';
  version: number;
}

export const createFiscalYearRequest = z.object({
  code: z.string().trim().regex(/^[0-9A-Za-z][0-9A-Za-z_-]{0,19}$/),
  startDate: isoDate,
});
export type CreateFiscalYearRequest = z.infer<typeof createFiscalYearRequest>;

export const changePeriodStatusRequest = z.object({
  status: z.enum(['open', 'closed']),
  version: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
});
export type ChangePeriodStatusRequest = z.infer<typeof changePeriodStatusRequest>;

export const DOCUMENT_TYPES = ['journal_entry', 'purchase_order', 'goods_receipt', 'ap_invoice', 'outgoing_payment', 'incoming_payment', 'sales_quotation', 'sales_order', 'delivery', 'ar_invoice', 'stock_transfer', 'stock_receipt', 'stock_issue', 'opening_balance', 'stock_opening'] as const;

export interface NumberingSeries {
  id: string;
  documentType: string;
  name: string;
  prefix: string;
  nextNumber: number;
  lastNumber: number | null;
  isDefault: boolean;
  status: 'active' | 'inactive';
  version: number;
}

export const createSeriesRequest = z.object({
  documentType: z.enum(DOCUMENT_TYPES),
  name: z.string().trim().min(1).max(40),
  prefix: z.string().trim().regex(/^[A-Za-z0-9/-]{0,10}$/).default(''),
  nextNumber: z.number().int().positive().default(1),
  lastNumber: z.number().int().positive().nullable().optional(),
  isDefault: z.boolean().default(false),
});
export type CreateSeriesRequest = z.infer<typeof createSeriesRequest>;

export const journalLineInput = z
  .object({
    accountId: z.uuid().nullable().optional(),
    partnerId: z.uuid().nullable().optional(),
    debit: moneyAmount.default('0'),
    credit: moneyAmount.default('0'),
    memo: z.string().trim().max(200).optional(),
  })
  .refine((line) => Boolean(line.accountId) !== Boolean(line.partnerId), {
    message: 'Choose either a G/L account or a business partner',
    path: ['accountId'],
  });

export const postJournalRequest = z.object({
  idempotencyKey,
  seriesId: z.uuid().optional(),
  postingDate: isoDate,
  documentDate: isoDate.optional(),
  dueDate: isoDate.optional(),
  memo: z.string().trim().max(200).optional(),
  reference: z.string().trim().max(60).optional(),
  lines: z.array(journalLineInput).min(2).max(500),
});
export type PostJournalRequest = z.infer<typeof postJournalRequest>;

export const reverseJournalRequest = z.object({
  idempotencyKey,
  postingDate: isoDate,
  reason: z.string().trim().min(1).max(500),
});
export type ReverseJournalRequest = z.infer<typeof reverseJournalRequest>;

export interface JournalLine {
  lineNo: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  partnerId: string | null;
  partnerCode: string | null;
  debit: string;
  credit: string;
  memo: string | null;
}

export interface JournalEntry {
  id: string;
  documentNumber: string;
  number: number;
  seriesName: string;
  sourceType: string;
  postingDate: string;
  documentDate: string;
  dueDate: string;
  periodCode: string;
  memo: string | null;
  reference: string | null;
  currency: string;
  totalDebit: string;
  totalCredit: string;
  reversalOfId: string | null;
  reversedById: string | null;
  reversalReason: string | null;
  postedAt: string;
  lines: JournalLine[];
}

export interface JournalSummary {
  id: string;
  documentNumber: string;
  sourceType: string;
  postingDate: string;
  memo: string | null;
  totalDebit: string;
  reversed: boolean;
}

export const journalListQuery = z.object({
  search: z.string().trim().max(60).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type JournalListQuery = z.infer<typeof journalListQuery>;

export const trialBalanceQuery = z.object({
  from: isoDate,
  to: isoDate,
});
export type TrialBalanceQuery = z.infer<typeof trialBalanceQuery>;

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  accountType: AccountType;
  openingBalance: string;
  debit: string;
  credit: string;
  closingBalance: string;
}

export interface TrialBalance {
  tenantName: string;
  currency: string;
  from: string;
  to: string;
  generatedAt: string;
  basis: string;
  rows: TrialBalanceRow[];
  totals: { debit: string; credit: string; openingBalance: string; closingBalance: string };
}

export const AGING_BASES = ['due_date', 'posting_date'] as const;
export type AgingBasis = (typeof AGING_BASES)[number];

export const apAgingQuery = z.object({
  asOf: isoDate,
  basis: z.enum(AGING_BASES).default('due_date'),
  vendorId: z.uuid().optional(),
});
export type ApAgingQuery = z.infer<typeof apAgingQuery>;

export interface AgingBuckets {
  current: string;
  days1To30: string;
  days31To60: string;
  days61To90: string;
  over90: string;
  total: string;
}

export type AgingBucketKey = Exclude<keyof AgingBuckets, 'total'>;

export interface ApAgingDocument {
  type: 'ap_invoice' | 'outgoing_payment' | 'opening_balance' | 'journal_entry';
  id: string;
  documentNumber: string;
  reference: string | null;
  postingDate: string;
  dueDate: string;
  days: number;
  bucket: AgingBucketKey;
  originalAmount: string;
  openAmount: string;
}

export interface ApAgingVendor extends AgingBuckets {
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  documents: ApAgingDocument[];
}

export interface ApAgingReport {
  tenantName: string;
  currency: string;
  asOf: string;
  basis: AgingBasis;
  generatedAt: string;
  accountingBasis: string;
  vendors: ApAgingVendor[];
  totals: AgingBuckets;
  controlAccount: { code: string; name: string; balance: string };
  difference: string;
}

export const arAgingQuery = z.object({
  asOf: isoDate,
  basis: z.enum(AGING_BASES).default('due_date'),
  customerId: z.uuid().optional(),
});
export type ArAgingQuery = z.infer<typeof arAgingQuery>;

export interface ArAgingDocument {
  type: 'ar_invoice' | 'incoming_payment' | 'opening_balance' | 'journal_entry';
  id: string;
  documentNumber: string;
  reference: string | null;
  postingDate: string;
  dueDate: string;
  days: number;
  bucket: AgingBucketKey;
  originalAmount: string;
  openAmount: string;
}

export interface ArAgingCustomer extends AgingBuckets {
  customerId: string;
  customerCode: string;
  customerName: string;
  documents: ArAgingDocument[];
}

export interface ArAgingReport {
  tenantName: string;
  currency: string;
  asOf: string;
  basis: AgingBasis;
  generatedAt: string;
  accountingBasis: string;
  customers: ArAgingCustomer[];
  totals: AgingBuckets;
  controlAccount: { code: string; name: string; balance: string };
  difference: string;
}

export const generalLedgerQuery = z.object({
  from: isoDate,
  to: isoDate,
  accountFrom: z.string().trim().max(20).optional(),
  accountTo: z.string().trim().max(20).optional(),
  partnerId: z.uuid().optional(),
});
export type GeneralLedgerQuery = z.infer<typeof generalLedgerQuery>;

export interface GeneralLedgerLine {
  journalId: string;
  journalNumber: string;
  postingDate: string;
  sourceType: string;
  reference: string | null;
  memo: string | null;
  partnerCode: string | null;
  debit: string;
  credit: string;
  balance: string;
}

export interface GeneralLedgerAccount {
  accountId: string;
  accountCode: string;
  accountName: string;
  openingBalance: string;
  debit: string;
  credit: string;
  closingBalance: string;
  lines: GeneralLedgerLine[];
}

export interface GeneralLedgerReport {
  tenantName: string;
  currency: string;
  from: string;
  to: string;
  generatedAt: string;
  basis: string;
  accounts: GeneralLedgerAccount[];
  totals: { debit: string; credit: string };
}

export const GENERAL_LEDGER_MAX_LINES = 20000;

export interface PeriodCloseCheck {
  key: 'trial_balance' | 'receivables' | 'payables' | 'inventory';
  label: string;
  passed: boolean;
  detail: string;
}

export interface PeriodCloseChecks {
  periodId: string;
  periodCode: string;
  endDate: string;
  passed: boolean;
  checks: PeriodCloseCheck[];
}
