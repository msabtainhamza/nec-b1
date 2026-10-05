import type { AcceptInvitationRequest, SessionUser, TenantSummary } from '@nec/contracts';

export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  body: T;
}

export interface ErpBridge {
  login(email: string, password: string): Promise<ApiResult<{ user: SessionUser; tenants: TenantSummary[] } | { mfaRequired: true; expiresIn: number }>>;
  verifyMfa(code: string): Promise<ApiResult<{ user: SessionUser; tenants: TenantSummary[] }>>;
  mfa<T = unknown>(action: 'status' | 'setup' | 'enable' | 'disable', body?: unknown): Promise<ApiResult<T>>;
  tenants(): Promise<ApiResult<TenantSummary[]>>;
  selectTenant(tenantId: string): Promise<ApiResult<TenantSummary>>;
  acceptInvitation(input: AcceptInvitationRequest): Promise<ApiResult>;
  request<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<ApiResult<T>>;
  logout(): Promise<void>;
  requestPasswordReset(email: string): Promise<ApiResult>;
  confirmPasswordReset(token: string, password: string): Promise<ApiResult>;
  changePassword(currentPassword: string, newPassword: string): Promise<ApiResult>;
  saveTextFile(name: string, content: string): Promise<{ saved: boolean }>;
  exportCompany(): Promise<{ saved: boolean }>;
  saveInvoicePdf(invoiceId: string): Promise<{ saved: boolean }>;
  printInvoice(invoiceId: string): Promise<{ printed: boolean }>;
  onConnection(listener: (state: { online: boolean }) => void): () => void;
}

declare global {
  interface Window {
    erp: ErpBridge;
  }
}
