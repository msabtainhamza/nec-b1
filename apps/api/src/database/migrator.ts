import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import type { AppConfig } from '../config.js';

const MIGRATIONS_DIR = new URL('../../../migrations/', import.meta.url);

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

function ownerClient(config: AppConfig): pg.Client {
  return new pg.Client({
    host: config.DB_HOST,
    port: config.POSTGRES_PORT,
    database: config.DB_NAME,
    user: config.DB_OWNER_USER,
    password: config.DB_OWNER_PASSWORD,
    application_name: 'nec-erp-migrator',
  });
}

function assertRoleName(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`Unsafe database role name: ${name}`);
  }
  return name;
}

function render(sqlText: string, config: AppConfig): string {
  return sqlText
    .replaceAll('{{app_role}}', assertRoleName(config.DB_APP_USER))
    .replaceAll('{{worker_role}}', assertRoleName(config.DB_WORKER_USER));
}

export async function migrate(config: AppConfig): Promise<MigrationResult> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();
  const client = ownerClient(config);
  await client.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', ['nec-erp-migrations']);
    const { rows } = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations');
    const applied = new Map(rows.map((row) => [row.name, row.checksum]));
    for (const file of files) {
      const text = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
      const checksum = createHash('sha256').update(text).digest('hex');
      const existing = applied.get(file);
      if (existing !== undefined) {
        if (existing !== checksum) {
          throw new Error(`Migration ${file} changed after it was applied`);
        }
        result.skipped.push(file);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(render(text, config));
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }
      result.applied.push(file);
    }
  } finally {
    await client.end();
  }
  return result;
}

export async function resetSchema(config: AppConfig): Promise<void> {
  if (config.NODE_ENV === 'production') {
    throw new Error('Schema reset is disabled in production');
  }
  const client = ownerClient(config);
  await client.connect();
  try {
    const app = assertRoleName(config.DB_APP_USER);
    const worker = assertRoleName(config.DB_WORKER_USER);
    await client.query(`DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO ${app}, ${worker};`);
  } finally {
    await client.end();
  }
}
