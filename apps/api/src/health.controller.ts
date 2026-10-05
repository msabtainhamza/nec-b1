import { Controller, Get, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { API_VERSION } from '@nec/contracts';
import { Public } from './auth/auth.guard.js';
import { DatabaseService } from './database/database.service.js';
import { AppError } from './common/errors.js';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly database: DatabaseService) {}

  @Public()
  @Get()
  async health(): Promise<{ status: 'ok'; apiVersion: string; database: 'ok' }> {
    try {
      await sql`select 1`.execute(this.database.db);
    } catch (error) {
      const failures = error instanceof AggregateError ? error.errors : [error];
      const codes = failures.map((failure: unknown) => {
        const code = (failure as { code?: unknown } | null)?.code;
        return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'UNKNOWN';
      });
      this.logger.warn(JSON.stringify({ event: 'health.database_unavailable', codes: [...new Set(codes)] }));
      throw new AppError(503, 'DATABASE_UNAVAILABLE', 'The database is unavailable. Restore database connectivity and retry.');
    }
    return { status: 'ok', apiVersion: API_VERSION, database: 'ok' };
  }
}
