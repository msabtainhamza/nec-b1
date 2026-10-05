import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type RequiredTimestamp = ColumnType<Date, Date | string, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json = ColumnType<unknown, string | undefined, string>;
type NullableJson = ColumnType<unknown | null, string | null | undefined, string | null>;

export interface PlansTable {
  id: Generated<string>;
  code: string;
  name: string;
  modules: ColumnType<string[], string[] | undefined, string[]>;
  max_active_seats: number;
  max_employees: number;
  max_branches: number;
  max_storage_bytes: ColumnType<string, number | string, number | string>;
  created_at: Timestamp;
}

export interface PlatformOperatorsTable {
  id: Generated<string>;
  email: string;
  display_name: string;
  password_hash: string;
  totp_secret: string;
  totp_last_counter: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  status: ColumnType<'active' | 'disabled', 'active' | 'disabled' | undefined, 'active' | 'disabled'>;
  created_at: Timestamp;
}

export interface TenantsTable {
  id: Generated<string>;
  code: string;
  legal_name: string;
  display_name: string;
  status: ColumnType<TenantStatus, TenantStatus | undefined, TenantStatus>;
  base_currency: string;
  time_zone: string;
  default_branch_id: string | null;
  created_by_operator_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type TenantStatus = 'active' | 'suspended' | 'deletion_requested';

export interface SubscriptionsTable {
  tenant_id: string;
  plan_id: string;
  state: 'trial' | 'active' | 'past_due' | 'grace' | 'suspended' | 'cancelled';
  state_changed_at: Timestamp;
  retention_ends_at: NullableTimestamp;
  version: ColumnType<number, number | undefined, number>;
}

export interface TenantEntitlementsTable {
  tenant_id: string;
  modules: ColumnType<string[], string[] | undefined, string[]>;
  max_active_seats: number;
  max_employees: number;
  max_branches: number;
  max_storage_bytes: ColumnType<string, number | string, number | string>;
  updated_at: Timestamp;
}

export interface UserMfaTable {
  user_id: string;
  secret_encrypted: string;
  last_counter: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  enabled_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface UserMfaRecoveryCodesTable {
  id: Generated<string>;
  user_id: string;
  code_hash: string;
  used_at: NullableTimestamp;
}

export interface MfaChallengesTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  user_agent: string | null;
  attempts: ColumnType<number, number | undefined, number>;
  created_at: Timestamp;
  expires_at: Timestamp;
  used_at: NullableTimestamp;
}

export interface ApprovalTemplatesTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  document_type: 'sales_order' | 'purchase_order';
  min_total: Decimal;
  approver_role_id: string;
  required_approvals: number;
  active: boolean;
  version: ColumnType<number, number | undefined, number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ApprovalRequestsTable {
  id: Generated<string>;
  tenant_id: string;
  template_id: string;
  document_type: 'sales_order' | 'purchase_order';
  originator_id: string;
  partner_id: string;
  total: Decimal;
  payload: ColumnType<unknown, string, never>;
  remarks: string | null;
  status: ColumnType<'pending' | 'approved' | 'rejected' | 'cancelled' | 'completed', 'pending' | undefined, 'pending' | 'approved' | 'rejected' | 'cancelled' | 'completed'>;
  document_id: string | null;
  version: ColumnType<number, number | undefined, number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ApprovalDecisionsTable {
  id: Generated<string>;
  tenant_id: string;
  request_id: string;
  approver_id: string;
  decision: 'approved' | 'rejected';
  remarks: string | null;
  decided_at: Timestamp;
}

export interface SupportGrantsTable {
  id: Generated<string>;
  tenant_id: string;
  granted_by: string;
  reason: string;
  created_at: Timestamp;
  expires_at: Timestamp;
  revoked_at: NullableTimestamp;
  revoked_by: string | null;
}

export interface CompanySecuritySettingsTable {
  tenant_id: string;
  require_admin_mfa: boolean;
  version: number;
  updated_at: Timestamp;
}

export interface PasswordResetTokensTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  created_at: Timestamp;
  expires_at: Timestamp;
  used_at: NullableTimestamp;
}

export interface UsersTable {
  id: Generated<string>;
  email: string;
  display_name: string;
  password_hash: string;
  email_verified_at: NullableTimestamp;
  status: ColumnType<'active' | 'disabled', 'active' | 'disabled' | undefined, 'active' | 'disabled'>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SessionsTable {
  id: Generated<string>;
  subject_type: 'user' | 'operator';
  user_id: string | null;
  operator_id: string | null;
  active_tenant_id: string | null;
  user_agent: string | null;
  created_at: Timestamp;
  last_used_at: Timestamp;
  expires_at: RequiredTimestamp;
  revoked_at: NullableTimestamp;
  revoked_reason: string | null;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  session_id: string;
  token_hash: string;
  created_at: Timestamp;
  expires_at: RequiredTimestamp;
  used_at: NullableTimestamp;
}

export interface PlatformAuditEventsTable {
  id: Generated<string>;
  operator_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  tenant_id: string | null;
  outcome: 'success' | 'failure' | 'denied';
  details: Json;
  correlation_id: string | null;
  occurred_at: Timestamp;
}

export interface MembershipsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  status: ColumnType<MembershipStatus, MembershipStatus | undefined, MembershipStatus>;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: ColumnType<number, number | undefined, number>;
}

export type MembershipStatus = 'active' | 'disabled' | 'revoked';

export interface RolesTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  is_system: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Timestamp;
}

