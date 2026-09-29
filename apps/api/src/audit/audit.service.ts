import { Injectable } from '@nestjs/common';
import type { Trx } from '../database/database.service.js';

export interface AuditActor {
  type: 'user' | 'operator' | 'system';
  id: string | null;
}

export interface TenantAuditEntry {
  tenantId: string;
  actor: AuditActor;
  action: string;
  entityType: string;
  entityId: string | null;
  outcome?: 'success' | 'failure' | 'denied';
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  correlationId?: string | null;
}

export interface PlatformAuditEntry {
  operatorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  tenantId?: string | null;
  outcome?: 'success' | 'failure' | 'denied';
  details?: Record<string, unknown>;
  correlationId?: string | null;
}

@Injectable()
export class AuditService {
  async record(trx: Trx, entry: TenantAuditEntry): Promise<void> {
    await trx
      .insertInto('audit_events')
      .values({
        tenant_id: entry.tenantId,
        actor_type: entry.actor.type,
        actor_id: entry.actor.id,
        action: entry.action,
        entity_type: entry.entityType,
        entity_id: entry.entityId,
        outcome: entry.outcome ?? 'success',
        before_data: entry.before ? JSON.stringify(entry.before) : null,
        after_data: entry.after ? JSON.stringify(entry.after) : null,
        correlation_id: entry.correlationId ?? null,
      })
      .execute();
  }

  async recordPlatform(trx: Trx, entry: PlatformAuditEntry): Promise<void> {
    await trx
      .insertInto('platform_audit_events')
      .values({
        operator_id: entry.operatorId,
        action: entry.action,
        target_type: entry.targetType,
        target_id: entry.targetId,
        tenant_id: entry.tenantId ?? null,
        outcome: entry.outcome ?? 'success',
        details: JSON.stringify(entry.details ?? {}),
        correlation_id: entry.correlationId ?? null,
      })
      .execute();
  }
}
