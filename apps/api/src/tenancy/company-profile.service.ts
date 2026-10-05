import { Injectable } from '@nestjs/common';
import type { CompanyProfile, UpdateCompanyProfileRequest } from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { versionConflict } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, lockTenantResource, type Trx } from '../database/database.service.js';

export async function loadCompanyProfile(trx: Trx, tenantId: string): Promise<CompanyProfile> {
  const row = await trx.selectFrom('company_profiles').selectAll().where('tenant_id', '=', tenantId).executeTakeFirst();
  if (!row) return { street: null, city: null, state: null, zipCode: null, country: null, taxNumber: null, phone: null, email: null, invoiceFooter: null, version: 0 };
  return {
    street: row.street,
    city: row.city,
    state: row.state,
    zipCode: row.zip_code,
    country: row.country,
    taxNumber: row.tax_number,
    phone: row.phone,
    email: row.email,
    invoiceFooter: row.invoice_footer,
    version: row.version,
  };
}

@Injectable()
export class CompanyProfileService {
  constructor(private readonly database: DatabaseService, private readonly audit: AuditService) {}

  async get(principal: TenantPrincipal): Promise<CompanyProfile> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, (trx) => loadCompanyProfile(trx, principal.tenantId));
  }

  async update(principal: TenantPrincipal, input: UpdateCompanyProfileRequest, correlationId: string): Promise<CompanyProfile> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      await lockTenantResource(trx, principal.tenantId, 'company-profile');
      const { version, ...fields } = input;
      const before = await loadCompanyProfile(trx, principal.tenantId);
      if (before.version !== version) throw versionConflict();
      const values = {
        street: fields.street ?? null,
        city: fields.city ?? null,
        state: fields.state ?? null,
        zip_code: fields.zipCode ?? null,
        country: fields.country ?? null,
        tax_number: fields.taxNumber ?? null,
        phone: fields.phone ?? null,
        email: fields.email ?? null,
        invoice_footer: fields.invoiceFooter ?? null,
        version: before.version + 1,
        updated_at: new Date(),
      };
      await trx.insertInto('company_profiles').values({ tenant_id: principal.tenantId, ...values }).onConflict((oc) => oc.column('tenant_id').doUpdateSet(values)).execute();
      const after = await loadCompanyProfile(trx, principal.tenantId);
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'company_profile.changed',
        entityType: 'company_profile',
        entityId: null,
        before: { ...before },
        after: { ...after },
        correlationId,
      });
      return after;
    });
  }
}