export interface RolePermissionsTable {
  tenant_id: string;
  role_id: string;
  permission: string;
}

export interface MembershipRolesTable {
  tenant_id: string;
  membership_id: string;
  role_id: string;
}

export interface InvitationsTable {
  id: Generated<string>;
  tenant_id: string;
  email: string;
  role_ids: ColumnType<string[], string[] | undefined, string[]>;
  token_hash: string;
  invited_by_user_id: string | null;
  invited_by_operator_id: string | null;
  expires_at: RequiredTimestamp;
  accepted_at: NullableTimestamp;
  accepted_user_id: string | null;
  revoked_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface BranchesTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  status: ColumnType<'active' | 'disabled', 'active' | 'disabled' | undefined, 'active' | 'disabled'>;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: ColumnType<number, number | undefined, number>;
  default_warehouse_id: string | null;
}

export interface AuditEventsTable {
  id: Generated<string>;
  tenant_id: string;
  actor_type: 'user' | 'operator' | 'system';
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  outcome: 'success' | 'failure' | 'denied';
  before_data: NullableJson;
  after_data: NullableJson;
  correlation_id: string | null;
  occurred_at: Timestamp;
}

export interface PaymentTermsTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  due_days: number;
  created_at: Timestamp;
}

export interface BpGroupsTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  partner_type: 'customer' | 'supplier';
  created_at: Timestamp;
}

export interface BusinessPartnersTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  foreign_name: string | null;
  partner_type: 'customer' | 'supplier' | 'lead';
  group_id: string | null;
  currency: string;
  tax_id: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  payment_terms_id: string | null;
  credit_limit: ColumnType<string, string | undefined, string>;
  status: ColumnType<'active' | 'inactive', 'active' | 'inactive' | undefined, 'active' | 'inactive'>;
  remarks: string | null;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: ColumnType<number, number | undefined, number>;
}

export interface BpContactsTable {
  id: Generated<string>;
  tenant_id: string;
  partner_id: string;
  line_no: number;
  name: string;
  position: string | null;
  phone: string | null;
  email: string | null;
  is_default: ColumnType<boolean, boolean | undefined, boolean>;
}

export interface BpAddressesTable {
  id: Generated<string>;
  tenant_id: string;
  partner_id: string;
  line_no: number;
  address_type: 'bill_to' | 'ship_to';
  address_name: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  country: string | null;
  is_default: ColumnType<boolean, boolean | undefined, boolean>;
}

