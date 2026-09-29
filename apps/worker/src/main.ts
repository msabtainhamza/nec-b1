import { UnrecoverableError, Worker } from 'bullmq';
import pg from 'pg';
import { loadConfig } from './config.js';
import { runTenantJob, TenantJobRejected } from './tenant-job.js';

export const TENANT_QUEUE = 'tenant-jobs';

const config = loadConfig();
const pool = new pg.Pool({
  host: config.DB_HOST,
  port: config.POSTGRES_PORT,
  database: config.DB_NAME,
  user: config.DB_WORKER_USER,
  password: config.DB_WORKER_PASSWORD,
  max: config.WORKER_CONCURRENCY,
  application_name: 'nec-erp-worker',
});

const redis = new URL(config.REDIS_URL);
const worker = new Worker(
  TENANT_QUEUE,
  async (job) => {
    try {
      switch (job.name) {
        case 'tenant.ping':
          return await runTenantJob(pool, job.data, async (client, payload) => {
            await client.query(
              `insert into audit_events (tenant_id, actor_type, actor_id, action, entity_type, outcome, correlation_id)
               values ($1, 'system', null, 'worker.ping', 'job', 'success', $2)`,
              [payload.tenantId, payload.correlationId],
            );
            return { ok: true };
          });
        default:
          throw new UnrecoverableError(`Unknown job ${job.name}`);
      }
    } catch (error) {
      if (error instanceof TenantJobRejected) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  },
  {
    connection: { host: redis.hostname, port: Number(redis.port || 6379) },
    concurrency: config.WORKER_CONCURRENCY,
  },
);

worker.on('failed', (job, error) => {
  console.error(JSON.stringify({ event: 'job.failed', queue: TENANT_QUEUE, jobId: job?.id, name: job?.name, error: error.message }));
});

const shutdown = async () => {
  await worker.close();
  await pool.end();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
console.log(JSON.stringify({ event: 'worker.started', queue: TENANT_QUEUE }));
