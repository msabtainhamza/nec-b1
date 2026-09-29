import { Injectable } from '@nestjs/common';
import {
  OWNER_ROLE_CODE,
  type AuditEvent,
  type ChangeStatusRequest,
  type Member,
  type Page,
  type PaginationQuery,
  type Role,
  type TenantContextResponse,
} from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { conflict, notFound, versionConflict } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, type Trx } from '../database/database.service.js';
import { EntitlementService } from '../entitlements/entitlement.service.js';

@Injectable()
export class MembersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
  ) {}

  async context(principal: TenantPrincipal): Promise<TenantContextResponse> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const tenant = await trx
        .selectFrom('tenants')
        .innerJoin('subscriptions', 'subscriptions.tenant_id', 'tenants.id')
        .select([
          'tenants.id',
          'tenants.code',
          'tenants.legal_name',
          'tenants.display_name',
          'tenants.base_currency',
          'tenants.time_zone',
          'subscriptions.state',
        ])
        .where('tenants.id', '=', principal.tenantId)
        .executeTakeFirstOrThrow();
      const entitlements = await this.entitlements.get(trx, principal.tenantId);
      return {
        user: { id: principal.userId, email: principal.email, displayName: principal.displayName },
        tenant: {
          id: tenant.id,
          code: tenant.code,
          legalName: tenant.legal_name,
          displayName: tenant.display_name,
          baseCurrency: tenant.base_currency,
          timeZone: tenant.time_zone,
        },
        membershipId: principal.membershipId,
        permissions: [...principal.permissions].sort(),
        subscription: { state: tenant.state, accessMode: principal.accessMode },
        entitlements,
      };
    });
  }

  async list(principal: TenantPrincipal): Promise<Member[]> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const members = await trx
        .selectFrom('memberships')
        .innerJoin('users', 'users.id', 'memberships.user_id')
        .select([
          'memberships.id as membership_id',
          'memberships.user_id',
          'memberships.status',
          'memberships.version',
          'users.email',
          'users.display_name',
        ])
        .where('memberships.tenant_id', '=', principal.tenantId)
        .orderBy('users.display_name')
        .execute();
      const roleRows = await trx
        .selectFrom('membership_roles')
        .innerJoin('roles', (join) =>
          join.onRef('roles.id', '=', 'membership_roles.role_id').onRef('roles.tenant_id', '=', 'membership_roles.tenant_id'),
        )
        .select(['membership_roles.membership_id', 'roles.code'])
        .where('membership_roles.tenant_id', '=', principal.tenantId)
        .execute();
      const rolesByMember = new Map<string, string[]>();
      for (const row of roleRows) {
        rolesByMember.set(row.membership_id, [...(rolesByMember.get(row.membership_id) ?? []), row.code]);
      }
      return members.map((member) => ({
        membershipId: member.membership_id,
        userId: member.user_id,
        email: member.email,
        displayName: member.display_name,
        status: member.status,
        roles: (rolesByMember.get(member.membership_id) ?? []).sort(),
        version: member.version,
      }));
    });
  }

  async changeStatus(
    principal: TenantPrincipal,
    membershipId: string,
    input: ChangeStatusRequest,
    correlationId: string,
  ): Promise<void> {
    await this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const membership = await trx
        .selectFrom('memberships')
        .select(['id', 'status', 'version', 'user_id'])
        .where('tenant_id', '=', principal.tenantId)
        .where('id', '=', membershipId)
        .forUpdate()
        .executeTakeFirst();
      if (!membership || membership.status === 'revoked') {
        throw notFound();
      }
      if (membership.version !== input.version) {
        throw versionConflict();
      }
      if (membership.status === input.status) {
        return;
      }
      if (input.status === 'disabled') {
        if (membership.id === principal.membershipId) {
          throw conflict('You cannot disable your own membership');
        }
        await this.assertNotLastOwner(trx, principal.tenantId, membership.id);
      } else {
        await this.entitlements.reserveSeat(trx, principal.tenantId);
      }
      await trx
        .updateTable('memberships')
        .set({ status: input.status, version: membership.version + 1, updated_at: new Date() })
        .where('id', '=', membership.id)
        .execute();
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: input.status === 'disabled' ? 'membership.disabled' : 'membership.enabled',
        entityType: 'membership',
        entityId: membership.id,
        before: { status: membership.status },
        after: { status: input.status },
        correlationId,
      });
    });
  }

  async roles(principal: TenantPrincipal): Promise<Role[]> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const roles = await trx
        .selectFrom('roles')
        .select(['id', 'code', 'name', 'is_system'])
        .where('tenant_id', '=', principal.tenantId)
        .orderBy('name')
        .execute();
      const permissions = await trx
        .selectFrom('role_permissions')
        .select(['role_id', 'permission'])
        .where('tenant_id', '=', principal.tenantId)
        .execute();
      return roles.map((role) => ({
        id: role.id,
        code: role.code,
        name: role.name,
        isSystem: role.is_system,
        permissions: permissions.filter((row) => row.role_id === role.id).map((row) => row.permission).sort(),
      }));
    });
  }

  async auditEvents(principal: TenantPrincipal, page: PaginationQuery): Promise<Page<AuditEvent>> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const total = await trx
        .selectFrom('audit_events')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('tenant_id', '=', principal.tenantId)
        .executeTakeFirstOrThrow();
      const rows = await trx
        .selectFrom('audit_events')
        .select(['id', 'actor_type', 'actor_id', 'action', 'entity_type', 'entity_id', 'outcome', 'occurred_at'])
        .where('tenant_id', '=', principal.tenantId)
        .orderBy('occurred_at', 'desc')
        .orderBy('id')
        .limit(page.limit)
        .offset(page.offset)
        .execute();
      return {
        items: rows.map((row) => ({
          id: row.id,
          actorType: row.actor_type,
          actorId: row.actor_id,
          action: row.action,
          entityType: row.entity_type,
          entityId: row.entity_id,
          outcome: row.outcome,
          occurredAt: row.occurred_at.toISOString(),
        })),
        limit: page.limit,
        offset: page.offset,
        total: Number(total.count),
      };
    });
  }

  private async assertNotLastOwner(trx: Trx, tenantId: string, membershipId: string): Promise<void> {
    const owners = await trx
      .selectFrom('membership_roles')
      .innerJoin('roles', (join) =>
        join.onRef('roles.id', '=', 'membership_roles.role_id').onRef('roles.tenant_id', '=', 'membership_roles.tenant_id'),
      )
      .innerJoin('memberships', (join) =>
        join
          .onRef('memberships.id', '=', 'membership_roles.membership_id')
          .onRef('memberships.tenant_id', '=', 'membership_roles.tenant_id'),
      )
      .select('memberships.id')
      .where('membership_roles.tenant_id', '=', tenantId)
      .where('roles.code', '=', OWNER_ROLE_CODE)
      .where('memberships.status', '=', 'active')
      .execute();
    if (owners.length === 1 && owners[0]?.id === membershipId) {
      throw conflict('The company must keep at least one active owner');
    }
  }
}
