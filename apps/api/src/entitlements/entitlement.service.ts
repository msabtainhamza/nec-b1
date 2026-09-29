import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { limitExceeded } from '../common/errors.js';
import { lockTenantResource, type Trx } from '../database/database.service.js';

export interface Entitlements {
  modules: string[];
  maxActiveSeats: number;
  maxEmployees: number;
  maxBranches: number;
  maxStorageBytes: number;
}

@Injectable()
export class EntitlementService {
  async get(trx: Trx, tenantId: string): Promise<Entitlements> {
    const row = await trx
      .selectFrom('tenant_entitlements')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .executeTakeFirstOrThrow();
    return {
      modules: row.modules,
      maxActiveSeats: row.max_active_seats,
      maxEmployees: row.max_employees,
      maxBranches: row.max_branches,
      maxStorageBytes: Number(row.max_storage_bytes),
    };
  }

  async seatUsage(trx: Trx, tenantId: string): Promise<number> {
    const members = await trx
      .selectFrom('memberships')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'active')
      .executeTakeFirstOrThrow();
    const invitations = await trx
      .selectFrom('invitations')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('tenant_id', '=', tenantId)
      .where('accepted_at', 'is', null)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .executeTakeFirstOrThrow();
    return Number(members.count) + Number(invitations.count);
  }

  async reserveSeat(trx: Trx, tenantId: string, alreadyReserved = 0): Promise<void> {
    await lockTenantResource(trx, tenantId, 'seats');
    const { maxActiveSeats } = await this.get(trx, tenantId);
    const used = (await this.seatUsage(trx, tenantId)) - alreadyReserved;
    if (used + 1 > maxActiveSeats) {
      throw limitExceeded('active seats', maxActiveSeats, used);
    }
  }

  async reserveBranch(trx: Trx, tenantId: string): Promise<void> {
    await lockTenantResource(trx, tenantId, 'branches');
    const { maxBranches } = await this.get(trx, tenantId);
    const row = await trx
      .selectFrom('branches')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'active')
      .executeTakeFirstOrThrow();
    const used = Number(row.count);
    if (used + 1 > maxBranches) {
      throw limitExceeded('active branches', maxBranches, used);
    }
  }
}