type DateColumn = ColumnType<string, string, string>;
type Decimal = ColumnType<string, string, string>;

export interface AccountsTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  account_type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  parent_id: string | null;
  is_title: ColumnType<boolean, boolean | undefined, boolean>;
  control_kind: 'receivable' | 'payable' | null;
  status: ColumnType<'active' | 'inactive', 'active' | 'inactive' | undefined, 'active' | 'inactive'>;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: ColumnType<number, number | undefined, number>;
}

export interface GlDeterminationTable {
  tenant_id: string;
  determination_key: string;
  account_id: string;
  updated_at: Timestamp;
}

export interface FiscalYearsTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  start_date: DateColumn;
  end_date: DateColumn;
  created_at: Timestamp;
}

export interface PostingPeriodsTable {
  id: Generated<string>;
  tenant_id: string;
  fiscal_year_id: string;
  code: string;
  name: string;
  start_date: DateColumn;
  end_date: DateColumn;
  status: ColumnType<'open' | 'closed', 'open' | 'closed' | undefined, 'open' | 'closed'>;
  updated_at: Timestamp;
  version: ColumnType<number, number | undefined, number>;
}

export interface NumberingSeriesTable {
  id: Generated<string>;
  tenant_id: string;
  document_type: string;
  name: string;
  prefix: ColumnType<string, string | undefined, string>;
  next_number: ColumnType<string, number | string | undefined, number | string>;
  last_number: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  is_default: ColumnType<boolean, boolean | undefined, boolean>;
  status: ColumnType<'active' | 'inactive', 'active' | 'inactive' | undefined, 'active' | 'inactive'>;
  created_at: Timestamp;
  version: ColumnType<number, number | undefined, number>;
}

export interface IdempotencyKeysTable {
  tenant_id: string;
  idempotency_key: string;
  operation: string;
  request_hash: string;
  result_id: string | null;
  created_at: Timestamp;
}

export interface JournalEntriesTable {
  id: Generated<string>;
  tenant_id: string;
  series_id: string;
  number: ColumnType<string, number | string, never>;
  document_number: string;
  source_type: string;
  source_id: string | null;
  posting_date: DateColumn;
  document_date: DateColumn;
  due_date: DateColumn;
  period_id: string;
  memo: string | null;
  reference: string | null;
  currency: string;
  total_debit: Decimal;
  total_credit: Decimal;
  reversal_of_id: string | null;
  reversal_reason: string | null;
  posted_by: string | null;
  posted_at: Timestamp;
}

export interface JournalLinesTable {
  id: Generated<string>;
  tenant_id: string;
  journal_id: string;
  line_no: number;
  account_id: string;
  partner_id: string | null;
  debit: Decimal;
  credit: Decimal;
  memo: string | null;
}

export interface UnitsOfMeasureTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  decimals: number;
  status: ColumnType<'active' | 'inactive', 'active' | 'inactive' | undefined, 'active' | 'inactive'>;
  created_at: Timestamp;
}

export interface ItemGroupsTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  inventory_account_id: string | null;
  cogs_account_id: string | null;
  revenue_account_id: string | null;
  status: ColumnType<'active' | 'inactive', 'active' | 'inactive' | undefined, 'active' | 'inactive'>;
  created_at: Timestamp;
  version: ColumnType<number, number | undefined, number>;
}

export interface WarehousesTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  branch_id: string;
  inventory_account_id: string | null;
  status: ColumnType<'active' | 'inactive', 'active' | 'inactive' | undefined, 'active' | 'inactive'>;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: ColumnType<number, number | undefined, number>;
}

export interface ItemsTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  foreign_name: string | null;
  item_type: 'inventory' | 'non_inventory' | 'service';
  is_sales_item: boolean;
  is_purchase_item: boolean;
  group_id: string;
  uom_id: string;
  barcode: string | null;
  default_warehouse_id: string | null;
  reorder_point: string | null;
  preferred_vendor_id: string | null;
  status: ColumnType<'active' | 'inactive', 'active' | 'inactive' | undefined, 'active' | 'inactive'>;
  remarks: string | null;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: ColumnType<number, number | undefined, number>;
}

