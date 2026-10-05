import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  CancelOpeningBalanceRequest,
  CreateAccountOpeningBalanceRequest,
  CreatePartnerOpeningBalanceRequest,
  OpeningBalance,
  OpeningBalanceKind,
  OpeningBalanceListQuery,
  OpeningBalanceSummary,
  Page,
} from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { AppError, conflict, isUniqueViolation, notFound } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, lockTenantResource, type Trx } from '../database/database.service.js';
import { claimIdempotencyKey, completeIdempotencyKey } from './idempotency.js';
import { formatMoney, parseMoney, sumMoney, type Money } from './money.js';
import { PostingService, type PostingLine } from './posting.service.js';

const lineError = (index: number, field: string, message: string) =>
  new AppError(400, 'VALIDATION_FAILED', message, [{ path: `lines.${index}.${field}`, message }]);

export interface PostingOptions {
  dryRun?: boolean;
  source?: Record<string, unknown>;
}

class DryRun extends Error {
  constructor(readonly result: { replayed: boolean; openingBalance: OpeningBalance }) {
    super('dry run');
  }
}

interface PlannedLine {
  accountId: string | null;
  partnerId: string | null;
  reference: string | null;
  documentDate: string | null;
  dueDate: string | null;
  debit: Money;
  credit: Money;
}

interface Header {
  idempotencyKey: string;
  postingDate: string;
  offsetAccountId?: string | undefined;
  reason: string;
  remarks?: string | null | undefined;
  seriesId?: string | undefined;
}

function amounts(debit: string, credit: string, index: number): { debit: Money; credit: Money } {
  const parsedDebit = parseMoney(debit);
  const parsedCredit = parseMoney(credit);
  if ((parsedDebit > 0n) === (parsedCredit > 0n)) throw lineError(index, 'debit', `Line ${index + 1}: enter either a debit or a credit amount`);
  return { debit: parsedDebit, credit: parsedCredit };
}

