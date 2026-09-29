import type { INestApplication } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import * as OTPAuth from 'otpauth';
import request from 'supertest';
import type { LoginResponse, SelectTenantResponse } from '@nec/contracts';
import { createApp } from '../src/bootstrap.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createPool } from '../src/database/database.service.js';
import { migrate, resetSchema } from '../src/database/migrator.js';
import type { Database } from '../src/database/schema.js';
import { seed, SHARED_USER_EMAIL, type SeedSummary } from '../src/database/seed.js';
import type { MailMessage, Mailer } from '../src/mail/mailer.js';

export class CapturingMailer implements Mailer {
  readonly messages: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.messages.push(message);
  }

  tokenFor(email: string): string {
    const message = [...this.messages].reverse().find((candidate) => candidate.to === email);
    const token = message?.text.split('\n').find((line) => /^[A-Za-z0-9_-]{40,}$/.test(line.trim()));
    if (!token) {
      throw new Error(`No invitation token was sent to ${email}`);
    }
    return token.trim();
  }
}

export interface TestContext {
  app: INestApplication;
  http: ReturnType<typeof request>;
  config: AppConfig;
  mailer: CapturingMailer;
  seeded: SeedSummary;
  password: string;
  tenantId: (code: string) => string;
  asApp: Kysely<Database>;
  close: () => Promise<void>;
}

export const ACME = 'acme-trading';
export const GLOBEX = 'globex-distribution';
export const ACME_OWNER = 'owner.acme@nec-erp.localhost';
export const GLOBEX_OWNER = 'owner.globex@nec-erp.localhost';
export const SHARED = SHARED_USER_EMAIL;

export async function setup(): Promise<TestContext> {
  const testDb = process.env.DB_TEST_NAME;
  if (!testDb) {
    throw new Error('DB_TEST_NAME must be set for tests');
  }
  const config = loadConfig({ ...process.env, DB_NAME: testDb, NODE_ENV: 'test' });
  await resetSchema(config);
  await migrate(config);
  const mailer = new CapturingMailer();
  const app = await createApp({ config, mailer });
  await app.init();
  const seeded = await seed(app, config);
  const asApp = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: createPool(config, config.DB_APP_USER, config.DB_APP_PASSWORD) }),
  });
  return {
    app,
    http: request(app.getHttpServer()),
    config,
    mailer,
    seeded,
    password: process.env.SEED_USER_PASSWORD ?? '',
    tenantId: (code) => {
      const tenant = seeded.tenants.find((candidate) => candidate.code === code);
      if (!tenant) {
        throw new Error(`Unknown seeded tenant ${code}`);
      }
      return tenant.id;
    },
    asApp,
    close: async () => {
      await asApp.destroy();
      await app.close();
    },
  };
}

export async function login(ctx: TestContext, email: string): Promise<LoginResponse> {
  const response = await ctx.http.post('/v1/auth/login').send({ email, password: ctx.password });
  if (response.status !== 200) {
    throw new Error(`Login failed for ${email}: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body as LoginResponse;
}

export async function loginToTenant(ctx: TestContext, email: string, code: string): Promise<{ token: string; login: LoginResponse }> {
  const session = await login(ctx, email);
  const response = await ctx.http
    .post('/v1/auth/select-tenant')
    .set('authorization', `Bearer ${session.accessToken}`)
    .send({ tenantId: ctx.tenantId(code) });
  if (response.status !== 200) {
    throw new Error(`Tenant selection failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return { token: (response.body as SelectTenantResponse).accessToken, login: session };
}

export function currentTotp(): string {
  const secret = process.env.SEED_OPERATOR_TOTP_SECRET;
  if (!secret) {
    throw new Error('SEED_OPERATOR_TOTP_SECRET must be set for tests');
  }
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), algorithm: 'SHA1', digits: 6, period: 30 }).generate();
}

export async function operatorLogin(ctx: TestContext): Promise<string> {
  const response = await ctx.http.post('/v1/platform/auth/login').send({
    email: process.env.SEED_OPERATOR_EMAIL,
    password: process.env.SEED_OPERATOR_PASSWORD,
    totp: currentTotp(),
  });
  if (response.status !== 200) {
    throw new Error(`Operator login failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.accessToken as string;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