export interface PriceListsTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  purpose: 'sales' | 'purchase';
  currency: string;
  valid_from: string | null;
  valid_to: string | null;
  is_default: ColumnType<boolean, boolean | undefined, boolean>;
  status: ColumnType<'active' | 'inactive', 'active' | 'inactive' | undefined, 'active' | 'inactive'>;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: ColumnType<number, number | undefined, number>;
}

export interface ItemPricesTable {
  tenant_id: string;
  price_list_id: string;
  item_id: string;
  price: string;
  updated_at: Timestamp;
}

export interface PurchaseOrdersTable {
  id: Generated<string>;
  tenant_id: string;
  series_id: string;
  number: ColumnType<string, number | string, never>;
  document_number: string;
  vendor_id: string;
  branch_id: string;
  posting_date: DateColumn;
  delivery_date: DateColumn;
  vendor_reference: string | null;
  remarks: string | null;
  currency: string;
  total: Decimal;
  status: ColumnType<'open' | 'closed' | 'cancelled', 'open' | 'closed' | 'cancelled' | undefined, 'open' | 'closed' | 'cancelled'>;
  closed_reason: 'fully_received' | 'manual' | null;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: ColumnType<number, number | undefined, number>;
}

export interface PurchaseOrderLinesTable {
  id: Generated<string>;
  tenant_id: string;
  order_id: string;
  line_no: number;
  item_id: string;
  description: string;
  uom_id: string;
  warehouse_id: string | null;
  quantity: Decimal;
  received_quantity: ColumnType<string, string | undefined, string>;
  unit_price: Decimal;
  discount_percent: Decimal;
  net_price: Decimal;
  line_total: Decimal;
}

export interface GoodsReceiptsTable {
  id: ColumnType<string, string | undefined, never>;
  tenant_id: string;
  series_id: string;
  number: ColumnType<string, number | string, never>;
  document_number: string;
  order_id: string;
  vendor_id: string;
  branch_id: string;
  posting_date: DateColumn;
  remarks: string | null;
  currency: string;
  total: Decimal;
  status: ColumnType<'posted' | 'cancelled', 'posted' | 'cancelled' | undefined, 'posted' | 'cancelled'>;
  is_cancellation: ColumnType<boolean, boolean | undefined, never>;
  cancellation_of_id: string | null;
  cancellation_reason: string | null;
  journal_id: string | null;
  created_by: string | null;
  posted_at: Timestamp;
}

export interface GoodsReceiptLinesTable {
  id: Generated<string>;
  tenant_id: string;
  receipt_id: string;
  line_no: number;
  order_line_id: string;
  item_id: string;
  warehouse_id: string | null;
  quantity: Decimal;
  net_price: Decimal;
  line_total: Decimal;
  invoiced_quantity: ColumnType<string, string | undefined, string>;
}

export interface StockMovementsTable {
  id: Generated<string>;
  tenant_id: string;
  item_id: string;
  warehouse_id: string;
  quantity: Decimal;
  value: Decimal;
  unit_cost: Decimal;
  source_type: string;
  source_id: string;
  source_line_id: string | null;
  posting_date: DateColumn;
  journal_id: string | null;
  created_by: string | null;
  created_at: Timestamp;
}

export interface ItemValuationsTable {
  tenant_id: string;
  item_id: string;
  on_hand: ColumnType<string, string | undefined, string>;
  total_value: ColumnType<string, string | undefined, string>;
  average_cost: ColumnType<string, string | undefined, string>;
  last_movement_id: string | null;
  updated_at: Timestamp;
}

export interface ItemWarehouseStockTable {
  tenant_id: string;
  item_id: string;
  warehouse_id: string;
  on_hand: ColumnType<string, string | undefined, string>;
  updated_at: Timestamp;
}

