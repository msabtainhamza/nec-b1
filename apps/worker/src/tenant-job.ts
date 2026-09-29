import { subscriptionAccessMode, type SubscriptionState } from '@nec/contracts';
import type pg from 'pg';
import { z } from 'zod';

export const tenantJobPayload = z.object({
  tenantId: z.uuid(),
  requestedByUserId: z.uuid(),
  correlationId: z.string().min(1).max(64),
});

export type TenantJobPayload = z.infer<typeof tenantJobPayload>;

export class TenantJobRejected extends Error {}

export interface JobAccessRow {
  membership_status: string;
  tenant_status: string;
  subscription_state: SubscriptionState;
  retention_ends_at: Date | null;
}

export function assertJobAllowed(row: JobAccessRow | undefined, now: Date): void {
  if (!row || row.membership_status !== 'active') {
    throw new TenantJobRejected('The requesting membership is not active in this tenant');
  }
  const mode = subscriptionAccessMode({ state: row.subscription_state, retentionEndsAt: row.retention_ends_at, now });
  if (row.tenant_status !== 'active' || mode !== 'full') {
    throw new TenantJobRejected('The tenant subscription does not allow background work');
  }
}

export async function runTenantJob<T>(
  pool: pg.Pool,
  rawPayload: unknown,
  handler: (client: pg.PoolClient, payload: TenantJobPayload) => Promise<T>,
): Promise<T> {
  const parsed = tenantJobPayload.safeParse(rawPayload);
  if (!parsed.success) {
    throw new TenantJobRejected('The job payload is invalid');
  }
  const payload = parsed.data;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [
      payload.tenantId,
      payload.requestedByUserId,
    ]);
    const { rows } = await client.query<JobAccessRow>(
      `select m.status as membership_status, t.status as tenant_status,
              s.state as subscription_state, s.retention_ends_at
         from memberships m
         join tenants t on t.id = m.tenant_id
         join subscriptions s on s.tenant_id = t.id
        where m.tenant_id = $1 and m.user_id = $2`,
      [payload.tenantId, payload.requestedByUserId],
    );
    assertJobAllowed(rows[0], new Date());
    const result = await handler(client, payload);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
