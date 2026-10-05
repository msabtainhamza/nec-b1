import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  AgingBasis,
  AgingBucketKey,
  AgingBuckets,
  ApAgingDocument,
  ApAgingQuery,
  ApAgingReport,
  ArAgingDocument,
  ArAgingQuery,
  ArAgingReport,
} from '@nec/contracts';
import { AppError } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, type Trx } from '../database/database.service.js';
import { formatMoney, parseMoney, type Money } from './money.js';

type Side = 'payables' | 'receivables';
type DocumentType = ApAgingDocument['type'] | ArAgingDocument['type'];

const SIDES = {
  payables: {
    controlKey: 'payable_control',
    controlLabel: 'payable',
    partnerType: 'supplier',
    direction: 'outgoing',
    paymentType: 'outgoing_payment',
    balance: sql.raw('jl.credit - jl.debit'),
    openingAmount: sql.raw('l.credit - l.debit'),
    sources: ['ap_invoice', 'ap_invoice_cancellation', 'outgoing_payment', 'outgoing_payment_cancellation', 'partner_opening_balance', 'partner_opening_balance_cancellation'],
  },
  receivables: {
    controlKey: 'receivable_control',
    controlLabel: 'receivable',
    partnerType: 'customer',
    direction: 'incoming',
    paymentType: 'incoming_payment',
    balance: sql.raw('jl.debit - jl.credit'),
    openingAmount: sql.raw('l.debit - l.credit'),
    sources: ['ar_invoice', 'ar_invoice_cancellation', 'incoming_payment', 'incoming_payment_cancellation', 'partner_opening_balance', 'partner_opening_balance_cancellation'],
  },
} as const;

const BUCKETS: AgingBucketKey[] = ['current', 'days1To30', 'days31To60', 'days61To90', 'over90'];

interface OpenItem {
  partnerId: string;
  type: DocumentType;
  id: string;
  documentNumber: string;
  reference: string | null;
  postingDate: string;
  dueDate: string;
  original: Money;
  open: Money;
}

interface AgedDocument {
  type: DocumentType;
  id: string;
  documentNumber: string;
  reference: string | null;
  postingDate: string;
  dueDate: string;
  days: number;
  bucket: AgingBucketKey;
  originalAmount: string;
  openAmount: string;
}

interface AgedPartner extends AgingBuckets {
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  documents: AgedDocument[];
}

interface AgedReport {
  tenantName: string;
  currency: string;
  asOf: string;
  basis: AgingBasis;
  generatedAt: string;
  partners: AgedPartner[];
  totals: AgingBuckets;
  controlAccount: { code: string; name: string; balance: string };
  difference: string;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function bucketFor(days: number): AgingBucketKey {
  if (days <= 0) return 'current';
  if (days <= 30) return 'days1To30';
  if (days <= 60) return 'days31To60';
  if (days <= 90) return 'days61To90';
  return 'over90';
}

function emptyTotals(): Record<AgingBucketKey | 'total', Money> {
  return { current: 0n, days1To30: 0n, days31To60: 0n, days61To90: 0n, over90: 0n, total: 0n };
}

function formatBuckets(totals: Record<AgingBucketKey | 'total', Money>): AgingBuckets {
  return {
    current: formatMoney(totals.current),
    days1To30: formatMoney(totals.days1To30),
    days31To60: formatMoney(totals.days31To60),
    days61To90: formatMoney(totals.days61To90),
    over90: formatMoney(totals.over90),
    total: formatMoney(totals.total),
  };
}

@Injectable()
export class AgingService {
  constructor(private readonly database: DatabaseService) {}

  async payables(principal: TenantPrincipal, query: ApAgingQuery): Promise<ApAgingReport> {
    const { partners, ...report } = await this.report(principal, 'payables', query.asOf, query.basis, query.vendorId ?? null);
    return {
      ...report,
      accountingBasis: `Posted A/P invoices, vendor opening balances (aged from their original document dates), outgoing payments and other supplier postings to the payables control account up to ${query.asOf}, net of allocations dated on or before that date; aged by ${query.basis === 'due_date' ? 'due date' : 'posting date'}; amounts owed are positive and unapplied payments negative`,
      vendors: partners.map(({ partnerId, partnerCode, partnerName, documents, ...buckets }) => ({
        vendorId: partnerId,
        vendorCode: partnerCode,
        vendorName: partnerName,
        ...buckets,
        documents: documents as ApAgingDocument[],
      })),
    };
  }