export interface PurchasingSettingsTable {
  tenant_id: string;
  price_tolerance_percent: ColumnType<string, string | undefined, string>;
  updated_at: Timestamp;
  version: ColumnType<number, number | undefined, number>;
}

export interface ApInvoicesTable {
  id: string;
  tenant_id: string;
  series_id: string;
  number: ColumnType<string, number | string, never>;
  document_number: string;
  vendor_id: string;
  branch_id: string;
  posting_date: DateColumn;
  document_date: DateColumn;
  due_date: DateColumn;
  vendor_reference: string | null;
  remarks: string | null;
  currency: string;
  total: Decimal;
  paid_amount: ColumnType<string, string | undefined, string>;
  status: ColumnType<'posted' | 'cancelled', 'posted' | 'cancelled' | undefined, 'posted' | 'cancelled'>;
  is_cancellation: ColumnType<boolean, boolean | undefined, never>;
  cancellation_of_id: string | null;
  cancellation_reason: string | null;
  price_override: ColumnType<boolean, boolean | undefined, never>;
  journal_id: string | null;
  created_by: string | null;
  posted_at: Timestamp;
  document_type: ColumnType<'item' | 'service', 'item' | 'service' | undefined, never>;
  subtotal: Decimal;
  tax_total: ColumnType<string, string | undefined, never>;
}

export interface ApInvoiceLinesTable {
  id: Generated<string>;
  tenant_id: string;
  invoice_id: string;
  line_no: number;
  line_kind: 'receipt' | 'item' | 'account';
  receipt_id: string | null;
  receipt_line_id: string | null;
  order_line_id: string | null;
  item_id: string | null;
  account_id: string | null;
  warehouse_id: string | null;
  description: string;
  stocked: boolean;
  quantity: Decimal;
  receipt_price: string | null;
  unit_price: Decimal;
  line_total: Decimal;
  tax_code_id: string | null;
  tax_rate: ColumnType<string, string | undefined, never>;
  tax_amount: ColumnType<string, string | undefined, never>;
  stock_revaluation: ColumnType<string, string | undefined, never>;
  price_difference: ColumnType<string, string | undefined, never>;
}

export interface TaxCodesTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  purpose: 'purchase' | 'sales' | 'both';
  status: ColumnType<'active' | 'inactive', 'active' | 'inactive' | undefined, 'active' | 'inactive'>;
  created_at: Timestamp;
  version: ColumnType<number, number | undefined, number>;
}

export interface TaxCodeRatesTable {
  tenant_id: string;
  tax_code_id: string;
  valid_from: DateColumn;
  rate: Decimal;
  created_at: Timestamp;
}

export type PaymentDirection = 'outgoing' | 'incoming';

export interface PaymentsTable {
  id: string;
  tenant_id: string;
  series_id: string;
  number: ColumnType<string, number | string, never>;
  document_number: string;
  direction: PaymentDirection;
  partner_id: string;
  branch_id: string;
  posting_date: DateColumn;
  document_date: DateColumn;
  payment_means: 'cash' | 'bank_transfer' | 'cheque';
  account_id: string;
  reference: string | null;
  remarks: string | null;
  currency: string;
  amount: Decimal;
  allocated_amount: ColumnType<string, string | undefined, string>;
  status: ColumnType<'posted' | 'cancelled', 'posted' | 'cancelled' | undefined, 'posted' | 'cancelled'>;
  is_cancellation: ColumnType<boolean, boolean | undefined, never>;
  cancellation_of_id: string | null;
  cancellation_reason: string | null;
  journal_id: string;
  created_by: string | null;
  posted_at: Timestamp;
}

export interface PaymentAllocationsTable {
  id: Generated<string>;
  tenant_id: string;
  event_type: 'allocate' | 'unallocate';
  payment_id: string;
  invoice_id: string | null;
  opening_line_id: string | null;
  ar_invoice_id: string | null;
  amount: Decimal;
  event_date: DateColumn;
  reverses_id: string | null;
  reason: string | null;
  created_by: string | null;
  created_at: Timestamp;
}

