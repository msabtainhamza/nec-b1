import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiSession, isAllowedRendererRequest } from './api-session.js';

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const { status, body } = handler(String(input), init ?? {});
    return new Response(body === null ? null : JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe('renderer request allowlist', () => {
  it('allows tenant API paths only', () => {
    assert.equal(isAllowedRendererRequest('GET', '/v1/tenant/branches'), true);
    assert.equal(isAllowedRendererRequest('GET', '/v1/tenant/audit-events?limit=20&offset=0'), true);
    assert.equal(isAllowedRendererRequest('POST', '/v1/auth/refresh'), false);
    assert.equal(isAllowedRendererRequest('POST', '/v1/platform/tenants'), false);
    assert.equal(isAllowedRendererRequest('GET', '/v1/tenant/../auth/sessions'), false);
    assert.equal(isAllowedRendererRequest('PUT', '/v1/bp/partners/abc'), true);
    assert.equal(isAllowedRendererRequest('OPTIONS', '/v1/tenant/branches'), false);
    assert.equal(isAllowedRendererRequest('GET', '/v1/bp/partners?search=acme%20co&limit=50'), true);
    assert.equal(isAllowedRendererRequest('GET', '/v1/fin/reports/trial-balance?from=2026-01-01&to=2026-12-31'), true);
    assert.equal(isAllowedRendererRequest('PUT', '/v1/inv/price-lists/abc/prices'), true);
    assert.equal(isAllowedRendererRequest('POST', '/v1/pur/receipts/abc/cancel'), true);
    assert.equal(isAllowedRendererRequest('POST', '/v1/bank/outgoing-payments/abc/allocations/def/unallocate'), true);
    assert.equal(isAllowedRendererRequest('GET', '/v1/banking/outgoing-payments'), false);
    assert.equal(isAllowedRendererRequest('POST', '/v1/sal/quotations/abc/convert'), true);
    assert.equal(isAllowedRendererRequest('GET', '/v1/sal/invoices/abc/document'), true);
    assert.equal(isAllowedRendererRequest('GET', '/v1/sal/prices?postingDate=2026-04-01&itemIds=abc'), true);
    assert.equal(isAllowedRendererRequest('GET', '/v1/sales/orders'), false);
    assert.equal(isAllowedRendererRequest('GET', 'https://example.com/v1/tenant'), false);
  });
});

describe('api session', () => {
  it('keeps tokens in the main process and refreshes once on expiry', async () => {
    let refreshCalls = 0;
    const seen: string[] = [];
    const session = new ApiSession(
      'http://api.test',
      fakeFetch((url, init) => {
        const headers = init.headers as Record<string, string>;
        seen.push(`${init.method} ${url} ${headers.authorization ?? ''}`);
        if (url.endsWith('/v1/auth/login')) {
          return { status: 200, body: { accessToken: 'a1', refreshToken: 'r1', accessTokenExpiresIn: 900, user: { id: 'u', email: 'e', displayName: 'd' }, tenants: [] } };
        }
        if (url.endsWith('/v1/auth/refresh')) {
          refreshCalls += 1;
          return { status: 200, body: { accessToken: 'a2', refreshToken: 'r2', accessTokenExpiresIn: 900 } };
        }
        if (headers.authorization === 'Bearer a1') {
          return { status: 401, body: { error: { code: 'UNAUTHENTICATED' } } };
        }
        return { status: 200, body: [] };
      }),
    );
    const login = await session.login('e', 'p');
    assert.equal(login.ok, true);
    assert.equal(JSON.stringify(login.body).includes('r1'), false);
    assert.equal(JSON.stringify(login.body).includes('a1'), false);
    const [first, second] = await Promise.all([
      session.request('GET', '/v1/tenant/branches'),
      session.request('GET', '/v1/tenant/members'),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(refreshCalls, 1);
    assert.ok(seen.some((line) => line.endsWith('Bearer a2')));
  });

  it('keeps the two-factor challenge in the main process and signs in after verification', async () => {
    const sent: { url: string; body: string }[] = [];
    const session = new ApiSession(
      'http://api.test',
      fakeFetch((url, init) => {
        sent.push({ url, body: String(init.body ?? '') });
        if (url.endsWith('/v1/auth/login')) return { status: 200, body: { mfaRequired: true, challengeToken: 'challenge-secret-token-value', challengeExpiresIn: 300 } };
        if (url.endsWith('/v1/auth/login/mfa')) return { status: 200, body: { accessToken: 'a1', refreshToken: 'r1', accessTokenExpiresIn: 900, user: { id: 'u', email: 'e', displayName: 'd' }, tenants: [] } };
        return { status: 200, body: { enabled: true } };
      }),
    );
    assert.equal((await session.verifyMfa('123456')).status, 401);
    const login = await session.login('e', 'p');
    assert.deepEqual(login.body, { mfaRequired: true, expiresIn: 300 });
    assert.equal(JSON.stringify(login.body).includes('challenge-secret'), false);
    const verified = await session.verifyMfa('123456');
    assert.equal(verified.ok, true);
    assert.equal(JSON.stringify(verified.body).includes('a1'), false);
    assert.deepEqual(JSON.parse(sent.find((entry) => entry.url.endsWith('/login/mfa'))?.body ?? '{}'), { challengeToken: 'challenge-secret-token-value', code: '123456' });
    assert.equal((await session.mfa('status')).ok, true);
    assert.equal((await session.verifyMfa('123456')).status, 401);
  });

  it('reports network failures without throwing', async () => {
    const session = new ApiSession('http://api.test', (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    const result = await session.login('e', 'p');
    assert.equal(result.status, 0);
    assert.equal(result.ok, false);
  });
});
