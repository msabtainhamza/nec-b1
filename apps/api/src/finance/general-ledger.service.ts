import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { GENERAL_LEDGER_MAX_LINES, type GeneralLedgerAccount, type GeneralLedgerQuery, type GeneralLedgerReport } from '@nec/contracts';
import { AppError } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService } from '../database/database.service.js';
import { formatMoney, parseMoney } from './money.js';

@Injectable()
export class GeneralLedgerService {
  constructor(private readonly database: DatabaseService) {}

  async report(principal: TenantPrincipal, query: GeneralLedgerQuery): Promise<GeneralLedgerReport> {
    if (query.from > query.to) throw new AppError(400, 'VALIDATION_FAILED', 'The start date must be on or before the end date', [{ path: 'from', message: 'After end date' }]);
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const tenantId = principal.tenantId;
      const tenant = await trx.selectFrom('tenants').select(['display_name', 'base_currency']).where('id', '=', tenantId).executeTakeFirstOrThrow();
      const accountFrom = query.accountFrom || null;
      const accountTo = query.accountTo || null;
      const partnerId = query.partnerId ?? null;
      const count = await sql<{ count: string }>`
        select count(*)::text as count from journal_lines l
        join journal_entries je on je.tenant_id = l.tenant_id and je.id = l.journal_id
        join accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
        where l.tenant_id = ${tenantId} and je.posting_date between ${query.from} and ${query.to}
          and (${accountFrom}::text is null or a.code >= ${accountFrom}) and (${accountTo}::text is null or a.code <= ${accountTo})
          and (${partnerId}::uuid is null or l.partner_id = ${partnerId}::uuid)`.execute(trx);
      if (Number(count.rows[0]?.count ?? 0) > GENERAL_LEDGER_MAX_LINES) {
        throw new AppError(422, 'REPORT_TOO_LARGE', `The report has more than ${GENERAL_LEDGER_MAX_LINES} lines; narrow the date or account range`);
      }
      const openings = await sql<{ account_id: string; code: string; name: string; opening: string }>`
        select a.id as account_id, a.code, a.name,
          coalesce((select sum(l.debit - l.credit) from journal_lines l join journal_entries je on je.tenant_id = l.tenant_id and je.id = l.journal_id
            where l.tenant_id = a.tenant_id and l.account_id = a.id and je.posting_date < ${query.from}
              and (${partnerId}::uuid is null or l.partner_id = ${partnerId}::uuid)), 0)::text as opening
        from accounts a
        where a.tenant_id = ${tenantId} and not a.is_title
          and (${accountFrom}::text is null or a.code >= ${accountFrom}) and (${accountTo}::text is null or a.code <= ${accountTo})
        order by a.code`.execute(trx);
      const lines = await sql<{ account_id: string; journal_id: string; document_number: string; posting_date: string; source_type: string; reference: string | null; memo: string | null; partner_code: string | null; debit: string; credit: string }>`
        select l.account_id, je.id as journal_id, je.document_number, je.posting_date::text as posting_date, je.source_type, je.reference,
          coalesce(l.memo, je.memo) as memo, p.code as partner_code, l.debit::text as debit, l.credit::text as credit
        from journal_lines l
        join journal_entries je on je.tenant_id = l.tenant_id and je.id = l.journal_id
        join accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
        left join business_partners p on p.tenant_id = l.tenant_id and p.id = l.partner_id
        where l.tenant_id = ${tenantId} and je.posting_date between ${query.from} and ${query.to}
          and (${accountFrom}::text is null or a.code >= ${accountFrom}) and (${accountTo}::text is null or a.code <= ${accountTo})
          and (${partnerId}::uuid is null or l.partner_id = ${partnerId}::uuid)
        order by a.code, je.posting_date, je.number, l.line_no`.execute(trx);
      let totalDebit = 0n;
      let totalCredit = 0n;
      const accounts: GeneralLedgerAccount[] = [];
      for (const account of openings.rows) {
        const own = lines.rows.filter((line) => line.account_id === account.account_id);
        const opening = parseMoney(account.opening);
        if (own.length === 0 && opening === 0n) continue;
        let balance = opening;
        let debit = 0n;
        let credit = 0n;
        const rows = own.map((line) => {
          const lineDebit = parseMoney(line.debit);
          const lineCredit = parseMoney(line.credit);
          debit += lineDebit;
          credit += lineCredit;
          balance += lineDebit - lineCredit;
          return {
            journalId: line.journal_id,
            journalNumber: line.document_number,
            postingDate: line.posting_date,
            sourceType: line.source_type,
            reference: line.reference,
            memo: line.memo,
            partnerCode: line.partner_code,
            debit: formatMoney(lineDebit),
            credit: formatMoney(lineCredit),
            balance: formatMoney(balance),
          };
        });
        totalDebit += debit;
        totalCredit += credit;
        accounts.push({
          accountId: account.account_id,
          accountCode: account.code,
          accountName: account.name,
          openingBalance: formatMoney(opening),
          debit: formatMoney(debit),
          credit: formatMoney(credit),
          closingBalance: formatMoney(balance),
          lines: rows,
        });
      }
      return {
        tenantName: tenant.display_name,
        currency: tenant.base_currency,
        from: query.from,
        to: query.to,
        generatedAt: new Date().toISOString(),
        basis: 'Posted journal entries by posting date; balances shown as debit positive, credit negative',
        accounts,
        totals: { debit: formatMoney(totalDebit), credit: formatMoney(totalCredit) },
      };
    });
  }
}