type StockDocumentStatus = ColumnType<'posted' | 'cancelled', 'posted' | 'cancelled' | undefined, 'posted' | 'cancelled'>;

export interface StockTransfersTable {
  id: string;
  tenant_id: string;
  series_id: string;
  number: ColumnType<string, number | string, never>;
  document_number: string;
  from_warehouse_id: string;
  to_warehouse_id: string;
  posting_date: DateColumn;
  reason: string;
  remarks: string | null;
  total_value: Decimal;
  status: StockDocumentStatus;
  is_cancellation: ColumnType<boolean, boolean | undefined, never>;
  cancellation_of_id: string | null;
  cancellation_reason: string | null;
  journal_id: string | null;
  created_by: string | null;
  posted_at: Timestamp;
}

export interface StockTransferLinesTable {
  id: Generated<string>;
  tenant_id: string;
  transfer_id: string;
  line_no: number;
  item_id: string;
  quantity: Decimal;
  value: Decimal;
}

export interface InventoryAdjustmentsTable {
  id: string;
  tenant_id: string;
  series_id: string;
  number: ColumnType<string, number | string, never>;
  document_number: string;
  direction: 'receipt' | 'issue' | 'opening';
  posting_date: DateColumn;
  offset_account_id: string;
  reason: string;
  remarks: string | null;
  total_value: Decimal;
  status: StockDocumentStatus;
  is_cancellation: ColumnType<boolean, boolean | undefined, never>;
  cancellation_of_id: string | null;
  cancellation_reason: string | null;
  journal_id: string | null;
  created_by: string | null;
  posted_at: Timestamp;
}

export interface InventoryAdjustmentLinesTable {
  id: Generated<string>;
  tenant_id: string;
  adjustment_id: string;
  line_no: number;
  item_id: string;
  warehouse_id: string;
  inventory_account_id: string;
  quantity: Decimal;
  unit_cost: Decimal;
  value: Decimal;
}

export interface OpeningBalancesTable {
  id: string;
  tenant_id: string;
  series_id: string;
  number: ColumnType<string, number | string, never>;
  document_number: string;
  kind: 'account' | 'partner';
  posting_date: DateColumn;
  offset_account_id: string;
  reason: string;
  remarks: string | null;
  total_debit: Decimal;
  total_credit: Decimal;
  status: StockDocumentStatus;
  is_cancellation: ColumnType<boolean, boolean | undefined, never>;
  cancellation_of_id: string | null;
  cancellation_reason: string | null;
  journal_id: string;
  created_by: string | null;
  posted_at: Timestamp;
}

export interface OpeningBalanceLinesTable {
  id: Generated<string>;
  tenant_id: string;
  opening_balance_id: string;
  line_no: number;
  account_id: string | null;
  partner_id: string | null;
  reference: string | null;
  document_date: ColumnType<string | null, string | null | undefined, string | null>;
  due_date: ColumnType<string | null, string | null | undefined, string | null>;
  debit: Decimal;
  credit: Decimal;
  paid_amount: ColumnType<string, string | undefined, string>;
}

type OrderStatus = ColumnType<'open' | 'closed' | 'cancelled', 'open' | 'closed' | 'cancelled' | undefined, 'open' | 'closed' | 'cancelled'>;

export interface SalesOrdersTable {
  quotation_id: string | null;
  id: Generated<string>;
  tenant_id: string;
  series_id: string;
  number: ColumnType<string, number | string, never>;
  document_number: string;
  customer_id: string;
  branch_id: string;
  posting_date: DateColumn;
  delivery_date: DateColumn;
  customer_reference: string | null;
  remarks: string | null;
  currency: string;
  total: Decimal;
  status: OrderStatus;
  closed_reason: 'fulfilled' | 'manual' | null;
  price_list_id: string | null;
  payment_terms_id: string | null;
  bill_to: ColumnType<unknown | null, string | null | undefined, never>;
  ship_to: ColumnType<unknown | null, string | null | undefined, never>;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: ColumnType<number, number | undefined, number>;
}

