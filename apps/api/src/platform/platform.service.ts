import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import * as OTPAuth from 'otpauth';
import {
  OWNER_ROLE_CODE,
  SYSTEM_ROLES,
  type ChangeSubscriptionRequest,
  type OperatorLoginRequest,
  type OperatorLoginResponse,
  type ProvisionTenantRequest,
  type ProvisionTenantResponse,
} from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { verifyPassword } from '../auth/crypto.js';
import { LoginLimiter } from '../auth/login-limiter.js';
import { SessionService } from '../auth/session.service.js';
import { TokenService } from '../auth/token.service.js';
import { conflict, isUniqueViolation, notFound, unauthenticated, versionConflict } from '../common/errors.js';
import type { OperatorPrincipal } from '../common/request-context.js';
import { applyContext, DatabaseService } from '../database/database.service.js';
import { InvitationsService, type PendingInvitationMail } from '../tenancy/invitations.service.js';

const TOTP_PERIOD_SECONDS = 30;

export interface PlatformTenant {
  id: string;
  code: string;
  displayName: string;
  status: string;
  planCode: string;
  subscriptionState: string;
  subscriptionVersion: number;
  createdAt: string;
}

@Injectable()
export class PlatformService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly limiter: LoginLimiter,
    private readonly audit: AuditService,
    private readonly invitations: InvitationsService,
  ) {}

  async login(input: OperatorLoginRequest, userAgent: string | null): Promise<OperatorLoginResponse> {
    const limiterKey = `operator:${input.email}`;
    this.limiter.assertAllowed(limiterKey);
    const operator = await this.database.db
      .selectFrom('platform_operators')
      .selectAll()
      .where('email', '=', input.email)
      .executeTakeFirst();
    const passwordValid = await verifyPassword(operator?.password_hash ?? null, input.password);
    if (!operator || !passwordValid || operator.status !== 'active') {
      this.limiter.recordFailure(limiterKey);
      throw unauthenticated('The credentials are incorrect');
    }
    const result = await this.database.db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom('platform_operators')
        .select(['totp_secret', 'totp_last_counter'])
        .where('id', '=', operator.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const counter = validateTotp(locked.totp_secret, input.totp);
      const lastCounter = locked.totp_last_counter === null ? -1 : Number(locked.totp_last_counter);
      if (counter === null || counter <= lastCounter) {
        await this.audit.recordPlatform(trx, {
          operatorId: operator.id,
          action: 'operator.login',
          targetType: 'operator',
          targetId: operator.id,
          outcome: 'denied',
          details: { reason: 'mfa' },
        });
        return null;
      }
      await trx.updateTable('platform_operators').set({ totp_last_counter: counter }).where('id', '=', operator.id).execute();
      const session = await this.sessions.create(trx, { type: 'operator', operatorId: operator.id }, userAgent);
      await this.audit.recordPlatform(trx, {
        operatorId: operator.id,
        action: 'operator.login',
        targetType: 'operator',
        targetId: operator.id,
      });
      return session;
    });
    if (!result) {
      this.limiter.recordFailure(limiterKey);
      throw unauthenticated('The credentials are incorrect');
    }
    this.limiter.clear(limiterKey);
    const accessToken = await this.tokens.sign({
      subject: operator.id,
      sessionId: result.sessionId,
      tenantId: null,
      audience: 'erp-platform',
    });
    return {
      accessToken,
      accessTokenExpiresIn: this.tokens.accessTtlSeconds,
      refreshToken: result.refreshToken,
      operator: { id: operator.id, email: operator.email, displayName: operator.display_name },
    };
  }

  async listTenants(): Promise<PlatformTenant[]> {
    const rows = await this.database.db
      .selectFrom('tenants')
      .innerJoin('subscriptions', 'subscriptions.tenant_id', 'tenants.id')
      .innerJoin('plans', 'plans.id', 'subscriptions.plan_id')
      .select([
        'tenants.id',
        'tenants.code',
        'tenants.display_name',
        'tenants.status',
        'tenants.created_at',
        'plans.code as plan_code',
        'subscriptions.state',
        'subscriptions.version',
      ])
      .orderBy('tenants.code')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      displayName: row.display_name,
      status: row.status,
      planCode: row.plan_code,
      subscriptionState: row.state,
      subscriptionVersion: row.version,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async provision(
    operator: OperatorPrincipal,
    input: ProvisionTenantRequest,
    correlationId: string,
  ): Promise<ProvisionTenantResponse & { mailSent: boolean }> {
    const { response, mail } = await this.provisionWithin(operator.operatorId, input, correlationId);
    const mailSent = await this.invitations.sendInvitation(mail, correlationId);
    return { ...response, mailSent };
  }

  async provisionWithin(
    operatorId: string,
    input: ProvisionTenantRequest,
    correlationId: string | null,
  ): Promise<{ response: ProvisionTenantResponse; mail: PendingInvitationMail }> {
    try {
      return await this.database.db.transaction().execute(async (trx) => {
        const plan = await trx.selectFrom('plans').selectAll().where('code', '=', input.planCode).executeTakeFirst();
        if (!plan) {
          throw notFound(`Plan ${input.planCode} was not found`);
        }
        const tenant = await trx
          .insertInto('tenants')
          .values({
            code: input.code,
            legal_name: input.legalName,
            display_name: input.displayName,
            base_currency: input.baseCurrency,
            time_zone: input.timeZone,
            created_by_operator_id: operatorId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('subscriptions')
          .values({ tenant_id: tenant.id, plan_id: plan.id, state: input.subscriptionState })
          .execute();
        await trx
          .insertInto('tenant_entitlements')
          .values({
            tenant_id: tenant.id,
            modules: plan.modules,
            max_active_seats: plan.max_active_seats,
            max_employees: plan.max_employees,
            max_branches: plan.max_branches,
            max_storage_bytes: plan.max_storage_bytes,
          })
          .execute();
        await applyContext(trx, { tenantId: tenant.id });
        const branch = await trx
          .insertInto('branches')
          .values({ tenant_id: tenant.id, code: input.defaultBranch.code, name: input.defaultBranch.name })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx.updateTable('tenants').set({ default_branch_id: branch.id }).where('id', '=', tenant.id).execute();
        let ownerRoleId: string | null = null;
        for (const definition of SYSTEM_ROLES) {
          const role = await trx
            .insertInto('roles')
            .values({ tenant_id: tenant.id, code: definition.code, name: definition.name, is_system: true })
            .returning('id')
            .executeTakeFirstOrThrow();
          await trx
            .insertInto('role_permissions')
            .values(definition.permissions.map((permission) => ({ tenant_id: tenant.id, role_id: role.id, permission })))
            .execute();
          if (definition.code === OWNER_ROLE_CODE) {
            ownerRoleId = role.id;
          }
        }
        await trx
          .insertInto('bp_groups')
          .values([
            { tenant_id: tenant.id, code: 'CUSTOMERS', name: 'Customers', partner_type: 'customer' },
            { tenant_id: tenant.id, code: 'SUPPLIERS', name: 'Suppliers', partner_type: 'supplier' },
          ])
          .execute();
        await trx
          .insertInto('payment_terms')
          .values([
            { tenant_id: tenant.id, code: 'IMMEDIATE', name: 'Immediate', due_days: 0 },
            { tenant_id: tenant.id, code: 'NET30', name: 'Net 30 days', due_days: 30 },
          ])
          .execute();
        await sql`select seed_finance_defaults(${tenant.id}::uuid, extract(year from now())::integer)`.execute(trx);
        await sql`select seed_inventory_defaults(${tenant.id}::uuid)`.execute(trx);
        await sql`select seed_purchasing_defaults(${tenant.id}::uuid)`.execute(trx);
        await sql`select seed_ap_defaults(${tenant.id}::uuid)`.execute(trx);
        await sql`select seed_tax_defaults(${tenant.id}::uuid)`.execute(trx);
        if (ownerRoleId === null) {
          throw new Error('System role definitions must include an owner role');
        }
        const invitation = await this.invitations.createWithin(trx, {
          tenantId: tenant.id,
          email: input.ownerEmail,
          roleIds: [ownerRoleId],
          actor: { type: 'operator', id: operatorId },
          correlationId,
        });
        await this.audit.record(trx, {
          tenantId: tenant.id,
          actor: { type: 'operator', id: operatorId },
          action: 'tenant.provisioned',
          entityType: 'tenant',
          entityId: tenant.id,
          after: { code: input.code, planCode: input.planCode, defaultBranch: input.defaultBranch.code },
          correlationId,
        });
        await this.audit.recordPlatform(trx, {
          operatorId,
          action: 'tenant.provisioned',
          targetType: 'tenant',
          targetId: tenant.id,
          tenantId: tenant.id,
          details: { code: input.code, planCode: input.planCode, subscriptionState: input.subscriptionState },
          correlationId,
        });
        return {
          response: { tenantId: tenant.id, ownerInvitation: invitation.response },
          mail: invitation.mail,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'tenants_code_key')) {
        throw conflict(`A tenant with code ${input.code} already exists`);
      }
      throw error;
    }
  }

  async changeSubscription(
    operator: OperatorPrincipal,
    tenantId: string,
    input: ChangeSubscriptionRequest,
    correlationId: string,
  ): Promise<void> {
    await this.database.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('subscriptions')
        .select(['state', 'version', 'retention_ends_at'])
        .where('tenant_id', '=', tenantId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) {
        throw notFound();
      }
      if (current.version !== input.version) {
        throw versionConflict();
      }
      const retentionEndsAt = input.retentionEndsAt === undefined ? current.retention_ends_at : input.retentionEndsAt;
      await trx
        .updateTable('subscriptions')
        .set({
          state: input.state,
          retention_ends_at: retentionEndsAt,
          state_changed_at: new Date(),
          version: current.version + 1,
        })
        .where('tenant_id', '=', tenantId)
        .execute();
      await this.audit.recordPlatform(trx, {
        operatorId: operator.operatorId,
        action: 'subscription.changed',
        targetType: 'subscription',
        targetId: tenantId,
        tenantId,
        details: {
          reason: input.reason,
          before: { state: current.state, retentionEndsAt: current.retention_ends_at },
          after: { state: input.state, retentionEndsAt },
        },
        correlationId,
      });
    });
  }
}

function validateTotp(secret: string, token: string): number | null {
  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    algorithm: 'SHA1',
    digits: 6,
    period: TOTP_PERIOD_SECONDS,
  });
  const delta = totp.validate({ token, window: 1 });
  if (delta === null) {
    return null;
  }
  return Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS) + delta;
}