  async receivables(principal: TenantPrincipal, query: ArAgingQuery): Promise<ArAgingReport> {
    const { partners, ...report } = await this.report(principal, 'receivables', query.asOf, query.basis, query.customerId ?? null);
    return {
      ...report,
      accountingBasis: `Posted A/R invoices, customer opening balances (aged from their original document dates), incoming payments and other customer postings to the receivables control account up to ${query.asOf}, net of allocations dated on or before that date; aged by ${query.basis === 'due_date' ? 'due date' : 'posting date'}; amounts receivable are positive and unapplied payments negative`,
      customers: partners.map(({ partnerId, partnerCode, partnerName, documents, ...buckets }) => ({
        customerId: partnerId,
        customerCode: partnerCode,
        customerName: partnerName,
        ...buckets,
        documents: documents as ArAgingDocument[],
      })),
    };
  }

  private async report(principal: TenantPrincipal, side: Side, asOf: string, basis: AgingBasis, partnerId: string | null): Promise<AgedReport> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, async (trx) => {
      const tenantId = principal.tenantId;
      const config = SIDES[side];
      const tenant = await trx.selectFrom('tenants').select(['display_name', 'base_currency']).where('id', '=', tenantId).executeTakeFirstOrThrow();
      const control = await trx
        .selectFrom('gl_determination as d')
        .innerJoin('accounts as a', (join) => join.onRef('a.id', '=', 'd.account_id').onRef('a.tenant_id', '=', 'd.tenant_id'))
        .select(['a.id', 'a.code', 'a.name'])
        .where('d.tenant_id', '=', tenantId)
        .where('d.determination_key', '=', config.controlKey)
        .executeTakeFirst();
      if (!control) throw new AppError(422, 'MAPPING_MISSING', `G/L account determination is missing the ${config.controlLabel} control account`);

      const items: OpenItem[] = [
        ...(side === 'payables' ? await this.invoices(trx, tenantId, asOf, partnerId) : await this.salesInvoices(trx, tenantId, asOf, partnerId)),
        ...(await this.payments(trx, tenantId, side, asOf, partnerId)),
        ...(await this.openings(trx, tenantId, side, asOf, partnerId)),
        ...(await this.journals(trx, tenantId, side, control.id, asOf, partnerId)),
      ].filter((item) => item.open !== 0n);

      const controlBalance = await sql<{ balance: string }>`
        select coalesce(sum(${config.balance}), 0)::text as balance
        from journal_lines jl
        join journal_entries je on je.id = jl.journal_id and je.tenant_id = jl.tenant_id
        where jl.tenant_id = ${tenantId} and jl.account_id = ${control.id} and je.posting_date <= ${asOf}::date
          and (${partnerId}::uuid is null or jl.partner_id = ${partnerId}::uuid)
      `.execute(trx);

      const partnerIds = [...new Set(items.map((item) => item.partnerId))];
      const partners = partnerIds.length
        ? await trx.selectFrom('business_partners').select(['id', 'code', 'name']).where('tenant_id', '=', tenantId).where('id', 'in', partnerIds).execute()
        : [];
      const grand = emptyTotals();
      const aged: AgedPartner[] = partners
        .map((partner) => {
          const totals = emptyTotals();
          const documents = items
            .filter((item) => item.partnerId === partner.id)
            .sort((a, b) => (a.dueDate === b.dueDate ? a.documentNumber.localeCompare(b.documentNumber) : a.dueDate.localeCompare(b.dueDate)))
            .map((item) => {
              const days = daysBetween(basis === 'due_date' ? item.dueDate : item.postingDate, asOf);
              const bucket = bucketFor(days);
              totals[bucket] += item.open;
              totals.total += item.open;
              return {
                type: item.type,
                id: item.id,
                documentNumber: item.documentNumber,
                reference: item.reference,
                postingDate: item.postingDate,
                dueDate: item.dueDate,
                days,
                bucket,
                originalAmount: formatMoney(item.original),
                openAmount: formatMoney(item.open),
              };
            });
          for (const key of [...BUCKETS, 'total'] as const) grand[key] += totals[key];
          return { partnerId: partner.id, partnerCode: partner.code, partnerName: partner.name, ...formatBuckets(totals), documents };
        })
        .sort((a, b) => a.partnerCode.localeCompare(b.partnerCode));
      const balance = parseMoney(controlBalance.rows[0]?.balance ?? '0');
      return {
        tenantName: tenant.display_name,
        currency: tenant.base_currency,
        asOf,
        basis,
        generatedAt: new Date().toISOString(),
        partners: aged,
        totals: formatBuckets(grand),
        controlAccount: { code: control.code, name: control.name, balance: formatMoney(balance) },
        difference: formatMoney(balance - grand.total),
      };
    });
  }

  private async invoices(trx: Trx, tenantId: string, asOf: string, partnerId: string | null): Promise<OpenItem[]> {
    const rows = await sql<{
      id: string;
      vendor_id: string;
      document_number: string;
      vendor_reference: string | null;
      posting_date: string;
      due_date: string;
      total: string;
      applied: string;
    }>`
      select i.id, i.vendor_id, i.document_number, i.vendor_reference, i.posting_date::text, i.due_date::text, i.total::text,
        coalesce((select sum(case when a.event_type = 'allocate' then a.amount else -a.amount end)
          from payment_allocations a where a.tenant_id = i.tenant_id and a.invoice_id = i.id and a.event_date <= ${asOf}::date), 0)::text as applied
      from ap_invoices i
      where i.tenant_id = ${tenantId} and not i.is_cancellation and i.posting_date <= ${asOf}::date
        and (${partnerId}::uuid is null or i.vendor_id = ${partnerId}::uuid)
        and not exists (select 1 from ap_invoices c where c.tenant_id = i.tenant_id and c.cancellation_of_id = i.id and c.posting_date <= ${asOf}::date)
    `.execute(trx);
    return rows.rows.map((row) => ({
      partnerId: row.vendor_id,
      type: 'ap_invoice' as const,
      id: row.id,
      documentNumber: row.document_number,
      reference: row.vendor_reference,
      postingDate: row.posting_date,
      dueDate: row.due_date,
      original: parseMoney(row.total),
      open: parseMoney(row.total) - parseMoney(row.applied),
    }));
  }

  private async salesInvoices(trx: Trx, tenantId: string, asOf: string, partnerId: string | null): Promise<OpenItem[]> {
    const rows = await sql<{
      id: string;
      customer_id: string;
      document_number: string;
      customer_reference: string | null;
      posting_date: string;
      due_date: string;
      total: string;
      applied: string;
    }>`
      select i.id, i.customer_id, i.document_number, i.customer_reference, i.posting_date::text, i.due_date::text, i.total::text,
        coalesce((select sum(case when a.event_type = 'allocate' then a.amount else -a.amount end)
          from payment_allocations a where a.tenant_id = i.tenant_id and a.ar_invoice_id = i.id and a.event_date <= ${asOf}::date), 0)::text as applied
      from ar_invoices i
      where i.tenant_id = ${tenantId} and not i.is_cancellation and i.posting_date <= ${asOf}::date
        and (${partnerId}::uuid is null or i.customer_id = ${partnerId}::uuid)
        and not exists (select 1 from ar_invoices c where c.tenant_id = i.tenant_id and c.cancellation_of_id = i.id and c.posting_date <= ${asOf}::date)
    `.execute(trx);
    return rows.rows.map((row) => ({
      partnerId: row.customer_id,
      type: 'ar_invoice' as const,
      id: row.id,
      documentNumber: row.document_number,
      reference: row.customer_reference,
      postingDate: row.posting_date,
      dueDate: row.due_date,
      original: parseMoney(row.total),
      open: parseMoney(row.total) - parseMoney(row.applied),
    }));
  }

  private async payments(trx: Trx, tenantId: string, side: Side, asOf: string, partnerId: string | null): Promise<OpenItem[]> {
    const config = SIDES[side];
    const rows = await sql<{
      id: string;
      partner_id: string;
      document_number: string;
      reference: string | null;
      posting_date: string;
      amount: string;
      applied: string;
    }>`
      select p.id, p.partner_id, p.document_number, p.reference, p.posting_date::text, p.amount::text,
        coalesce((select sum(case when a.event_type = 'allocate' then a.amount else -a.amount end)
          from payment_allocations a where a.tenant_id = p.tenant_id and a.payment_id = p.id and a.event_date <= ${asOf}::date), 0)::text as applied
      from payments p
      where p.tenant_id = ${tenantId} and p.direction = ${config.direction} and not p.is_cancellation and p.posting_date <= ${asOf}::date
        and (${partnerId}::uuid is null or p.partner_id = ${partnerId}::uuid)
        and not exists (select 1 from payments c where c.tenant_id = p.tenant_id and c.cancellation_of_id = p.id and c.posting_date <= ${asOf}::date)
    `.execute(trx);
    return rows.rows.map((row) => ({
      partnerId: row.partner_id,
      type: config.paymentType,
      id: row.id,
      documentNumber: row.document_number,
      reference: row.reference,
      postingDate: row.posting_date,
      dueDate: row.posting_date,
      original: -parseMoney(row.amount),
      open: -(parseMoney(row.amount) - parseMoney(row.applied)),
    }));
  }

  private async openings(trx: Trx, tenantId: string, side: Side, asOf: string, partnerId: string | null): Promise<OpenItem[]> {
    const config = SIDES[side];
    const rows = await sql<{
      id: string;
      partner_id: string;
      document_number: string;
      reference: string | null;
      document_date: string;
      due_date: string;
      amount: string;
      applied: string;
    }>`
      select l.id, l.partner_id, o.document_number || '/' || l.line_no as document_number, l.reference, l.document_date::text, l.due_date::text,
        (${config.openingAmount})::text as amount,
        coalesce((select sum(case when a.event_type = 'allocate' then a.amount else -a.amount end)
          from payment_allocations a where a.tenant_id = l.tenant_id and a.opening_line_id = l.id and a.event_date <= ${asOf}::date), 0)::text as applied
      from opening_balance_lines l
      join opening_balances o on o.id = l.opening_balance_id and o.tenant_id = l.tenant_id
      join business_partners p on p.id = l.partner_id and p.tenant_id = l.tenant_id
      where l.tenant_id = ${tenantId} and o.kind = 'partner' and not o.is_cancellation and p.partner_type = ${config.partnerType}
        and o.posting_date <= ${asOf}::date
        and (${partnerId}::uuid is null or l.partner_id = ${partnerId}::uuid)
        and not exists (select 1 from opening_balances c where c.tenant_id = o.tenant_id and c.cancellation_of_id = o.id and c.posting_date <= ${asOf}::date)
    `.execute(trx);
    return rows.rows.map((row) => ({
      partnerId: row.partner_id,
      type: 'opening_balance' as const,
      id: row.id,
      documentNumber: row.document_number,
      reference: row.reference,
      postingDate: row.document_date,
      dueDate: row.due_date,
      original: parseMoney(row.amount),
      open: parseMoney(row.amount) - parseMoney(row.applied),
    }));
  }

  private async journals(trx: Trx, tenantId: string, side: Side, controlId: string, asOf: string, partnerId: string | null): Promise<OpenItem[]> {
    const config = SIDES[side];
    const rows = await sql<{
      id: string;
      partner_id: string;
      document_number: string;
      reference: string | null;
      posting_date: string;
      due_date: string;
      amount: string;
    }>`
      select je.id, jl.partner_id, je.document_number, je.reference, je.posting_date::text, je.due_date::text, sum(${config.balance})::text as amount
      from journal_lines jl
      join journal_entries je on je.id = jl.journal_id and je.tenant_id = jl.tenant_id
      where jl.tenant_id = ${tenantId} and jl.account_id = ${controlId} and jl.partner_id is not null
        and je.posting_date <= ${asOf}::date
        and je.source_type <> all(${[...config.sources]}::text[])
        and (${partnerId}::uuid is null or jl.partner_id = ${partnerId}::uuid)
      group by je.id, jl.partner_id, je.document_number, je.reference, je.posting_date, je.due_date
      having sum(${config.balance}) <> 0
    `.execute(trx);
    return rows.rows.map((row) => ({
      partnerId: row.partner_id,
      type: 'journal_entry' as const,
      id: row.id,
      documentNumber: row.document_number,
      reference: row.reference,
      postingDate: row.posting_date,
      dueDate: row.due_date,
      original: parseMoney(row.amount),
      open: parseMoney(row.amount),
    }));
  }
}