export interface SalesOrderLinesTable {
  quotation_line_id: string | null;
  id: Generated<string>;
  tenant_id: string;
  order_id: string;
  line_no: number;
  item_id: string;
  description: string;
  uom_id: string;
  stocked: boolean;
  warehouse_id: string | null;
  quantity: Decimal;
  delivered_quantity: ColumnType<string, string | undefined, string>;
  invoiced_quantity: ColumnType<string, string | undefined, string>;
  unit_price: Decimal;
  discount_percent: Decimal;
  net_price: Decimal;
  line_total: Decimal;
}

export interface SalesQuotationsTable extends Omit<SalesOrdersTable, 'quotation_id' | 'delivery_date' | 'status' | 'closed_reason'> {
  valid_until: DateColumn;
  status: ColumnType<'draft' | 'issued' | 'closed' | 'cancelled', 'draft' | undefined, 'draft' | 'issued' | 'closed' | 'cancelled'>;
}

export interface SalesQuotationLinesTable extends Omit<SalesOrderLinesTable, 'quotation_line_id' | 'order_id' | 'delivered_quantity' | 'invoiced_quantity'> {
  quotation_id: string;
}

export interface DeliveriesTable {
  id: string;
  tenant_id: string;
  series_id: string;
  number: ColumnType<string, number | string, never>;
  document_number: string;
  order_id: string;
  customer_id: string;
  branch_id: string;
  posting_date: DateColumn;
  remarks: string | null;
  currency: string;
  total: Decimal;
  cost_total: Decimal;
  status: StockDocumentStatus;
  is_cancellation: ColumnType<boolean, boolean | undefined, never>;
  cancellation_of_id: string | null;
  cancellation_reason: string | null;
  journal_id: string | null;
  created_by: string | null;
  posted_at: Timestamp;
}

export interface DeliveryLinesTable {
  id: Generated<string>;
  tenant_id: string;
  delivery_id: string;
  line_no: number;
  order_line_id: string;
  item_id: string;
  warehouse_id: string;
  quantity: Decimal;
  net_price: Decimal;
  line_total: Decimal;
  cost_value: Decimal;
  invoiced_quantity: ColumnType<string, string | undefined, string>;
}

export interface ArInvoicesTable {
  id: string;
  tenant_id: string;
  series_id: string;
  number: ColumnType<string, number | string, never>;
  document_number: string;
  customer_id: string;
  branch_id: string;
  posting_date: DateColumn;
  document_date: DateColumn;
  due_date: DateColumn;
  customer_reference: string | null;
  remarks: string | null;
  currency: string;
  subtotal: Decimal;
  tax_total: Decimal;
  total: Decimal;
  paid_amount: ColumnType<string, string | undefined, string>;
  status: StockDocumentStatus;
  is_cancellation: ColumnType<boolean, boolean | undefined, never>;
  cancellation_of_id: string | null;
  cancellation_reason: string | null;
  journal_id: string | null;
  price_override: ColumnType<boolean, boolean | undefined, never>;
  print_snapshot: ColumnType<unknown | null, string | null | undefined, never>;
  payment_terms_id: string | null;
  created_by: string | null;
  posted_at: Timestamp;
}

export interface ArInvoiceLinesTable {
  id: Generated<string>;
  tenant_id: string;
  invoice_id: string;
  line_no: number;
  line_kind: 'delivery' | 'order';
  delivery_id: string | null;
  delivery_line_id: string | null;
  order_line_id: string;
  item_id: string;
  description: string;
  quantity: Decimal;
  unit_price: Decimal;
  source_price: Decimal;
  line_total: Decimal;
  revenue_account_id: string;
  tax_code_id: string | null;
  tax_rate: Decimal;
  tax_amount: Decimal;
}

export interface CompanyProfilesTable {
  tenant_id: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  country: string | null;
  tax_number: string | null;
  phone: string | null;
  email: string | null;
  invoice_footer: string | null;
  version: number;
  updated_at: Timestamp;
}

