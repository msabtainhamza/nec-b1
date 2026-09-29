import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  PartnerBalance,
  BusinessPartner,
  CreateGroupRequest,
  CreatePartnerRequest,
  CreatePaymentTermsRequest,
  Page,
  PartnerGroup,
  PartnerListQuery,
  PartnerSummary,
  PartnerType,
  PaymentTerms,
  UpdatePartnerRequest,
} from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { formatMoney, parseMoney } from '../finance/money.js';
import { AppError, conflict, isUniqueViolation, notFound, versionConflict } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, type Trx } from '../database/database.service.js';

type PartnerFields = Omit<CreatePartnerRequest, 'code'>;

const HEADER_AUDIT_FIELDS = [
  'name',
  'foreignName',
  'partnerType',
  'groupId',
  'taxId',
  'phone',
  'email',
  'website',
  'paymentTermsId',
  'creditLimit',
  'status',
] as const;

function fieldError(path: string, message: string): AppError {
  return new AppError(400, 'VALIDATION_FAILED', message, [{ path, message }]);
}

@Injectable()
export class BusinessPartnersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list(principal: TenantPrincipal, query: PartnerListQuery): Promise<Page<PartnerSummary>> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      let base = trx
        .selectFrom('business_partners as bp')
        .leftJoin('bp_groups as g', (join) => join.onRef('g.id', '=', 'bp.group_id').onRef('g.tenant_id', '=', 'bp.tenant_id'))
        .where('bp.tenant_id', '=', principal.tenantId);
      if (query.search) {
        const pattern = `%${query.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
        base = base.where((eb) => eb.or([eb('bp.code', 'ilike', pattern), eb('bp.name', 'ilike', pattern)]));
      }
      if (query.partnerType) {
        base = base.where('bp.partner_type', '=', query.partnerType);
      }
      if (query.status) {
        base = base.where('bp.status', '=', query.status);
      }
      const total = await base.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
      const rows = await base
        .select(['bp.id', 'bp.code', 'bp.name', 'bp.partner_type', 'bp.phone', 'bp.status', 'g.name as group_name'])
        .orderBy('bp.code')
        .limit(query.limit)
        .offset(query.offset)
        .execute();
      return {
        items: rows.map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          partnerType: row.partner_type,
          groupName: row.group_name,
          phone: row.phone,
          status: row.status,
        })),
        limit: query.limit,
        offset: query.offset,
        total: Number(total.count),
      };
    });
  }

  async get(principal: TenantPrincipal, partnerId: string): Promise<BusinessPartner> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const partner = await this.load(trx, principal.tenantId, partnerId);
      if (!partner) {
        throw notFound();
      }
      return partner;
    });
  }

  async create(principal: TenantPrincipal, input: CreatePartnerRequest, correlationId: string): Promise<BusinessPartner> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const currency = await this.validate(trx, principal.tenantId, input);
      let created: { id: string };
      try {
        created = await trx
          .insertInto('business_partners')
          .values({
            tenant_id: principal.tenantId,
            code: input.code,
            ...this.headerValues(input, currency),
            created_by: principal.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error, 'business_partners_tenant_id_code_key')) {
          throw conflict(`A business partner with code ${input.code} already exists`);
        }
        throw error;
      }
      await this.replaceLines(trx, principal.tenantId, created.id, input);
      const partner = await this.load(trx, principal.tenantId, created.id);
      if (!partner) {
        throw new Error('Created business partner could not be read back');
      }
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'business_partner.created',
        entityType: 'business_partner',
        entityId: partner.id,
        after: { code: partner.code, ...auditHeader(partner), contacts: partner.contacts.length, addresses: partner.addresses.length },
        correlationId,
      });
      return partner;
    });
  }

  async update(principal: TenantPrincipal, partnerId: string, input: UpdatePartnerRequest, correlationId: string): Promise<BusinessPartner> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const current = await trx
        .selectFrom('business_partners')
        .select(['id', 'version', 'partner_type'])
        .where('tenant_id', '=', principal.tenantId)
        .where('id', '=', partnerId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) {
        throw notFound();
      }
      if (current.version !== input.version) {
        throw versionConflict();
      }
      assertTypeChange(current.partner_type, input.partnerType);
      const before = await this.load(trx, principal.tenantId, partnerId);
      const currency = await this.validate(trx, principal.tenantId, input);
      await trx
        .updateTable('business_partners')
        .set({ ...this.headerValues(input, currency), version: current.version + 1, updated_at: new Date() })
        .where('tenant_id', '=', principal.tenantId)
        .where('id', '=', partnerId)
        .execute();
      await this.replaceLines(trx, principal.tenantId, partnerId, input);
      const after = await this.load(trx, principal.tenantId, partnerId);
      if (!before || !after) {
        throw new Error('Business partner could not be read back');
      }
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'business_partner.updated',
        entityType: 'business_partner',
        entityId: partnerId,
        before: { ...auditHeader(before), contacts: before.contacts.length, addresses: before.addresses.length },
        after: { ...auditHeader(after), contacts: after.contacts.length, addresses: after.addresses.length },
        correlationId,
      });
      return after;
    });
  }

  async balance(principal: TenantPrincipal, partnerId: string): Promise<PartnerBalance> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const partner = await trx
        .selectFrom('business_partners')
        .select(['id', 'partner_type', 'currency'])
        .where('tenant_id', '=', principal.tenantId)
        .where('id', '=', partnerId)
        .executeTakeFirst();
      if (!partner) throw notFound();
      const totals = await trx
        .selectFrom('journal_lines')
        .select([
          sql<string>`coalesce(sum(debit), 0)::text`.as('debit'),
          sql<string>`coalesce(sum(credit), 0)::text`.as('credit'),
        ])
        .where('tenant_id', '=', principal.tenantId)
        .where('partner_id', '=', partnerId)
        .executeTakeFirstOrThrow();
      const open = await trx
        .selectFrom('ap_invoices')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('tenant_id', '=', principal.tenantId)
        .where('vendor_id', '=', partnerId)
        .where('status', '=', 'posted')
        .where('is_cancellation', '=', false)
        .whereRef('paid_amount', '<', 'total')
        .executeTakeFirstOrThrow();
      const debit = parseMoney(totals.debit);
      const credit = parseMoney(totals.credit);
      const balance = formatMoney(partner.partner_type === 'supplier' ? credit - debit : debit - credit);
      return { partnerId, currency: partner.currency, balance, openInvoices: Number(open.count) };
    });
  }

  async groups(principal: TenantPrincipal): Promise<PartnerGroup[]> {
    const rows = await this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, (trx) =>
      trx.selectFrom('bp_groups').select(['id', 'code', 'name', 'partner_type']).where('tenant_id', '=', principal.tenantId).orderBy('name').execute(),
    );
    return rows.map((row) => ({ id: row.id, code: row.code, name: row.name, partnerType: row.partner_type }));
  }

  async createGroup(principal: TenantPrincipal, input: CreateGroupRequest, correlationId: string): Promise<PartnerGroup> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      try {
        const row = await trx
          .insertInto('bp_groups')
          .values({ tenant_id: principal.tenantId, code: input.code, name: input.name, partner_type: input.partnerType })
          .returning(['id', 'code', 'name', 'partner_type'])
          .executeTakeFirstOrThrow();
        await this.audit.record(trx, {
          tenantId: principal.tenantId,
          actor: { type: 'user', id: principal.userId },
          action: 'business_partner_group.created',
          entityType: 'business_partner_group',
          entityId: row.id,
          after: { code: row.code, name: row.name, partnerType: row.partner_type },
          correlationId,
        });
        return { id: row.id, code: row.code, name: row.name, partnerType: row.partner_type };
      } catch (error) {
        if (isUniqueViolation(error, 'bp_groups_tenant_id_code_key')) {
          throw conflict(`A group with code ${input.code} already exists`);
        }
        throw error;
      }
    });
  }

  async paymentTerms(principal: TenantPrincipal): Promise<PaymentTerms[]> {
    const rows = await this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, (trx) =>
      trx.selectFrom('payment_terms').select(['id', 'code', 'name', 'due_days']).where('tenant_id', '=', principal.tenantId).orderBy('due_days').execute(),
    );
    return rows.map((row) => ({ id: row.id, code: row.code, name: row.name, dueDays: row.due_days }));
  }

  async createPaymentTerms(principal: TenantPrincipal, input: CreatePaymentTermsRequest, correlationId: string): Promise<PaymentTerms> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      try {
        const row = await trx
          .insertInto('payment_terms')
          .values({ tenant_id: principal.tenantId, code: input.code, name: input.name, due_days: input.dueDays })
          .returning(['id', 'code', 'name', 'due_days'])
          .executeTakeFirstOrThrow();
        await this.audit.record(trx, {
          tenantId: principal.tenantId,
          actor: { type: 'user', id: principal.userId },
          action: 'payment_terms.created',
          entityType: 'payment_terms',
          entityId: row.id,
          after: { code: row.code, name: row.name, dueDays: row.due_days },
          correlationId,
        });
        return { id: row.id, code: row.code, name: row.name, dueDays: row.due_days };
      } catch (error) {
        if (isUniqueViolation(error, 'payment_terms_tenant_id_code_key')) {
          throw conflict(`Payment terms with code ${input.code} already exist`);
        }
        throw error;
      }
    });
  }

  private async validate(trx: Trx, tenantId: string, input: PartnerFields): Promise<string> {
    const tenant = await trx.selectFrom('tenants').select('base_currency').where('id', '=', tenantId).executeTakeFirstOrThrow();
    const currency = input.currency ?? tenant.base_currency;
    if (currency !== tenant.base_currency) {
      throw fieldError('currency', `Only the company currency ${tenant.base_currency} is supported in this release`);
    }
    if (input.groupId) {
      const group = await trx
        .selectFrom('bp_groups')
        .select('partner_type')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', input.groupId)
        .executeTakeFirst();
      if (!group) {
        throw fieldError('groupId', 'The selected group was not found');
      }
      const expected = input.partnerType === 'supplier' ? 'supplier' : 'customer';
      if (group.partner_type !== expected) {
        throw fieldError('groupId', `Choose a ${expected} group for this partner type`);
      }
    }
    if (input.paymentTermsId) {
      const terms = await trx
        .selectFrom('payment_terms')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', input.paymentTermsId)
        .executeTakeFirst();
      if (!terms) {
        throw fieldError('paymentTermsId', 'The selected payment terms were not found');
      }
    }
    if (input.contacts.filter((contact) => contact.isDefault).length > 1) {
      throw fieldError('contacts', 'Only one contact person can be the default');
    }
    for (const type of ['bill_to', 'ship_to'] as const) {
      const addresses = input.addresses.filter((address) => address.addressType === type);
      if (addresses.filter((address) => address.isDefault).length > 1) {
        throw fieldError('addresses', `Only one ${type === 'bill_to' ? 'bill-to' : 'ship-to'} address can be the default`);
      }
      const names = new Set(addresses.map((address) => address.addressName.toLowerCase()));
      if (names.size !== addresses.length) {
        throw fieldError('addresses', 'Address names must be unique per address type');
      }
    }
    return currency;
  }

  private headerValues(input: PartnerFields, currency: string) {
    return {
      name: input.name,
      foreign_name: input.foreignName ?? null,
      partner_type: input.partnerType,
      group_id: input.groupId ?? null,
      currency,
      tax_id: input.taxId ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      website: input.website ?? null,
      payment_terms_id: input.paymentTermsId ?? null,
      credit_limit: input.creditLimit,
      status: input.status,
      remarks: input.remarks ?? null,
    };
  }

  private async replaceLines(trx: Trx, tenantId: string, partnerId: string, input: PartnerFields): Promise<void> {
    await trx.deleteFrom('bp_contacts').where('tenant_id', '=', tenantId).where('partner_id', '=', partnerId).execute();
    await trx.deleteFrom('bp_addresses').where('tenant_id', '=', tenantId).where('partner_id', '=', partnerId).execute();
    if (input.contacts.length > 0) {
      await trx
        .insertInto('bp_contacts')
        .values(
          input.contacts.map((contact, index) => ({
            tenant_id: tenantId,
            partner_id: partnerId,
            line_no: index + 1,
            name: contact.name,
            position: contact.position ?? null,
            phone: contact.phone ?? null,
            email: contact.email ?? null,
            is_default: contact.isDefault,
          })),
        )
        .execute();
    }
    if (input.addresses.length > 0) {
      await trx
        .insertInto('bp_addresses')
        .values(
          input.addresses.map((address, index) => ({
            tenant_id: tenantId,
            partner_id: partnerId,
            line_no: index + 1,
            address_type: address.addressType,
            address_name: address.addressName,
            street: address.street ?? null,
            city: address.city ?? null,
            state: address.state ?? null,
            zip_code: address.zipCode ?? null,
            country: address.country ?? null,
            is_default: address.isDefault,
          })),
        )
        .execute();
    }
  }

  private async load(trx: Trx, tenantId: string, partnerId: string): Promise<BusinessPartner | null> {
    const row = await trx
      .selectFrom('business_partners')
      .selectAll()
      .select(sql<string>`credit_limit::text`.as('credit_limit_text'))
      .where('tenant_id', '=', tenantId)
      .where('id', '=', partnerId)
      .executeTakeFirst();
    if (!row) {
      return null;
    }
    const contacts = await trx
      .selectFrom('bp_contacts')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('partner_id', '=', partnerId)
      .orderBy('line_no')
      .execute();
    const addresses = await trx
      .selectFrom('bp_addresses')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('partner_id', '=', partnerId)
      .orderBy('line_no')
      .execute();
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      foreignName: row.foreign_name,
      partnerType: row.partner_type,
      groupId: row.group_id,
      currency: row.currency,
      taxId: row.tax_id,
      phone: row.phone,
      email: row.email,
      website: row.website,
      paymentTermsId: row.payment_terms_id,
      creditLimit: row.credit_limit_text,
      status: row.status,
      remarks: row.remarks,
      version: row.version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      contacts: contacts.map((contact) => ({
        id: contact.id,
        lineNo: contact.line_no,
        name: contact.name,
        position: contact.position,
        phone: contact.phone,
        email: contact.email,
        isDefault: contact.is_default,
      })),
      addresses: addresses.map((address) => ({
        id: address.id,
        lineNo: address.line_no,
        addressType: address.address_type,
        addressName: address.address_name,
        street: address.street,
        city: address.city,
        state: address.state,
        zipCode: address.zip_code,
        country: address.country,
        isDefault: address.is_default,
      })),
    };
  }
}

function assertTypeChange(from: PartnerType, to: PartnerType): void {
  if (from === to || (from === 'lead' && to === 'customer')) {
    return;
  }
  throw conflict('Only a lead can change type, and only to customer');
}

function auditHeader(partner: BusinessPartner): Record<string, unknown> {
  return Object.fromEntries(HEADER_AUDIT_FIELDS.map((field) => [field, partner[field]]));
}
