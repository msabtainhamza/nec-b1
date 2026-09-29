import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALWAYS_ENABLED_MODULES, ERROR_CODES, permissionModule, RESTRICTED_ACCESS_PERMISSION, type Permission } from '@nec/contracts';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service.js';
import { AppError, forbidden, subscriptionRestricted, unauthenticated } from '../common/errors.js';
import type { Principal, RequestWithContext, UserPrincipal } from '../common/request-context.js';
import { DatabaseService } from '../database/database.service.js';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

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
}

function bearerToken(request: Request): string | null {
  const header = request.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}
