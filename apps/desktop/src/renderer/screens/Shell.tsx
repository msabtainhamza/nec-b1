import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SessionUser, TenantContextResponse, TenantSummary } from '@nec/contracts';
import { Banner, Button } from '@nec/ui';
import { errorMessage } from '../api';
import type { ApiResult } from '../erp';
import { AboutForm } from '../forms/AboutForm';
import { AuditLogForm } from '../forms/AuditLogForm';
import { PaymentForm } from '../forms/BankingForms';
import { AgingForm } from '../forms/ReportForms';
import { BranchesForm } from '../forms/BranchesForm';
import { BusinessPartnerForm } from '../forms/BusinessPartnerForm';
import { AuthorizationsForm } from '../forms/AuthorizationsForm';
import { ApprovalsForm, ApprovalTemplatesForm } from '../forms/ApprovalForms';
import { ChangePasswordForm } from '../forms/ChangePasswordForm';
import { CockpitForm } from '../forms/CockpitForm';
import { SupportAccessForm } from '../forms/SupportAccessForm';
import { CompanyDetailsForm } from '../forms/CompanyDetailsForm';
import { TwoFactorForm } from '../forms/TwoFactorForm';
import { DataImportForm } from '../forms/DataImportForm';
import { GeneralLedgerForm } from '../forms/GeneralLedgerForm';
import { InventoryStatusForm, InventoryValuationForm } from '../forms/InventoryReportForms';
import {
  ChartOfAccountsForm,
  DocumentNumberingForm,
  GlDeterminationForm,
  PostingPeriodsForm,
  TrialBalanceForm,
} from '../forms/FinanceSetupForms';
import { ItemGroupsForm, PriceListsForm, UnitsOfMeasureForm, WarehousesForm } from '../forms/InventorySetupForms';
import { InventoryAdjustmentForm, InventoryTransferForm } from '../forms/InventoryTransactionForms';
import { ItemMasterDataForm } from '../forms/ItemMasterDataForm';
import { OpeningBalanceForm } from '../forms/OpeningBalanceForms';
import { JournalEntryForm } from '../forms/JournalEntryForm';
import { ApInvoiceForm } from '../forms/ApInvoiceForm';
import { GoodsReceiptForm, PurchaseOrderForm } from '../forms/PurchasingForms';
import { CreditSettingsForm } from '../forms/CreditControls';
import { QuotationForm } from '../forms/QuotationForm';
import { ArInvoiceForm, DeliveryForm, SalesOrderForm } from '../forms/SalesForms';
import { DocumentSettingsForm, TaxCodesForm } from '../forms/SettingsForms';
import { InventoryAuditForm } from '../forms/StockForms';
import { UsersForm } from '../forms/UsersForm';
import { RecordToolbarContext, type RecordActions } from '../toolbar';

export type ApiCall = <T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => Promise<ApiResult<T>>;

type FormId = 'company' | 'users' | 'branches' | 'audit' | 'about' | 'bp' | 'coa' | 'journal' | 'periods' | 'gldet' | 'trial' | 'numbering' | 'item' | 'pricelists' | 'warehouses' | 'units' | 'itemgroups' | 'po' | 'grpo' | 'invaudit' | 'invstatus' | 'dataimport' | 'generalledger' | 'changepassword' | 'twofactor' | 'authorizations' | 'supportaccess' | 'cockpit' | 'approvaltemplates' | 'approvals' | 'invvaluation' | 'apinv' | 'taxcodes' | 'docsettings' | 'outpay' | 'goodsreceipt' | 'goodsissue' | 'invtransfer' | 'apaging' | 'glopening' | 'bpopening' | 'invopening' | 'inpay' | 'araging' | 'creditsettings' | 'quotation' | 'so' | 'delivery' | 'arinv';

