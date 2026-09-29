import type {
  AcceptInvitationRequest,
  AcceptInvitationResponse,
  LoginResponse,
  SelectTenantResponse,
  SessionUser,
  TenantSummary,
  TokenPair,
} from '@nec/contracts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  body: T;
}

const RENDERER_METHODS = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const RENDERER_PATH = /^\/v1\/(tenant|invitations|bp|fin|inv|pur)(\/[A-Za-z0-9._~-]+)*(\?[A-Za-z0-9=&._~%-]*)?$/;

export function isAllowedRendererRequest(method: string, path: string): method is HttpMethod {
  return RENDERER_METHODS.has(method as HttpMethod) && RENDERER_PATH.test(path) && !path.includes('..');
}

export class ApiSession {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private refreshing: Promise<boolean> | null = null;
  user: SessionUser | null = null;
  tenant: TenantSummary | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async login(email: string, password: string): Promise<ApiResult<{ user: SessionUser; tenants: TenantSummary[] } | unknown>> {
    const result = await this.send<LoginResponse>('POST', '/v1/auth/login', { email, password }, null);
    if (!result.ok) {
      return result;
    }
    this.accessToken = result.body.accessToken;
    this.refreshToken = result.body.refreshToken;
    this.user = result.body.user;
    this.tenant = null;
    return { ok: true, status: result.status, body: { user: result.body.user, tenants: result.body.tenants } };
  }

  async tenants(): Promise<ApiResult<TenantSummary[] | unknown>> {
    return this.authorized('GET', '/v1/auth/tenants');
  }

  async selectTenant(tenantId: string): Promise<ApiResult<TenantSummary | unknown>> {
    const result = await this.authorized<SelectTenantResponse>('POST', '/v1/auth/select-tenant', { tenantId });
    if (!result.ok) {
      return result;
    }
    const body = result.body as SelectTenantResponse;
    this.accessToken = body.accessToken;
    this.tenant = body.tenant;
    return { ok: true, status: result.status, body: body.tenant };
  }

  async acceptInvitation(input: AcceptInvitationRequest): Promise<ApiResult<AcceptInvitationResponse | unknown>> {
    return this.send('POST', '/v1/invitations/accept', input, null);
  }

  async request(method: string, path: string, body?: unknown): Promise<ApiResult> {
    if (!isAllowedRendererRequest(method, path)) {
      return { ok: false, status: 400, body: { error: { code: 'CLIENT_REJECTED', message: 'Request not permitted' } } };
    }
    return this.authorized(method, path, body);
  }

  async logout(): Promise<void> {
    if (this.accessToken) {
      await this.send('POST', '/v1/auth/logout', undefined, this.accessToken).catch(() => undefined);
    }
    this.clear();
  }

  async health(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(4000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  clear(): void {
    this.accessToken = null;
    this.refreshToken = null;
    this.user = null;
    this.tenant = null;
  }

  private async authorized<T = unknown>(method: HttpMethod, path: string, body?: unknown): Promise<ApiResult<T | unknown>> {
    if (!this.accessToken) {
      return unauthenticatedResult();
    }
    const first = await this.send<T>(method, path, body, this.accessToken);
    if (first.status !== 401 || !this.refreshToken) {
      return first;
    }
    if (!(await this.refresh())) {
      this.clear();
      return first;
    }
    return this.send<T>(method, path, body, this.accessToken);
  }

  private refresh(): Promise<boolean> {
    this.refreshing ??= (async () => {
      try {
        const result = await this.send<TokenPair>('POST', '/v1/auth/refresh', { refreshToken: this.refreshToken }, null);
        if (!result.ok) {
          return false;
        }
        this.accessToken = result.body.accessToken;
        this.refreshToken = result.body.refreshToken;
        return true;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async send<T>(method: HttpMethod, path: string, body: unknown, token: string | null): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      return { ok: response.ok, status: response.status, body: (text ? JSON.parse(text) : null) as T };
    } catch {
      return {
        ok: false,
        status: 0,
        body: { error: { code: 'NETWORK_UNAVAILABLE', message: 'The server could not be reached. Check your connection.' } } as T,
      };
    }
  }
}

function unauthenticatedResult(): ApiResult {
  return { ok: false, status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue' } } };
}
