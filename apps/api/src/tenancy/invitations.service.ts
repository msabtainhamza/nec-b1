import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  AcceptInvitationRequest,
  AcceptInvitationResponse,
  CreateInvitationRequest,
  CreateInvitationResponse,
  Permission,
} from '@nec/contracts';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { hashPassword, generateToken, hashToken, verifyPassword } from '../auth/crypto.js';
import { AppError, conflict, forbidden, isUniqueViolation, notFound } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { applyContext, DatabaseService, type Trx } from '../database/database.service.js';
import { EntitlementService } from '../entitlements/entitlement.service.js';
import { MailDispatcher } from '../mail/mailer.js';

export interface PendingInvitationMail {
  email: string;
  token: string;
  tenantDisplayName: string;
  expiresAt: Date;
}

export interface InvitationSummary {
  id: string;
  email: string;
  expiresAt: string;
  createdAt: string;
}

@Injectable()
export class InvitationsService {
  private readonly ttlMs: number;

  constructor(
    private readonly database: DatabaseService,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
    private readonly mail: MailDispatcher,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.ttlMs = config.INVITATION_TTL_HOURS * 60 * 60 * 1000;
  }

  async create(principal: TenantPrincipal, input: CreateInvitationRequest, correlationId: string): Promise<CreateInvitationResponse> {
    const { response, mail } = await this.database.withContext(
      { tenantId: principal.tenantId, userId: principal.userId },
      async (trx) => {
        await this.assertGrantable(trx, principal.tenantId, input.roleIds, principal.permissions);
        return this.createWithin(trx, {
          tenantId: principal.tenantId,
          email: input.email,
          roleIds: input.roleIds,
          actor: { type: 'user', id: principal.userId },
          correlationId,
        });
      },
    );
    await this.sendInvitation(mail, correlationId);
    return response;
  }

