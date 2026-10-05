import { Inject, Injectable } from '@nestjs/common';
import type { ChangePasswordRequest, PasswordResetConfirmRequest } from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { AppError, unauthenticated } from '../common/errors.js';
import type { UserPrincipal } from '../common/request-context.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DatabaseService, type Trx } from '../database/database.service.js';
import { MailDispatcher } from '../mail/mailer.js';
import { generateToken, hashPassword, hashToken, verifyPassword } from './crypto.js';
import { LoginLimiter } from './login-limiter.js';

@Injectable()
export class PasswordService {
  private readonly ttlMs: number;

  constructor(
    private readonly database: DatabaseService,
    private readonly mail: MailDispatcher,
    private readonly limiter: LoginLimiter,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.ttlMs = config.PASSWORD_RESET_TTL_MINUTES * 60 * 1000;
  }

  private async revokeSessions(trx: Trx, userId: string, reason: string, keepSessionId: string | null): Promise<number> {
    let query = trx.updateTable('sessions').set({ revoked_at: new Date(), revoked_reason: reason }).where('user_id', '=', userId).where('revoked_at', 'is', null);
    if (keepSessionId) query = query.where('id', '<>', keepSessionId);
    const result = await query.executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async requestReset(email: string, correlationId: string): Promise<void> {
    const limiterKey = `reset:${email}`;
    this.limiter.assertAllowed(limiterKey);
    this.limiter.recordFailure(limiterKey);
    const user = await this.database.db.selectFrom('users').select(['id', 'email', 'status', 'email_verified_at']).where('email', '=', email).executeTakeFirst();
    if (!user || user.status !== 'active' || user.email_verified_at === null) return;
    const token = generateToken();
    const expiresAt = new Date(Date.now() + this.ttlMs);
    await this.database.db.transaction().execute(async (trx) => {
      await trx.updateTable('password_reset_tokens').set({ used_at: new Date() }).where('user_id', '=', user.id).where('used_at', 'is', null).execute();
      await trx.insertInto('password_reset_tokens').values({ user_id: user.id, token_hash: hashToken(token), expires_at: expiresAt }).execute();
      await this.audit.recordPlatform(trx, { operatorId: null, action: 'user.password_reset_requested', targetType: 'user', targetId: user.id, correlationId });
    });
    await this.mail.dispatch(
      {
        to: user.email,
        subject: 'Reset your NEC ERP password',
        text: [
          'A password reset was requested for your account.',
          '',
          'Open the desktop application, choose "Forgot password", and paste this code:',
          '',
          token,
          '',
          `The code expires at ${expiresAt.toISOString()} and can be used once. If you did not request this, ignore this message; your password stays unchanged.`,
        ].join('\n'),
      },
      correlationId,
    );
  }

  async confirmReset(input: PasswordResetConfirmRequest, correlationId: string): Promise<void> {
    const passwordHash = await hashPassword(input.password);
    await this.database.db.transaction().execute(async (trx) => {
      const token = await trx
        .selectFrom('password_reset_tokens as t')
        .innerJoin('users as u', 'u.id', 't.user_id')
        .select(['t.id', 't.user_id', 't.expires_at', 't.used_at', 'u.status'])
        .where('t.token_hash', '=', hashToken(input.token))
        .forUpdate('t')
        .executeTakeFirst();
      if (!token || token.used_at !== null || token.expires_at <= new Date() || token.status !== 'active') {
        throw new AppError(400, 'RESET_TOKEN_INVALID', 'This reset code is invalid, expired or already used. Request a new one.');
      }
      await trx.updateTable('password_reset_tokens').set({ used_at: new Date() }).where('id', '=', token.id).execute();
      await trx.updateTable('users').set({ password_hash: passwordHash, updated_at: new Date() }).where('id', '=', token.user_id).execute();
      const revoked = await this.revokeSessions(trx, token.user_id, 'password_reset', null);
      await this.audit.recordPlatform(trx, { operatorId: null, action: 'user.password_reset', targetType: 'user', targetId: token.user_id, details: { sessionsRevoked: revoked }, correlationId });
    });
  }

  async change(principal: UserPrincipal, input: ChangePasswordRequest, correlationId: string): Promise<void> {
    const limiterKey = `user:${principal.email}`;
    this.limiter.assertAllowed(limiterKey);
    const user = await this.database.db.selectFrom('users').select(['id', 'password_hash']).where('id', '=', principal.userId).executeTakeFirstOrThrow();
    if (!(await verifyPassword(user.password_hash, input.currentPassword))) {
      this.limiter.recordFailure(limiterKey);
      throw unauthenticated('The current password is incorrect');
    }
    if (await verifyPassword(user.password_hash, input.newPassword)) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Choose a password different from the current one', [{ path: 'newPassword', message: 'Same as the current password' }]);
    }
    const passwordHash = await hashPassword(input.newPassword);
    await this.database.db.transaction().execute(async (trx) => {
      await trx.updateTable('users').set({ password_hash: passwordHash, updated_at: new Date() }).where('id', '=', user.id).execute();
      const revoked = await this.revokeSessions(trx, user.id, 'password_changed', principal.sessionId);
      await this.audit.recordPlatform(trx, { operatorId: null, action: 'user.password_changed', targetType: 'user', targetId: user.id, details: { sessionsRevoked: revoked }, correlationId });
    });
  }
}