const FORM_TITLES: Record<FormId, string> = {
  company: 'Company Details',
  users: 'Users - Setup',
  branches: 'Branches - Setup',
  audit: 'Audit Log',
  about: 'About NEC ERP',
  bp: 'Business Partner Master Data',
  coa: 'Chart of Accounts',
  journal: 'Journal Entry',
  periods: 'Posting Periods',
  gldet: 'G/L Account Determination',
  trial: 'Trial Balance',
  numbering: 'Document Numbering - Setup',
  item: 'Item Master Data',
  pricelists: 'Price Lists',
  warehouses: 'Warehouses - Setup',
  units: 'Units of Measure - Setup',
  itemgroups: 'Item Groups - Setup',
  po: 'Purchase Order',
  grpo: 'Goods Receipt PO',
  invaudit: 'Inventory Audit Report',
  invstatus: 'Inventory Status',
  dataimport: 'Data Import',
  generalledger: 'General Ledger',
  changepassword: 'Change Password',
  twofactor: 'Two-Factor Authentication',
  authorizations: 'Authorizations',
  supportaccess: 'Support Access',
  cockpit: 'Cockpit',
  approvaltemplates: 'Approval Templates',
  approvals: 'Approvals',
  invvaluation: 'Inventory Valuation',
  apinv: 'A/P Invoice',
  taxcodes: 'Tax Codes - Setup',
  docsettings: 'Document Settings',
  outpay: 'Outgoing Payments',
  inpay: 'Incoming Payments',
  goodsreceipt: 'Goods Receipt',
  goodsissue: 'Goods Issue',
  invtransfer: 'Inventory Transfer',
  apaging: 'Vendor Liabilities Aging',
  araging: 'Customer Receivables Aging',
  creditsettings: 'Sales Credit Policy',
  quotation: 'Sales Quotation',
  so: 'Sales Order',
  delivery: 'Delivery',
  arinv: 'A/R Invoice',
  glopening: 'G/L Accounts Opening Balance',
  bpopening: 'Business Partners Opening Balance',
  invopening: 'Inventory Opening Balance',
};

interface TreeNode {
  id: string;
  label: string;
  form?: FormId;
  permission?: string;
  anyPermission?: string[];
  module?: string;
  planned?: string;
  children?: TreeNode[];
}

