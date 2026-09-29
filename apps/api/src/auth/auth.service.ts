import { Injectable } from '@nestjs/common';
import type {
  LoginRequest,
  LoginResponse,
  SelectTenantResponse,
  SessionInfo,
  TokenPair,
} from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { notFound, unauthenticated } from '../common/errors.js';
import type { UserPrincipal } from '../common/request-context.js';
import { DatabaseService } from '../database/database.service.js';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';
import { verifyPassword } from './crypto.js';
import { LoginLimiter } from './login-limiter.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly tenantAccess: TenantAccessService,
    private readonly limiter: LoginLimiter,
    private readonly audit: AuditService,
  ) {}

  async login(input: LoginRequest, userAgent: string | null): Promise<LoginResponse> {
    const limiterKey = `user:${input.email}`;
    this.limiter.assertAllowed(limiterKey);
    const user = await this.database.db
      .selectFrom('users')
      .select(['id', 'email', 'display_name', 'password_hash', 'status', 'email_verified_at'])
      .where('email', '=', input.email)
      .executeTakeFirst();
    const valid = await verifyPassword(user?.password_hash ?? null, input.password);
    if (!user || !valid || user.status !== 'active' || user.email_verified_at === null) {
      this.limiter.recordFailure(limiterKey);
      throw unauthenticated('The email or password is incorrect');
    }
    this.limiter.clear(limiterKey);
    const { sessionId, refreshToken } = await this.database.db
      .transaction()
      .execute((trx) => this.sessions.create(trx, { type: 'user', userId: user.id }, userAgent));
    const accessToken = await this.tokens.sign({ subject: user.id, sessionId, tenantId: null, audience: 'erp-app' });
    return {
      accessToken,
      accessTokenExpiresIn: this.tokens.accessTtlSeconds,
      refreshToken,
      user: { id: user.id, email: user.email, displayName: user.display_name },
      tenants: await this.tenantAccess.listForUser(user.id),
    };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const { session, refreshToken: next } = await this.sessions.rotate(refreshToken);
    const subject = session.subject_type === 'user' ? session.user_id : session.operator_id;
    if (!subject) {
      throw unauthenticated();
    }
    const accessToken = await this.tokens.sign({
      subject,
      sessionId: session.id,
      tenantId: session.active_tenant_id,
      audience: session.subject_type === 'user' ? 'erp-app' : 'erp-platform',
    });
    return { accessToken, accessTokenExpiresIn: this.tokens.accessTtlSeconds, refreshToken: next };
  }

  async selectTenant(principal: UserPrincipal, tenantId: string, correlationId: string): Promise<SelectTenantResponse> {
    const access = await this.tenantAccess.resolve(principal.userId, tenantId);
    if (!access) {
      throw notFound('The company was not found or you do not have access to it');
    }
    await this.database.withContext({ tenantId, userId: principal.userId }, async (trx) => {
      const updated = await trx
        .updateTable('sessions')
        .set({ active_tenant_id: tenantId, last_used_at: new Date() })
        .where('id', '=', principal.sessionId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (updated.numUpdatedRows === 0n) {
        throw unauthenticated();
      }
      await this.audit.record(trx, {
        tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'session.tenant_selected',
        entityType: 'membership',
        entityId: access.membershipId,
        correlationId,
      });
    });
    const accessToken = await this.tokens.sign({
      subject: principal.userId,
      sessionId: principal.sessionId,
      tenantId,
      audience: 'erp-app',
    });
    return {
      accessToken,
      accessTokenExpiresIn: this.tokens.accessTtlSeconds,
      tenant: {
        tenantId: access.tenantId,
        code: access.code,
        displayName: access.displayName,
        membershipId: access.membershipId,
        subscriptionState: access.subscriptionState,
        accessMode: access.accessMode,
      },
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId, 'logout');
  }

  async listSessions(principal: UserPrincipal): Promise<SessionInfo[]> {
    const rows = await this.database.db
      .selectFrom('sessions')
      .select(['id', 'user_agent', 'created_at', 'last_used_at'])
      .where('user_id', '=', principal.userId)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', new Date())
      .orderBy('last_used_at', 'desc')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      current: row.id === principal.sessionId,
      userAgent: row.user_agent,
      createdAt: row.created_at.toISOString(),
      lastUsedAt: row.last_used_at.toISOString(),
    }));
  }

  async revokeSession(principal: UserPrincipal, sessionId: string): Promise<void> {
    const session = await this.database.db
      .selectFrom('sessions')
      .select('id')
      .where('id', '=', sessionId)
      .where('user_id', '=', principal.userId)
      .executeTakeFirst();
    if (!session) {
      throw notFound();
    }
    await this.sessions.revoke(session.id, 'user_revoked');
  }
}
