import { z } from 'zod';
import { SUBSCRIPTION_STATES } from './subscription.js';

export const API_VERSION = 'v1';

const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
const password = z.string().min(12).max(256);
const uuid = z.uuid();

export const loginRequest = z.object({
  email,
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof loginRequest>;

export const refreshRequest = z.object({
  refreshToken: z.string().min(20).max(512),
});
export type RefreshRequest = z.infer<typeof refreshRequest>;

export const selectTenantRequest = z.object({
  tenantId: uuid,
});
export type SelectTenantRequest = z.infer<typeof selectTenantRequest>;

export interface TokenPair {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
}

export interface TenantSummary {
  tenantId: string;
  code: string;
  displayName: string;
  membershipId: string;
  subscriptionState: (typeof SUBSCRIPTION_STATES)[number];
  accessMode: 'full' | 'restricted_export' | 'none';
}

export interface LoginResponse extends TokenPair {
  user: SessionUser;
  tenants: TenantSummary[];
}

export interface SelectTenantResponse {
  accessToken: string;
  accessTokenExpiresIn: number;
  tenant: TenantSummary;
}

export interface OperatorLoginResponse extends TokenPair {
  operator: { id: string; email: string; displayName: string };
}

export interface SessionInfo {
  id: string;
  current: boolean;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string;
}

export interface TenantContextResponse {
  user: SessionUser;
  tenant: {
    id: string;
    code: string;
    legalName: string;
    displayName: string;
    baseCurrency: string;
    timeZone: string;
  };
  membershipId: string;
  permissions: string[];
  subscription: {
    state: (typeof SUBSCRIPTION_STATES)[number];
    accessMode: 'full' | 'restricted_export' | 'none';
  };
  entitlements: {
    modules: string[];
    maxActiveSeats: number;
    maxEmployees: number;
    maxBranches: number;
    maxStorageBytes: number;
  };
}

export const createInvitationRequest = z.object({
  email,
  roleIds: z.array(uuid).min(1).max(20),
});
export type CreateInvitationRequest = z.infer<typeof createInvitationRequest>;

export interface CreateInvitationResponse {
  invitationId: string;
  email: string;
  expiresAt: string;
}

export const acceptInvitationRequest = z.object({
  token: z.string().min(20).max(512),
  password,
  displayName: z.string().trim().min(1).max(120).optional(),
});
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequest>;

export interface AcceptInvitationResponse {
  tenantId: string;
  membershipId: string;
  userId: string;
}

export const createBranchRequest = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/),
  name: z.string().trim().min(1).max(120),
});
export type CreateBranchRequest = z.infer<typeof createBranchRequest>;

export const changeStatusRequest = z.object({
  status: z.enum(['active', 'disabled']),
  version: z.number().int().positive(),
});
export type ChangeStatusRequest = z.infer<typeof changeStatusRequest>;

export interface Branch {
  id: string;
  code: string;
  name: string;
  status: 'active' | 'disabled';
  version: number;
}

export interface Member {
  membershipId: string;
  userId: string;
  email: string;
  displayName: string;
  status: 'active' | 'disabled' | 'revoked';
  roles: string[];
  version: number;
}

export interface Role {
  id: string;
  code: string;
  name: string;
  isSystem: boolean;
  permissions: string[];
}

export interface AuditEvent {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  outcome: string;
  occurredAt: string;
}

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

export interface Page<T> {
  items: T[];
  limit: number;
  offset: number;
  total: number;
}

export const operatorLoginRequest = z.object({
  email,
  password: z.string().min(1).max(256),
  totp: z.string().regex(/^\d{6}$/),
});
export type OperatorLoginRequest = z.infer<typeof operatorLoginRequest>;

export const provisionTenantRequest = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  legalName: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(120),
  baseCurrency: z.string().regex(/^[A-Z]{3}$/),
  timeZone: z.string().min(1).max(64),
  planCode: z.string().min(1).max(64),
  subscriptionState: z.enum(['trial', 'active']).default('trial'),
  defaultBranch: z.object({
    code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/),
    name: z.string().trim().min(1).max(120),
  }),
  ownerEmail: email,
});
export type ProvisionTenantRequest = z.infer<typeof provisionTenantRequest>;

export interface ProvisionTenantResponse {
  tenantId: string;
  ownerInvitation: CreateInvitationResponse;
}

export const changeSubscriptionRequest = z.object({
  state: z.enum(SUBSCRIPTION_STATES),
  retentionEndsAt: z.iso.datetime().nullable().optional(),
  version: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
});
export type ChangeSubscriptionRequest = z.infer<typeof changeSubscriptionRequest>;

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    correlationId?: string;
  };
}

export const ERROR_CODES = {
  validation: 'VALIDATION_FAILED',
  unauthenticated: 'UNAUTHENTICATED',
  forbidden: 'FORBIDDEN',
  notFound: 'NOT_FOUND',
  conflict: 'CONFLICT',
  limitExceeded: 'PLAN_LIMIT_EXCEEDED',
  subscriptionRestricted: 'SUBSCRIPTION_RESTRICTED',
  moduleNotEntitled: 'MODULE_NOT_ENTITLED',
  tenantNotSelected: 'TENANT_NOT_SELECTED',
  versionConflict: 'VERSION_CONFLICT',
  internal: 'INTERNAL_ERROR',
} as const;
