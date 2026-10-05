import { z } from 'zod';
import type { ImportRowError } from './opening-balances.js';

export const MASTER_IMPORT_KINDS = ['partner', 'item', 'price'] as const;
export type MasterImportKind = (typeof MASTER_IMPORT_KINDS)[number];

export const MASTER_IMPORT_MAX_ROWS = 2000;

export const MASTER_IMPORT_COLUMNS: Record<MasterImportKind, { name: string; required: boolean }[]> = {
  partner: [
    { name: 'BPCode', required: true },
    { name: 'BPName', required: false },
    { name: 'BPType', required: false },
    { name: 'GroupCode', required: false },
    { name: 'ForeignName', required: false },
    { name: 'TaxId', required: false },
    { name: 'Phone', required: false },
    { name: 'Email', required: false },
    { name: 'Website', required: false },
    { name: 'PaymentTermsCode', required: false },
    { name: 'CreditLimit', required: false },
    { name: 'Status', required: false },
    { name: 'BillToStreet', required: false },
    { name: 'BillToCity', required: false },
    { name: 'BillToZipCode', required: false },
    { name: 'BillToCountry', required: false },
    { name: 'ShipToStreet', required: false },
    { name: 'ShipToCity', required: false },
    { name: 'ShipToZipCode', required: false },
    { name: 'ShipToCountry', required: false },
    { name: 'Remarks', required: false },
  ],
  item: [
    { name: 'ItemCode', required: true },
    { name: 'ItemName', required: false },
    { name: 'ItemType', required: false },
    { name: 'GroupCode', required: false },
    { name: 'UomCode', required: false },
    { name: 'ForeignName', required: false },
    { name: 'SalesItem', required: false },
    { name: 'PurchaseItem', required: false },
    { name: 'Barcode', required: false },
    { name: 'DefaultWarehouseCode', required: false },
    { name: 'ReorderPoint', required: false },
    { name: 'PreferredVendorCode', required: false },
    { name: 'Status', required: false },
    { name: 'Remarks', required: false },
  ],
  price: [
    { name: 'PriceListCode', required: true },
    { name: 'ItemCode', required: true },
    { name: 'Price', required: false },
  ],
};

export const MASTER_IMPORT_TEMPLATES: Record<MasterImportKind, { fileName: string; content: string }> = {
  partner: {
    fileName: 'business-partners.csv',
    content:
      'BPCode,BPName,BPType,GroupCode,ForeignName,TaxId,Phone,Email,Website,PaymentTermsCode,CreditLimit,Status,BillToStreet,BillToCity,BillToZipCode,BillToCountry,ShipToStreet,ShipToCity,ShipToZipCode,ShipToCountry,Remarks\r\n' +
      'C3000,Northwind Stores,customer,,,TAX-3000,,orders@northwind.example,,NET30,5000,active,1 Market Street,Lahore,54000,PK,,,,,\r\n' +
      'V3000,Fabrikam Supplies,supplier,,,,,,,,0,active,,,,,,,,,\r\n',
  },
  item: {
    fileName: 'items.csv',
    content:
      'ItemCode,ItemName,ItemType,GroupCode,UomCode,ForeignName,SalesItem,PurchaseItem,Barcode,DefaultWarehouseCode,ReorderPoint,PreferredVendorCode,Status,Remarks\r\n' +
      'B-200,Widget B,inventory,GENERAL,EA,,Y,Y,,WH01,10,,active,\r\n' +
      'SRV-INSTALL,Installation service,service,SERVICES,EA,,Y,N,,,,,active,\r\n',
  },
  price: { fileName: 'prices.csv', content: 'PriceListCode,ItemCode,Price\r\nSALES,B-200,12.50\r\n' },
};

export const masterImportRequest = z.object({
  idempotencyKey: z.string().trim().min(8).max(100),
  mode: z.enum(['validate', 'commit']),
  fileName: z.string().trim().max(200).optional(),
  csv: z.string().min(1).max(2_000_000),
  updateExisting: z.boolean().default(false),
});
export type MasterImportRequest = z.infer<typeof masterImportRequest>;

export interface MasterImportResult {
  kind: MasterImportKind;
  mode: 'validate' | 'commit';
  valid: boolean;
  committed: boolean;
  replayed: boolean;
  rowCount: number;
  created: number;
  updated: number;
  errors: ImportRowError[];
}

export const MIGRATION_ORDER = [
  'Chart of accounts and G/L account determination (set up manually)',
  'Business partners (Data Import > Business Partners)',
  'Items (Data Import > Items)',
  'Prices (Data Import > Prices)',
  'G/L account opening balances (Opening Balances > G/L Accounts Opening Balance > Import from File)',
  'Business partner open items (Opening Balances > Business Partners Opening Balance > Import from File)',
  'Opening stock (Inventory Transactions > Inventory Opening Balance > Import from File)',
] as const;
