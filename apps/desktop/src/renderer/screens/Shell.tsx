import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SessionUser, TenantContextResponse, TenantSummary } from '@nec/contracts';
import { Banner, Button } from '@nec/ui';
import { errorMessage } from '../api';
import type { ApiResult } from '../erp';
import { AboutForm } from '../forms/AboutForm';
import { AuditLogForm } from '../forms/AuditLogForm';
import { BranchesForm } from '../forms/BranchesForm';
import { BusinessPartnerForm } from '../forms/BusinessPartnerForm';
import { CompanyDetailsForm } from '../forms/CompanyDetailsForm';
import {
  ChartOfAccountsForm,
  DocumentNumberingForm,
  GlDeterminationForm,
  PostingPeriodsForm,
  TrialBalanceForm,
} from '../forms/FinanceSetupForms';
import { ItemGroupsForm, PriceListsForm, UnitsOfMeasureForm, WarehousesForm } from '../forms/InventorySetupForms';
import { ItemMasterDataForm } from '../forms/ItemMasterDataForm';
import { JournalEntryForm } from '../forms/JournalEntryForm';
import { ApInvoiceForm } from '../forms/ApInvoiceForm';
import { GoodsReceiptForm, PurchaseOrderForm } from '../forms/PurchasingForms';
import { DocumentSettingsForm, TaxCodesForm } from '../forms/SettingsForms';
import { InventoryAuditForm } from '../forms/StockForms';
import { UsersForm } from '../forms/UsersForm';
import { RecordToolbarContext, type RecordActions } from '../toolbar';

export type ApiCall = <T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => Promise<ApiResult<T>>;

type FormId = 'company' | 'users' | 'branches' | 'audit' | 'about' | 'bp' | 'coa' | 'journal' | 'periods' | 'gldet' | 'trial' | 'numbering' | 'item' | 'pricelists' | 'warehouses' | 'units' | 'itemgroups' | 'po' | 'grpo' | 'invaudit' | 'apinv' | 'taxcodes' | 'docsettings';

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
  apinv: 'A/P Invoice',
  taxcodes: 'Tax Codes - Setup',
  docsettings: 'Document Settings',
};

interface TreeNode {
  id: string;
  label: string;
  form?: FormId;
  permission?: string;
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
          { id: 'docsettings', label: 'Document Settings', form: 'docsettings', permission: 'pur.invoice.view', module: 'pur' },
        ],
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
      { id: 'utilities', label: 'Utilities', children: [{ id: 'audit', label: 'Audit Log', form: 'audit', permission: 'admin.audit.view' }] },
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
        children: [{ id: 'trial', label: 'Trial Balance', form: 'trial', permission: 'fin.report.view', module: 'fin' }],
      },
    ],
  },
  { id: 'sales', label: 'Sales - A/R', planned: 'Planned for milestone M4' },
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
  { id: 'banking', label: 'Banking', planned: 'Planned for milestones M4-M5' },
  {
    id: 'inventory',
    label: 'Inventory',
    children: [
      { id: 'item', label: 'Item Master Data', form: 'item', permission: 'inv.item.view', module: 'inv' },
      { id: 'pricelists', label: 'Price Lists', form: 'pricelists', permission: 'inv.price.view', module: 'inv' },
      {
        id: 'inv-reports',
        label: 'Inventory Reports',
        children: [{ id: 'invaudit', label: 'Inventory Audit Report', form: 'invaudit', permission: 'inv.stock.view', module: 'inv' }],
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
  const [openForms, setOpenForms] = useState<FormId[]>(['company']);
  const [refreshKey, setRefreshKey] = useState(0);
  const [receiptOrderId, setReceiptOrderId] = useState<string | null>(null);
  const [invoiceVendorId, setInvoiceVendorId] = useState<string | null>(null);
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
        node.form ? can(node.permission) && entitled(node.module) : node.planned !== undefined || (node.children?.length ?? 0) > 0,
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
        return <CompanyDetailsForm context={context} onClose={close} />;
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
        return <PostingPeriodsForm call={call} canAdminister={can('fin.period.administer')} onClose={close} />;
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
      case 'taxcodes':
        return <TaxCodesForm call={call} canAdminister={can('fin.setup.administer')} onClose={close} />;
      case 'docsettings':
        return <DocumentSettingsForm call={call} canAdminister={can('pur.setup.administer')} onClose={close} />;
      case 'invaudit':
        return <InventoryAuditForm call={call} onClose={close} />;
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