export interface SalesSettingsTable {
  tenant_id: string;
  price_tolerance_percent: string | null;
  version: number;
  updated_at: Timestamp;
}

export interface SalesCreditSettingsTable {
  tenant_id: string;
  mode: 'disabled' | 'warn' | 'block';
  version: number;
}

export interface Database {
  sales_credit_settings: SalesCreditSettingsTable;
  sales_settings: SalesSettingsTable;
  company_profiles: CompanyProfilesTable;
  plans: PlansTable;
  platform_operators: PlatformOperatorsTable;
  tenants: TenantsTable;
  subscriptions: SubscriptionsTable;
  tenant_entitlements: TenantEntitlementsTable;
  users: UsersTable;
  sessions: SessionsTable;
  refresh_tokens: RefreshTokensTable;
  password_reset_tokens: PasswordResetTokensTable;
  user_mfa: UserMfaTable;
  user_mfa_recovery_codes: UserMfaRecoveryCodesTable;
  mfa_challenges: MfaChallengesTable;
  company_security_settings: CompanySecuritySettingsTable;
  support_grants: SupportGrantsTable;
  approval_templates: ApprovalTemplatesTable;
  approval_requests: ApprovalRequestsTable;
  approval_decisions: ApprovalDecisionsTable;
  platform_audit_events: PlatformAuditEventsTable;
  memberships: MembershipsTable;
  roles: RolesTable;
  role_permissions: RolePermissionsTable;
  membership_roles: MembershipRolesTable;
  invitations: InvitationsTable;
  branches: BranchesTable;
  audit_events: AuditEventsTable;
  payment_terms: PaymentTermsTable;
  bp_groups: BpGroupsTable;
  business_partners: BusinessPartnersTable;
  bp_contacts: BpContactsTable;
  bp_addresses: BpAddressesTable;
  accounts: AccountsTable;
  gl_determination: GlDeterminationTable;
  fiscal_years: FiscalYearsTable;
  posting_periods: PostingPeriodsTable;
  numbering_series: NumberingSeriesTable;
  idempotency_keys: IdempotencyKeysTable;
  journal_entries: JournalEntriesTable;
  journal_lines: JournalLinesTable;
  units_of_measure: UnitsOfMeasureTable;
  item_groups: ItemGroupsTable;
  warehouses: WarehousesTable;
  items: ItemsTable;
  price_lists: PriceListsTable;
  item_prices: ItemPricesTable;
  purchase_orders: PurchaseOrdersTable;
  purchase_order_lines: PurchaseOrderLinesTable;
  goods_receipts: GoodsReceiptsTable;
  goods_receipt_lines: GoodsReceiptLinesTable;
  stock_movements: StockMovementsTable;
  item_valuations: ItemValuationsTable;
  item_warehouse_stock: ItemWarehouseStockTable;
  purchasing_settings: PurchasingSettingsTable;
  ap_invoices: ApInvoicesTable;
  ap_invoice_lines: ApInvoiceLinesTable;
  tax_codes: TaxCodesTable;
  tax_code_rates: TaxCodeRatesTable;
  payments: PaymentsTable;
  payment_allocations: PaymentAllocationsTable;
  stock_transfers: StockTransfersTable;
  stock_transfer_lines: StockTransferLinesTable;
  inventory_adjustments: InventoryAdjustmentsTable;
  inventory_adjustment_lines: InventoryAdjustmentLinesTable;
  opening_balances: OpeningBalancesTable;
  opening_balance_lines: OpeningBalanceLinesTable;
  sales_quotations: SalesQuotationsTable;
  sales_quotation_lines: SalesQuotationLinesTable;
  sales_orders: SalesOrdersTable;
  sales_order_lines: SalesOrderLinesTable;
  deliveries: DeliveriesTable;
  delivery_lines: DeliveryLinesTable;
  ar_invoices: ArInvoicesTable;
  ar_invoice_lines: ArInvoiceLinesTable;
}
