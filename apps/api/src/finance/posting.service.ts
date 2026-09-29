import { Injectable } from '@nestjs/common';
import { AppError } from '../common/errors.js';
import type { Trx } from '../database/database.service.js';
import { formatMoney, sumMoney, type Money } from './money.js';

export interface PostingLine {
  accountId?: string | null;
  partnerId?: string | null;
  debit: Money;
  credit: Money;
  memo?: string | null;
}

export interface PostingInput {
  tenantId: string;
  userId: string | null;
  sourceType: string;
  sourceId?: string | null;
  seriesId?: string | null;
  postingDate: string;
  documentDate?: string | null;
  dueDate?: string | null;
  memo?: string | null;
  reference?: string | null;
  lines: PostingLine[];
  reversalOfId?: string | null;
  reversalReason?: string | null;
}

export interface PostedJournal {
  id: string;
  documentNumber: string;
}

const lineError = (index: number, message: string) =>
  new AppError(422, 'POSTING_REJECTED', message, [{ path: `lines.${index}`, message }]);

@Injectable()
export class PostingService {
  async openPeriodFor(trx: Trx, tenantId: string, postingDate: string): Promise<{ id: string; code: string }> {
    const period = await trx
      .selectFrom('posting_periods')
      .select(['id', 'code', 'status'])
      .where('tenant_id', '=', tenantId)
      .where('start_date', '<=', postingDate)
      .where('end_date', '>=', postingDate)
      .forShare()
      .executeTakeFirst();
    if (!period) {
      throw new AppError(422, 'PERIOD_NOT_DEFINED', `No posting period is defined for ${postingDate}. Create the fiscal year first.`);
    }
    if (period.status !== 'open') {
      throw new AppError(422, 'PERIOD_CLOSED', `Posting period ${period.code} is closed. An authorized user must reopen it before posting.`);
    }
    return { id: period.id, code: period.code };
  }

  async nextNumber(
    trx: Trx,
    tenantId: string,
    documentType: string,
    seriesId?: string | null,
  ): Promise<{ seriesId: string; number: number; documentNumber: string }> {
    let query = trx
      .selectFrom('numbering_series')
      .select(['id', 'prefix', 'next_number', 'last_number', 'status'])
      .where('tenant_id', '=', tenantId)
      .where('document_type', '=', documentType);
    query = seriesId ? query.where('id', '=', seriesId) : query.where('is_default', '=', true);
    const series = await query.forUpdate().executeTakeFirst();
    if (!series) {
      throw new AppError(422, 'SERIES_NOT_FOUND', 'No numbering series is available for this document type');
    }
    if (series.status !== 'active') {
      throw new AppError(422, 'SERIES_INACTIVE', 'The selected numbering series is inactive');
    }
    const number = Number(series.next_number);
    if (series.last_number !== null && number > Number(series.last_number)) {
      throw new AppError(422, 'SERIES_EXHAUSTED', 'The numbering series has reached its last number');
    }
    await trx
      .updateTable('numbering_series')
      .set({ next_number: number + 1 })
      .where('id', '=', series.id)
      .execute();
    return { seriesId: series.id, number, documentNumber: `${series.prefix}${number}` };
  }

