import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALWAYS_ENABLED_MODULES, ERROR_CODES, PERMISSIONS, permissionModule, RESTRICTED_ACCESS_PERMISSION, type Permission } from '@nec/contracts';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service.js';
import { AppError, forbidden, subscriptionRestricted, unauthenticated } from '../common/errors.js';
import type { Principal, RequestWithContext, UserPrincipal } from '../common/request-context.js';
import { DatabaseService } from '../database/database.service.js';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';
import { SessionService } from './session.service.js';
import { TokenService, type AccessClaims } from './token.service.js';

const ACCESS_KEY = 'nec:access';

type AccessRule =
  | { kind: 'public' }
  | { kind: 'platform' }
  | { kind: 'user' }
  | { kind: 'tenant'; permissions: Permission[] };

export const Public = () => SetMetadata(ACCESS_KEY, { kind: 'public' } satisfies AccessRule);
export const PlatformOnly = () => SetMetadata(ACCESS_KEY, { kind: 'platform' } satisfies AccessRule);
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(ACCESS_KEY, { kind: 'tenant', permissions } satisfies AccessRule);
export const TenantScoped = () => RequirePermission();

const READ_METHODS = new Set(['GET', 'HEAD']);
const SUPPORT_PERMISSIONS = new Set<Permission>(PERMISSIONS.filter((permission) => permission.endsWith('.view')));

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly database: DatabaseService,
    private readonly tenantAccess: TenantAccessService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<AccessRule | undefined>(ACCESS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? { kind: 'user' };
    if (rule.kind === 'public') {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request & RequestWithContext>();
    const token = bearerToken(request);
    if (!token) {
      throw unauthenticated();
    }
    request.principal = rule.kind === 'platform' ? await this.operatorPrincipal(token) : await this.userPrincipal(token, rule, request);
    return true;
  }

  private async operatorPrincipal(token: string): Promise<Principal> {
    const claims = await this.tokens.verify(token, 'erp-platform');
    if (!claims) {
      throw unauthenticated();
    }
    const session = await this.sessions.findActive(claims.sessionId, 'operator');
    if (!session || session.operator_id !== claims.subject) {
      throw unauthenticated();
    }
    const operator = await this.database.db
      .selectFrom('platform_operators')
      .select(['id', 'email'])
      .where('id', '=', claims.subject)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!operator) {
      throw unauthenticated();
    }
    return { kind: 'operator', operatorId: operator.id, sessionId: session.id, email: operator.email };
  }

  private async userPrincipal(token: string, rule: AccessRule, request: Request & RequestWithContext): Promise<UserPrincipal> {
    const claims = await this.tokens.verify(token, 'erp-app');
    if (!claims) {
      const support = await this.tokens.verify(token, 'erp-support');
      if (support) return this.supportPrincipal(support, rule, request);
      throw unauthenticated();
    }
    const session = await this.sessions.findActive(claims.sessionId, 'user');
    if (!session || session.user_id !== claims.subject) {
      throw unauthenticated();
    }
    const user = await this.database.db
      .selectFrom('users')
      .select(['id', 'email', 'display_name'])
      .where('id', '=', claims.subject)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!user) {
      throw unauthenticated();
    }
    const base: UserPrincipal = {
      kind: 'user',
      userId: user.id,
      sessionId: session.id,
      email: user.email,
      displayName: user.display_name,
      tenantId: null,
      membershipId: null,
      permissions: new Set(),
      modules: new Set(),
      accessMode: null,
    };
    if (rule.kind !== 'tenant') {
      return base;
    }
    if (!claims.tenantId) {
      throw new AppError(403, ERROR_CODES.tenantNotSelected, 'Select a company before continuing');
    }
    if (session.active_tenant_id !== claims.tenantId) {
      throw unauthenticated('The active company changed. Refresh your session.');
    }
    const access = await this.tenantAccess.resolve(user.id, claims.tenantId);
    if (!access) {
      throw forbidden('You no longer have access to this company');
    }
    const principal: UserPrincipal = {
      ...base,
      tenantId: access.tenantId,
      membershipId: access.membershipId,
      permissions: access.permissions,
      modules: access.modules,
      accessMode: access.accessMode,
    };
    if (access.accessMode === 'restricted_export') {
      const allowed = READ_METHODS.has(request.method) && access.permissions.has(RESTRICTED_ACCESS_PERMISSION);
      if (!allowed) {
        throw subscriptionRestricted();
      }
    }
    const unentitled = rule.permissions
      .map(permissionModule)
      .filter((module) => !(ALWAYS_ENABLED_MODULES as readonly string[]).includes(module) && !access.modules.has(module));
    if (unentitled.length > 0) {
      throw new AppError(403, ERROR_CODES.moduleNotEntitled, 'Your company plan does not include this module');
    }
    const missing = rule.permissions.filter((permission) => !access.permissions.has(permission));
    if (missing.length > 0) {
      await this.database.withContext({ tenantId: access.tenantId, userId: user.id }, (trx) =>
        this.audit.record(trx, {
          tenantId: access.tenantId,
          actor: { type: 'user', id: user.id },
          action: 'authorization.denied',
          entityType: 'route',
          entityId: null,
          outcome: 'denied',
          after: { method: request.method, path: request.route?.path ?? request.path, missing },
          correlationId: request.correlationId,
        }),
      );
      throw forbidden();
    }
    return principal;
  }

  private async supportPrincipal(claims: AccessClaims, rule: AccessRule, request: Request & RequestWithContext): Promise<UserPrincipal> {
    if (rule.kind !== 'tenant' || !claims.tenantId || !claims.grantId) throw supportDenied('Support access is limited to company data');
    const session = await this.sessions.findActive(claims.sessionId, 'operator');
    if (!session || session.operator_id !== claims.subject) throw unauthenticated();
    const operator = await this.database.db.selectFrom('platform_operators').select(['id', 'email', 'display_name']).where('id', '=', claims.subject).where('status', '=', 'active').executeTakeFirst();
    if (!operator) throw unauthenticated();
    const tenantId = claims.tenantId;
    const grantId = claims.grantId;
    const grant = await this.database.withContext({ tenantId, userId: null }, (trx) =>
      trx.selectFrom('support_grants').select('id').where('tenant_id', '=', tenantId).where('id', '=', grantId).where('revoked_at', 'is', null).where('expires_at', '>', new Date()).executeTakeFirst(),
    );
    if (!grant) throw supportDenied('The support access for this company expired or was revoked');
    const entitlements = await this.database.db.selectFrom('tenant_entitlements').select('modules').where('tenant_id', '=', tenantId).executeTakeFirst();
    const modules = new Set(entitlements?.modules ?? []);
    const denial = !READ_METHODS.has(request.method)
      ? supportDenied('Support access is read-only')
      : rule.permissions.some((permission) => !SUPPORT_PERMISSIONS.has(permission))
        ? supportDenied('Support access allows viewing data only')
        : rule.permissions.map(permissionModule).some((module) => !(ALWAYS_ENABLED_MODULES as readonly string[]).includes(module) && !modules.has(module))
          ? new AppError(403, ERROR_CODES.moduleNotEntitled, 'The company plan does not include this module')
          : null;
    await this.database.db.transaction().execute((trx) =>
      this.audit.recordPlatform(trx, {
        operatorId: operator.id,
        action: 'support.request',
        targetType: 'tenant',
        targetId: tenantId,
        tenantId,
        outcome: denial ? 'denied' : 'success',
        details: { grantId, method: request.method, path: request.route?.path ?? request.path },
        correlationId: request.correlationId,
      }),
    );
    if (denial) throw denial;
    return {
      kind: 'user',
      userId: operator.id,
      sessionId: session.id,
      email: operator.email,
      displayName: `Support: ${operator.display_name}`,
      tenantId,
      membershipId: grantId,
      permissions: SUPPORT_PERMISSIONS,
      modules,
      accessMode: 'full',
      supportGrantId: grantId,
    };
  }
}

function supportDenied(message: string): AppError {
  return new AppError(403, 'SUPPORT_ACCESS_DENIED', message);
}

function bearerToken(request: Request): string | null {
  const header = request.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}
