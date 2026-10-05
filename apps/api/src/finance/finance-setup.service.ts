import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import {
  DETERMINATION_KEYS,
  type Account,
  type ChangePeriodStatusRequest,
  type CreateAccountRequest,
  type CreateFiscalYearRequest,
  type CreateSeriesRequest,
  type DeterminationKey,
  type GlDetermination,
  type NumberingSeries,
  type PostingPeriod,
  type UpdateAccountRequest,
  type UpdateDeterminationRequest,
} from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { AppError, conflict, isUniqueViolation, notFound, versionConflict } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, lockTenantResource, type Trx } from '../database/database.service.js';

const fieldError = (path: string, message: string) => new AppError(400, 'VALIDATION_FAILED', message, [{ path, message }]);

@Injectable()
export class FinanceSetupService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private context(principal: TenantPrincipal) {
    return { tenantId: principal.tenantId, userId: principal.userId };
  }

  async accounts(principal: TenantPrincipal): Promise<Account[]> {
    return this.database.withContext(this.context(principal), async (trx) => {
      const rows = await trx
        .selectFrom('accounts as a')
        .select([
          'a.id',
          'a.code',
          'a.name',
          'a.account_type',
          'a.parent_id',
          'a.is_title',
          'a.control_kind',
          'a.status',
          'a.version',
          sql<boolean>`exists (select 1 from journal_lines l where l.tenant_id = a.tenant_id and l.account_id = a.id)`.as('has_postings'),
        ])
        .where('a.tenant_id', '=', principal.tenantId)
        .orderBy('a.code')
        .execute();
      const byId = new Map(rows.map((row) => [row.id, row]));
      const level = (id: string | null, depth = 0): number => {
        const row = id ? byId.get(id) : undefined;
        return row && depth < 20 ? level(row.parent_id, depth + 1) : depth;
      };
      return rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        accountType: row.account_type,
        parentId: row.parent_id,
        isTitle: row.is_title,
        controlKind: row.control_kind,
        status: row.status,
        level: level(row.parent_id) + 1,
        hasPostings: row.has_postings,
        version: row.version,
      }));
    });
  }

  async createAccount(principal: TenantPrincipal, input: CreateAccountRequest, correlationId: string): Promise<Account> {
    const id = await this.database.withContext(this.context(principal), async (trx) => {
      if (input.parentId) {
        await this.assertParent(trx, principal.tenantId, input.parentId, input.accountType, null);
      }
      if (input.controlKind && input.isTitle) {
        throw fieldError('controlKind', 'A title account cannot be a control account');
      }
      if (input.controlKind === 'receivable' && input.accountType !== 'asset') {
        throw fieldError('controlKind', 'A receivable control account must be an asset account');
      }
      if (input.controlKind === 'payable' && input.accountType !== 'liability') {
        throw fieldError('controlKind', 'A payable control account must be a liability account');
      }
      try {
        const row = await trx
          .insertInto('accounts')
          .values({
            tenant_id: principal.tenantId,
            code: input.code,
            name: input.name,
            account_type: input.accountType,
            parent_id: input.parentId ?? null,
            is_title: input.isTitle,
            control_kind: input.controlKind ?? null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await this.audit.record(trx, {
          tenantId: principal.tenantId,
          actor: { type: 'user', id: principal.userId },
          action: 'account.created',
          entityType: 'account',
          entityId: row.id,
          after: { code: input.code, name: input.name, accountType: input.accountType, isTitle: input.isTitle, controlKind: input.controlKind ?? null },
          correlationId,
        });
        return row.id;
      } catch (error) {
        if (isUniqueViolation(error, 'accounts_tenant_id_code_key')) {
          throw conflict(`Account ${input.code} already exists`);
        }
        throw error;
      }
    });
    return this.account(principal, id);
  }

  async updateAccount(principal: TenantPrincipal, accountId: string, input: UpdateAccountRequest, correlationId: string): Promise<Account> {
    await this.database.withContext(this.context(principal), async (trx) => {
      const current = await trx
        .selectFrom('accounts')
        .selectAll()
        .where('tenant_id', '=', principal.tenantId)
        .where('id', '=', accountId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) {
        throw notFound();
      }
      if (current.version !== input.version) {
        throw versionConflict();
      }
      const parentId = input.parentId === undefined ? current.parent_id : input.parentId;
      if (parentId && parentId !== current.parent_id) {
        await this.assertParent(trx, principal.tenantId, parentId, current.account_type, current.id);
      }
      if (input.status === 'inactive' && current.status === 'active') {
        const mapped = await trx
          .selectFrom('gl_determination')
          .select('determination_key')
          .where('tenant_id', '=', principal.tenantId)
          .where('account_id', '=', accountId)
          .executeTakeFirst();
        if (mapped) {
          throw conflict(`Account ${current.code} is used in G/L account determination (${mapped.determination_key}); change the mapping first`);
        }
      }
      await trx
        .updateTable('accounts')
        .set({ name: input.name, parent_id: parentId, status: input.status, version: current.version + 1, updated_at: new Date() })
        .where('id', '=', accountId)
        .execute();
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'account.updated',
        entityType: 'account',
        entityId: accountId,
        before: { name: current.name, parentId: current.parent_id, status: current.status },
        after: { name: input.name, parentId, status: input.status },
        correlationId,
      });
    });
    return this.account(principal, accountId);
  }

  private async account(principal: TenantPrincipal, accountId: string): Promise<Account> {
    const account = (await this.accounts(principal)).find((row) => row.id === accountId);
    if (!account) {
      throw notFound();
    }
    return account;
  }

  private async assertParent(trx: Trx, tenantId: string, parentId: string, accountType: string, selfId: string | null): Promise<void> {
    const parent = await trx
      .selectFrom('accounts')
      .select(['id', 'is_title', 'account_type', 'parent_id'])
      .where('tenant_id', '=', tenantId)
      .where('id', '=', parentId)
      .executeTakeFirst();
    if (!parent) {
      throw fieldError('parentId', 'The parent account was not found');
    }
    if (!parent.is_title) {
      throw fieldError('parentId', 'The parent must be a title account');
    }
    if (parent.account_type !== accountType) {
      throw fieldError('parentId', 'The parent must have the same account type');
    }
    let cursor: string | null = parent.id;
    for (let depth = 0; cursor && depth < 20; depth += 1) {
      if (cursor === selfId) {
        throw fieldError('parentId', 'An account cannot be placed under itself');
      }
      const next: { parent_id: string | null } | undefined = await trx
        .selectFrom('accounts')
        .select('parent_id')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', cursor)
        .executeTakeFirst();
      cursor = next?.parent_id ?? null;
    }
  }

  async determination(principal: TenantPrincipal): Promise<GlDetermination[]> {
    const rows = await this.database.withContext(this.context(principal), (trx) =>
      trx
        .selectFrom('gl_determination as d')
        .innerJoin('accounts as a', (join) => join.onRef('a.id', '=', 'd.account_id').onRef('a.tenant_id', '=', 'd.tenant_id'))
        .select(['d.determination_key', 'a.id', 'a.code', 'a.name'])
        .where('d.tenant_id', '=', principal.tenantId)
        .execute(),
    );
    return (Object.keys(DETERMINATION_KEYS) as DeterminationKey[]).map((key) => {
      const row = rows.find((candidate) => candidate.determination_key === key);
      return {
        key,
        label: DETERMINATION_KEYS[key].label,
        accountId: row?.id ?? null,
        accountCode: row?.code ?? null,
        accountName: row?.name ?? null,
      };
    });
  }

  async updateDetermination(principal: TenantPrincipal, input: UpdateDeterminationRequest, correlationId: string): Promise<GlDetermination[]> {
    await this.database.withContext(this.context(principal), async (trx) => {
      for (const mapping of input.mappings) {
        const account = await trx
          .selectFrom('accounts')
          .select(['id', 'code', 'account_type', 'is_title', 'status', 'control_kind'])
          .where('tenant_id', '=', principal.tenantId)
          .where('id', '=', mapping.accountId)
          .executeTakeFirst();
        const path = `mappings.${mapping.key}`;
        if (!account) {
          throw fieldError(path, 'The account was not found');
        }
        const rule = DETERMINATION_KEYS[mapping.key];
        if (account.is_title || account.status !== 'active') {
          throw fieldError(path, `${account.code} must be an active postable account`);
        }
        if (!(rule.accountTypes as readonly string[]).includes(account.account_type)) {
          throw fieldError(path, `${rule.label} requires a ${rule.accountTypes.join(' or ')} account`);
        }
        const expectedControl = mapping.key === 'receivable_control' ? 'receivable' : mapping.key === 'payable_control' ? 'payable' : null;
        if (account.control_kind !== expectedControl) {
          throw fieldError(
            path,
            expectedControl ? `${rule.label} must be a ${expectedControl} control account` : `${account.code} is a control account and cannot be used for ${rule.label}`,
          );
        }
        const previous = await trx
          .selectFrom('gl_determination')
          .select('account_id')
          .where('tenant_id', '=', principal.tenantId)
          .where('determination_key', '=', mapping.key)
          .executeTakeFirst();
        await trx
          .insertInto('gl_determination')
          .values({ tenant_id: principal.tenantId, determination_key: mapping.key, account_id: account.id })
          .onConflict((oc) => oc.columns(['tenant_id', 'determination_key']).doUpdateSet({ account_id: account.id, updated_at: new Date() }))
          .execute();
        await this.audit.record(trx, {
          tenantId: principal.tenantId,
          actor: { type: 'user', id: principal.userId },
          action: 'gl_determination.changed',
          entityType: 'gl_determination',
          entityId: null,
          before: { key: mapping.key, accountId: previous?.account_id ?? null },
          after: { key: mapping.key, accountId: account.id },
          correlationId,
        });
      }
    });
    return this.determination(principal);
  }

  async periods(principal: TenantPrincipal): Promise<PostingPeriod[]> {
    const rows = await this.database.withContext(this.context(principal), (trx) =>
      trx
        .selectFrom('posting_periods as p')
        .innerJoin('fiscal_years as y', (join) => join.onRef('y.id', '=', 'p.fiscal_year_id').onRef('y.tenant_id', '=', 'p.tenant_id'))
        .select(['p.id', 'p.code', 'p.name', 'p.start_date', 'p.end_date', 'p.status', 'p.version', 'y.code as year_code'])
        .where('p.tenant_id', '=', principal.tenantId)
        .orderBy('p.start_date')
        .execute(),
    );
    return rows.map((row) => ({
      id: row.id,
      fiscalYearCode: row.year_code,
      code: row.code,
      name: row.name,
      startDate: row.start_date,
      endDate: row.end_date,
      status: row.status,
      version: row.version,
    }));
  }

  async createFiscalYear(principal: TenantPrincipal, input: CreateFiscalYearRequest, correlationId: string): Promise<PostingPeriod[]> {
    if (!input.startDate.endsWith('-01')) {
      throw fieldError('startDate', 'A fiscal year must start on the first day of a month');
    }
    await this.database.withContext(this.context(principal), async (trx) => {
      await lockTenantResource(trx, principal.tenantId, 'fiscal-years');
      const range = await sql<{ end_date: string }>`select (${input.startDate}::date + interval '1 year - 1 day')::date::text as end_date`.execute(trx);
      const endDate = range.rows[0]?.end_date;
      if (!endDate) {
        throw new Error('Could not compute fiscal year end');
      }
      const overlap = await trx
        .selectFrom('fiscal_years')
        .select('code')
        .where('tenant_id', '=', principal.tenantId)
        .where('start_date', '<=', endDate)
        .where('end_date', '>=', input.startDate)
        .executeTakeFirst();
      if (overlap) {
        throw conflict(`The new fiscal year overlaps fiscal year ${overlap.code}`);
      }
      let year: { id: string };
      try {
        year = await trx
          .insertInto('fiscal_years')
          .values({ tenant_id: principal.tenantId, code: input.code, start_date: input.startDate, end_date: endDate })
          .returning('id')
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error, 'fiscal_years_tenant_id_code_key')) {
          throw conflict(`Fiscal year ${input.code} already exists`);
        }
        throw error;
      }
      await sql`insert into posting_periods (tenant_id, fiscal_year_id, code, name, start_date, end_date)
        select ${principal.tenantId}::uuid, ${year.id}::uuid, to_char(m, 'YYYY-MM'), to_char(m, 'FMMonth YYYY'), m::date, (m + interval '1 month - 1 day')::date
        from generate_series(${input.startDate}::date, ${input.startDate}::date + interval '11 months', interval '1 month') as m`.execute(trx);
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'fiscal_year.created',
        entityType: 'fiscal_year',
        entityId: year.id,
        after: { code: input.code, startDate: input.startDate, endDate },
        correlationId,
      });
    });
    return this.periods(principal);
  }

  async changePeriodStatus(principal: TenantPrincipal, periodId: string, input: ChangePeriodStatusRequest, correlationId: string, auditDetail: Record<string, unknown> = {}): Promise<PostingPeriod> {
    await this.database.withContext(this.context(principal), async (trx) => {
      const period = await trx
        .selectFrom('posting_periods')
        .select(['id', 'code', 'status', 'version'])
        .where('tenant_id', '=', principal.tenantId)
        .where('id', '=', periodId)
        .forUpdate()
        .executeTakeFirst();
      if (!period) {
        throw notFound();
      }
      if (period.version !== input.version) {
        throw versionConflict();
      }
      if (period.status === input.status) {
        return;
      }
      await trx
        .updateTable('posting_periods')
        .set({ status: input.status, version: period.version + 1, updated_at: new Date() })
        .where('id', '=', periodId)
        .execute();
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: input.status === 'closed' ? 'posting_period.closed' : 'posting_period.reopened',
        entityType: 'posting_period',
        entityId: periodId,
        before: { status: period.status },
        after: { status: input.status, reason: input.reason, ...auditDetail },
        correlationId,
      });
    });
    const updated = (await this.periods(principal)).find((row) => row.id === periodId);
    if (!updated) {
      throw notFound();
    }
    return updated;
  }

  async series(principal: TenantPrincipal): Promise<NumberingSeries[]> {
    const rows = await this.database.withContext(this.context(principal), (trx) =>
      trx
        .selectFrom('numbering_series')
        .selectAll()
        .where('tenant_id', '=', principal.tenantId)
        .orderBy('document_type')
        .orderBy('name')
        .execute(),
    );
    return rows.map((row) => ({
      id: row.id,
      documentType: row.document_type,
      name: row.name,
      prefix: row.prefix,
      nextNumber: Number(row.next_number),
      lastNumber: row.last_number === null ? null : Number(row.last_number),
      isDefault: row.is_default,
      status: row.status,
      version: row.version,
    }));
  }

  async createSeries(principal: TenantPrincipal, input: CreateSeriesRequest, correlationId: string): Promise<NumberingSeries[]> {
    if (input.lastNumber != null && input.lastNumber < input.nextNumber) {
      throw fieldError('lastNumber', 'The last number must not be lower than the first number');
    }
    await this.database.withContext(this.context(principal), async (trx) => {
      if (input.isDefault) {
        await trx
          .updateTable('numbering_series')
          .set({ is_default: false })
          .where('tenant_id', '=', principal.tenantId)
          .where('document_type', '=', input.documentType)
          .execute();
      }
      try {
        const row = await trx
          .insertInto('numbering_series')
          .values({
            tenant_id: principal.tenantId,
            document_type: input.documentType,
            name: input.name,
            prefix: input.prefix,
            next_number: input.nextNumber,
            last_number: input.lastNumber ?? null,
            is_default: input.isDefault,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await this.audit.record(trx, {
          tenantId: principal.tenantId,
          actor: { type: 'user', id: principal.userId },
          action: 'numbering_series.created',
          entityType: 'numbering_series',
          entityId: row.id,
          after: { ...input },
          correlationId,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'numbering_series_tenant_id_document_type_name_key')) {
          throw conflict(`A series named ${input.name} already exists for this document type`);
        }
        throw error;
      }
    });
    return this.series(principal);
  }

  async setDefaultSeries(principal: TenantPrincipal, seriesId: string, correlationId: string): Promise<NumberingSeries[]> {
    await this.database.withContext(this.context(principal), async (trx) => {
      const series = await trx
        .selectFrom('numbering_series')
        .select(['id', 'document_type', 'status'])
        .where('tenant_id', '=', principal.tenantId)
        .where('id', '=', seriesId)
        .forUpdate()
        .executeTakeFirst();
      if (!series) {
        throw notFound();
      }
      if (series.status !== 'active') {
        throw conflict('An inactive series cannot be the default');
      }
      await trx
        .updateTable('numbering_series')
        .set({ is_default: false })
        .where('tenant_id', '=', principal.tenantId)
        .where('document_type', '=', series.document_type)
        .execute();
      await trx.updateTable('numbering_series').set({ is_default: true }).where('id', '=', seriesId).execute();
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'numbering_series.default_changed',
        entityType: 'numbering_series',
        entityId: seriesId,
        after: { documentType: series.document_type },
        correlationId,
      });
    });
    return this.series(principal);
  }
}
