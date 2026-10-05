import { Injectable } from '@nestjs/common';
import type { CreditDecision, CreditSettings } from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { AppError, forbidden, versionConflict } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, type Trx } from '../database/database.service.js';
import { parseMoney } from '../finance/money.js';
import { customerCreditExposure } from './credit-exposure.js';

@Injectable()
export class CreditService {
  constructor(private readonly database: DatabaseService, private readonly audit: AuditService) {}

  private async settings(trx: Trx, tenantId: string): Promise<CreditSettings> {
    return await trx.selectFrom('sales_credit_settings').select(['mode', 'version']).where('tenant_id', '=', tenantId).executeTakeFirst() ?? { mode: 'disabled', version: 0 };
  }

  async get(principal: TenantPrincipal): Promise<CreditSettings> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, (trx) => this.settings(trx, principal.tenantId));
  }

  async update(principal: TenantPrincipal, input: CreditSettings, correlationId: string): Promise<CreditSettings> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId, changeCreditPolicy: true }, async (trx) => {
      const before = await this.settings(trx, principal.tenantId);
      if (before.version !== input.version) throw versionConflict();
      const after = { mode: input.mode, version: before.version + 1 };
      await trx.insertInto('sales_credit_settings').values({ tenant_id: principal.tenantId, ...after })
        .onConflict((oc) => oc.column('tenant_id').doUpdateSet(after)).execute();
      await this.audit.record(trx, { tenantId: principal.tenantId, actor: { type: 'user', id: principal.userId }, action: 'sales.credit_policy_updated', entityType: 'sales_credit_settings', entityId: principal.tenantId, before: { ...before }, after, correlationId });
      return after;
    });
  }

  async check(trx: Trx, principal: TenantPrincipal, customerId: string, decision: CreditDecision, entityType: string, entityId: string, correlationId: string): Promise<void> {
    const canOverride = principal.permissions.has('sal.credit.override');
    if (decision.creditOverrideReason && !canOverride) throw forbidden('Credit-limit override permission is required');
    const { mode } = await this.settings(trx, principal.tenantId);
    if (mode === 'disabled') return;
    const exposure = await customerCreditExposure(trx, principal.tenantId, customerId);
    if (parseMoney(exposure.remaining) >= 0n) return;
    const overridden = Boolean(decision.creditOverrideReason);
    if (!overridden && (mode === 'block' || !decision.creditAcknowledged)) {
      throw new AppError(409, 'CREDIT_LIMIT_EXCEEDED', `Credit limit ${exposure.creditLimit} would be exceeded: total exposure ${exposure.total}. ${mode === 'warn' ? 'Acknowledge the warning to continue.' : 'An authorized override with a reason is required.'}`, { mode, exposure, canOverride });
    }
    await this.audit.record(trx, {
      tenantId: principal.tenantId, actor: { type: 'user', id: principal.userId },
      action: overridden ? 'sales.credit_override' : 'sales.credit_warning_acknowledged', entityType, entityId,
      after: { customerId, mode, exposure, reason: decision.creditOverrideReason ?? null }, correlationId,
    });
  }
}
