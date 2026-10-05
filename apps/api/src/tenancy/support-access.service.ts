import { Injectable } from '@nestjs/common';
import type { GrantSupportAccessRequest, SupportGrant, SupportSessionRequest, SupportSessionResponse } from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { TokenService } from '../auth/token.service.js';
import { AppError, conflict, notFound } from '../common/errors.js';
import type { OperatorPrincipal, TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, type Trx } from '../database/database.service.js';

@Injectable()
export class SupportAccessService {
  constructor(
    private readonly database: DatabaseService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async activeGrant(trx: Trx, tenantId: string, grantId?: string): Promise<{ id: string; expires_at: Date } | null> {
    let query = trx
      .selectFrom('support_grants')
      .select(['id', 'expires_at'])
      .where('tenant_id', '=', tenantId)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', new Date());
    if (grantId) query = query.where('id', '=', grantId);
    return (await query.orderBy('expires_at', 'desc').executeTakeFirst()) ?? null;
  }

  async list(principal: TenantPrincipal): Promise<SupportGrant[]> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const rows = await trx
        .selectFrom('support_grants as g')
        .innerJoin('users as u', 'u.id', 'g.granted_by')
        .select(['g.id', 'u.display_name', 'g.reason', 'g.created_at', 'g.expires_at', 'g.revoked_at'])
        .where('g.tenant_id', '=', principal.tenantId)
        .orderBy('g.created_at', 'desc')
        .limit(50)
        .execute();
      const now = new Date();
      return rows.map((row) => ({
        id: row.id,
        grantedBy: row.display_name,
        reason: row.reason,
        createdAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
        active: row.revoked_at === null && row.expires_at > now,
      }));
    });
  }

  async grant(principal: TenantPrincipal, input: GrantSupportAccessRequest, correlationId: string): Promise<SupportGrant> {
    const id = await this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const expiresAt = new Date(Date.now() + input.hours * 3600 * 1000);
      const row = await trx
        .insertInto('support_grants')
        .values({ tenant_id: principal.tenantId, granted_by: principal.userId, reason: input.reason, expires_at: expiresAt })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'support_access.granted',
        entityType: 'support_grant',
        entityId: row.id,
        after: { reason: input.reason, expiresAt: expiresAt.toISOString() },
        correlationId,
      });
      return row.id;
    });
    return (await this.list(principal)).find((grant) => grant.id === id) as SupportGrant;
  }

  async revoke(principal: TenantPrincipal, grantId: string, correlationId: string): Promise<void> {
    await this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const grant = await trx.selectFrom('support_grants').select(['id', 'revoked_at']).where('tenant_id', '=', principal.tenantId).where('id', '=', grantId).forUpdate().executeTakeFirst();
      if (!grant) throw notFound();
      if (grant.revoked_at) throw conflict('This support access was already revoked');
      await trx.updateTable('support_grants').set({ revoked_at: new Date(), revoked_by: principal.userId }).where('tenant_id', '=', principal.tenantId).where('id', '=', grantId).execute();
      await this.audit.record(trx, { tenantId: principal.tenantId, actor: { type: 'user', id: principal.userId }, action: 'support_access.revoked', entityType: 'support_grant', entityId: grantId, correlationId });
    });
  }

  async openSession(operator: OperatorPrincipal, tenantId: string, input: SupportSessionRequest, correlationId: string): Promise<SupportSessionResponse> {
    const tenant = await this.database.db.selectFrom('tenants').select(['id', 'code', 'display_name']).where('id', '=', tenantId).executeTakeFirst();
    if (!tenant) throw notFound();
    const grant = await this.database.withContext({ tenantId, userId: null }, async (trx) => {
      const active = await this.activeGrant(trx, tenantId);
      if (!active) return null;
      await this.audit.record(trx, {
        tenantId,
        actor: { type: 'operator', id: operator.operatorId },
        action: 'support_access.session_started',
        entityType: 'support_grant',
        entityId: active.id,
        after: { operator: operator.email, reason: input.reason },
        correlationId,
      });
      await this.audit.recordPlatform(trx, { operatorId: operator.operatorId, action: 'support.session_started', targetType: 'tenant', targetId: tenantId, tenantId, details: { grantId: active.id, reason: input.reason }, correlationId });
      return active;
    });
    if (!grant) throw new AppError(403, 'SUPPORT_NOT_AUTHORIZED', 'The company has not granted support access, or the grant has expired or was revoked');
    const accessToken = await this.tokens.sign({ subject: operator.operatorId, sessionId: operator.sessionId, tenantId, audience: 'erp-support', grantId: grant.id });
    return {
      accessToken,
      accessTokenExpiresIn: Math.min(this.tokens.accessTtlSeconds, Math.floor((grant.expires_at.getTime() - Date.now()) / 1000)),
      grantId: grant.id,
      tenant: { tenantId: tenant.id, code: tenant.code, displayName: tenant.display_name },
    };
  }
}
