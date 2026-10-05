import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { OWNER_ROLE_CODE, type ChangeMemberRolesRequest, type CreateRoleRequest, type Permission, type Role, type UpdateRoleRequest } from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { conflict, forbidden, isUniqueViolation, notFound, versionConflict } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, lockTenantResource, type Trx } from '../database/database.service.js';

@Injectable()
export class RolesService {
  constructor(private readonly database: DatabaseService, private readonly audit: AuditService) {}

  private run<T>(principal: TenantPrincipal, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      await lockTenantResource(trx, principal.tenantId, 'roles');
      return fn(trx);
    });
  }

  private assertHeld(principal: TenantPrincipal, permissions: readonly string[]): void {
    if (permissions.some((permission) => !principal.permissions.has(permission as Permission))) throw forbidden('You cannot grant or change permissions that you do not hold');
  }

  private async load(trx: Trx, tenantId: string, roleId: string): Promise<Role> {
    const role = await trx.selectFrom('roles').select(['id', 'code', 'name', 'is_system']).where('tenant_id', '=', tenantId).where('id', '=', roleId).forUpdate().executeTakeFirst();
    if (!role) throw notFound();
    const permissions = await trx.selectFrom('role_permissions').select('permission').where('tenant_id', '=', tenantId).where('role_id', '=', roleId).execute();
    return { id: role.id, code: role.code, name: role.name, isSystem: role.is_system, permissions: permissions.map((row) => row.permission).sort() };
  }

  async create(principal: TenantPrincipal, input: CreateRoleRequest, correlationId: string): Promise<Role> {
    this.assertHeld(principal, input.permissions);
    return this.run(principal, async (trx) => {
      let created: { id: string };
      try {
        created = await trx.insertInto('roles').values({ tenant_id: principal.tenantId, code: input.code, name: input.name, is_system: false }).returning('id').executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict(`A role with code ${input.code} already exists`);
        throw error;
      }
      await trx.insertInto('role_permissions').values(input.permissions.map((permission) => ({ tenant_id: principal.tenantId, role_id: created.id, permission }))).execute();
      const role = await this.load(trx, principal.tenantId, created.id);
      await this.audit.record(trx, { tenantId: principal.tenantId, actor: { type: 'user', id: principal.userId }, action: 'role.created', entityType: 'role', entityId: role.id, after: { ...role }, correlationId });
      return role;
    });
  }

  async update(principal: TenantPrincipal, roleId: string, input: UpdateRoleRequest, correlationId: string): Promise<Role> {
    return this.run(principal, async (trx) => {
      const before = await this.load(trx, principal.tenantId, roleId);
      if (before.isSystem) throw conflict('System roles cannot be changed; create a custom role instead');
      this.assertHeld(principal, [...before.permissions, ...input.permissions]);
      await trx.updateTable('roles').set({ name: input.name }).where('tenant_id', '=', principal.tenantId).where('id', '=', roleId).execute();
      await trx.deleteFrom('role_permissions').where('tenant_id', '=', principal.tenantId).where('role_id', '=', roleId).execute();
      await trx.insertInto('role_permissions').values(input.permissions.map((permission) => ({ tenant_id: principal.tenantId, role_id: roleId, permission }))).execute();
      const after = await this.load(trx, principal.tenantId, roleId);
      await this.audit.record(trx, { tenantId: principal.tenantId, actor: { type: 'user', id: principal.userId }, action: 'role.updated', entityType: 'role', entityId: roleId, before: { ...before }, after: { ...after }, correlationId });
      return after;
    });
  }

  async remove(principal: TenantPrincipal, roleId: string, correlationId: string): Promise<void> {
    await this.run(principal, async (trx) => {
      const role = await this.load(trx, principal.tenantId, roleId);
      if (role.isSystem) throw conflict('System roles cannot be deleted');
      this.assertHeld(principal, role.permissions);
      const used = await trx.selectFrom('membership_roles').select('role_id').where('tenant_id', '=', principal.tenantId).where('role_id', '=', roleId).executeTakeFirst();
      const invited = await trx
        .selectFrom('invitations')
        .select('id')
        .where('tenant_id', '=', principal.tenantId)
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', new Date())
        .where(sql<boolean>`${roleId}::uuid = any(role_ids)`)
        .executeTakeFirst();
      if (used || invited) throw conflict(`Role ${role.name} is assigned to users or pending invitations; remove it from them first`);
      await trx.deleteFrom('role_permissions').where('tenant_id', '=', principal.tenantId).where('role_id', '=', roleId).execute();
      await trx.deleteFrom('roles').where('tenant_id', '=', principal.tenantId).where('id', '=', roleId).execute();
      await this.audit.record(trx, { tenantId: principal.tenantId, actor: { type: 'user', id: principal.userId }, action: 'role.deleted', entityType: 'role', entityId: roleId, before: { ...role }, correlationId });
    });
  }

  async changeMemberRoles(principal: TenantPrincipal, membershipId: string, input: ChangeMemberRolesRequest, correlationId: string): Promise<void> {
    await this.run(principal, async (trx) => {
      const tenantId = principal.tenantId;
      const membership = await trx.selectFrom('memberships').select(['id', 'status', 'version']).where('tenant_id', '=', tenantId).where('id', '=', membershipId).forUpdate().executeTakeFirst();
      if (!membership || membership.status === 'revoked') throw notFound();
      if (membership.version !== input.version) throw versionConflict();
      const roleIds = [...new Set(input.roleIds)];
      const roles = await trx.selectFrom('roles').select(['id', 'code']).where('tenant_id', '=', tenantId).where('id', 'in', roleIds).execute();
      if (roles.length !== roleIds.length) throw notFound('One or more roles were not found');
      const permissions = async (ids: string[]) =>
        ids.length === 0 ? [] : (await trx.selectFrom('role_permissions').select('permission').distinct().where('tenant_id', '=', tenantId).where('role_id', 'in', ids).execute()).map((row) => row.permission);
      const current = (await trx.selectFrom('membership_roles').select('role_id').where('tenant_id', '=', tenantId).where('membership_id', '=', membershipId).execute()).map((row) => row.role_id);
      this.assertHeld(principal, [...(await permissions(current)), ...(await permissions(roleIds))]);
      await trx.deleteFrom('membership_roles').where('tenant_id', '=', tenantId).where('membership_id', '=', membershipId).execute();
      await trx.insertInto('membership_roles').values(roleIds.map((roleId) => ({ tenant_id: tenantId, membership_id: membershipId, role_id: roleId }))).execute();
      const owners = await trx
        .selectFrom('membership_roles as mr')
        .innerJoin('roles as r', (join) => join.onRef('r.id', '=', 'mr.role_id').onRef('r.tenant_id', '=', 'mr.tenant_id'))
        .innerJoin('memberships as m', (join) => join.onRef('m.id', '=', 'mr.membership_id').onRef('m.tenant_id', '=', 'mr.tenant_id'))
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('mr.tenant_id', '=', tenantId)
        .where('r.code', '=', OWNER_ROLE_CODE)
        .where('m.status', '=', 'active')
        .executeTakeFirstOrThrow();
      if (Number(owners.count) === 0) throw conflict('The company must keep at least one active owner');
      await trx.updateTable('memberships').set({ version: membership.version + 1, updated_at: new Date() }).where('id', '=', membershipId).execute();
      await this.audit.record(trx, {
        tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'membership.roles_changed',
        entityType: 'membership',
        entityId: membershipId,
        before: { roleIds: current },
        after: { roleIds, roles: roles.map((role) => role.code).sort() },
        correlationId,
      });
    });
  }
}
