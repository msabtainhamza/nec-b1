import { z } from 'zod';
import { PERMISSIONS } from './permissions.js';
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

export const passwordResetRequest = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
});
export type PasswordResetRequest = z.infer<typeof passwordResetRequest>;

export const passwordResetConfirmRequest = z.object({
  token: z.string().min(20).max(512),
  password,
});
export type PasswordResetConfirmRequest = z.infer<typeof passwordResetConfirmRequest>;

export const changePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: password,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequest>;

export interface MfaChallengeResponse {
  mfaRequired: true;
  challengeToken: string;
  challengeExpiresIn: number;
}

export type LoginResult = LoginResponse | MfaChallengeResponse;

export const mfaCode = z.string().trim().regex(/^(\d{6}|[a-z2-7]{4}-[a-z2-7]{4})$/i, 'Enter the 6-digit code or a recovery code');

export const mfaLoginRequest = z.object({
  challengeToken: z.string().min(20).max(512),
  code: mfaCode,
});
export type MfaLoginRequest = z.infer<typeof mfaLoginRequest>;

export interface MfaStatus {
  enabled: boolean;
  pending: boolean;
  recoveryCodesRemaining: number;
}

export interface MfaSetupResponse {
  secret: string;
  uri: string;
}

export const mfaEnableRequest = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from the authenticator app') });
export type MfaEnableRequest = z.infer<typeof mfaEnableRequest>;

export interface MfaEnableResponse {
  recoveryCodes: string[];
}

export const mfaDisableRequest = z.object({
  password: z.string().min(1).max(256),
  code: mfaCode,
});
export type MfaDisableRequest = z.infer<typeof mfaDisableRequest>;

export interface SecuritySettings {
  requireAdminMfa: boolean;
  version: number;
}

export const updateSecuritySettingsRequest = z.object({
  requireAdminMfa: z.boolean(),
  version: z.number().int().min(0),
});
export type UpdateSecuritySettingsRequest = z.infer<typeof updateSecuritySettingsRequest>;

const rolePermissions = z
  .array(z.enum(PERMISSIONS))
  .min(1)
  .max(PERMISSIONS.length)
  .transform((values) => [...new Set(values)].sort());

export const createRoleRequest = z.object({
  code: z.string().trim().regex(/^[a-z][a-z0-9_-]{1,39}$/, 'Use 2-40 lower-case letters, digits, dash or underscore, starting with a letter'),
  name: z.string().trim().min(1).max(80),
  permissions: rolePermissions,
});
export type CreateRoleRequest = z.infer<typeof createRoleRequest>;

export const updateRoleRequest = z.object({
  name: z.string().trim().min(1).max(80),
  permissions: rolePermissions,
});
export type UpdateRoleRequest = z.infer<typeof updateRoleRequest>;

export const changeMemberRolesRequest = z.object({
  roleIds: z.array(z.uuid()).min(1).max(20),
  version: z.number().int().positive(),
});
export type ChangeMemberRolesRequest = z.infer<typeof changeMemberRolesRequest>;

export const grantSupportAccessRequest = z.object({
  hours: z.number().int().min(1).max(72),
  reason: z.string().trim().min(1).max(500),
});
export type GrantSupportAccessRequest = z.infer<typeof grantSupportAccessRequest>;

export interface SupportGrant {
  id: string;
  grantedBy: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  active: boolean;
}

export const supportSessionRequest = z.object({ reason: z.string().trim().min(1).max(500) });
export type SupportSessionRequest = z.infer<typeof supportSessionRequest>;

export interface SupportSessionResponse {
  accessToken: string;
  accessTokenExpiresIn: number;
  grantId: string;
  tenant: { tenantId: string; code: string; displayName: string };
}

export const deletionRequest = z.object({
  confirmCode: z.string().trim().min(1).max(60),
  reason: z.string().trim().min(1).max(500),
});
export type DeletionRequest = z.infer<typeof deletionRequest>;

export const restoreTenantRequest = z.object({ reason: z.string().trim().min(1).max(500) });
export type RestoreTenantRequest = z.infer<typeof restoreTenantRequest>;

export interface DashboardCount {
  count: number;
  amount: string;
}

export interface DashboardPeriod {
  month: string;
  sales: string | null;
  purchases: string | null;
}

export interface Dashboard {
  currency: string;
  asOf: string;
  openSalesOrders: DashboardCount | null;
  openPurchaseOrders: DashboardCount | null;
  overdueReceivables: DashboardCount | null;
  overduePayables: DashboardCount | null;
  lowStockItems: number | null;
  pendingApprovals: number | null;
  periods: DashboardPeriod[];
}
