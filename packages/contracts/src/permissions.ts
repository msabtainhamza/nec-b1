export const PERMISSIONS = [
  'admin.company.view',
  'admin.company.edit',
  'admin.branch.view',
  'admin.branch.create',
  'admin.branch.edit',
  'admin.user.view',
  'admin.user.invite',
  'admin.user.administer',
  'admin.role.view',
  'admin.role.administer',
  'admin.audit.view',
  'admin.subscription.view',
  'admin.tenant.export',
  'admin.numbering.view',
  'admin.numbering.administer',
  'bp.partner.view',
  'bp.partner.create',
  'bp.partner.edit',
  'bp.setup.administer',
  'fin.account.view',
  'fin.account.administer',
  'fin.journal.view',
  'fin.journal.post',
  'fin.journal.reverse',
  'fin.period.view',
  'fin.period.administer',
  'fin.setup.administer',
  'fin.report.view',
  'inv.item.view',
  'inv.item.create',
  'inv.item.edit',
  'inv.price.view',
  'inv.price.administer',
  'inv.setup.administer',
  'inv.stock.view',
  'pur.order.view',
  'pur.order.create',
  'pur.order.edit',
  'pur.receipt.view',
  'pur.receipt.post',
  'pur.receipt.cancel',
  'pur.invoice.view',
  'pur.invoice.post',
  'pur.invoice.cancel',
  'pur.invoice.override',
  'pur.setup.administer',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export interface SystemRoleDefinition {
  code: string;
  name: string;
  permissions: readonly Permission[];
}

export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  { code: 'owner', name: 'Owner', permissions: PERMISSIONS },
  {
    code: 'administrator',
    name: 'Administrator',
    permissions: PERMISSIONS.filter((p) => p !== 'admin.tenant.export'),
  },
  {
    code: 'accountant',
    name: 'Accountant',
    permissions: PERMISSIONS.filter(
      (p) =>
        p.startsWith('fin.') ||
        [
          'admin.numbering.view',
          'admin.company.view',
          'admin.branch.view',
          'admin.audit.view',
          'bp.partner.view',
          'inv.item.view',
          'inv.price.view',
          'inv.stock.view',
          'pur.order.view',
          'pur.receipt.view',
          'pur.invoice.view',
          'pur.invoice.post',
          'pur.invoice.cancel',
        ].includes(p),
    ),
  },
  {
    code: 'buyer',
    name: 'Buyer',
    permissions: [
      'pur.order.view',
      'pur.order.create',
      'pur.order.edit',
      'pur.receipt.view',
      'pur.invoice.view',
      'inv.stock.view',
      'inv.item.view',
      'inv.price.view',
      'bp.partner.view',
      'bp.partner.create',
      'bp.partner.edit',
      'admin.branch.view',
    ],
  },
  {
    code: 'warehouse',
    name: 'Warehouse Operator',
    permissions: [
      'pur.order.view',
      'pur.receipt.view',
      'pur.receipt.post',
      'pur.receipt.cancel',
      'inv.stock.view',
      'inv.item.view',
      'bp.partner.view',
      'admin.branch.view',
    ],
  },
  {
    code: 'auditor',
    name: 'Auditor',
    permissions: PERMISSIONS.filter((p) => p.endsWith('.view')),
  },
];

export const OWNER_ROLE_CODE = 'owner';

export const ALWAYS_ENABLED_MODULES = ['admin'] as const;

export function permissionModule(permission: Permission): string {
  return permission.slice(0, permission.indexOf('.'));
}