  async createWithin(
    trx: Trx,
    input: { tenantId: string; email: string; roleIds: string[]; actor: AuditActor; correlationId: string | null },
  ): Promise<{ response: CreateInvitationResponse; mail: PendingInvitationMail }> {
    const tenant = await trx
      .selectFrom('tenants')
      .select('display_name')
      .where('id', '=', input.tenantId)
      .executeTakeFirstOrThrow();
    const existingMember = await trx
      .selectFrom('memberships')
      .innerJoin('users', 'users.id', 'memberships.user_id')
      .select('memberships.id')
      .where('memberships.tenant_id', '=', input.tenantId)
      .where('users.email', '=', input.email)
      .where('memberships.status', '=', 'active')
      .executeTakeFirst();
    if (existingMember) {
      throw conflict('This person is already an active member of the company');
    }
    await trx
      .updateTable('invitations')
      .set({ revoked_at: sql<Date>`now()` })
      .where('tenant_id', '=', input.tenantId)
      .where('email', '=', input.email)
      .where('accepted_at', 'is', null)
      .where('revoked_at', 'is', null)
      .where('expires_at', '<=', sql<Date>`now()`)
      .execute();
    await this.entitlements.reserveSeat(trx, input.tenantId);
    const token = generateToken();
    const expiresAt = new Date(Date.now() + this.ttlMs);
    let invitation: { id: string };
    try {
      invitation = await trx
        .insertInto('invitations')
        .values({
          tenant_id: input.tenantId,
          email: input.email,
          role_ids: input.roleIds,
          token_hash: hashToken(token),
          invited_by_user_id: input.actor.type === 'user' ? input.actor.id : null,
          invited_by_operator_id: input.actor.type === 'operator' ? input.actor.id : null,
          expires_at: expiresAt,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    } catch (error) {
      if (isUniqueViolation(error, 'invitations_pending_email_key')) {
        throw conflict('A pending invitation already exists for this email');
      }
      throw error;
    }
    await this.audit.record(trx, {
      tenantId: input.tenantId,
      actor: input.actor,
      action: 'invitation.created',
      entityType: 'invitation',
      entityId: invitation.id,
      after: { email: input.email, roleIds: input.roleIds, expiresAt: expiresAt.toISOString() },
      correlationId: input.correlationId,
    });
    return {
      response: { invitationId: invitation.id, email: input.email, expiresAt: expiresAt.toISOString() },
      mail: { email: input.email, token, tenantDisplayName: tenant.display_name, expiresAt },
    };
  }

  async sendInvitation(mail: PendingInvitationMail, correlationId: string | null): Promise<boolean> {
    return this.mail.dispatch(
      {
        to: mail.email,
        subject: `You have been invited to ${mail.tenantDisplayName}`,
        text: [
          `You have been invited to join ${mail.tenantDisplayName}.`,
          '',
          'Open the desktop application, choose "Accept invitation" and paste this code:',
          '',
          mail.token,
          '',
          `The invitation expires at ${mail.expiresAt.toISOString()}.`,
        ].join('\n'),
      },
      correlationId,
    );
  }

  async accept(input: AcceptInvitationRequest, correlationId: string): Promise<AcceptInvitationResponse> {
    const tokenHash = hashToken(input.token);
    return this.database.withContext({ invitationTokenHash: tokenHash }, async (trx) => {
      const invitation = await trx
        .selectFrom('invitations')
        .selectAll()
        .where('token_hash', '=', tokenHash)
        .executeTakeFirst();
      const now = new Date();
      if (!invitation || invitation.accepted_at !== null || invitation.revoked_at !== null || invitation.expires_at <= now) {
        throw new AppError(400, 'INVITATION_INVALID', 'The invitation code is invalid or has expired');
      }
      const tenantId = invitation.tenant_id;
      await applyContext(trx, { tenantId, invitationTokenHash: tokenHash });
      await this.entitlements.reserveSeat(trx, tenantId, 1);

      let user = await trx
        .selectFrom('users')
        .select(['id', 'password_hash', 'status', 'email_verified_at'])
        .where('email', '=', invitation.email)
        .executeTakeFirst();
      if (user) {
        if (user.status !== 'active' || !(await verifyPassword(user.password_hash, input.password))) {
          throw new AppError(400, 'INVITATION_INVALID', 'Enter the existing password for this email to accept');
        }
        if (user.email_verified_at === null) {
          await trx.updateTable('users').set({ email_verified_at: now, updated_at: now }).where('id', '=', user.id).execute();
        }
      } else {
        if (!input.displayName) {
          throw new AppError(400, 'VALIDATION_FAILED', 'A display name is required for a new account', [
            { path: 'displayName', message: 'Required' },
          ]);
        }
        const created = await trx
          .insertInto('users')
          .values({
            email: invitation.email,
            display_name: input.displayName,
            password_hash: await hashPassword(input.password),
            email_verified_at: now,
          })
          .returning(['id', 'password_hash', 'status', 'email_verified_at'])
          .executeTakeFirstOrThrow();
        user = created;
      }
      await applyContext(trx, { tenantId, userId: user.id, invitationTokenHash: tokenHash });

      if (invitation.role_ids.length === 0) {
        throw new AppError(400, 'INVITATION_INVALID', 'The invitation does not grant any role');
      }
      const roles = await trx
        .selectFrom('roles')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('id', 'in', invitation.role_ids)
        .execute();
      if (roles.length !== invitation.role_ids.length) {
        throw new AppError(400, 'INVITATION_INVALID', 'The invitation refers to roles that no longer exist');
      }

      const existing = await trx
        .selectFrom('memberships')
        .select(['id', 'status', 'version'])
        .where('tenant_id', '=', tenantId)
        .where('user_id', '=', user.id)
        .forUpdate()
        .executeTakeFirst();
      let membershipId: string;
      if (existing) {
        if (existing.status === 'active') {
          throw conflict('You are already a member of this company');
        }
        await trx
          .updateTable('memberships')
          .set({ status: 'active', updated_at: now, version: existing.version + 1 })
          .where('id', '=', existing.id)
          .execute();
        await trx.deleteFrom('membership_roles').where('tenant_id', '=', tenantId).where('membership_id', '=', existing.id).execute();
        membershipId = existing.id;
      } else {
        const created = await trx
          .insertInto('memberships')
          .values({ tenant_id: tenantId, user_id: user.id })
          .returning('id')
          .executeTakeFirstOrThrow();
        membershipId = created.id;
      }
      await trx
        .insertInto('membership_roles')
        .values(roles.map((role) => ({ tenant_id: tenantId, membership_id: membershipId, role_id: role.id })))
        .execute();
      await trx
        .updateTable('invitations')
        .set({ accepted_at: now, accepted_user_id: user.id })
        .where('id', '=', invitation.id)
        .execute();
      await this.audit.record(trx, {
        tenantId,
        actor: { type: 'user', id: user.id },
        action: 'invitation.accepted',
        entityType: 'membership',
        entityId: membershipId,
        after: { invitationId: invitation.id, roleIds: invitation.role_ids },
        correlationId,
      });
      return { tenantId, membershipId, userId: user.id };
    });
  }

  async listPending(principal: TenantPrincipal): Promise<InvitationSummary[]> {
    const rows = await this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, (trx) =>
      trx
        .selectFrom('invitations')
        .select(['id', 'email', 'expires_at', 'created_at'])
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', sql<Date>`now()`)
        .orderBy('created_at', 'desc')
        .execute(),
    );
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      expiresAt: row.expires_at.toISOString(),
      createdAt: row.created_at.toISOString(),
    }));
  }

  async revoke(principal: TenantPrincipal, invitationId: string, correlationId: string): Promise<void> {
    await this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const updated = await trx
        .updateTable('invitations')
        .set({ revoked_at: sql<Date>`now()` })
        .where('id', '=', invitationId)
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .returning('email')
        .executeTakeFirst();
      if (!updated) {
        throw notFound();
      }
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'invitation.revoked',
        entityType: 'invitation',
        entityId: invitationId,
        before: { email: updated.email },
        correlationId,
      });
    });
  }

  async assertGrantable(trx: Trx, tenantId: string, roleIds: string[], held: ReadonlySet<Permission>): Promise<void> {
    const unique = [...new Set(roleIds)];
    const roles = await trx
      .selectFrom('roles')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('id', 'in', unique)
      .execute();
    if (roles.length !== unique.length) {
      throw notFound('One or more roles were not found');
    }
    const granted = await trx
      .selectFrom('role_permissions')
      .select('permission')
      .distinct()
      .where('tenant_id', '=', tenantId)
      .where('role_id', 'in', unique)
      .execute();
    const escalations = granted.map((row) => row.permission).filter((permission) => !held.has(permission as Permission));
    if (escalations.length > 0) {
      throw forbidden('You cannot grant permissions that you do not hold');
    }
  }
}
