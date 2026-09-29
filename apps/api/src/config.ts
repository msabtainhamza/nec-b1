import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  DB_HOST: z.string().min(1),
  POSTGRES_PORT: z.coerce.number().int().positive(),
  DB_NAME: z.string().min(1),
  DB_OWNER_USER: z.string().min(1),
  DB_OWNER_PASSWORD: z.string().min(1),
  DB_APP_USER: z.string().min(1),
  DB_APP_PASSWORD: z.string().min(1),
  DB_WORKER_USER: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  INVITATION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(72),
  MAIL_HOST: z.string().default('localhost'),
  MAIL_SMTP_PORT: z.coerce.number().int().positive().default(1025),
  MAIL_FROM: z.string().default('NEC ERP <no-reply@nec-erp.localhost>'),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration: ${fields}`);
  }
  return parsed.data;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