@Injectable()
export class OpeningBalancesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
  ) {}

  private run<T>(principal: TenantPrincipal, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId, serializeCredit: true }, fn);
  }

  private read<T>(principal: TenantPrincipal, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, fn);
  }

  private async execute(
    principal: TenantPrincipal,
    options: PostingOptions,
    fn: (trx: Trx) => Promise<{ replayed: boolean; openingBalance: OpeningBalance }>,
  ): Promise<{ replayed: boolean; openingBalance: OpeningBalance }> {
    if (!options.dryRun) return this.run(principal, fn);
    try {
      await this.run(principal, async (trx) => {
        throw new DryRun(await fn(trx));
      });
    } catch (error) {
      if (error instanceof DryRun) return error.result;
      throw error;
    }
    throw new Error('Opening balance dry run did not roll back');
  }

  private async inventoryAccounts(trx: Trx, tenantId: string): Promise<Set<string>> {
    const rows = await sql<{ account_id: string }>`
      select inventory_account_id as account_id from warehouses where tenant_id = ${tenantId} and inventory_account_id is not null
      union select inventory_account_id from item_groups where tenant_id = ${tenantId} and inventory_account_id is not null
      union select account_id from gl_determination where tenant_id = ${tenantId} and determination_key = 'inventory'
    `.execute(trx);
    return new Set(rows.rows.map((row) => row.account_id));
  }

  private async offsetAccount(trx: Trx, tenantId: string, requested: string | undefined, inventory: Set<string>): Promise<string> {
    let accountId = requested;
    if (!accountId) {
      const row = await trx
        .selectFrom('gl_determination')
        .select('account_id')
        .where('tenant_id', '=', tenantId)
        .where('determination_key', '=', 'opening_balance')
        .executeTakeFirst();
      if (!row) throw new AppError(422, 'MAPPING_MISSING', 'G/L account determination is missing the Opening Balance Offset account');
      accountId = row.account_id;
    }
    const account = await trx
      .selectFrom('accounts')
      .select(['id', 'is_title', 'status', 'control_kind'])
      .where('tenant_id', '=', tenantId)
      .where('id', '=', accountId)
      .executeTakeFirst();
    if (!account || account.is_title || account.status !== 'active' || account.control_kind || inventory.has(account.id)) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Choose an active, postable offset account that is neither a control account nor an inventory account', [
        { path: 'offsetAccountId', message: 'Choose an active, postable, non-control, non-inventory account' },
      ]);
    }
    return account.id;
  }

  async createAccounts(
    principal: TenantPrincipal,
    input: CreateAccountOpeningBalanceRequest,
    correlationId: string,
    options: PostingOptions = {},
  ): Promise<{ replayed: boolean; openingBalance: OpeningBalance }> {
    return this.execute(principal, options, (trx) =>
      this.postDocument(trx, principal, 'account', input, correlationId, options.source, async (tenantId, offsetAccountId, inventory) => {
        const accountIds = input.lines.map((line) => line.accountId);
        const accounts = await trx
          .selectFrom('accounts')
          .select(['id', 'code', 'is_title', 'status', 'control_kind'])
          .where('tenant_id', '=', tenantId)
          .where('id', 'in', [...new Set(accountIds)])
          .execute();
        const seen = new Set<string>();
        return input.lines.map((line, index): PlannedLine => {
          const account = accounts.find((candidate) => candidate.id === line.accountId);
          if (!account) throw lineError(index, 'accountId', `Line ${index + 1}: G/L account not found`);
          if (account.is_title || account.status !== 'active') throw lineError(index, 'accountId', `Line ${index + 1}: ${account.code} is not an active, postable account`);
          if (account.control_kind) {
            throw lineError(index, 'accountId', `Line ${index + 1}: ${account.code} is a control account; enter its balance through Business Partners Opening Balance`);
          }
          if (inventory.has(account.id)) {
            throw lineError(index, 'accountId', `Line ${index + 1}: ${account.code} is an inventory account; enter stock through Inventory Opening Balance`);
          }
          if (account.id === offsetAccountId) throw lineError(index, 'accountId', `Line ${index + 1}: ${account.code} is the offset account`);
          if (seen.has(account.id)) throw lineError(index, 'accountId', `Line ${index + 1}: ${account.code} appears more than once`);
          seen.add(account.id);
          return { accountId: account.id, partnerId: null, reference: null, documentDate: null, dueDate: null, ...amounts(line.debit, line.credit, index) };
        });
      }),
    );
  }

  async createPartners(
    principal: TenantPrincipal,
    input: CreatePartnerOpeningBalanceRequest,
    correlationId: string,
    options: PostingOptions = {},
  ): Promise<{ replayed: boolean; openingBalance: OpeningBalance }> {
    return this.execute(principal, options, (trx) =>
      this.postDocument(trx, principal, 'partner', input, correlationId, options.source, async (tenantId) => {
        const partners = await trx
          .selectFrom('business_partners as p')
          .leftJoin('payment_terms as t', (join) => join.onRef('t.id', '=', 'p.payment_terms_id').onRef('t.tenant_id', '=', 'p.tenant_id'))
          .select(['p.id', 'p.code', 'p.partner_type', 'p.status', 't.due_days'])
          .where('p.tenant_id', '=', tenantId)
          .where('p.id', 'in', [...new Set(input.lines.map((line) => line.partnerId))])
          .execute();
        const planned: PlannedLine[] = [];
        for (const [index, line] of input.lines.entries()) {
          const partner = partners.find((candidate) => candidate.id === line.partnerId);
          if (!partner || partner.status !== 'active' || partner.partner_type === 'lead') {
            throw lineError(index, 'partnerId', `Line ${index + 1}: choose an active customer or vendor`);
          }
          const documentDate = line.documentDate ?? input.postingDate;
          if (documentDate > input.postingDate) {
            throw lineError(index, 'documentDate', `Line ${index + 1}: the document date cannot be after the opening balance posting date`);
          }
          const dueDate =
            line.dueDate ?? ((await sql<{ due: string }>`select (${documentDate}::date + ${partner.due_days ?? 0}::integer)::text as due`.execute(trx)).rows[0]?.due as string);
          if (dueDate < documentDate) throw lineError(index, 'dueDate', `Line ${index + 1}: the due date cannot be before the document date`);
          planned.push({ accountId: null, partnerId: partner.id, reference: line.reference ?? null, documentDate, dueDate, ...amounts(line.debit, line.credit, index) });
        }
        return planned;
      }),
    );
  }

  private async postDocument(
    trx: Trx,
    principal: TenantPrincipal,
    kind: OpeningBalanceKind,
    input: Header,
    correlationId: string,
    source: Record<string, unknown> | undefined,
    plan: (tenantId: string, offsetAccountId: string, inventory: Set<string>) => Promise<PlannedLine[]>,
  ): Promise<{ replayed: boolean; openingBalance: OpeningBalance }> {
    const { idempotencyKey, ...payload } = input;
    const tenantId = principal.tenantId;
    const existing = await claimIdempotencyKey(trx, tenantId, idempotencyKey, `opening_balance.${kind}.create`, payload);
    if (existing) return { replayed: true, openingBalance: await this.loadOrThrow(trx, tenantId, existing) };
    await this.posting.openPeriodFor(trx, tenantId, payload.postingDate);
    const inventory = await this.inventoryAccounts(trx, tenantId);
    const offsetAccountId = await this.offsetAccount(trx, tenantId, payload.offsetAccountId, inventory);
    const lines = await plan(tenantId, offsetAccountId, inventory);
    const totalDebit = sumMoney(lines.map((line) => line.debit));
    const totalCredit = sumMoney(lines.map((line) => line.credit));
    const difference = totalDebit - totalCredit;
    const journalLines: PostingLine[] = lines.map((line) => ({ accountId: line.accountId, partnerId: line.partnerId, debit: line.debit, credit: line.credit, memo: line.reference }));
    if (difference !== 0n) journalLines.push({ accountId: offsetAccountId, debit: difference < 0n ? -difference : 0n, credit: difference > 0n ? difference : 0n });
    const id = randomUUID();
    const label = kind === 'account' ? 'G/L account opening balance' : 'Business partner opening balance';
    const journal = await this.posting.post(trx, {
      tenantId,
      userId: principal.userId,
      sourceType: `${kind}_opening_balance`,
      sourceId: id,
      postingDate: payload.postingDate,
      memo: `${label}: ${payload.reason}`,
      lines: journalLines,
    });
    const series = await this.posting.nextNumber(trx, tenantId, 'opening_balance', payload.seriesId);
    await trx
      .insertInto('opening_balances')
      .values({
        id,
        tenant_id: tenantId,
        series_id: series.seriesId,
        number: series.number,
        document_number: series.documentNumber,
        kind,
        posting_date: payload.postingDate,
        offset_account_id: offsetAccountId,
        reason: payload.reason,
        remarks: payload.remarks ?? null,
        total_debit: formatMoney(totalDebit),
        total_credit: formatMoney(totalCredit),
        journal_id: journal.id,
        created_by: principal.userId,
      })
      .execute();
    await trx
      .insertInto('opening_balance_lines')
      .values(
        lines.map((line, index) => ({
          tenant_id: tenantId,
          opening_balance_id: id,
          line_no: index + 1,
          account_id: line.accountId,
          partner_id: line.partnerId,
          reference: line.reference,
          document_date: line.documentDate,
          due_date: line.dueDate,
          debit: formatMoney(line.debit),
          credit: formatMoney(line.credit),
        })),
      )
      .execute();
    await completeIdempotencyKey(trx, tenantId, idempotencyKey, id);
    const openingBalance = await this.loadOrThrow(trx, tenantId, id);
    await this.audit.record(trx, {
      tenantId,
      actor: { type: 'user', id: principal.userId },
      action: `opening_balance.${kind}_posted`,
      entityType: 'opening_balance',
      entityId: id,
      after: {
        documentNumber: openingBalance.documentNumber,
        reason: payload.reason,
        lines: lines.length,
        totalDebit: openingBalance.totalDebit,
        totalCredit: openingBalance.totalCredit,
        offsetAccount: openingBalance.offsetAccountCode,
        journal: openingBalance.journalNumber,
        ...(source ? { source } : {}),
      },
      correlationId,
    });
    return { replayed: false, openingBalance };
  }

  async cancel(principal: TenantPrincipal, id: string, input: CancelOpeningBalanceRequest, correlationId: string): Promise<{ replayed: boolean; openingBalance: OpeningBalance }> {
    const { idempotencyKey, ...payload } = input;
    try {
      return await this.run(principal, async (trx) => {
        const tenantId = principal.tenantId;
        const existing = await claimIdempotencyKey(trx, tenantId, idempotencyKey, `opening_balance.cancel:${id}`, payload);
        if (existing) return { replayed: true, openingBalance: await this.loadOrThrow(trx, tenantId, existing) };
        await lockTenantResource(trx, tenantId, `opening-balance-cancel:${id}`);
        const header = await trx.selectFrom('opening_balances').selectAll().where('tenant_id', '=', tenantId).where('id', '=', id).forUpdate().executeTakeFirst();
        if (!header) throw notFound();
        if (header.is_cancellation) throw conflict('A cancellation document cannot itself be cancelled');
        if (header.status === 'cancelled') throw conflict(`Opening balance ${header.document_number} is already cancelled`);
        const lines = await trx
          .selectFrom('opening_balance_lines')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('opening_balance_id', '=', id)
          .orderBy('line_no')
          .forUpdate()
          .execute();
        if (lines.some((line) => parseMoney(line.paid_amount) > 0n)) {
          const blocking = await trx
            .selectFrom('payment_allocations as a')
            .innerJoin('payments as p', (join) => join.onRef('p.id', '=', 'a.payment_id').onRef('p.tenant_id', '=', 'a.tenant_id'))
            .innerJoin('opening_balance_lines as l', (join) => join.onRef('l.id', '=', 'a.opening_line_id').onRef('l.tenant_id', '=', 'a.tenant_id'))
            .select(['p.document_number', 'l.line_no', 'a.amount'])
            .where('a.tenant_id', '=', tenantId)
            .where('l.opening_balance_id', '=', id)
            .where('a.event_type', '=', 'allocate')
            .where(({ not, exists, selectFrom }) =>
              not(exists(selectFrom('payment_allocations as u').select('u.id').whereRef('u.reverses_id', '=', 'a.id').whereRef('u.tenant_id', '=', 'a.tenant_id'))),
            )
            .orderBy('p.document_number')
            .execute();
          throw conflict(
            `Payments are applied to this opening balance (${blocking.map((row) => `${row.document_number} on line ${row.line_no}: ${formatMoney(parseMoney(row.amount))}`).join(', ')}); unallocate them first`,
            { blockingPayments: blocking.map((row) => ({ documentNumber: row.document_number, lineNo: row.line_no, amount: row.amount })) },
          );
        }
        if (payload.postingDate < header.posting_date) {
          throw new AppError(422, 'POSTING_REJECTED', 'The cancellation date cannot be earlier than the opening balance date', [{ path: 'postingDate', message: 'Before the document date' }]);
        }
        await this.posting.openPeriodFor(trx, tenantId, payload.postingDate);
        const journalLines = await trx
          .selectFrom('journal_lines')
          .select(['account_id', 'partner_id', 'debit', 'credit', 'memo'])
          .where('tenant_id', '=', tenantId)
          .where('journal_id', '=', header.journal_id)
          .orderBy('line_no')
          .execute();
        const cancellationId = randomUUID();
        const journal = await this.posting.post(trx, {
          tenantId,
          userId: principal.userId,
          sourceType: `${header.kind}_opening_balance_cancellation`,
          sourceId: cancellationId,
          postingDate: payload.postingDate,
          memo: `Cancellation of opening balance ${header.document_number}`,
          reference: header.document_number,
          lines: journalLines.map((line) => ({ accountId: line.account_id, partnerId: line.partner_id, debit: parseMoney(line.credit), credit: parseMoney(line.debit), memo: line.memo })),
        });
        const series = await this.posting.nextNumber(trx, tenantId, 'opening_balance', header.series_id);
        await trx
          .insertInto('opening_balances')
          .values({
            id: cancellationId,
            tenant_id: tenantId,
            series_id: series.seriesId,
            number: series.number,
            document_number: series.documentNumber,
            kind: header.kind,
            posting_date: payload.postingDate,
            offset_account_id: header.offset_account_id,
            reason: header.reason,
            remarks: `Cancellation of ${header.document_number}`,
            total_debit: header.total_debit,
            total_credit: header.total_credit,
            is_cancellation: true,
            cancellation_of_id: id,
            cancellation_reason: payload.reason,
            journal_id: journal.id,
            created_by: principal.userId,
          })
          .execute();
        await trx
          .insertInto('opening_balance_lines')
          .values(
            lines.map((line) => ({
              tenant_id: tenantId,
              opening_balance_id: cancellationId,
              line_no: line.line_no,
              account_id: line.account_id,
              partner_id: line.partner_id,
              reference: line.reference,
              document_date: line.document_date,
              due_date: line.due_date,
              debit: line.debit,
              credit: line.credit,
            })),
          )
          .execute();
        await trx.updateTable('opening_balances').set({ status: 'cancelled' }).where('tenant_id', '=', tenantId).where('id', '=', id).execute();
        await completeIdempotencyKey(trx, tenantId, idempotencyKey, cancellationId);
        const cancellation = await this.loadOrThrow(trx, tenantId, cancellationId);
        await this.audit.record(trx, {
          tenantId,
          actor: { type: 'user', id: principal.userId },
          action: 'opening_balance.cancelled',
          entityType: 'opening_balance',
          entityId: id,
          before: { documentNumber: header.document_number, status: 'posted' },
          after: { status: 'cancelled', cancellation: cancellation.documentNumber, reason: payload.reason, postingDate: payload.postingDate },
          correlationId,
        });
        return { replayed: false, openingBalance: cancellation };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'opening_balances_single_cancellation_key')) throw conflict('This opening balance has already been cancelled');
      throw error;
    }
  }

  async list(principal: TenantPrincipal, query: OpeningBalanceListQuery): Promise<Page<OpeningBalanceSummary>> {
    return this.read(principal, async (trx) => {
      let base = trx.selectFrom('opening_balances as o').where('o.tenant_id', '=', principal.tenantId);
      if (query.kind) base = base.where('o.kind', '=', query.kind);
      if (query.search) {
        const pattern = `%${query.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
        base = base.where((eb) => eb.or([eb('o.document_number', 'ilike', pattern), eb('o.reason', 'ilike', pattern)]));
      }
      const total = await base.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
      const rows = await base
        .select(['o.id', 'o.document_number', 'o.kind', 'o.posting_date', 'o.reason', 'o.total_debit', 'o.total_credit', 'o.status', 'o.is_cancellation'])
        .orderBy('o.posted_at', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute();
      return {
        items: rows.map((row) => ({
          id: row.id,
          documentNumber: row.document_number,
          kind: row.kind,
          postingDate: row.posting_date,
          reason: row.reason,
          totalDebit: row.total_debit,
          totalCredit: row.total_credit,
          status: row.status,
          isCancellation: row.is_cancellation,
        })),
        limit: query.limit,
        offset: query.offset,
        total: Number(total.count),
      };
    });
  }

  async get(principal: TenantPrincipal, id: string): Promise<OpeningBalance> {
    return this.read(principal, (trx) => this.loadOrThrow(trx, principal.tenantId, id));
  }

  private async loadOrThrow(trx: Trx, tenantId: string, id: string): Promise<OpeningBalance> {
    const row = await trx
      .selectFrom('opening_balances as o')
      .innerJoin('accounts as acc', (join) => join.onRef('acc.id', '=', 'o.offset_account_id').onRef('acc.tenant_id', '=', 'o.tenant_id'))
      .innerJoin('journal_entries as je', (join) => join.onRef('je.id', '=', 'o.journal_id').onRef('je.tenant_id', '=', 'o.tenant_id'))
      .leftJoin('opening_balances as c', (join) => join.onRef('c.cancellation_of_id', '=', 'o.id').onRef('c.tenant_id', '=', 'o.tenant_id'))
      .selectAll('o')
      .select(['acc.code as account_code', 'acc.name as account_name', 'je.document_number as journal_number', 'c.id as cancelled_by_id'])
      .where('o.tenant_id', '=', tenantId)
      .where('o.id', '=', id)
      .executeTakeFirst();
    if (!row) throw notFound();
    const lines = await trx
      .selectFrom('opening_balance_lines as l')
      .innerJoin('journal_lines as jl', (join) => join.onRef('jl.tenant_id', '=', 'l.tenant_id').onRef('jl.line_no', '=', 'l.line_no').on('jl.journal_id', '=', row.journal_id))
      .innerJoin('accounts as a', (join) => join.onRef('a.id', '=', 'jl.account_id').onRef('a.tenant_id', '=', 'jl.tenant_id'))
      .leftJoin('business_partners as p', (join) => join.onRef('p.id', '=', 'l.partner_id').onRef('p.tenant_id', '=', 'l.tenant_id'))
      .select([
        'l.id',
        'l.line_no',
        'l.account_id',
        'a.code as account_code',
        'a.name as account_name',
        'l.partner_id',
        'p.code as partner_code',
        'p.name as partner_name',
        'p.partner_type',
        'l.reference',
        'l.document_date',
        'l.due_date',
        'l.debit',
        'l.credit',
        'l.paid_amount',
      ])
      .where('l.tenant_id', '=', tenantId)
      .where('l.opening_balance_id', '=', id)
      .orderBy('l.line_no')
      .execute();
    const difference = parseMoney(row.total_debit) - parseMoney(row.total_credit);
    const active = row.status === 'posted' && !row.is_cancellation;
    return {
      id: row.id,
      documentNumber: row.document_number,
      kind: row.kind,
      postingDate: row.posting_date,
      offsetAccountId: row.offset_account_id,
      offsetAccountCode: row.account_code,
      offsetAccountName: row.account_name,
      reason: row.reason,
      remarks: row.remarks,
      totalDebit: row.total_debit,
      totalCredit: row.total_credit,
      offsetDebit: formatMoney(difference < 0n ? -difference : 0n),
      offsetCredit: formatMoney(difference > 0n ? difference : 0n),
      status: row.status,
      isCancellation: row.is_cancellation,
      cancellationOfId: row.cancellation_of_id,
      cancelledById: row.cancelled_by_id,
      cancellationReason: row.cancellation_reason,
      journalId: row.journal_id,
      journalNumber: row.journal_number,
      postedAt: row.posted_at.toISOString(),
      lines: lines.map((line) => {
        const amount = parseMoney(line.debit) + parseMoney(line.credit);
        const open = line.partner_id && active ? amount - parseMoney(line.paid_amount) : 0n;
        return {
          id: line.id,
          lineNo: line.line_no,
          accountId: line.account_id,
          accountCode: line.account_code,
          accountName: line.account_name,
          partnerId: line.partner_id,
          partnerCode: line.partner_code,
          partnerName: line.partner_name,
          partnerType: line.partner_type === 'customer' || line.partner_type === 'supplier' ? line.partner_type : null,
          reference: line.reference,
          documentDate: line.document_date,
          dueDate: line.due_date,
          debit: line.debit,
          credit: line.credit,
          paidAmount: line.paid_amount,
          openAmount: formatMoney(open),
        };
      }),
    };
  }
}
