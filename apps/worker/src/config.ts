import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  REDIS_URL: z.url(),
  DB_HOST: z.string().min(1),
  POSTGRES_PORT: z.coerce.number().int().positive(),
  DB_NAME: z.string().min(1),
  DB_WORKER_USER: z.string().min(1),
  DB_WORKER_PASSWORD: z.string().min(1),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
});

export type WorkerConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid worker configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  }
  return parsed.data;
}
