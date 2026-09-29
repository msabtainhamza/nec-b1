import { randomUUID } from 'node:crypto';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { AccessMode, Permission } from '@nec/contracts';

export interface UserPrincipal {
  kind: 'user';
  userId: string;
  sessionId: string;
  email: string;
  displayName: string;
  tenantId: string | null;
  membershipId: string | null;
  permissions: ReadonlySet<Permission>;
  modules: ReadonlySet<string>;
  accessMode: AccessMode | null;
}

export interface TenantPrincipal extends UserPrincipal {
  tenantId: string;
  membershipId: string;
  accessMode: AccessMode;
}

export interface OperatorPrincipal {
  kind: 'operator';
  operatorId: string;
  sessionId: string;
  email: string;
  tenantId?: undefined;
}

export type Principal = UserPrincipal | OperatorPrincipal;

export interface RequestWithContext {
  correlationId: string;
  principal?: Principal;
}

const CORRELATION_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

export function correlationMiddleware(request: Request, response: Response, next: NextFunction): void {
  const incoming = request.header('x-correlation-id');
  const correlationId = incoming && CORRELATION_PATTERN.test(incoming) ? incoming : randomUUID();
  (request as Request & RequestWithContext).correlationId = correlationId;
  response.setHeader('x-correlation-id', correlationId);
  next();
}

export const CurrentPrincipal = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  return context.switchToHttp().getRequest<RequestWithContext>().principal;
});

export const CorrelationId = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  return context.switchToHttp().getRequest<RequestWithContext>().correlationId;
});

export function tenantPrincipal(principal: Principal | undefined): TenantPrincipal {
  if (principal?.kind !== 'user' || principal.tenantId === null || principal.membershipId === null || principal.accessMode === null) {
    throw new Error('Tenant principal is required for this handler');
  }
  return principal as TenantPrincipal;
}

export function userPrincipal(principal: Principal | undefined): UserPrincipal {
  if (principal?.kind !== 'user') {
    throw new Error('User principal is required for this handler');
  }
  return principal;
}

export function operatorPrincipal(principal: Principal | undefined): OperatorPrincipal {
  if (principal?.kind !== 'operator') {
    throw new Error('Operator principal is required for this handler');
  }
  return principal;
}
