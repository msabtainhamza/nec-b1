import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { DeletionRequest, RestoreTenantRequest } from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { AppError, conflict, notFound } from '../common/errors.js';
import type { OperatorPrincipal, TenantPrincipal } from '../common/request-context.js';
import { DatabaseService } from '../database/database.service.js';

const EXCLUDED_TABLES = new Set(['idempotency_keys']);
const EXCLUDED_COLUMNS = new Set(['token_hash', 'password_hash', 'secret_encrypted']);

@Injectable()
export class TenantLifecycleService {
  constructor(private readonly database: DatabaseService, private readonly audit: AuditService) {}

  async export(principal: TenantPrincipal, correlationId: string): Promise<Record<string, unknown>> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const tenant = await trx.selectFrom('tenants').select(['id', 'code', 'legal_name', 'display_name', 'base_currency', 'time_zone', 'status']).where('id', '=', principal.tenantId).executeTakeFirstOrThrow();
      const columns = await sql<{ table_name: string; column_name: string }>`
        select c.table_name, c.column_name from information_schema.columns c
        join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
        where c.table_schema = 'public' and c.table_name in (
          select table_name from information_schema.columns where table_schema = 'public' and column_name = 'tenant_id'
        )
        order by c.table_name, c.ordinal_position`.execute(trx);
      const byTable = new Map<string, string[]>();
      for (const row of columns.rows) {
        if (EXCLUDED_TABLES.has(row.table_name) || EXCLUDED_COLUMNS.has(row.column_name)) continue;
        byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row.column_name]);
      }
      const tables: Record<string, unknown[]> = {};
      let rowCount = 0;
      for (const [table, names] of byTable) {
        const result = await sql<Record<string, unknown>>`select ${sql.join(names.map((name) => sql.ref(name)))} from ${sql.table(table)} where tenant_id = ${principal.tenantId}`.execute(trx);
        tables[table] = result.rows;
        rowCount += result.rows.length;
      }
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'tenant.exported',
        entityType: 'tenant',
        entityId: principal.tenantId,
        after: { tables: byTable.size, rows: rowCount },
        correlationId,
      });
      return {
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        tenant: { id: tenant.id, code: tenant.code, legalName: tenant.legal_name, displayName: tenant.display_name, baseCurrency: tenant.base_currency, timeZone: tenant.time_zone, status: tenant.status },
        tables,
      };
    });
  }

  async requestDeletion(principal: TenantPrincipal, input: DeletionRequest, correlationId: string): Promise<void> {
    await this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const tenant = await trx.selectFrom('tenants').select(['code', 'status']).where('id', '=', principal.tenantId).forUpdate().executeTakeFirstOrThrow();
      if (input.confirmCode !== tenant.code) throw new AppError(400, 'VALIDATION_FAILED', 'Type the company code exactly to confirm', [{ path: 'confirmCode', message: 'Does not match the company code' }]);
      if (tenant.status !== 'active') throw conflict('Deletion can only be requested for an active company');
      await trx.updateTable('tenants').set({ status: 'deletion_requested', updated_at: new Date() }).where('id', '=', principal.tenantId).execute();
      await this.audit.record(trx, { tenantId: principal.tenantId, actor: { type: 'user', id: principal.userId }, action: 'tenant.deletion_requested', entityType: 'tenant', entityId: principal.tenantId, after: { reason: input.reason }, correlationId });
      await this.audit.recordPlatform(trx, { operatorId: null, action: 'tenant.deletion_requested', targetType: 'tenant', targetId: principal.tenantId, tenantId: principal.tenantId, details: { requestedBy: principal.userId, reason: input.reason }, correlationId });
    });
  }

  async restore(operator: OperatorPrincipal, tenantId: string, input: RestoreTenantRequest, correlationId: string): Promise<void> {
    await this.database.withContext({ tenantId, userId: null }, async (trx) => {
      const tenant = await trx.selectFrom('tenants').select(['status']).where('id', '=', tenantId).forUpdate().executeTakeFirst();
      if (!tenant) throw notFound();
      if (tenant.status === 'active') throw conflict('The company is already active');
      await trx.updateTable('tenants').set({ status: 'active', updated_at: new Date() }).where('id', '=', tenantId).execute();
      await this.audit.record(trx, { tenantId, actor: { type: 'operator', id: operator.operatorId }, action: 'tenant.restored', entityType: 'tenant', entityId: tenantId, before: { status: tenant.status }, after: { status: 'active', reason: input.reason }, correlationId });
      await this.audit.recordPlatform(trx, { operatorId: operator.operatorId, action: 'tenant.restored', targetType: 'tenant', targetId: tenantId, tenantId, details: { from: tenant.status, reason: input.reason }, correlationId });
    });
  }
}
