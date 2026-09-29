import { Injectable } from '@nestjs/common';
import type { AddTaxRateRequest, CreateTaxCodeRequest, TaxCode } from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { conflict, isUniqueViolation, notFound } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, type Trx } from '../database/database.service.js';
import { formatMoney, parseMoney } from './money.js';

@Injectable()
export class TaxService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private run<T>(principal: TenantPrincipal, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, fn);
  }

  async list(principal: TenantPrincipal): Promise<TaxCode[]> {
    return this.run(principal, async (trx) => {
      const codes = await trx.selectFrom('tax_codes').selectAll().where('tenant_id', '=', principal.tenantId).orderBy('code').execute();
      const rates = await trx
        .selectFrom('tax_code_rates')
        .select(['tax_code_id', 'valid_from', 'rate'])
        .where('tenant_id', '=', principal.tenantId)
        .orderBy('valid_from', 'desc')
        .execute();
      const today = new Date().toISOString().slice(0, 10);
      return codes.map((code) => {
        const own = rates.filter((rate) => rate.tax_code_id === code.id);
        return {
          id: code.id,
          code: code.code,
          name: code.name,
          purpose: code.purpose,
          status: code.status,
          currentRate: own.find((rate) => rate.valid_from <= today)?.rate ?? null,
          rates: own.map((rate) => ({ validFrom: rate.valid_from, rate: rate.rate })),
          version: code.version,
        };
      });
    });
  }

  async create(principal: TenantPrincipal, input: CreateTaxCodeRequest, correlationId: string): Promise<TaxCode> {
    const id = await this.run(principal, async (trx) => {
      try {
        const row = await trx
          .insertInto('tax_codes')
          .values({ tenant_id: principal.tenantId, code: input.code, name: input.name, purpose: input.purpose })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('tax_code_rates')
          .values({ tenant_id: principal.tenantId, tax_code_id: row.id, valid_from: input.validFrom, rate: formatMoney(parseMoney(input.rate)) })
          .execute();
        await this.audit.record(trx, {
          tenantId: principal.tenantId,
          actor: { type: 'user', id: principal.userId },
          action: 'tax_code.created',
          entityType: 'tax_code',
          entityId: row.id,
          after: { ...input },
          correlationId,
        });
        return row.id;
      } catch (error) {
        if (isUniqueViolation(error, 'tax_codes_tenant_id_code_key')) throw conflict(`Tax code ${input.code} already exists`);
        throw error;
      }
    });
    return this.one(principal, id);
  }

  async addRate(principal: TenantPrincipal, taxCodeId: string, input: AddTaxRateRequest, correlationId: string): Promise<TaxCode> {
    await this.run(principal, async (trx) => {
      const code = await trx.selectFrom('tax_codes').select('id').where('tenant_id', '=', principal.tenantId).where('id', '=', taxCodeId).executeTakeFirst();
      if (!code) throw notFound();
      try {
        await trx
          .insertInto('tax_code_rates')
          .values({ tenant_id: principal.tenantId, tax_code_id: taxCodeId, valid_from: input.validFrom, rate: formatMoney(parseMoney(input.rate)) })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict(`A rate already starts on ${input.validFrom}; rates are versioned and cannot be overwritten`);
        throw error;
      }
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'tax_code.rate_added',
        entityType: 'tax_code',
        entityId: taxCodeId,
        after: { ...input },
        correlationId,
      });
    });
    return this.one(principal, taxCodeId);
  }

  private async one(principal: TenantPrincipal, id: string): Promise<TaxCode> {
    const code = (await this.list(principal)).find((row) => row.id === id);
    if (!code) throw notFound();
    return code;
  }
}
