import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DatabaseService, type Trx } from '../database/database.service.js';
import { unauthenticated } from '../common/errors.js';
import { generateToken, hashToken } from './crypto.js';

export type SessionSubject = { type: 'user'; userId: string } | { type: 'operator'; operatorId: string };

export interface SessionRecord {
  id: string;
  subject_type: 'user' | 'operator';
  user_id: string | null;
  operator_id: string | null;
  active_tenant_id: string | null;
}

@Injectable()
export class SessionService {
  private readonly refreshTtlMs: number;

  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.refreshTtlMs = config.REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000;
  }

  async create(trx: Trx, subject: SessionSubject, userAgent: string | null): Promise<{ sessionId: string; refreshToken: string }> {
    const expiresAt = new Date(Date.now() + this.refreshTtlMs);
    const session = await trx
      .insertInto('sessions')
      .values({
        subject_type: subject.type,
        user_id: subject.type === 'user' ? subject.userId : null,
        operator_id: subject.type === 'operator' ? subject.operatorId : null,
        user_agent: userAgent?.slice(0, 256) ?? null,
        expires_at: expiresAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const refreshToken = await this.issueRefreshToken(trx, session.id, expiresAt);
    return { sessionId: session.id, refreshToken };
  }

  async rotate(refreshToken: string): Promise<{ session: SessionRecord; refreshToken: string }> {
    const tokenHash = hashToken(refreshToken);
    const outcome = await this.database.db.transaction().execute(async (trx) => {
      const token = await trx
        .selectFrom('refresh_tokens')
        .innerJoin('sessions', 'sessions.id', 'refresh_tokens.session_id')
        .select([
          'refresh_tokens.id as token_id',
          'refresh_tokens.used_at',
          'refresh_tokens.expires_at as token_expires_at',
          'sessions.id',
          'sessions.subject_type',
          'sessions.user_id',
          'sessions.operator_id',
          'sessions.active_tenant_id',
          'sessions.revoked_at',
          'sessions.expires_at',
        ])
        .where('refresh_tokens.token_hash', '=', tokenHash)
        .forUpdate()
        .executeTakeFirst();
      if (!token) {
        return { ok: false as const };
      }
      if (token.used_at !== null) {
        await this.revokeWithin(trx, token.id, 'refresh_token_reuse');
        return { ok: false as const };
      }
      const now = new Date();
      if (token.revoked_at !== null || token.expires_at <= now || token.token_expires_at <= now) {
        return { ok: false as const };
      }
      await trx.updateTable('refresh_tokens').set({ used_at: now }).where('id', '=', token.token_id).execute();
      await trx.updateTable('sessions').set({ last_used_at: now }).where('id', '=', token.id).execute();
      const next = await this.issueRefreshToken(trx, token.id, token.expires_at);
      return {
        ok: true as const,
        session: {
          id: token.id,
          subject_type: token.subject_type,
          user_id: token.user_id,
          operator_id: token.operator_id,
          active_tenant_id: token.active_tenant_id,
        },
        refreshToken: next,
      };
    });
    if (!outcome.ok) {
      throw unauthenticated('The session has expired. Sign in again.');
    }
    return { session: outcome.session, refreshToken: outcome.refreshToken };
  }

  async findActive(sessionId: string, subjectType: 'user' | 'operator'): Promise<SessionRecord | undefined> {
    return this.database.db
      .selectFrom('sessions')
      .select(['id', 'subject_type', 'user_id', 'operator_id', 'active_tenant_id'])
      .where('id', '=', sessionId)
      .where('subject_type', '=', subjectType)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .executeTakeFirst();
  }

  async revoke(sessionId: string, reason: string): Promise<void> {
    await this.database.db.transaction().execute((trx) => this.revokeWithin(trx, sessionId, reason));
  }

  async revokeWithin(trx: Trx, sessionId: string, reason: string): Promise<void> {
    await trx
      .updateTable('sessions')
      .set({ revoked_at: new Date(), revoked_reason: reason })
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  private async issueRefreshToken(trx: Trx, sessionId: string, expiresAt: Date): Promise<string> {
    const token = generateToken();
    await trx
      .insertInto('refresh_tokens')
      .values({ session_id: sessionId, token_hash: hashToken(token), expires_at: expiresAt })
      .execute();
    return token;
  }
}
