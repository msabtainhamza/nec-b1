import { Controller, Get } from '@nestjs/common';
import { sql } from 'kysely';
import { API_VERSION } from '@nec/contracts';
import { Public } from './auth/auth.guard.js';
import { DatabaseService } from './database/database.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Public()
  @Get()
  async health(): Promise<{ status: 'ok'; apiVersion: string; database: 'ok' }> {
    await sql`select 1`.execute(this.database.db);
    return { status: 'ok', apiVersion: API_VERSION, database: 'ok' };
  }
}
