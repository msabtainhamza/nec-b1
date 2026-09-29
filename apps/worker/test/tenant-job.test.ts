import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertJobAllowed, tenantJobPayload, TenantJobRejected } from '../src/tenant-job.js';

const now = new Date('2026-09-28T00:00:00Z');

describe('tenant job access', () => {
  it('allows an active member of an active tenant', () => {
    assert.doesNotThrow(() =>
      assertJobAllowed({ membership_status: 'active', tenant_status: 'active', subscription_state: 'active', retention_ends_at: null }, now),
    );
  });

  it('rejects a missing or disabled membership', () => {
    assert.throws(() => assertJobAllowed(undefined, now), TenantJobRejected);
    assert.throws(
      () => assertJobAllowed({ membership_status: 'disabled', tenant_status: 'active', subscription_state: 'active', retention_ends_at: null }, now),
      TenantJobRejected,
    );
  });

  it('rejects background work for suspended or restricted tenants', () => {
    assert.throws(
      () => assertJobAllowed({ membership_status: 'active', tenant_status: 'active', subscription_state: 'suspended', retention_ends_at: null }, now),
      TenantJobRejected,
    );
    assert.throws(
      () => assertJobAllowed({ membership_status: 'active', tenant_status: 'suspended', subscription_state: 'active', retention_ends_at: null }, now),
      TenantJobRejected,
    );
  });

  it('rejects payloads without a valid tenant and requester', () => {
    assert.equal(tenantJobPayload.safeParse({ tenantId: 'x', requestedByUserId: 'y', correlationId: 'z' }).success, false);
  });
});
