import type { AcceptInvitationRequest, SessionUser, TenantSummary } from '@nec/contracts';

export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  body: T;
}

export interface ErpBridge {
  login(email: string, password: string): Promise<ApiResult<{ user: SessionUser; tenants: TenantSummary[] }>>;
  tenants(): Promise<ApiResult<TenantSummary[]>>;
  selectTenant(tenantId: string): Promise<ApiResult<TenantSummary>>;
  acceptInvitation(input: AcceptInvitationRequest): Promise<ApiResult>;
  request<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<ApiResult<T>>;
  logout(): Promise<void>;
  onConnection(listener: (state: { online: boolean }) => void): () => void;
}

declare global {
  interface Window {
    erp: ErpBridge;
  }
}