  async post(trx: Trx, input: PostingInput): Promise<PostedJournal> {
    if (input.lines.length < 2) {
      throw new AppError(422, 'POSTING_REJECTED', 'A journal entry needs at least two lines');
    }
    const period = await this.openPeriodFor(trx, input.tenantId, input.postingDate);
    const tenant = await trx.selectFrom('tenants').select('base_currency').where('id', '=', input.tenantId).executeTakeFirstOrThrow();
    const resolved = await this.resolveLines(trx, input.tenantId, input.lines);
    const totalDebit = sumMoney(resolved.map((line) => line.debit));
    const totalCredit = sumMoney(resolved.map((line) => line.credit));
    if (totalDebit !== totalCredit) {
      throw new AppError(
        422,
        'JOURNAL_UNBALANCED',
        `Debits (${formatMoney(totalDebit)}) and credits (${formatMoney(totalCredit)}) must be equal`,
      );
    }
    if (totalDebit <= 0n) {
      throw new AppError(422, 'POSTING_REJECTED', 'The journal entry total must be greater than zero');
    }
    const numbering = await this.nextNumber(trx, input.tenantId, 'journal_entry', input.seriesId);
    const header = await trx
      .insertInto('journal_entries')
      .values({
        tenant_id: input.tenantId,
        series_id: numbering.seriesId,
        number: numbering.number,
        document_number: numbering.documentNumber,
        source_type: input.sourceType,
        source_id: input.sourceId ?? null,
        posting_date: input.postingDate,
        document_date: input.documentDate ?? input.postingDate,
        due_date: input.dueDate ?? input.postingDate,
        period_id: period.id,
        memo: input.memo ?? null,
        reference: input.reference ?? null,
        currency: tenant.base_currency,
        total_debit: formatMoney(totalDebit),
        total_credit: formatMoney(totalCredit),
        reversal_of_id: input.reversalOfId ?? null,
        reversal_reason: input.reversalReason ?? null,
        posted_by: input.userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('journal_lines')
      .values(
        resolved.map((line, index) => ({
          tenant_id: input.tenantId,
          journal_id: header.id,
          line_no: index + 1,
          account_id: line.accountId,
          partner_id: line.partnerId,
          debit: formatMoney(line.debit),
          credit: formatMoney(line.credit),
          memo: line.memo,
        })),
      )
      .execute();
    return { id: header.id, documentNumber: numbering.documentNumber };
  }

  private async resolveLines(
    trx: Trx,
    tenantId: string,
    lines: PostingLine[],
  ): Promise<{ accountId: string; partnerId: string | null; debit: Money; credit: Money; memo: string | null }[]> {
    const controls = await trx
      .selectFrom('gl_determination')
      .select(['determination_key', 'account_id'])
      .where('tenant_id', '=', tenantId)
      .where('determination_key', 'in', ['receivable_control', 'payable_control'])
      .execute();
    const controlFor = (kind: 'receivable' | 'payable') =>
      controls.find((row) => row.determination_key === `${kind}_control`)?.account_id ?? null;
    const accountIds = [
      ...new Set([
        ...lines.map((line) => line.accountId).filter((id): id is string => Boolean(id)),
        ...controls.map((row) => row.account_id),
      ]),
    ];
    const partnerIds = [...new Set(lines.map((line) => line.partnerId).filter((id): id is string => Boolean(id)))];
    const accounts = accountIds.length
      ? await trx
          .selectFrom('accounts')
          .select(['id', 'code', 'is_title', 'status', 'control_kind'])
          .where('tenant_id', '=', tenantId)
          .where('id', 'in', accountIds)
          .execute()
      : [];
    const partners = partnerIds.length
      ? await trx
          .selectFrom('business_partners')
          .select(['id', 'code', 'partner_type', 'status'])
          .where('tenant_id', '=', tenantId)
          .where('id', 'in', partnerIds)
          .execute()
      : [];

    return lines.map((line, index) => {
      if (line.debit < 0n || line.credit < 0n || (line.debit > 0n) === (line.credit > 0n)) {
        throw lineError(index, `Line ${index + 1} must have either a debit or a credit amount`);
      }
      let accountId = line.accountId ?? null;
      const partnerId = line.partnerId ?? null;
      let expectedControl: 'receivable' | 'payable' | null = null;
      if (partnerId) {
        const partner = partners.find((candidate) => candidate.id === partnerId);
        if (!partner) {
          throw lineError(index, `Line ${index + 1}: business partner not found`);
        }
        if (partner.status !== 'active') {
          throw lineError(index, `Line ${index + 1}: business partner ${partner.code} is inactive`);
        }
        if (partner.partner_type === 'lead') {
          throw lineError(index, `Line ${index + 1}: leads cannot be posted; convert ${partner.code} to a customer first`);
        }
        expectedControl = partner.partner_type === 'customer' ? 'receivable' : 'payable';
        const control = controlFor(expectedControl);
        if (!control) {
          throw new AppError(422, 'MAPPING_MISSING', `G/L account determination is missing the ${expectedControl} control account`);
        }
        accountId ??= control;
        if (accountId !== control) {
          throw lineError(index, `Line ${index + 1}: partner lines must post to the ${expectedControl} control account`);
        }
      }
      if (!accountId) {
        throw lineError(index, `Line ${index + 1}: choose a G/L account or a business partner`);
      }
      const account = accounts.find((candidate) => candidate.id === accountId);
      if (!account) {
        throw lineError(index, `Line ${index + 1}: G/L account not found`);
      }
      if (account.is_title) {
        throw lineError(index, `Line ${index + 1}: ${account.code} is a title account and cannot be posted`);
      }
      if (account.status !== 'active') {
        throw lineError(index, `Line ${index + 1}: account ${account.code} is inactive`);
      }
      if (account.control_kind && account.control_kind !== expectedControl) {
        throw lineError(index, `Line ${index + 1}: ${account.code} is a control account; post it through a business partner`);
      }
      return { accountId, partnerId, debit: line.debit, credit: line.credit, memo: line.memo ?? null };
    });
  }
}
