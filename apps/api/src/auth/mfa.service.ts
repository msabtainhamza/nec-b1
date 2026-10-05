import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { MfaDisableRequest, MfaEnableResponse, MfaSetupResponse, MfaStatus, SecuritySettings, UpdateSecuritySettingsRequest } from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { AppError, conflict, unauthenticated, versionConflict } from '../common/errors.js';
import type { TenantPrincipal, UserPrincipal } from '../common/request-context.js';
import { DatabaseService, lockTenantResource, type Trx } from '../database/database.service.js';
import { generateToken, hashToken, verifyPassword } from './crypto.js';
import { SecretBox } from './secret-box.js';
import { newTotpSecret, totpUri, validateTotp } from './totp.js';

const RECOVERY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const CHALLENGE_TTL_SECONDS = 300;
const MAX_CHALLENGE_ATTEMPTS = 5;

function recoveryCode(): string {
  const bytes = randomBytes(8);
  const chars = [...bytes].map((byte) => RECOVERY_ALPHABET[byte % 32]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

@Injectable()
export class MfaService {
  readonly challengeTtlSeconds = CHALLENGE_TTL_SECONDS;

  constructor(
    private readonly database: DatabaseService,
    private readonly secrets: SecretBox,
    private readonly audit: AuditService,
  ) {}

  async isEnabled(trx: Trx, userId: string): Promise<boolean> {
    const row = await trx.selectFrom('user_mfa').select('enabled_at').where('user_id', '=', userId).executeTakeFirst();
    return Boolean(row?.enabled_at);
  }

  async status(principal: UserPrincipal): Promise<MfaStatus> {
    const row = await this.database.db.selectFrom('user_mfa').select('enabled_at').where('user_id', '=', principal.userId).executeTakeFirst();
    const remaining = await this.database.db
      .selectFrom('user_mfa_recovery_codes')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('user_id', '=', principal.userId)
      .where('used_at', 'is', null)
      .executeTakeFirstOrThrow();
    return { enabled: Boolean(row?.enabled_at), pending: Boolean(row && !row.enabled_at), recoveryCodesRemaining: row?.enabled_at ? Number(remaining.count) : 0 };
  }

  async setup(principal: UserPrincipal): Promise<MfaSetupResponse> {
    const secret = newTotpSecret();
    await this.database.db.transaction().execute(async (trx) => {
      if (await this.isEnabled(trx, principal.userId)) throw conflict('Two-factor authentication is already enabled; disable it before setting it up again');
      const values = { secret_encrypted: this.secrets.encrypt(secret), last_counter: null, enabled_at: null, updated_at: new Date() };
      await trx.insertInto('user_mfa').values({ user_id: principal.userId, ...values }).onConflict((oc) => oc.column('user_id').doUpdateSet(values)).execute();
    });
    return { secret, uri: totpUri(secret, principal.email) };
  }

  async enable(principal: UserPrincipal, code: string, correlationId: string): Promise<MfaEnableResponse> {
    const codes = Array.from({ length: 10 }, recoveryCode);
    await this.database.db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom('user_mfa').selectAll().where('user_id', '=', principal.userId).forUpdate().executeTakeFirst();
      if (!row) throw conflict('Start the two-factor setup first');
      if (row.enabled_at) throw conflict('Two-factor authentication is already enabled');
      const counter = validateTotp(this.secrets.decrypt(row.secret_encrypted), code);
      if (counter === null) throw new AppError(400, 'MFA_CODE_INVALID', 'The code is not valid; check the time on your device and try again', [{ path: 'code', message: 'Invalid code' }]);
      await trx.updateTable('user_mfa').set({ enabled_at: new Date(), last_counter: counter, updated_at: new Date() }).where('user_id', '=', principal.userId).execute();
      await trx.deleteFrom('user_mfa_recovery_codes').where('user_id', '=', principal.userId).execute();
      await trx.insertInto('user_mfa_recovery_codes').values(codes.map((value) => ({ user_id: principal.userId, code_hash: hashToken(value) }))).execute();
      await this.audit.recordPlatform(trx, { operatorId: null, action: 'user.mfa_enabled', targetType: 'user', targetId: principal.userId, correlationId });
    });
    return { recoveryCodes: codes };
  }

  async verify(trx: Trx, userId: string, code: string): Promise<'totp' | 'recovery' | null> {
    const row = await trx.selectFrom('user_mfa').selectAll().where('user_id', '=', userId).forUpdate().executeTakeFirst();
    if (!row?.enabled_at) return null;
    const normalized = code.trim().toLowerCase();
    if (/^\d{6}$/.test(normalized)) {
      const counter = validateTotp(this.secrets.decrypt(row.secret_encrypted), normalized);
      const last = row.last_counter === null ? -1 : Number(row.last_counter);
      if (counter === null || counter <= last) return null;
      await trx.updateTable('user_mfa').set({ last_counter: counter, updated_at: new Date() }).where('user_id', '=', userId).execute();
      return 'totp';
    }
    const used = await trx
      .updateTable('user_mfa_recovery_codes')
      .set({ used_at: new Date() })
      .where('user_id', '=', userId)
      .where('code_hash', '=', hashToken(normalized))
      .where('used_at', 'is', null)
      .executeTakeFirst();
    return used.numUpdatedRows > 0n ? 'recovery' : null;
  }

  async disable(principal: UserPrincipal, input: MfaDisableRequest, correlationId: string): Promise<void> {
    const user = await this.database.db.selectFrom('users').select('password_hash').where('id', '=', principal.userId).executeTakeFirstOrThrow();
    if (!(await verifyPassword(user.password_hash, input.password))) throw unauthenticated('The password is incorrect');
    await this.database.db.transaction().execute(async (trx) => {
      if (!(await this.verify(trx, principal.userId, input.code))) throw new AppError(400, 'MFA_CODE_INVALID', 'The code is not valid', [{ path: 'code', message: 'Invalid code' }]);
      await trx.deleteFrom('user_mfa_recovery_codes').where('user_id', '=', principal.userId).execute();
      await trx.deleteFrom('user_mfa').where('user_id', '=', principal.userId).execute();
      await this.audit.recordPlatform(trx, { operatorId: null, action: 'user.mfa_disabled', targetType: 'user', targetId: principal.userId, correlationId });
    });
  }

  async createChallenge(trx: Trx, userId: string, userAgent: string | null): Promise<string> {
    const token = generateToken();
    await trx
      .insertInto('mfa_challenges')
      .values({ user_id: userId, token_hash: hashToken(token), user_agent: userAgent, expires_at: new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000) })
      .execute();
    return token;
  }

  async consumeChallenge(challengeToken: string, code: string, correlationId: string): Promise<{ userId: string; userAgent: string | null } | null> {
    return this.database.db.transaction().execute(async (trx) => {
      const challenge = await trx.selectFrom('mfa_challenges').selectAll().where('token_hash', '=', hashToken(challengeToken)).forUpdate().executeTakeFirst();
      if (!challenge || challenge.used_at !== null || challenge.expires_at <= new Date() || challenge.attempts >= MAX_CHALLENGE_ATTEMPTS) return null;
      const method = await this.verify(trx, challenge.user_id, code);
      if (!method) {
        await trx.updateTable('mfa_challenges').set({ attempts: challenge.attempts + 1 }).where('id', '=', challenge.id).execute();
        await this.audit.recordPlatform(trx, { operatorId: null, action: 'user.mfa_login', targetType: 'user', targetId: challenge.user_id, outcome: 'denied', correlationId });
        return null;
      }
      await trx.updateTable('mfa_challenges').set({ used_at: new Date() }).where('id', '=', challenge.id).execute();
      await this.audit.recordPlatform(trx, { operatorId: null, action: 'user.mfa_login', targetType: 'user', targetId: challenge.user_id, details: { method }, correlationId });
      return { userId: challenge.user_id, userAgent: challenge.user_agent };
    });
  }

  async settings(principal: TenantPrincipal): Promise<SecuritySettings> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => this.loadSettings(trx, principal.tenantId));
  }

  async loadSettings(trx: Trx, tenantId: string): Promise<SecuritySettings> {
    const row = await trx.selectFrom('company_security_settings').select(['require_admin_mfa', 'version']).where('tenant_id', '=', tenantId).executeTakeFirst();
    return row ? { requireAdminMfa: row.require_admin_mfa, version: row.version } : { requireAdminMfa: false, version: 0 };
  }

  async updateSettings(principal: TenantPrincipal, input: UpdateSecuritySettingsRequest, correlationId: string): Promise<SecuritySettings> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      await lockTenantResource(trx, principal.tenantId, 'security-settings');
      const before = await this.loadSettings(trx, principal.tenantId);
      if (before.version !== input.version) throw versionConflict();
      if (input.requireAdminMfa && !(await this.isEnabled(trx, principal.userId))) {
        throw conflict('Enable two-factor authentication for your own account before requiring it for administrators');
      }
      const values = { require_admin_mfa: input.requireAdminMfa, version: before.version + 1, updated_at: new Date() };
      await trx.insertInto('company_security_settings').values({ tenant_id: principal.tenantId, ...values }).onConflict((oc) => oc.column('tenant_id').doUpdateSet(values)).execute();
      const after = { requireAdminMfa: input.requireAdminMfa, version: values.version };
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'security_settings.changed',
        entityType: 'security_settings',
        entityId: null,
        before: { ...before },
        after: { ...after },
        correlationId,
      });
      return after;
    });
  }
}
