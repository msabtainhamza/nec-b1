import type { INestApplicationContext } from '@nestjs/common';
import type { ProvisionTenantRequest } from '@nec/contracts';
import { Kysely, PostgresDialect } from 'kysely';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { hashPassword } from '../auth/crypto.js';
import { InvitationsService } from '../tenancy/invitations.service.js';
import { PlatformService } from '../platform/platform.service.js';
import { createPool, DatabaseService } from './database.service.js';
import type { Database } from './schema.js';

const seedEnv = z.object({
  SEED_OPERATOR_EMAIL: z.email(),
  SEED_OPERATOR_PASSWORD: z.string().min(12),
  SEED_OPERATOR_TOTP_SECRET: z.string().regex(/^[A-Z2-7]{16,}$/),
  SEED_USER_PASSWORD: z.string().min(12),
});

export const SEED_PLANS = [
  { code: 'starter', name: 'Starter', maxActiveSeats: 5, maxEmployees: 25, maxBranches: 3, maxStorageBytes: 1_073_741_824 },
  { code: 'micro', name: 'Micro', maxActiveSeats: 2, maxEmployees: 5, maxBranches: 1, maxStorageBytes: 268_435_456 },
] as const;

export const SEED_TENANTS: ReadonlyArray<ProvisionTenantRequest & { extraBranches: { code: string; name: string }[] }> = [
  {
    code: 'acme-trading',
    legalName: 'Acme Trading Local Test Company',
    displayName: 'Acme Trading',
    baseCurrency: 'USD',
    timeZone: 'UTC',
    planCode: 'starter',
    subscriptionState: 'active',
    defaultBranch: { code: 'HQ', name: 'Head Office' },
    ownerEmail: 'owner.acme@nec-erp.localhost',
    extraBranches: [{ code: 'WH1', name: 'Main Warehouse' }],
  },
  {
    code: 'globex-distribution',
    legalName: 'Globex Distribution Local Test Company',
    displayName: 'Globex Distribution',
    baseCurrency: 'USD',
    timeZone: 'UTC',
    planCode: 'micro',
    subscriptionState: 'trial',
    defaultBranch: { code: 'HQ', name: 'Globex Head Office' },
    ownerEmail: 'owner.globex@nec-erp.localhost',
    extraBranches: [],
  },
];

export const SHARED_USER_EMAIL = 'shared.user@nec-erp.localhost';

export interface SeedSummary {
  tenants: { code: string; id: string }[];
  users: string[];
  operator: string;
}

export async function seed(app: INestApplicationContext, config: AppConfig, env: NodeJS.ProcessEnv = process.env): Promise<SeedSummary> {
  const values = seedEnv.parse(env);
  const database = app.get(DatabaseService);
  const platform = app.get(PlatformService);
  const invitations = app.get(InvitationsService);

  const existing = await database.db.selectFrom('tenants').select('id').limit(1).execute();
  if (existing.length > 0) {
    throw new Error('Seed requires an empty database. Run db:reset first.');
  }

  const ownerDb = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: createPool(config, config.DB_OWNER_USER, config.DB_OWNER_PASSWORD) }),
  });
  try {
    await seedCatalog(ownerDb, values);
  } finally {
    await ownerDb.destroy();
  }
  const operator = await database.db
    .selectFrom('platform_operators')
    .select('id')
    .where('email', '=', values.SEED_OPERATOR_EMAIL.toLowerCase())
    .executeTakeFirstOrThrow();

  const summary: SeedSummary = { tenants: [], users: [], operator: values.SEED_OPERATOR_EMAIL };
  for (const tenant of SEED_TENANTS) {
    const { extraBranches, ...request } = tenant;
    const { response, mail } = await platform.provisionWithin(operator.id, request, 'seed');
    await invitations.accept(
      { token: mail.token, password: values.SEED_USER_PASSWORD, displayName: `${tenant.displayName} Owner` },
      'seed',
    );
    summary.tenants.push({ code: tenant.code, id: response.tenantId });
    summary.users.push(tenant.ownerEmail);
    for (const branch of extraBranches) {
      await database.withContext({ tenantId: response.tenantId }, (trx) =>
        trx.insertInto('branches').values({ tenant_id: response.tenantId, code: branch.code, name: branch.name }).execute(),
      );
    }
  }

  const roleFor = async (tenantId: string, code: string) =>
    database.withContext({ tenantId }, (trx) =>
      trx.selectFrom('roles').select('id').where('code', '=', code).executeTakeFirstOrThrow(),
    );
  const [acme, globex] = summary.tenants;
  if (!acme || !globex) {
    throw new Error('Seed tenants were not created');
  }
  const sharedRoles = [
    { tenantId: acme.id, role: 'administrator' },
    { tenantId: globex.id, role: 'auditor' },
  ];
  for (const { tenantId, role } of sharedRoles) {
    const roleId = (await roleFor(tenantId, role)).id;
    const { mail } = await database.withContext({ tenantId }, (trx) =>
      invitations.createWithin(trx, {
        tenantId,
        email: SHARED_USER_EMAIL,
        roleIds: [roleId],
        actor: { type: 'operator', id: operator.id },
        correlationId: 'seed',
      }),
    );
    await invitations.accept({ token: mail.token, password: values.SEED_USER_PASSWORD, displayName: 'Shared User' }, 'seed');
  }
  summary.users.push(SHARED_USER_EMAIL);
  return summary;
}

async function seedCatalog(ownerDb: Kysely<Database>, values: z.infer<typeof seedEnv>): Promise<void> {
  await ownerDb.transaction().execute(async (trx) => {
    for (const plan of SEED_PLANS) {
      await trx
        .insertInto('plans')
        .values({
          code: plan.code,
          name: plan.name,
          modules: ['admin', 'bp', 'fin', 'inv', 'pur', 'bank', 'sal'],
          max_active_seats: plan.maxActiveSeats,
          max_employees: plan.maxEmployees,
          max_branches: plan.maxBranches,
          max_storage_bytes: plan.maxStorageBytes,
        })
        .execute();
    }
    await trx
      .insertInto('platform_operators')
      .values({
        email: values.SEED_OPERATOR_EMAIL.toLowerCase(),
        display_name: 'Local Platform Operator',
        password_hash: await hashPassword(values.SEED_OPERATOR_PASSWORD),
        totp_secret: values.SEED_OPERATOR_TOTP_SECRET,
      })
      .execute();
  });
}
