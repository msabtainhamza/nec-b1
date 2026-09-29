import { Injectable } from '@nestjs/common';
import type { Branch, ChangeStatusRequest, CreateBranchRequest } from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { conflict, isUniqueViolation, notFound, versionConflict } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService } from '../database/database.service.js';
import { EntitlementService } from '../entitlements/entitlement.service.js';

@Injectable()
export class BranchesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
  ) {}

  async list(principal: TenantPrincipal): Promise<Branch[]> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, (trx) =>
      trx
        .selectFrom('branches')
        .select(['id', 'code', 'name', 'status', 'version'])
        .where('tenant_id', '=', principal.tenantId)
        .orderBy('code')
        .execute(),
    );
  }

  async get(principal: TenantPrincipal, branchId: string): Promise<Branch> {
    const branch = await this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, (trx) =>
      trx
        .selectFrom('branches')
        .select(['id', 'code', 'name', 'status', 'version'])
        .where('tenant_id', '=', principal.tenantId)
        .where('id', '=', branchId)
        .executeTakeFirst(),
    );
    if (!branch) {
      throw notFound();
    }
    return branch;
  }

  async create(principal: TenantPrincipal, input: CreateBranchRequest, correlationId: string): Promise<Branch> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      await this.entitlements.reserveBranch(trx, principal.tenantId);
      let branch: Branch;
      try {
        branch = await trx
          .insertInto('branches')
          .values({ tenant_id: principal.tenantId, code: input.code, name: input.name })
          .returning(['id', 'code', 'name', 'status', 'version'])
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error, 'branches_tenant_id_code_key')) {
          throw conflict(`A branch with code ${input.code} already exists`);
        }
        throw error;
      }
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'branch.created',
        entityType: 'branch',
        entityId: branch.id,
        after: { code: branch.code, name: branch.name },
        correlationId,
      });
      return branch;
    });
  }

  async changeStatus(principal: TenantPrincipal, branchId: string, input: ChangeStatusRequest, correlationId: string): Promise<Branch> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const branch = await trx
        .selectFrom('branches')
        .select(['id', 'code', 'name', 'status', 'version'])
        .where('tenant_id', '=', principal.tenantId)
        .where('id', '=', branchId)
        .forUpdate()
        .executeTakeFirst();
      if (!branch) {
        throw notFound();
      }
      if (branch.version !== input.version) {
        throw versionConflict();
      }
      if (branch.status === input.status) {
        return branch;
      }
      if (input.status === 'disabled') {
        const tenant = await trx
          .selectFrom('tenants')
          .select('default_branch_id')
          .where('id', '=', principal.tenantId)
          .executeTakeFirstOrThrow();
        if (tenant.default_branch_id === branch.id) {
          throw conflict('The default branch cannot be disabled');
        }
      } else {
        await this.entitlements.reserveBranch(trx, principal.tenantId);
      }
      const updated = await trx
        .updateTable('branches')
        .set({ status: input.status, version: branch.version + 1, updated_at: new Date() })
        .where('id', '=', branch.id)
        .returning(['id', 'code', 'name', 'status', 'version'])
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: input.status === 'disabled' ? 'branch.disabled' : 'branch.enabled',
        entityType: 'branch',
        entityId: branch.id,
        before: { status: branch.status },
        after: { status: updated.status },
        correlationId,
      });
      return updated;
    });
  }
}
