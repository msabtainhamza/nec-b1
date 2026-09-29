import { Injectable } from '@nestjs/common';
import { isPermission, subscriptionAccessMode, type AccessMode, type Permission, type TenantSummary } from '@nec/contracts';
import { DatabaseService, type Trx } from '../database/database.service.js';

export interface TenantAccess {
  tenantId: string;
  membershipId: string;
  code: string;
  displayName: string;
  subscriptionState: TenantSummary['subscriptionState'];
  accessMode: AccessMode;
  permissions: Set<Permission>;
  modules: Set<string>;
}

@Injectable()
export class TenantAccessService {
  constructor(private readonly database: DatabaseService) {}

  async listForUser(userId: string): Promise<TenantSummary[]> {
    const rows = await this.database.withContext({ userId }, (trx) =>
      trx
        .selectFrom('memberships')
        .innerJoin('tenants', 'tenants.id', 'memberships.tenant_id')
        .innerJoin('subscriptions', 'subscriptions.tenant_id', 'tenants.id')
        .select([
          'tenants.id as tenant_id',
          'tenants.code',
          'tenants.display_name',
          'tenants.status as tenant_status',
          'memberships.id as membership_id',
          'subscriptions.state',
          'subscriptions.retention_ends_at',
        ])
        .where('memberships.user_id', '=', userId)
        .where('memberships.status', '=', 'active')
        .orderBy('tenants.display_name')
        .execute(),
    );
    const now = new Date();
    return rows
      .map((row) => ({
        tenantId: row.tenant_id,
        code: row.code,
        displayName: row.display_name,
        membershipId: row.membership_id,
        subscriptionState: row.state,
        accessMode: effectiveAccessMode(row.tenant_status, row.state, row.retention_ends_at, now),
      }))
      .filter((tenant) => tenant.accessMode !== 'none');
  }

  async resolve(userId: string, tenantId: string): Promise<TenantAccess | null> {
    return this.database.withContext({ userId, tenantId }, (trx) => this.resolveWithin(trx, userId, tenantId));
  }

  async resolveWithin(trx: Trx, userId: string, tenantId: string): Promise<TenantAccess | null> {
    const row = await trx
      .selectFrom('memberships')
      .innerJoin('tenants', 'tenants.id', 'memberships.tenant_id')
      .innerJoin('subscriptions', 'subscriptions.tenant_id', 'tenants.id')
      .innerJoin('tenant_entitlements', 'tenant_entitlements.tenant_id', 'tenants.id')
      .select([
        'tenant_entitlements.modules',
        'memberships.id as membership_id',
        'tenants.code',
        'tenants.display_name',
        'tenants.status as tenant_status',
        'subscriptions.state',
        'subscriptions.retention_ends_at',
      ])
      .where('memberships.tenant_id', '=', tenantId)
      .where('memberships.user_id', '=', userId)
      .where('memberships.status', '=', 'active')
      .executeTakeFirst();
    if (!row) {
      return null;
    }
    const accessMode = effectiveAccessMode(row.tenant_status, row.state, row.retention_ends_at, new Date());
    if (accessMode === 'none') {
      return null;
    }
    const permissionRows = await trx
      .selectFrom('membership_roles')
      .innerJoin('role_permissions', (join) =>
        join
          .onRef('role_permissions.role_id', '=', 'membership_roles.role_id')
          .onRef('role_permissions.tenant_id', '=', 'membership_roles.tenant_id'),
      )
      .select('role_permissions.permission')
      .distinct()
      .where('membership_roles.membership_id', '=', row.membership_id)
      .execute();
    const permissions = new Set<Permission>();
    for (const { permission } of permissionRows) {
      if (isPermission(permission)) {
        permissions.add(permission);
      }
    }
    return {
      tenantId,
      membershipId: row.membership_id,
      code: row.code,
      displayName: row.display_name,
      subscriptionState: row.state,
      accessMode,
      permissions,
      modules: new Set(row.modules),
    };
  }
}

export function effectiveAccessMode(
  tenantStatus: 'active' | 'suspended' | 'deletion_requested',
  state: TenantSummary['subscriptionState'],
  retentionEndsAt: Date | null,
  now: Date,
): AccessMode {
  const subscriptionMode = subscriptionAccessMode({ state, retentionEndsAt, now });
  if (tenantStatus === 'active' || subscriptionMode === 'none') {
    return subscriptionMode;
  }
  return 'restricted_export';
}
