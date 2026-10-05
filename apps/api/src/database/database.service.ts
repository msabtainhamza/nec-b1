import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import { APP_CONFIG, type AppConfig } from '../config.js';
import type { Database } from './schema.js';

const UUID_ARRAY_OID = 2951 as Parameters<typeof pg.types.setTypeParser>[0];
pg.types.setTypeParser(UUID_ARRAY_OID, (value: string) => (value === '{}' ? [] : value.slice(1, -1).split(',')));
const DATE_OID = 1082 as Parameters<typeof pg.types.setTypeParser>[0];
pg.types.setTypeParser(DATE_OID, (value: string) => value);

export type Trx = Transaction<Database>;

export interface DbContext {
  serializeCredit?: boolean;
  changeCreditPolicy?: boolean;
  tenantId?: string | null;
  userId?: string | null;
  invitationTokenHash?: string | null;
}

export function createPool(config: AppConfig, user: string, password: string): pg.Pool {
  return new pg.Pool({
    host: config.DB_HOST,
    port: config.POSTGRES_PORT,
    database: config.DB_NAME,
    user,
    password,
    max: config.DB_POOL_MAX,
    application_name: 'nec-erp-api',
  });
}

export async function applyContext(trx: Trx, context: DbContext): Promise<void> {
  await sql`select
      set_config('app.tenant_id', ${context.tenantId ?? ''}, true),
      set_config('app.user_id', ${context.userId ?? ''}, true),
      set_config('app.invitation_token_hash', ${context.invitationTokenHash ?? ''}, true)`.execute(trx);
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly db: Kysely<Database>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: createPool(config, config.DB_APP_USER, config.DB_APP_PASSWORD) }),
    });
  }

  async withContext<T>(context: DbContext, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await applyContext(trx, context);
      if (context.tenantId && context.changeCreditPolicy) await lockTenantResource(trx, context.tenantId, 'credit-policy');
      else if (context.tenantId && context.serializeCredit) {
        await sql`select pg_advisory_xact_lock_shared(hashtextextended(${`credit-policy:${context.tenantId}`}, 0))`.execute(trx);
        const policy = await trx.selectFrom('sales_credit_settings').select('mode').where('tenant_id', '=', context.tenantId).executeTakeFirst();
        if (policy && policy.mode !== 'disabled') await lockTenantResource(trx, context.tenantId, 'credit-exposure');
      }
      return fn(trx);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.destroy();
  }
}

export async function lockTenantResource(trx: Trx, tenantId: string, resource: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`${resource}:${tenantId}`}, 0))`.execute(trx);
}
