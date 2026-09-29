import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  JournalEntry,
  JournalListQuery,
  JournalSummary,
  Page,
  PostJournalRequest,
  ReverseJournalRequest,
  TrialBalance,
  TrialBalanceQuery,
} from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { AppError, conflict, isUniqueViolation, notFound } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, lockTenantResource, type Trx } from '../database/database.service.js';
import { claimIdempotencyKey, completeIdempotencyKey } from './idempotency.js';
import { formatMoney, parseMoney, sumMoney } from './money.js';
import { PostingService } from './posting.service.js';

@Injectable()
export class JournalsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
  ) {}

  async post(principal: TenantPrincipal, input: PostJournalRequest, correlationId: string): Promise<{ replayed: boolean; entry: JournalEntry }> {
    const { idempotencyKey, ...payload } = input;
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const existing = await claimIdempotencyKey(trx, principal.tenantId, idempotencyKey, 'journal.post', payload);
      if (existing) {
        return { replayed: true, entry: await this.loadOrThrow(trx, principal.tenantId, existing) };
      }
      const posted = await this.posting.post(trx, {
        tenantId: principal.tenantId,
        userId: principal.userId,
        sourceType: 'manual',
        seriesId: payload.seriesId,
        postingDate: payload.postingDate,
        documentDate: payload.documentDate,
        dueDate: payload.dueDate,
        memo: payload.memo,
        reference: payload.reference,
        lines: payload.lines.map((line) => ({
          accountId: line.accountId,
          partnerId: line.partnerId,
          debit: parseMoney(line.debit),
          credit: parseMoney(line.credit),
          memo: line.memo,
        })),
      });
      await completeIdempotencyKey(trx, principal.tenantId, idempotencyKey, posted.id);
      const entry = await this.loadOrThrow(trx, principal.tenantId, posted.id);
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'journal_entry.posted',
        entityType: 'journal_entry',
        entityId: entry.id,
        after: { documentNumber: entry.documentNumber, postingDate: entry.postingDate, total: entry.totalDebit, lines: entry.lines.length },
        correlationId,
      });
      return { replayed: false, entry };
    });
  }

  async reverse(
    principal: TenantPrincipal,
    journalId: string,
    input: ReverseJournalRequest,
    correlationId: string,
  ): Promise<{ replayed: boolean; entry: JournalEntry }> {
    const { idempotencyKey, ...payload } = input;
    try {
      return await this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
        const existing = await claimIdempotencyKey(trx, principal.tenantId, idempotencyKey, `journal.reverse:${journalId}`, payload);
        if (existing) {
          return { replayed: true, entry: await this.loadOrThrow(trx, principal.tenantId, existing) };
        }
        await lockTenantResource(trx, principal.tenantId, `journal-reverse:${journalId}`);
        const original = await this.load(trx, principal.tenantId, journalId);
        if (!original) {
          throw notFound();
        }
        if (original.sourceType === 'reversal') {
          throw conflict('A reversal cannot itself be reversed; post a new corrective journal entry instead');
        }
        if (original.sourceType !== 'manual') {
          throw conflict('This journal entry was created by a document; reverse it through that document');
        }
        if (original.reversedById) {
          throw conflict('This journal entry has already been reversed');
        }
        if (payload.postingDate < original.postingDate) {
          throw new AppError(422, 'POSTING_REJECTED', 'The reversal date cannot be earlier than the original posting date', [
            { path: 'postingDate', message: 'Must be on or after the original posting date' },
          ]);
        }
        const posted = await this.posting.post(trx, {
          tenantId: principal.tenantId,
          userId: principal.userId,
          sourceType: 'reversal',
          sourceId: original.id,
          postingDate: payload.postingDate,
          memo: `Reversal of ${original.documentNumber}`,
          reference: original.documentNumber,
          reversalOfId: original.id,
          reversalReason: payload.reason,
          lines: original.lines.map((line) => ({
            accountId: line.accountId,
            partnerId: line.partnerId,
            debit: parseMoney(line.credit),
            credit: parseMoney(line.debit),
            memo: line.memo,
          })),
        });
        await completeIdempotencyKey(trx, principal.tenantId, idempotencyKey, posted.id);
        const entry = await this.loadOrThrow(trx, principal.tenantId, posted.id);
        await this.audit.record(trx, {
          tenantId: principal.tenantId,
          actor: { type: 'user', id: principal.userId },
          action: 'journal_entry.reversed',
          entityType: 'journal_entry',
          entityId: original.id,
          before: { documentNumber: original.documentNumber },
          after: { reversalId: entry.id, reversalNumber: entry.documentNumber, postingDate: entry.postingDate, reason: payload.reason },
          correlationId,
        });
        return { replayed: false, entry };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'journal_entries_single_reversal_key')) {
        throw conflict('This journal entry has already been reversed');
      }
      throw error;
    }
  }

  async list(principal: TenantPrincipal, query: JournalListQuery): Promise<Page<JournalSummary>> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      let base = trx.selectFrom('journal_entries as je').where('je.tenant_id', '=', principal.tenantId);
      if (query.search) {
        const pattern = `%${query.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
        base = base.where((eb) => eb.or([eb('je.document_number', 'ilike', pattern), eb('je.memo', 'ilike', pattern), eb('je.reference', 'ilike', pattern)]));
      }
      if (query.from) base = base.where('je.posting_date', '>=', query.from);
      if (query.to) base = base.where('je.posting_date', '<=', query.to);
      const total = await base.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
      const rows = await base
        .select([
          'je.id',
          'je.document_number',
          'je.source_type',
          'je.posting_date',
          'je.memo',
          'je.total_debit',
          sql<boolean>`exists (select 1 from journal_entries r where r.tenant_id = je.tenant_id and r.reversal_of_id = je.id)`.as('reversed'),
        ])
        .orderBy('je.posting_date', 'desc')
        .orderBy('je.number', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute();
      return {
        items: rows.map((row) => ({
          id: row.id,
          documentNumber: row.document_number,
          sourceType: row.source_type,
          postingDate: row.posting_date,
          memo: row.memo,
          totalDebit: row.total_debit,
          reversed: row.reversed,
        })),
        limit: query.limit,
        offset: query.offset,
        total: Number(total.count),
      };
    });
  }

  async get(principal: TenantPrincipal, journalId: string): Promise<JournalEntry> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, (trx) => this.loadOrThrow(trx, principal.tenantId, journalId));
  }

  async trialBalance(principal: TenantPrincipal, query: TrialBalanceQuery): Promise<TrialBalance> {
    if (query.from > query.to) {
      throw new AppError(400, 'VALIDATION_FAILED', 'The start date must be on or before the end date', [{ path: 'from', message: 'After end date' }]);
    }
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const tenant = await trx.selectFrom('tenants').select(['display_name', 'base_currency']).where('id', '=', principal.tenantId).executeTakeFirstOrThrow();
      const rows = await trx
        .selectFrom('journal_lines as l')
        .innerJoin('journal_entries as je', (join) => join.onRef('je.id', '=', 'l.journal_id').onRef('je.tenant_id', '=', 'l.tenant_id'))
        .innerJoin('accounts as a', (join) => join.onRef('a.id', '=', 'l.account_id').onRef('a.tenant_id', '=', 'l.tenant_id'))
        .select([
          'a.id',
          'a.code',
          'a.name',
          'a.account_type',
          sql<string>`coalesce(sum(case when je.posting_date < ${query.from} then l.debit - l.credit else 0 end), 0)::text`.as('opening'),
          sql<string>`coalesce(sum(case when je.posting_date >= ${query.from} then l.debit else 0 end), 0)::text`.as('debit'),
          sql<string>`coalesce(sum(case when je.posting_date >= ${query.from} then l.credit else 0 end), 0)::text`.as('credit'),
        ])
        .where('l.tenant_id', '=', principal.tenantId)
        .where('je.posting_date', '<=', query.to)
        .groupBy(['a.id', 'a.code', 'a.name', 'a.account_type'])
        .orderBy('a.code')
        .execute();
      const mapped = rows.map((row) => {
        const opening = parseMoney(row.opening);
        const debit = parseMoney(row.debit);
        const credit = parseMoney(row.credit);
        return {
          accountId: row.id,
          code: row.code,
          name: row.name,
          accountType: row.account_type,
          opening,
          debit,
          credit,
          closing: opening + debit - credit,
        };
      });
      return {
        tenantName: tenant.display_name,
        currency: tenant.base_currency,
        from: query.from,
        to: query.to,
        generatedAt: new Date().toISOString(),
        basis: 'Posted journal entries by posting date; balances shown as debit positive, credit negative',
        rows: mapped.map((row) => ({
          accountId: row.accountId,
          code: row.code,
          name: row.name,
          accountType: row.accountType,
          openingBalance: formatMoney(row.opening),
          debit: formatMoney(row.debit),
          credit: formatMoney(row.credit),
          closingBalance: formatMoney(row.closing),
        })),
        totals: {
          debit: formatMoney(sumMoney(mapped.map((row) => row.debit))),
          credit: formatMoney(sumMoney(mapped.map((row) => row.credit))),
          openingBalance: formatMoney(sumMoney(mapped.map((row) => row.opening))),
          closingBalance: formatMoney(sumMoney(mapped.map((row) => row.closing))),
        },
      };
    });
  }

  private async loadOrThrow(trx: Trx, tenantId: string, journalId: string): Promise<JournalEntry> {
    const entry = await this.load(trx, tenantId, journalId);
    if (!entry) {
      throw notFound();
    }
    return entry;
  }

  private async load(trx: Trx, tenantId: string, journalId: string): Promise<JournalEntry | null> {
    const header = await trx
      .selectFrom('journal_entries as je')
      .innerJoin('numbering_series as s', (join) => join.onRef('s.id', '=', 'je.series_id').onRef('s.tenant_id', '=', 'je.tenant_id'))
      .innerJoin('posting_periods as p', (join) => join.onRef('p.id', '=', 'je.period_id').onRef('p.tenant_id', '=', 'je.tenant_id'))
      .selectAll('je')
      .select(['s.name as series_name', 'p.code as period_code'])
      .select(sql<string | null>`(select r.id from journal_entries r where r.tenant_id = je.tenant_id and r.reversal_of_id = je.id)`.as('reversed_by_id'))
      .where('je.tenant_id', '=', tenantId)
      .where('je.id', '=', journalId)
      .executeTakeFirst();
    if (!header) {
      return null;
    }
    const lines = await trx
      .selectFrom('journal_lines as l')
      .innerJoin('accounts as a', (join) => join.onRef('a.id', '=', 'l.account_id').onRef('a.tenant_id', '=', 'l.tenant_id'))
      .leftJoin('business_partners as bp', (join) => join.onRef('bp.id', '=', 'l.partner_id').onRef('bp.tenant_id', '=', 'l.tenant_id'))
      .select(['l.line_no', 'l.account_id', 'a.code as account_code', 'a.name as account_name', 'l.partner_id', 'bp.code as partner_code', 'l.debit', 'l.credit', 'l.memo'])
      .where('l.tenant_id', '=', tenantId)
      .where('l.journal_id', '=', journalId)
      .orderBy('l.line_no')
      .execute();
    return {
      id: header.id,
      documentNumber: header.document_number,
      number: Number(header.number),
      seriesName: header.series_name,
      sourceType: header.source_type,
      postingDate: header.posting_date,
      documentDate: header.document_date,
      dueDate: header.due_date,
      periodCode: header.period_code,
      memo: header.memo,
      reference: header.reference,
      currency: header.currency,
      totalDebit: header.total_debit,
      totalCredit: header.total_credit,
      reversalOfId: header.reversal_of_id,
      reversedById: header.reversed_by_id,
      reversalReason: header.reversal_reason,
      postedAt: header.posted_at.toISOString(),
      lines: lines.map((line) => ({
        lineNo: line.line_no,
        accountId: line.account_id,
        accountCode: line.account_code,
        accountName: line.account_name,
        partnerId: line.partner_id,
        partnerCode: line.partner_code,
        debit: line.debit,
        credit: line.credit,
        memo: line.memo,
      })),
    };
  }
}
