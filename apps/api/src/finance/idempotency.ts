import { createHash } from 'node:crypto';
import { AppError } from '../common/errors.js';
import type { Trx } from '../database/database.service.js';

export function requestHash(operation: string, payload: unknown): string {
  return createHash('sha256').update(JSON.stringify({ operation, payload })).digest('hex');
}

export async function claimIdempotencyKey(
  trx: Trx,
  tenantId: string,
  key: string,
  operation: string,
  payload: unknown,
): Promise<string | null> {
  const hash = requestHash(operation, payload);
  const inserted = await trx
    .insertInto('idempotency_keys')
    .values({ tenant_id: tenantId, idempotency_key: key, operation, request_hash: hash })
    .onConflict((oc) => oc.columns(['tenant_id', 'idempotency_key']).doNothing())
    .returning('idempotency_key')
    .executeTakeFirst();
  if (inserted) {
    return null;
  }
  const existing = await trx
    .selectFrom('idempotency_keys')
    .select(['operation', 'request_hash', 'result_id'])
    .where('tenant_id', '=', tenantId)
    .where('idempotency_key', '=', key)
    .executeTakeFirstOrThrow();
  if (existing.operation !== operation || existing.request_hash !== hash || existing.result_id === null) {
    throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different request');
  }
  return existing.result_id;
}

export async function completeIdempotencyKey(trx: Trx, tenantId: string, key: string, resultId: string): Promise<void> {
  await trx
    .updateTable('idempotency_keys')
    .set({ result_id: resultId })
    .where('tenant_id', '=', tenantId)
    .where('idempotency_key', '=', key)
    .execute();
}