const MENU_TREE: TreeNode[] = [
  {
    id: 'administration',
    label: 'Administration',
    children: [
      {
        id: 'system-init',
        label: 'System Initialization',
        children: [
          { id: 'company', label: 'Company Details', form: 'company' },
          { id: 'numbering', label: 'Document Numbering', form: 'numbering', permission: 'admin.numbering.view' },
          { id: 'creditsettings', label: 'Sales Credit Policy', form: 'creditsettings', permission: 'sal.credit.view', module: 'sal' },
          { id: 'docsettings', label: 'Document Settings', form: 'docsettings', permission: 'pur.invoice.view', module: 'pur' },
          {
            id: 'opening-balances',
            label: 'Opening Balances',
            children: [
              { id: 'glopening', label: 'G/L Accounts Opening Balance', form: 'glopening', permission: 'fin.journal.view', module: 'fin' },
              { id: 'bpopening', label: 'Business Partners Opening Balance', form: 'bpopening', permission: 'fin.journal.view', module: 'fin' },
            ],
          },
        ],
      },
      {
        id: 'approval-procedures',
        label: 'Approval Procedures',
        children: [
          { id: 'approvaltemplates', label: 'Approval Templates', form: 'approvaltemplates', permission: 'admin.approval.view' },
          { id: 'approvals', label: 'Approvals', form: 'approvals', permission: 'admin.approval.view' },
        ],
      },
      {
        id: 'data-import-export',
        label: 'Data Import/Export',
        children: [{ id: 'dataimport', label: 'Data Import', form: 'dataimport', anyPermission: ['bp.partner.create', 'inv.item.create', 'inv.price.administer'] }],
      },
      {
        id: 'setup',
        label: 'Setup',
        children: [
          {
            id: 'setup-general',
            label: 'General',
            children: [
              { id: 'users', label: 'Users', form: 'users', permission: 'admin.user.view' },
              { id: 'authorizations', label: 'Authorizations', form: 'authorizations', permission: 'admin.role.view' },
              { id: 'branches', label: 'Branches', form: 'branches', permission: 'admin.branch.view' },
            ],
          },
          {
            id: 'setup-financials',
            label: 'Financials',
            children: [{ id: 'taxcodes', label: 'Tax Codes', form: 'taxcodes', permission: 'fin.account.view', module: 'fin' }],
          },
          {
            id: 'setup-inventory',
            label: 'Inventory',
            children: [
              { id: 'warehouses', label: 'Warehouses', form: 'warehouses', permission: 'inv.item.view', module: 'inv' },
              { id: 'units', label: 'Units of Measure', form: 'units', permission: 'inv.item.view', module: 'inv' },
              { id: 'itemgroups', label: 'Item Groups', form: 'itemgroups', permission: 'inv.item.view', module: 'inv' },
            ],
          },
        ],
      },
      {
        id: 'utilities',
        label: 'Utilities',
        children: [
          { id: 'audit', label: 'Audit Log', form: 'audit', permission: 'admin.audit.view' },
          { id: 'changepassword', label: 'Change Password', form: 'changepassword' },
          { id: 'twofactor', label: 'Two-Factor Authentication', form: 'twofactor' },
          { id: 'supportaccess', label: 'Support Access', form: 'supportaccess', permission: 'admin.user.view' },
        ],
      },
    ],
  },
  {
    id: 'financials',
    label: 'Financials',
    children: [
      { id: 'coa', label: 'Chart of Accounts', form: 'coa', permission: 'fin.account.view', module: 'fin' },
      { id: 'journal', label: 'Journal Entry', form: 'journal', permission: 'fin.journal.view', module: 'fin' },
      { id: 'periods', label: 'Posting Periods', form: 'periods', permission: 'fin.period.view', module: 'fin' },
      { id: 'gldet', label: 'G/L Account Determination', form: 'gldet', permission: 'fin.account.view', module: 'fin' },
      {
        id: 'fin-reports',
        label: 'Financial Reports',
        children: [
          {
            id: 'accounting-reports',
            label: 'Accounting',
            children: [
              { id: 'generalledger', label: 'General Ledger', form: 'generalledger', permission: 'fin.report.view', module: 'fin' },
              { id: 'trial', label: 'Trial Balance', form: 'trial', permission: 'fin.report.view', module: 'fin' },
            ],
          },
          {
            id: 'aging',
            label: 'Aging',
            children: [
              { id: 'araging', label: 'Customer Receivables Aging', form: 'araging', permission: 'fin.report.view', module: 'fin' },
              { id: 'apaging', label: 'Vendor Liabilities Aging', form: 'apaging', permission: 'fin.report.view', module: 'fin' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'sales',
    label: 'Sales - A/R',
    children: [
      { id: 'quotation', label: 'Sales Quotation', form: 'quotation', permission: 'sal.quotation.view', module: 'sal' },
      { id: 'so', label: 'Sales Order', form: 'so', permission: 'sal.order.view', module: 'sal' },
      { id: 'delivery', label: 'Delivery', form: 'delivery', permission: 'sal.delivery.view', module: 'sal' },
      { id: 'arinv', label: 'A/R Invoice', form: 'arinv', permission: 'sal.invoice.view', module: 'sal' },
    ],
  },
  {
    id: 'purchasing',
    label: 'Purchasing - A/P',
    children: [
      { id: 'po', label: 'Purchase Order', form: 'po', permission: 'pur.order.view', module: 'pur' },
      { id: 'grpo', label: 'Goods Receipt PO', form: 'grpo', permission: 'pur.receipt.view', module: 'pur' },
      { id: 'apinv', label: 'A/P Invoice', form: 'apinv', permission: 'pur.invoice.view', module: 'pur' },
    ],
  },
  {
    id: 'business-partners',
    label: 'Business Partners',
    children: [{ id: 'bp-master', label: 'Business Partner Master Data', form: 'bp', permission: 'bp.partner.view', module: 'bp' }],
  },
  {
    id: 'banking',
    label: 'Banking',
    children: [
      { id: 'inpay', label: 'Incoming Payments', form: 'inpay', permission: 'bank.payment.view', module: 'bank' },
      { id: 'outpay', label: 'Outgoing Payments', form: 'outpay', permission: 'bank.payment.view', module: 'bank' },
    ],
  },
  {
    id: 'inventory',
    label: 'Inventory',
    children: [
      { id: 'item', label: 'Item Master Data', form: 'item', permission: 'inv.item.view', module: 'inv' },
      { id: 'pricelists', label: 'Price Lists', form: 'pricelists', permission: 'inv.price.view', module: 'inv' },
      {
        id: 'inv-transactions',
        label: 'Inventory Transactions',
        children: [
          { id: 'goodsreceipt', label: 'Goods Receipt', form: 'goodsreceipt', permission: 'inv.stock.view', module: 'inv' },
          { id: 'goodsissue', label: 'Goods Issue', form: 'goodsissue', permission: 'inv.stock.view', module: 'inv' },
          { id: 'invtransfer', label: 'Inventory Transfer', form: 'invtransfer', permission: 'inv.stock.view', module: 'inv' },
          { id: 'invopening', label: 'Inventory Opening Balance', form: 'invopening', permission: 'inv.stock.view', module: 'inv' },
        ],
      },
      {
        id: 'inv-reports',
        label: 'Inventory Reports',
        children: [
          { id: 'invstatus', label: 'Inventory Status', form: 'invstatus', permission: 'inv.stock.view', module: 'inv' },
          { id: 'invvaluation', label: 'Inventory Valuation', form: 'invvaluation', permission: 'inv.stock.view', module: 'inv' },
          { id: 'invaudit', label: 'Inventory Audit Report', form: 'invaudit', permission: 'inv.stock.view', module: 'inv' },
        ],
      },
    ],
  },
  { id: 'reports', label: 'Reports', planned: 'Planned for milestone M5' },
];

export function Shell({
  user,
  tenant,
  canSwitch,
  online,
  onSwitchTenant,
  onLogout,
  onSessionExpired,
}: {
  user: SessionUser;
  tenant: TenantSummary;
  canSwitch: boolean;
  online: boolean;
  onSwitchTenant: () => void;
  onLogout: () => void;
  onSessionExpired: () => void;
}) {
  const [context, setContext] = useState<TenantContextResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openForms, setOpenForms] = useState<FormId[]>(['cockpit']);
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [receiptOrderId, setReceiptOrderId] = useState<string | null>(null);
  const [invoiceVendorId, setInvoiceVendorId] = useState<string | null>(null);
  const [salesOrderId, setSalesOrderId] = useState<string | null>(null);
  const [deliveryOrderId, setDeliveryOrderId] = useState<string | null>(null);
  const [invoiceCustomerId, setInvoiceCustomerId] = useState<string | null>(null);
  const [showMenu, setShowMenu] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['administration', 'system-init', 'setup', 'setup-general', 'utilities']));

  const call: ApiCall = useCallback(
    async <T,>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => {
      const result = await window.erp.request<T>(method, path, body);
      if (result.status === 401) {
        onSessionExpired();
      }
      return result;
    },
    [onSessionExpired],
  );

  useEffect(() => {
    void call<TenantContextResponse>('GET', '/v1/tenant/context').then((result) => {
      if (result.ok) {
        setContext(result.body);
      } else {
        setError(errorMessage(result));
      }
    });
  }, [call]);

  const can = useCallback((permission?: string) => !permission || (context?.permissions.includes(permission) ?? false), [context]);
  const entitled = useCallback((module?: string) => !module || (context?.entitlements.modules.includes(module) ?? false), [context]);
  const recordActions = useRef<RecordActions | null>(null);
  const [recordButtons, setRecordButtons] = useState('');
  const registerRecordActions = useCallback((actions: RecordActions | null) => {
    recordActions.current = actions;
    const signature = actions ? Object.keys(actions).filter((key) => actions[key as keyof RecordActions]).sort().join(',') : '';
    setRecordButtons((current) => (current === signature ? current : signature));
  }, []);
  const recordAction = useMemo(
    () => (name: keyof RecordActions) => ({
      disabled: !recordButtons.split(',').includes(name),
      onClick: () => recordActions.current?.[name]?.(),
    }),
    [recordButtons],
  );
  const activeForm = openForms[openForms.length - 1] ?? null;

  const openForm = useCallback((form: FormId) => {
    setOpenForms((current) => [...current.filter((item) => item !== form), form]);
  }, []);

  const closeForm = useCallback((form: FormId) => {
    setOpenForms((current) => current.filter((item) => item !== form));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && activeForm && !(event.target instanceof HTMLInputElement)) {
        closeForm(activeForm);
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        setShowMenu((value) => !value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeForm, closeForm]);

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  const visibleNodes = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .map((node) => (node.children ? { ...node, children: visibleNodes(node.children) } : node))
      .filter((node) =>
        node.form ? can(node.permission) && (!node.anyPermission || node.anyPermission.some((permission) => can(permission))) && entitled(node.module) : node.planned !== undefined || (node.children?.length ?? 0) > 0,
      );

  const renderTree = (nodes: TreeNode[], depth: number): ReactNode =>
    nodes.map((node) => {
      const isFolder = node.children !== undefined;
      const isOpen = expanded.has(node.id);
      return (
        <li key={node.id} role="treeitem" aria-expanded={isFolder ? isOpen : undefined} aria-disabled={node.planned ? true : undefined}>
          <button
            type="button"
            className="tree__row"
            style={{ paddingLeft: 6 + depth * 14 }}
            disabled={node.planned !== undefined}
            title={node.planned}
            aria-current={node.form && node.form === activeForm ? 'page' : undefined}
            onClick={() => (isFolder ? toggle(node.id) : node.form && openForm(node.form))}
          >
            <span className="tree__toggle" aria-hidden="true">
              {isFolder ? (isOpen ? '−' : '+') : ''}
            </span>
            <span className={isFolder || node.planned ? 'tree__icon' : 'tree__icon tree__icon--form'} aria-hidden="true" />
            {node.label}
          </button>
          {isFolder && isOpen ? <ul role="group">{renderTree(node.children ?? [], depth + 1)}</ul> : null}
        </li>
      );
    });

  const formNodes = collectForms(visibleNodes(MENU_TREE));
  const today = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeZone: context?.tenant.timeZone ?? undefined,
  }).format(new Date());

  const renderForm = (form: FormId) => {
    const close = () => closeForm(form);
    switch (form) {
      case 'company':
        return <CompanyDetailsForm context={context} call={call} canViewProfile={can('admin.company.view')} canEditProfile={can('admin.company.edit')} canEditSecurity={can('admin.user.administer')} canExport={can('admin.tenant.export')} onClose={close} />;
      case 'branches':
        return <BranchesForm call={call} canCreate={can('admin.branch.create')} canEdit={can('admin.branch.edit')} onClose={close} />;
      case 'users':
        return context ? (
          <UsersForm
            call={call}
            canInvite={can('admin.user.invite')}
            canAdminister={can('admin.user.administer')}
            currentMembershipId={context.membershipId}
            onClose={close}
          />
        ) : null;
      case 'audit':
        return <AuditLogForm call={call} onClose={close} />;
      case 'about':
        return <AboutForm onClose={close} />;
      case 'coa':
        return <ChartOfAccountsForm call={call} canAdminister={can('fin.account.administer')} onClose={close} />;
      case 'journal':
        return context ? (
          <JournalEntryForm
            call={call}
            canPost={can('fin.journal.post')}
            canReverse={can('fin.journal.reverse')}
            currency={context.tenant.baseCurrency}
            onClose={close}
          />
        ) : null;
      case 'periods':
        return <PostingPeriodsForm call={call} canAdminister={can('fin.period.administer')} canClose={can('fin.period.close')} canReopen={can('fin.period.reopen')} onClose={close} />;
      case 'gldet':
        return <GlDeterminationForm call={call} canAdminister={can('fin.setup.administer')} onClose={close} />;
      case 'trial':
        return <TrialBalanceForm call={call} onClose={close} />;
      case 'numbering':
        return <DocumentNumberingForm call={call} canAdminister={can('admin.numbering.administer')} onClose={close} />;
      case 'item':
        return <ItemMasterDataForm call={call} canCreate={can('inv.item.create')} canEdit={can('inv.item.edit')} canViewStock={can('inv.stock.view')} onClose={close} />;
      case 'pricelists':
        return <PriceListsForm call={call} canAdminister={can('inv.price.administer')} onClose={close} />;
      case 'warehouses':
        return <WarehousesForm call={call} canAdminister={can('inv.setup.administer')} onClose={close} />;
      case 'units':
        return <UnitsOfMeasureForm call={call} canAdminister={can('inv.setup.administer')} onClose={close} />;
      case 'itemgroups':
        return <ItemGroupsForm call={call} canAdminister={can('inv.setup.administer')} onClose={close} />;
      case 'po':
        return context ? (
          <PurchaseOrderForm
            call={call}
            canCreate={can('pur.order.create')}
            canEdit={can('pur.order.edit')}
            canReceive={can('pur.receipt.post')}
            currency={context.tenant.baseCurrency}
            onCopyToReceipt={(orderId) => {
              setReceiptOrderId(orderId);
              setRefreshKey((value) => value + 1);
              openForm('grpo');
            }}
            onClose={close}
          />
        ) : null;
      case 'grpo':
        return (
          <GoodsReceiptForm
            call={call}
            canPost={can('pur.receipt.post')}
            canCancel={can('pur.receipt.cancel')}
            initialOrderId={receiptOrderId}
            canInvoice={can('pur.invoice.post')}
            onCopyToInvoice={(vendorId) => {
              setInvoiceVendorId(vendorId);
              setRefreshKey((value) => value + 1);
              openForm('apinv');
            }}
            onClose={() => {
              setReceiptOrderId(null);
              close();
            }}
          />
        );
      case 'apinv':
        return context ? (
          <ApInvoiceForm
            call={call}
            canPost={can('pur.invoice.post')}
            canCancel={can('pur.invoice.cancel')}
            canOverride={can('pur.invoice.override')}
            currency={context.tenant.baseCurrency}
            initialVendorId={invoiceVendorId}
            onClose={() => {
              setInvoiceVendorId(null);
              close();
            }}
          />
        ) : null;
      case 'creditsettings':
        return <CreditSettingsForm call={call} canAdminister={can('sal.credit.administer')} onClose={close} />;
      case 'quotation':
        return <QuotationForm call={call} canCreate={can('sal.quotation.create')} canEdit={can('sal.quotation.edit')} canConvert={can('sal.quotation.edit') && can('sal.order.create')} onClose={close} onOrder={(id) => { setSalesOrderId(id); setRefreshKey((value) => value + 1); openForm('so'); }} />;
      case 'so':
        return context ? (
          <SalesOrderForm
            initialOrderId={salesOrderId}
            call={call}
            canCreate={can('sal.order.create')}
            canEdit={can('sal.order.edit')}
            canDeliver={can('sal.delivery.post')}
            canInvoice={can('sal.invoice.post')}
            currency={context.tenant.baseCurrency}
            onCopyToDelivery={(orderId) => {
              setDeliveryOrderId(orderId);
              setRefreshKey((value) => value + 1);
              openForm('delivery');
            }}
            onCopyToInvoice={(customerId) => {
              setInvoiceCustomerId(customerId);
              setRefreshKey((value) => value + 1);
              openForm('arinv');
            }}
            onClose={close}
          />
        ) : null;
      case 'delivery':
        return (
          <DeliveryForm
            call={call}
            canPost={can('sal.delivery.post')}
            canCancel={can('sal.delivery.cancel')}
            canInvoice={can('sal.invoice.post')}
            initialOrderId={deliveryOrderId}
            onCopyToInvoice={(customerId) => {
              setInvoiceCustomerId(customerId);
              setRefreshKey((value) => value + 1);
              openForm('arinv');
            }}
            onClose={() => {
              setDeliveryOrderId(null);
              close();
            }}
          />
        );
      case 'arinv':
        return context ? (
          <ArInvoiceForm
            call={call}
            canPost={can('sal.invoice.post')}
            canCancel={can('sal.invoice.cancel')}
            canOverride={can('sal.invoice.override')}
            currency={context.tenant.baseCurrency}
            initialCustomerId={invoiceCustomerId}
            onClose={() => {
              setInvoiceCustomerId(null);
              close();
            }}
          />
        ) : null;
      case 'goodsreceipt':
      case 'goodsissue':
        return context ? (
          <InventoryAdjustmentForm
            key={form}
            call={call}
            direction={form === 'goodsreceipt' ? 'receipt' : 'issue'}
            canPost={can('inv.adjustment.post')}
            canCancel={can('inv.adjustment.cancel')}
            currency={context.tenant.baseCurrency}
            onClose={close}
          />
        ) : null;
      case 'invopening':
        return context ? (
          <InventoryAdjustmentForm
            key={form}
            call={call}
            direction="opening"
            canPost={can('inv.opening.post')}
            canCancel={can('inv.opening.cancel')}
            currency={context.tenant.baseCurrency}
            onClose={close}
          />
        ) : null;
      case 'glopening':
      case 'bpopening':
        return context ? (
          <OpeningBalanceForm
            key={form}
            call={call}
            kind={form === 'glopening' ? 'account' : 'partner'}
            canPost={can('fin.opening.post')}
            canCancel={can('fin.opening.cancel')}
            currency={context.tenant.baseCurrency}
            onClose={close}
          />
        ) : null;
      case 'invtransfer':
        return context ? (
          <InventoryTransferForm call={call} canPost={can('inv.transfer.post')} canCancel={can('inv.transfer.cancel')} currency={context.tenant.baseCurrency} onClose={close} />
        ) : null;
      case 'apaging':
      case 'araging':
        return <AgingForm key={form} call={call} side={form === 'apaging' ? 'payables' : 'receivables'} onClose={close} />;
      case 'outpay':
      case 'inpay':
        return context ? (
          <PaymentForm
            key={form}
            call={call}
            direction={form === 'outpay' ? 'outgoing' : 'incoming'}
            canPost={can('bank.payment.post')}
            canCancel={can('bank.payment.cancel')}
            canUnallocate={can('bank.payment.unallocate')}
            currency={context.tenant.baseCurrency}
            onClose={close}
          />
        ) : null;
      case 'taxcodes':
        return <TaxCodesForm call={call} canAdminister={can('fin.setup.administer')} onClose={close} />;
      case 'docsettings':
        return <DocumentSettingsForm call={call} canAdminister={can('pur.setup.administer')} canViewSales={can('sal.invoice.view')} canAdministerSales={can('sal.setup.administer')} onClose={close} />;
      case 'invaudit':
        return <InventoryAuditForm call={call} onClose={close} />;
      case 'approvaltemplates':
        return <ApprovalTemplatesForm call={call} canAdminister={can('admin.approval.administer')} onClose={close} />;
      case 'approvals':
        return <ApprovalsForm call={call} onClose={close} />;
      case 'cockpit':
        return (
          <CockpitForm
            call={call}
            onOpen={(target) => {
              if (target === 'lowstock') {
                setLowStockOnly(true);
                openForm('invstatus');
              } else openForm(target);
            }}
            onClose={close}
          />
        );
      case 'supportaccess':
        return <SupportAccessForm call={call} canAdminister={can('admin.user.administer')} onClose={close} />;
      case 'authorizations':
        return <AuthorizationsForm call={call} canAdminister={can('admin.role.administer')} held={new Set(context?.permissions ?? [])} onClose={close} />;
      case 'twofactor':
        return <TwoFactorForm onClose={close} />;
      case 'changepassword':
        return <ChangePasswordForm onClose={close} />;
      case 'generalledger':
        return <GeneralLedgerForm call={call} onClose={close} />;
      case 'dataimport':
        return <DataImportForm call={call} allowed={{ partner: can('bp.partner.create'), item: can('inv.item.create'), price: can('inv.price.administer') }} onClose={close} />;
      case 'invstatus':
        return (
          <InventoryStatusForm
            key={lowStockOnly ? 'low' : 'all'}
            call={call}
            initialBelowOnly={lowStockOnly}
            onClose={() => {
              setLowStockOnly(false);
              close();
            }}
          />
        );
      case 'invvaluation':
        return <InventoryValuationForm call={call} onClose={close} />;
      case 'bp':
        return context ? (
          <BusinessPartnerForm
            call={call}
            canCreate={can('bp.partner.create')}
            canEdit={can('bp.partner.edit')}
            currency={context.tenant.baseCurrency}
            onClose={close}
          />
        ) : null;
    }
  };

  return (
    <div className="app">
      <MenuBar
        companyName={tenant.displayName}
        menus={[
          {
            label: 'Modules',
            items: formNodes.map((node) => ({ label: node.label, onSelect: () => node.form && openForm(node.form) })),
          },
          {
            label: 'View',
            items: [{ label: showMenu ? 'Hide Main Menu (Ctrl+M)' : 'Show Main Menu (Ctrl+M)', onSelect: () => setShowMenu((value) => !value) }],
          },
          {
            label: 'Window',
            items: [
              { label: 'Cockpit', onSelect: () => openForm('cockpit') },
              ...openForms.map((form) => ({ label: FORM_TITLES[form], onSelect: () => openForm(form) })),
              { label: 'Close All', onSelect: () => setOpenForms([]), disabled: openForms.length === 0 },
            ],
          },
          { label: 'Help', items: [{ label: 'About NEC ERP', onSelect: () => openForm('about') }] },
        ]}
      />
      <div className="toolbar" role="toolbar" aria-label="Main toolbar">
        <Button variant="ghost" onClick={() => setShowMenu((value) => !value)} aria-pressed={showMenu}>
          Main Menu
        </Button>
        <Button variant="ghost" onClick={() => setRefreshKey((value) => value + 1)} disabled={!activeForm}>
          Refresh
        </Button>
        <span className="toolbar__separator" aria-hidden="true" />
        <Button variant="ghost" {...recordAction('find')}>
          Find
        </Button>
        <Button variant="ghost" {...recordAction('add')}>
          Add
        </Button>
        <Button variant="ghost" aria-label="First record" {...recordAction('first')}>
          |◀
        </Button>
        <Button variant="ghost" aria-label="Previous record" {...recordAction('previous')}>
          ◀
        </Button>
        <Button variant="ghost" aria-label="Next record" {...recordAction('next')}>
          ▶
        </Button>
        <Button variant="ghost" aria-label="Last record" {...recordAction('last')}>
          ▶|
        </Button>
        <span className="toolbar__separator" aria-hidden="true" />
        {canSwitch ? (
          <Button variant="ghost" onClick={onSwitchTenant}>
            Choose Company
          </Button>
        ) : null}
        <Button variant="ghost" onClick={onLogout}>
          Log Off
        </Button>
      </div>
      <div className="workspace">
        {showMenu ? (
          <nav className="main-menu" aria-label="Main Menu">
            <div className="main-menu__title">Main Menu</div>
            <div className="main-menu__company">
              <strong>{tenant.displayName}</strong>
              <span className="ui-muted">{user.displayName}</span>
            </div>
            <ul className="tree" role="tree">
              {renderTree(visibleNodes(MENU_TREE), 0)}
            </ul>
          </nav>
        ) : null}
        <main className="desktop">
          {tenant.accessMode === 'restricted_export' ? (
            <Banner tone="warning">This company's subscription is restricted. Data is available read-only for export.</Banner>
          ) : null}
          {error ? <Banner>{error}</Banner> : null}
          {activeForm ? (
            <RecordToolbarContext.Provider value={registerRecordActions}>
              <div key={`${activeForm}-${refreshKey}`}>{renderForm(activeForm)}</div>
            </RecordToolbarContext.Provider>
          ) : (
            <p className="desktop__empty">Open a form from the Main Menu.</p>
          )}
        </main>
      </div>
      <footer className="statusbar">
        <span className="statusbar__cell">{user.displayName}</span>
        <span className="statusbar__cell">{tenant.displayName}</span>
        <span className="statusbar__cell">{today}</span>
        <span className={online ? 'statusbar__cell status-online' : 'statusbar__cell status-offline'} role="status">
          {online ? 'Connected' : 'Offline'}
        </span>
      </footer>
    </div>
  );
}

function collectForms(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => (node.form ? [node] : collectForms(node.children ?? [])));
}

interface MenuDefinition {
  label: string;
  items: { label: string; onSelect: () => void; disabled?: boolean }[];
}

function MenuBar({ menus, companyName }: { menus: MenuDefinition[]; companyName: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(null);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(null);
      }
    };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div className="menubar" ref={ref} role="menubar">
      {menus.map((menu) => (
        <div className="menubar__item" key={menu.label}>
          <button
            type="button"
            className="menubar__button"
            aria-haspopup="menu"
            aria-expanded={open === menu.label}
            onClick={() => setOpen(open === menu.label ? null : menu.label)}
            onMouseEnter={() => open && setOpen(menu.label)}
          >
            {menu.label}
          </button>
          {open === menu.label ? (
            <ul className="menubar__dropdown" role="menu">
              {menu.items.map((item) => (
                <li key={item.label} role="none">
                  <button
                    type="button"
                    role="menuitem"
                    disabled={item.disabled}
                    onClick={() => {
                      setOpen(null);
                      item.onSelect();
                    }}
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
      <span className="menubar__company">{companyName}</span>
    </div>
  );
}
