import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  OpenPaymentItem,
  Page,
  PayableDocumentType,
  Payment,
  PaymentDirection,
  PaymentMeans,
  PaymentSummary,
  UnallocatePaymentRequest,
} from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { AppError, conflict, isUniqueViolation, notFound } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, lockTenantResource, type Trx } from '../database/database.service.js';
import { claimIdempotencyKey, completeIdempotencyKey } from '../finance/idempotency.js';
import { formatMoney, parseMoney, sumMoney, type Money } from '../finance/money.js';
import { PostingService } from '../finance/posting.service.js';

export interface AllocationInput {
  invoiceId?: string | undefined;
  arInvoiceId?: string | undefined;
  openingLineId?: string | undefined;
  amount: string;
}

export interface PaymentInput {
  partnerId: string;
  postingDate: string;
  documentDate?: string | undefined;
  paymentMeans: PaymentMeans;
  accountId?: string | undefined;
  amount: string;
  reference?: string | null | undefined;
  remarks?: string | null | undefined;
  seriesId?: string | undefined;
  allocations: AllocationInput[];
}

export interface PaymentListInput {
  search?: string | undefined;
  partnerId?: string | undefined;
  limit: number;
  offset: number;
}

interface PaymentState {
  id: string;
  direction: PaymentDirection;
  documentNumber: string;
  partnerId: string;
  postingDate: string;
  amount: Money;
  allocated: Money;
}

interface AllocationTarget {
  invoice_id: string | null;
  ar_invoice_id: string | null;
  opening_line_id: string | null;
}

interface PlannedAllocation {
  type: PayableDocumentType;
  id: string;
  label: string;
  paid: Money;
  amount: Money;
}

const CONFIG = {
  outgoing: { partnerType: 'supplier', partner: 'vendor', title: 'Outgoing payment', field: 'vendorId', control: 'payables' },
  incoming: { partnerType: 'customer', partner: 'customer', title: 'Incoming payment', field: 'customerId', control: 'receivables' },
} as const;

const allocationError = (index: number, message: string, status = 400, code = 'VALIDATION_FAILED') =>
  new AppError(status, code, message, [{ path: `allocations.${index}`, message }]);

const documentLabel = sql<string>`coalesce(i.document_number, ari.document_number, ob.document_number || '/' || ol.line_no)`;
const documentReference = sql<string | null>`coalesce(i.vendor_reference, ari.customer_reference, ol.reference)`;

@Injectable()
export class PaymentsService {
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

  async openItems(principal: TenantPrincipal, direction: PaymentDirection, partnerId: string): Promise<OpenPaymentItem[]> {
    return this.read(principal, async (trx) => {
      const base = trx
        .selectFrom('opening_balance_lines as l')
        .innerJoin('opening_balances as o', (join) => join.onRef('o.id', '=', 'l.opening_balance_id').onRef('o.tenant_id', '=', 'l.tenant_id'))
        .select(['l.id', 'o.document_number', 'l.line_no', 'l.reference', 'l.document_date', 'l.due_date', 'l.debit', 'l.credit', 'l.paid_amount'])
        .where('l.tenant_id', '=', principal.tenantId)
        .where('l.partner_id', '=', partnerId)
        .where('o.status', '=', 'posted')
        .where('o.is_cancellation', '=', false);
      const openings = (
        direction === 'outgoing'
          ? await base.where('l.credit', '>', '0').whereRef('l.paid_amount', '<', 'l.credit').execute()
          : await base.where('l.debit', '>', '0').whereRef('l.paid_amount', '<', 'l.debit').execute()
      ).map((row) => ({ ...row, amount: direction === 'outgoing' ? row.credit : row.debit }));
      const invoices =
        direction === 'outgoing'
          ? await trx
              .selectFrom('ap_invoices')
              .select(['id', 'document_number', 'vendor_reference', 'posting_date', 'due_date', 'total', 'paid_amount'])
              .where('tenant_id', '=', principal.tenantId)
              .where('vendor_id', '=', partnerId)
              .where('status', '=', 'posted')
              .where('is_cancellation', '=', false)
              .whereRef('paid_amount', '<', 'total')
              .execute()
          : [];
      const arInvoices =
        direction === 'incoming'
          ? await trx
              .selectFrom('ar_invoices')
              .select(['id', 'document_number', 'customer_reference', 'posting_date', 'due_date', 'total', 'paid_amount'])
              .where('tenant_id', '=', principal.tenantId)
              .where('customer_id', '=', partnerId)
              .where('status', '=', 'posted')
              .where('is_cancellation', '=', false)
              .whereRef('paid_amount', '<', 'total')
              .execute()
          : [];
      const items: OpenPaymentItem[] = [
        ...arInvoices.map((row) => ({
          documentType: 'ar_invoice' as const,
          invoiceId: row.id,
          openingLineId: null,
          documentNumber: row.document_number,
          vendorReference: row.customer_reference,
          postingDate: row.posting_date,
          dueDate: row.due_date,
          total: row.total,
          paidAmount: row.paid_amount,
          openAmount: formatMoney(parseMoney(row.total) - parseMoney(row.paid_amount)),
        })),
        ...invoices.map((row) => ({
          documentType: 'ap_invoice' as const,
          invoiceId: row.id,
          openingLineId: null,
          documentNumber: row.document_number,
          vendorReference: row.vendor_reference,
          postingDate: row.posting_date,
          dueDate: row.due_date,
          total: row.total,
          paidAmount: row.paid_amount,
          openAmount: formatMoney(parseMoney(row.total) - parseMoney(row.paid_amount)),
        })),
        ...openings.map((row) => ({
          documentType: 'opening_balance' as const,
          invoiceId: null,
          openingLineId: row.id,
          documentNumber: `${row.document_number}/${row.line_no}`,
          vendorReference: row.reference,
          postingDate: row.document_date as string,
          dueDate: row.due_date as string,
          total: row.amount,
          paidAmount: row.paid_amount,
          openAmount: formatMoney(parseMoney(row.amount) - parseMoney(row.paid_amount)),
        })),
      ];
      return items.sort((a, b) => (a.dueDate === b.dueDate ? a.documentNumber.localeCompare(b.documentNumber) : a.dueDate.localeCompare(b.dueDate)));
    });
  }

  async create(
    principal: TenantPrincipal,
    direction: PaymentDirection,
    idempotencyKey: string,
    request: unknown,
    payload: PaymentInput,
    correlationId: string,
  ): Promise<{ replayed: boolean; payment: Payment }> {
    const config = CONFIG[direction];
    return this.run(principal, async (trx) => {
      const tenantId = principal.tenantId;
      const existing = await claimIdempotencyKey(trx, tenantId, idempotencyKey, `${direction}_payment.create`, request);
      if (existing) return { replayed: true, payment: await this.loadOrThrow(trx, tenantId, direction, existing) };

      const partner = await trx
        .selectFrom('business_partners')
        .select(['id', 'partner_type', 'status'])
        .where('tenant_id', '=', tenantId)
        .where('id', '=', payload.partnerId)
        .executeTakeFirst();
      if (!partner || partner.partner_type !== config.partnerType || partner.status !== 'active') {
        throw new AppError(400, 'VALIDATION_FAILED', `Choose an active ${config.partner}`, [{ path: config.field, message: `Choose an active ${config.partner}` }]);
      }
      await this.posting.openPeriodFor(trx, tenantId, payload.postingDate);
      const documentDate = payload.documentDate ?? payload.postingDate;
      const amount = parseMoney(payload.amount);
      if (amount <= 0n) {
        throw new AppError(400, 'VALIDATION_FAILED', 'The payment amount must be greater than zero', [{ path: 'amount', message: 'Must be greater than zero' }]);
      }
      const accountId = await this.paymentAccount(trx, tenantId, payload.paymentMeans, payload.accountId);
      const tenant = await trx.selectFrom('tenants').select(['base_currency', 'default_branch_id']).where('id', '=', tenantId).executeTakeFirstOrThrow();
      if (!tenant.default_branch_id) throw new AppError(422, 'VALIDATION_FAILED', 'The company has no default branch');

      const paymentId = randomUUID();
      const partnerLine = { partnerId: partner.id, debit: direction === 'outgoing' ? amount : 0n, credit: direction === 'incoming' ? amount : 0n };
      const cashLine = { accountId, debit: direction === 'incoming' ? amount : 0n, credit: direction === 'outgoing' ? amount : 0n };
      const journal = await this.posting.post(trx, {
        tenantId,
        userId: principal.userId,
        sourceType: `${direction}_payment`,
        sourceId: paymentId,
        postingDate: payload.postingDate,
        documentDate,
        memo: `${config.title}${payload.reference ? ` ${payload.reference}` : ''}`,
        reference: payload.reference ?? null,
        lines: direction === 'outgoing' ? [partnerLine, cashLine] : [cashLine, partnerLine],
      });
      const series = await this.posting.nextNumber(trx, tenantId, `${direction}_payment`, payload.seriesId);
      await trx
        .insertInto('payments')
        .values({
          id: paymentId,
          tenant_id: tenantId,
          direction,
          series_id: series.seriesId,
          number: series.number,
          document_number: series.documentNumber,
          partner_id: partner.id,
          branch_id: tenant.default_branch_id,
          posting_date: payload.postingDate,
          document_date: documentDate,
          payment_means: payload.paymentMeans,
          account_id: accountId,
          reference: payload.reference ?? null,
          remarks: payload.remarks ?? null,
          currency: tenant.base_currency,
          amount: formatMoney(amount),
          journal_id: journal.id,
          created_by: principal.userId,
        })
        .execute();
      const state: PaymentState = {
        id: paymentId,
        direction,
        documentNumber: series.documentNumber,
        partnerId: partner.id,
        postingDate: payload.postingDate,
        amount,
        allocated: 0n,
      };
      const allocated = await this.applyAllocations(trx, tenantId, principal.userId, state, payload.allocations, payload.postingDate);
      await completeIdempotencyKey(trx, tenantId, idempotencyKey, paymentId);
      const payment = await this.loadOrThrow(trx, tenantId, direction, paymentId);
      await this.audit.record(trx, {
        tenantId,
        actor: { type: 'user', id: principal.userId },
        action: `${direction}_payment.posted`,
        entityType: `${direction}_payment`,
        entityId: paymentId,
        after: {
          documentNumber: payment.documentNumber,
          [config.partner]: payment.partnerCode,
          paymentMeans: payment.paymentMeans,
          account: payment.accountCode,
          amount: payment.amount,
          allocations: allocated,
          journal: payment.journalNumber,
        },
        correlationId,
      });
      return { replayed: false, payment };
    });
  }

  async allocate(
    principal: TenantPrincipal,
    direction: PaymentDirection,
    paymentId: string,
    input: { idempotencyKey: string; allocationDate: string; allocations: AllocationInput[] },
    correlationId: string,
  ): Promise<{ replayed: boolean; payment: Payment }> {
    const { idempotencyKey, ...payload } = input;
    return this.run(principal, async (trx) => {
      const tenantId = principal.tenantId;
      const existing = await claimIdempotencyKey(trx, tenantId, idempotencyKey, `${direction}_payment.allocate:${paymentId}`, payload);
      if (existing) return { replayed: true, payment: await this.loadOrThrow(trx, tenantId, direction, existing) };
      const state = await this.lockPayment(trx, tenantId, direction, paymentId);
      if (payload.allocationDate < state.postingDate) {
        throw new AppError(422, 'POSTING_REJECTED', 'The allocation date cannot be earlier than the payment date', [{ path: 'allocationDate', message: 'Before the payment date' }]);
      }
      await this.posting.openPeriodFor(trx, tenantId, payload.allocationDate);
      const allocated = await this.applyAllocations(trx, tenantId, principal.userId, state, payload.allocations, payload.allocationDate);
      await completeIdempotencyKey(trx, tenantId, idempotencyKey, paymentId);
      await this.audit.record(trx, {
        tenantId,
        actor: { type: 'user', id: principal.userId },
        action: `${direction}_payment.allocated`,
        entityType: `${direction}_payment`,
        entityId: paymentId,
        after: { documentNumber: state.documentNumber, allocationDate: payload.allocationDate, allocations: allocated },
        correlationId,
      });
      return { replayed: false, payment: await this.loadOrThrow(trx, tenantId, direction, paymentId) };
    });
  }

  async unallocate(
    principal: TenantPrincipal,
    direction: PaymentDirection,
    paymentId: string,
    allocationId: string,
    input: UnallocatePaymentRequest,
    correlationId: string,
  ): Promise<{ replayed: boolean; payment: Payment }> {
    const { idempotencyKey, ...payload } = input;
    try {
      return await this.run(principal, async (trx) => {
        const tenantId = principal.tenantId;
        const existing = await claimIdempotencyKey(trx, tenantId, idempotencyKey, `${direction}_payment.unallocate:${allocationId}`, payload);
        if (existing) return { replayed: true, payment: await this.loadOrThrow(trx, tenantId, direction, existing) };
        const state = await this.lockPayment(trx, tenantId, direction, paymentId);
        const allocation = await trx
          .selectFrom('payment_allocations as a')
          .leftJoin('ap_invoices as i', (join) => join.onRef('i.id', '=', 'a.invoice_id').onRef('i.tenant_id', '=', 'a.tenant_id'))
          .leftJoin('ar_invoices as ari', (join) => join.onRef('ari.id', '=', 'a.ar_invoice_id').onRef('ari.tenant_id', '=', 'a.tenant_id'))
          .leftJoin('opening_balance_lines as ol', (join) => join.onRef('ol.id', '=', 'a.opening_line_id').onRef('ol.tenant_id', '=', 'a.tenant_id'))
          .leftJoin('opening_balances as ob', (join) => join.onRef('ob.id', '=', 'ol.opening_balance_id').onRef('ob.tenant_id', '=', 'ol.tenant_id'))
          .leftJoin('payment_allocations as u', (join) => join.onRef('u.reverses_id', '=', 'a.id').onRef('u.tenant_id', '=', 'a.tenant_id'))
          .select(['a.id', 'a.invoice_id', 'a.ar_invoice_id', 'a.opening_line_id', 'a.amount', 'a.event_date', documentLabel.as('document_label'), 'u.id as unallocation_id'])
          .where('a.tenant_id', '=', tenantId)
          .where('a.id', '=', allocationId)
          .where('a.payment_id', '=', paymentId)
          .where('a.event_type', '=', 'allocate')
          .executeTakeFirst();
        if (!allocation) throw notFound();
        if (allocation.unallocation_id) throw conflict('This allocation has already been unallocated');
        if (payload.unallocationDate < allocation.event_date) {
          throw new AppError(422, 'POSTING_REJECTED', 'The unallocation date cannot be earlier than the allocation date', [
            { path: 'unallocationDate', message: 'Before the allocation date' },
          ]);
        }
        await this.posting.openPeriodFor(trx, tenantId, payload.unallocationDate);
        await this.reverseAllocation(trx, tenantId, principal.userId, state, allocation, payload.unallocationDate, payload.reason);
        await completeIdempotencyKey(trx, tenantId, idempotencyKey, paymentId);
        await this.audit.record(trx, {
          tenantId,
          actor: { type: 'user', id: principal.userId },
          action: `${direction}_payment.unallocated`,
          entityType: `${direction}_payment`,
          entityId: paymentId,
          before: { document: allocation.document_label, amount: allocation.amount },
          after: { documentNumber: state.documentNumber, unallocationDate: payload.unallocationDate, reason: payload.reason },
          correlationId,
        });
        return { replayed: false, payment: await this.loadOrThrow(trx, tenantId, direction, paymentId) };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'payment_allocations_single_unallocation_key')) {
        throw conflict('This allocation has already been unallocated');
      }
      throw error;
    }
  }

  async cancel(
    principal: TenantPrincipal,
    direction: PaymentDirection,
    paymentId: string,
    input: { idempotencyKey: string; postingDate: string; reason: string },
    correlationId: string,
  ): Promise<{ replayed: boolean; payment: Payment }> {
    const { idempotencyKey, ...payload } = input;
    const config = CONFIG[direction];
    try {
      return await this.run(principal, async (trx) => {
        const tenantId = principal.tenantId;
        const existing = await claimIdempotencyKey(trx, tenantId, idempotencyKey, `${direction}_payment.cancel:${paymentId}`, payload);
        if (existing) return { replayed: true, payment: await this.loadOrThrow(trx, tenantId, direction, existing) };
        const state = await this.lockPayment(trx, tenantId, direction, paymentId);
        const original = await this.loadOrThrow(trx, tenantId, direction, paymentId);
        if (payload.postingDate < original.postingDate) {
          throw new AppError(422, 'POSTING_REJECTED', 'The cancellation date cannot be earlier than the payment date', [{ path: 'postingDate', message: 'Before the payment date' }]);
        }
        const active = await trx
          .selectFrom('payment_allocations as a')
          .leftJoin('ap_invoices as i', (join) => join.onRef('i.id', '=', 'a.invoice_id').onRef('i.tenant_id', '=', 'a.tenant_id'))
          .leftJoin('ar_invoices as ari', (join) => join.onRef('ari.id', '=', 'a.ar_invoice_id').onRef('ari.tenant_id', '=', 'a.tenant_id'))
          .leftJoin('opening_balance_lines as ol', (join) => join.onRef('ol.id', '=', 'a.opening_line_id').onRef('ol.tenant_id', '=', 'a.tenant_id'))
          .leftJoin('opening_balances as ob', (join) => join.onRef('ob.id', '=', 'ol.opening_balance_id').onRef('ob.tenant_id', '=', 'ol.tenant_id'))
          .select(['a.id', 'a.invoice_id', 'a.ar_invoice_id', 'a.opening_line_id', 'a.amount', 'a.event_date', documentLabel.as('document_label')])
          .where('a.tenant_id', '=', tenantId)
          .where('a.payment_id', '=', paymentId)
          .where('a.event_type', '=', 'allocate')
          .where(({ not, exists, selectFrom }) =>
            not(exists(selectFrom('payment_allocations as u').select('u.id').whereRef('u.reverses_id', '=', 'a.id').whereRef('u.tenant_id', '=', 'a.tenant_id'))),
          )
          .orderBy('a.invoice_id')
          .orderBy('a.ar_invoice_id')
          .orderBy('a.opening_line_id')
          .execute();
        const late = active.find((allocation) => allocation.event_date > payload.postingDate);
        if (late) {
          throw new AppError(422, 'POSTING_REJECTED', `The cancellation date cannot be earlier than the allocation to ${late.document_label} on ${late.event_date}`, [
            { path: 'postingDate', message: 'Before an active allocation' },
          ]);
        }
        await this.posting.openPeriodFor(trx, tenantId, payload.postingDate);
        const reason = `Cancellation of ${original.documentNumber}: ${payload.reason}`;
        for (const allocation of active) {
          await this.reverseAllocation(trx, tenantId, principal.userId, state, allocation, payload.postingDate, reason);
        }
        const lines = await trx
          .selectFrom('journal_lines')
          .select(['account_id', 'partner_id', 'debit', 'credit', 'memo'])
          .where('tenant_id', '=', tenantId)
          .where('journal_id', '=', original.journalId)
          .orderBy('line_no')
          .execute();
        const cancellationId = randomUUID();
        const journal = await this.posting.post(trx, {
          tenantId,
          userId: principal.userId,
          sourceType: `${direction}_payment_cancellation`,
          sourceId: cancellationId,
          postingDate: payload.postingDate,
          memo: `Cancellation of ${config.title.toLowerCase()} ${original.documentNumber}`,
          reference: original.documentNumber,
          lines: lines.map((line) => ({
            accountId: line.account_id,
            partnerId: line.partner_id,
            debit: parseMoney(line.credit),
            credit: parseMoney(line.debit),
            memo: line.memo,
          })),
        });
        const header = await trx
          .selectFrom('payments')
          .select(['series_id', 'partner_id', 'branch_id', 'payment_means', 'account_id', 'reference', 'currency', 'amount'])
          .where('tenant_id', '=', tenantId)
          .where('id', '=', paymentId)
          .executeTakeFirstOrThrow();
        const series = await this.posting.nextNumber(trx, tenantId, `${direction}_payment`, header.series_id);
        await trx
          .insertInto('payments')
          .values({
            id: cancellationId,
            tenant_id: tenantId,
            direction,
            series_id: series.seriesId,
            number: series.number,
            document_number: series.documentNumber,
            partner_id: header.partner_id,
            branch_id: header.branch_id,
            posting_date: payload.postingDate,
            document_date: payload.postingDate,
            payment_means: header.payment_means,
            account_id: header.account_id,
            reference: header.reference,
            remarks: `Cancellation of ${original.documentNumber}`,
            currency: header.currency,
            amount: header.amount,
            is_cancellation: true,
            cancellation_of_id: paymentId,
            cancellation_reason: payload.reason,
            journal_id: journal.id,
            created_by: principal.userId,
          })
          .execute();
        await trx.updateTable('payments').set({ status: 'cancelled' }).where('tenant_id', '=', tenantId).where('id', '=', paymentId).execute();
        await completeIdempotencyKey(trx, tenantId, idempotencyKey, cancellationId);
        const cancellation = await this.loadOrThrow(trx, tenantId, direction, cancellationId);
        await this.audit.record(trx, {
          tenantId,
          actor: { type: 'user', id: principal.userId },
          action: `${direction}_payment.cancelled`,
          entityType: `${direction}_payment`,
          entityId: paymentId,
          before: { documentNumber: original.documentNumber, status: 'posted', allocatedAmount: original.allocatedAmount },
          after: {
            status: 'cancelled',
            cancellation: cancellation.documentNumber,
            reason: payload.reason,
            postingDate: payload.postingDate,
            unallocated: active.map((allocation) => ({ document: allocation.document_label, amount: allocation.amount })),
          },
          correlationId,
        });
        return { replayed: false, payment: cancellation };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'payments_single_cancellation_key')) {
        throw conflict(`This ${config.title.toLowerCase()} has already been cancelled`);
      }
      throw error;
    }
  }

  private async paymentAccount(trx: Trx, tenantId: string, means: PaymentMeans, requested: string | undefined): Promise<string> {
    let accountId = requested;
    if (!accountId) {
      const key = means === 'cash' ? 'cash' : 'bank';
      const row = await trx
        .selectFrom('gl_determination')
        .select('account_id')
        .where('tenant_id', '=', tenantId)
        .where('determination_key', '=', key)
        .executeTakeFirst();
      if (!row) throw new AppError(422, 'MAPPING_MISSING', `G/L account determination is missing the ${key === 'cash' ? 'Cash' : 'Bank'} account`);
      accountId = row.account_id;
    }
    const account = await trx
      .selectFrom('accounts')
      .select(['id', 'code', 'account_type', 'is_title', 'status', 'control_kind'])
      .where('tenant_id', '=', tenantId)
      .where('id', '=', accountId)
      .executeTakeFirst();
    if (!account || account.account_type !== 'asset' || account.is_title || account.status !== 'active' || account.control_kind) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Choose an active, postable cash or bank asset account', [
        { path: 'accountId', message: 'Choose an active, postable cash or bank asset account' },
      ]);
    }
    return account.id;
  }

  private async lockPayment(trx: Trx, tenantId: string, direction: PaymentDirection, paymentId: string): Promise<PaymentState> {
    await lockTenantResource(trx, tenantId, `payment:${paymentId}`);
    const row = await trx
      .selectFrom('payments')
      .select(['id', 'document_number', 'partner_id', 'posting_date', 'amount', 'allocated_amount', 'status', 'is_cancellation'])
      .where('tenant_id', '=', tenantId)
      .where('id', '=', paymentId)
      .where('direction', '=', direction)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw notFound();
    const title = CONFIG[direction].title;
    if (row.is_cancellation) throw conflict('A cancellation document cannot be changed or cancelled');
    if (row.status === 'cancelled') throw conflict(`${title} ${row.document_number} is cancelled`);
    return {
      id: row.id,
      direction,
      documentNumber: row.document_number,
      partnerId: row.partner_id,
      postingDate: row.posting_date,
      amount: parseMoney(row.amount),
      allocated: parseMoney(row.allocated_amount),
    };
  }

  private async applyAllocations(
    trx: Trx,
    tenantId: string,
    userId: string,
    payment: PaymentState,
    allocations: AllocationInput[],
    date: string,
  ): Promise<{ document: string; amount: string }[]> {
    if (allocations.length === 0) return [];
    const partner = CONFIG[payment.direction].partner;
    const invoiceIds = allocations.flatMap((allocation) => (allocation.invoiceId ? [allocation.invoiceId] : []));
    const arInvoiceIds = allocations.flatMap((allocation) => (allocation.arInvoiceId ? [allocation.arInvoiceId] : []));
    const openingLineIds = allocations.flatMap((allocation) => (allocation.openingLineId ? [allocation.openingLineId] : []));
    if (new Set(invoiceIds).size !== invoiceIds.length || new Set(arInvoiceIds).size !== arInvoiceIds.length || new Set(openingLineIds).size !== openingLineIds.length) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Each document can appear only once in an allocation');
    }
    if (payment.direction === 'incoming' && invoiceIds.length > 0) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Incoming payments allocate to customer documents only');
    }
    if (payment.direction === 'outgoing' && arInvoiceIds.length > 0) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Outgoing payments allocate to vendor documents only');
    }
    const invoices = invoiceIds.length
      ? await trx
          .selectFrom('ap_invoices')
          .select(['id', 'document_number', 'vendor_id', 'status', 'is_cancellation', 'posting_date', 'total', 'paid_amount'])
          .where('tenant_id', '=', tenantId)
          .where('id', 'in', invoiceIds)
          .orderBy('id')
          .forUpdate()
          .execute()
      : [];
    const arInvoices = arInvoiceIds.length
      ? await trx
          .selectFrom('ar_invoices')
          .select(['id', 'document_number', 'customer_id', 'status', 'is_cancellation', 'posting_date', 'total', 'paid_amount'])
          .where('tenant_id', '=', tenantId)
          .where('id', 'in', arInvoiceIds)
          .orderBy('id')
          .forUpdate()
          .execute()
      : [];
    const openingLines = openingLineIds.length
      ? await trx
          .selectFrom('opening_balance_lines')
          .select(['id', 'opening_balance_id', 'line_no', 'partner_id', 'debit', 'credit', 'paid_amount'])
          .where('tenant_id', '=', tenantId)
          .where('id', 'in', openingLineIds)
          .orderBy('id')
          .forUpdate()
          .execute()
      : [];
    const openingHeaders = openingLines.length
      ? await trx
          .selectFrom('opening_balances')
          .select(['id', 'document_number', 'status', 'is_cancellation', 'posting_date'])
          .where('tenant_id', '=', tenantId)
          .where('id', 'in', [...new Set(openingLines.map((line) => line.opening_balance_id))])
          .execute()
      : [];
    const plan = allocations.map((allocation, index): PlannedAllocation => {
      let target: { label: string; partnerId: string | null; open: boolean; postingDate: string; total: Money; paid: Money };
      if (allocation.invoiceId) {
        const invoice = invoices.find((candidate) => candidate.id === allocation.invoiceId);
        if (!invoice) throw allocationError(index, `Allocation ${index + 1}: the A/P invoice was not found`, 404, 'NOT_FOUND');
        target = {
          label: invoice.document_number,
          partnerId: invoice.vendor_id,
          open: invoice.status === 'posted' && !invoice.is_cancellation,
          postingDate: invoice.posting_date,
          total: parseMoney(invoice.total),
          paid: parseMoney(invoice.paid_amount),
        };
      } else if (allocation.arInvoiceId) {
        const invoice = arInvoices.find((candidate) => candidate.id === allocation.arInvoiceId);
        if (!invoice) throw allocationError(index, `Allocation ${index + 1}: the A/R invoice was not found`, 404, 'NOT_FOUND');
        target = {
          label: invoice.document_number,
          partnerId: invoice.customer_id,
          open: invoice.status === 'posted' && !invoice.is_cancellation,
          postingDate: invoice.posting_date,
          total: parseMoney(invoice.total),
          paid: parseMoney(invoice.paid_amount),
        };
      } else {
        const line = openingLines.find((candidate) => candidate.id === allocation.openingLineId);
        const header = openingHeaders.find((candidate) => candidate.id === line?.opening_balance_id);
        if (!line || !header) throw allocationError(index, `Allocation ${index + 1}: the opening balance line was not found`, 404, 'NOT_FOUND');
        const total = parseMoney(payment.direction === 'outgoing' ? line.credit : line.debit);
        target = {
          label: `${header.document_number}/${line.line_no}`,
          partnerId: line.partner_id,
          open: header.status === 'posted' && !header.is_cancellation && total > 0n,
          postingDate: header.posting_date,
          total,
          paid: parseMoney(line.paid_amount),
        };
      }
      if (target.partnerId !== payment.partnerId) throw allocationError(index, `Allocation ${index + 1}: ${target.label} belongs to another business partner`);
      if (!target.open) {
        throw allocationError(index, `Allocation ${index + 1}: ${target.label} is not an open posted amount ${payment.direction === 'outgoing' ? 'owed to the vendor' : 'owed by the customer'}`, 409, 'CONFLICT');
      }
      if (target.postingDate > date) throw allocationError(index, `Allocation ${index + 1}: ${target.label} is dated after ${date}`);
      const amount = parseMoney(allocation.amount);
      if (amount <= 0n) throw allocationError(index, `Allocation ${index + 1}: the amount must be greater than zero`);
      const open = target.total - target.paid;
      if (amount > open) {
        throw allocationError(index, `Allocation ${index + 1}: only ${formatMoney(open)} is open on ${target.label}`, 422, 'OVER_ALLOCATION');
      }
      return {
        type: allocation.invoiceId ? 'ap_invoice' : allocation.arInvoiceId ? 'ar_invoice' : 'opening_balance',
        id: (allocation.invoiceId ?? allocation.arInvoiceId ?? allocation.openingLineId) as string,
        label: target.label,
        paid: target.paid,
        amount,
      };
    });
    const total = sumMoney(plan.map((line) => line.amount));
    const unapplied = payment.amount - payment.allocated;
    if (total > unapplied) {
      throw new AppError(
        422,
        'OVER_ALLOCATION',
        `Allocations total ${formatMoney(total)} but only ${formatMoney(unapplied)} of payment ${payment.documentNumber} is unapplied to the ${partner}'s documents`,
      );
    }
    for (const line of plan) {
      const target: AllocationTarget = {
        invoice_id: line.type === 'ap_invoice' ? line.id : null,
        ar_invoice_id: line.type === 'ar_invoice' ? line.id : null,
        opening_line_id: line.type === 'opening_balance' ? line.id : null,
      };
      await trx
        .insertInto('payment_allocations')
        .values({
          tenant_id: tenantId,
          event_type: 'allocate',
          payment_id: payment.id,
          ...target,
          amount: formatMoney(line.amount),
          event_date: date,
          created_by: userId,
        })
        .execute();
      await this.setPaid(trx, tenantId, target, line.paid + line.amount);
    }
    payment.allocated += total;
    await trx
      .updateTable('payments')
      .set({ allocated_amount: formatMoney(payment.allocated) })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', payment.id)
      .execute();
    return plan.map((line) => ({ document: line.label, amount: formatMoney(line.amount) }));
  }

  private async setPaid(trx: Trx, tenantId: string, target: AllocationTarget, paid: Money): Promise<void> {
    if (target.invoice_id) {
      await trx.updateTable('ap_invoices').set({ paid_amount: formatMoney(paid) }).where('tenant_id', '=', tenantId).where('id', '=', target.invoice_id).execute();
    } else if (target.ar_invoice_id) {
      await trx.updateTable('ar_invoices').set({ paid_amount: formatMoney(paid) }).where('tenant_id', '=', tenantId).where('id', '=', target.ar_invoice_id).execute();
    } else if (target.opening_line_id) {
      await trx.updateTable('opening_balance_lines').set({ paid_amount: formatMoney(paid) }).where('tenant_id', '=', tenantId).where('id', '=', target.opening_line_id).execute();
    }
  }

  private async currentPaid(trx: Trx, tenantId: string, target: AllocationTarget): Promise<Money> {
    const row = target.invoice_id
      ? await trx.selectFrom('ap_invoices').select('paid_amount').where('tenant_id', '=', tenantId).where('id', '=', target.invoice_id).forUpdate().executeTakeFirstOrThrow()
      : target.ar_invoice_id
        ? await trx.selectFrom('ar_invoices').select('paid_amount').where('tenant_id', '=', tenantId).where('id', '=', target.ar_invoice_id).forUpdate().executeTakeFirstOrThrow()
        : await trx
          .selectFrom('opening_balance_lines')
          .select('paid_amount')
          .where('tenant_id', '=', tenantId)
          .where('id', '=', target.opening_line_id as string)
          .forUpdate()
          .executeTakeFirstOrThrow();
    return parseMoney(row.paid_amount);
  }

  private async reverseAllocation(
    trx: Trx,
    tenantId: string,
    userId: string,
    payment: PaymentState,
    allocation: AllocationTarget & { id: string; amount: string },
    date: string,
    reason: string,
  ): Promise<void> {
    const paid = await this.currentPaid(trx, tenantId, allocation);
    const amount = parseMoney(allocation.amount);
    await trx
      .insertInto('payment_allocations')
      .values({
        tenant_id: tenantId,
        event_type: 'unallocate',
        payment_id: payment.id,
        invoice_id: allocation.invoice_id,
        ar_invoice_id: allocation.ar_invoice_id,
        opening_line_id: allocation.opening_line_id,
        amount: allocation.amount,
        event_date: date,
        reverses_id: allocation.id,
        reason,
        created_by: userId,
      })
      .execute();
    await this.setPaid(trx, tenantId, allocation, paid - amount);
    payment.allocated -= amount;
    await trx
      .updateTable('payments')
      .set({ allocated_amount: formatMoney(payment.allocated) })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', payment.id)
      .execute();
  }

  async list(principal: TenantPrincipal, direction: PaymentDirection, query: PaymentListInput): Promise<Page<PaymentSummary>> {
    return this.read(principal, async (trx) => {
      let base = trx
        .selectFrom('payments as p')
        .innerJoin('business_partners as v', (join) => join.onRef('v.id', '=', 'p.partner_id').onRef('v.tenant_id', '=', 'p.tenant_id'))
        .where('p.tenant_id', '=', principal.tenantId)
        .where('p.direction', '=', direction);
      if (query.search) {
        const pattern = `%${query.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
        base = base.where((eb) => eb.or([eb('p.document_number', 'ilike', pattern), eb('p.reference', 'ilike', pattern), eb('v.name', 'ilike', pattern)]));
      }
      if (query.partnerId) base = base.where('p.partner_id', '=', query.partnerId);
      const total = await base.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
      const rows = await base
        .select(['p.id', 'p.document_number', 'v.name', 'p.posting_date', 'p.payment_means', 'p.reference', 'p.amount', 'p.allocated_amount', 'p.status', 'p.is_cancellation'])
        .orderBy('p.posted_at', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute();
      return {
        items: rows.map((row) => ({
          id: row.id,
          documentNumber: row.document_number,
          partnerName: row.name,
          postingDate: row.posting_date,
          paymentMeans: row.payment_means,
          reference: row.reference,
          amount: row.amount,
          unappliedAmount: unapplied(row),
          status: row.status,
          isCancellation: row.is_cancellation,
        })),
        limit: query.limit,
        offset: query.offset,
        total: Number(total.count),
      };
    });
  }

  async get(principal: TenantPrincipal, direction: PaymentDirection, paymentId: string): Promise<Payment> {
    return this.read(principal, (trx) => this.loadOrThrow(trx, principal.tenantId, direction, paymentId));
  }

  private async loadOrThrow(trx: Trx, tenantId: string, direction: PaymentDirection, paymentId: string): Promise<Payment> {
    const payment = await trx
      .selectFrom('payments as p')
      .innerJoin('business_partners as v', (join) => join.onRef('v.id', '=', 'p.partner_id').onRef('v.tenant_id', '=', 'p.tenant_id'))
      .innerJoin('branches as b', (join) => join.onRef('b.id', '=', 'p.branch_id').onRef('b.tenant_id', '=', 'p.tenant_id'))
      .innerJoin('accounts as acc', (join) => join.onRef('acc.id', '=', 'p.account_id').onRef('acc.tenant_id', '=', 'p.tenant_id'))
      .innerJoin('journal_entries as je', (join) => join.onRef('je.id', '=', 'p.journal_id').onRef('je.tenant_id', '=', 'p.tenant_id'))
      .leftJoin('payments as c', (join) => join.onRef('c.cancellation_of_id', '=', 'p.id').onRef('c.tenant_id', '=', 'p.tenant_id'))
      .selectAll('p')
      .select([
        'v.code as partner_code',
        'v.name as partner_name',
        'b.code as branch_code',
        'acc.code as account_code',
        'acc.name as account_name',
        'je.document_number as journal_number',
        'c.id as cancelled_by_id',
      ])
      .where('p.tenant_id', '=', tenantId)
      .where('p.id', '=', paymentId)
      .where('p.direction', '=', direction)
      .executeTakeFirst();
    if (!payment) throw notFound();
    const allocations = await trx
      .selectFrom('payment_allocations as a')
      .leftJoin('ap_invoices as i', (join) => join.onRef('i.id', '=', 'a.invoice_id').onRef('i.tenant_id', '=', 'a.tenant_id'))
      .leftJoin('ar_invoices as ari', (join) => join.onRef('ari.id', '=', 'a.ar_invoice_id').onRef('ari.tenant_id', '=', 'a.tenant_id'))
      .leftJoin('opening_balance_lines as ol', (join) => join.onRef('ol.id', '=', 'a.opening_line_id').onRef('ol.tenant_id', '=', 'a.tenant_id'))
      .leftJoin('opening_balances as ob', (join) => join.onRef('ob.id', '=', 'ol.opening_balance_id').onRef('ob.tenant_id', '=', 'ol.tenant_id'))
      .leftJoin('payment_allocations as u', (join) => join.onRef('u.reverses_id', '=', 'a.id').onRef('u.tenant_id', '=', 'a.tenant_id'))
      .select([
        'a.id',
        'a.invoice_id',
        'a.ar_invoice_id',
        'a.opening_line_id',
        documentLabel.as('document_label'),
        documentReference.as('reference'),
        'a.amount',
        'a.event_date',
        'u.id as unallocation_id',
        'u.event_date as unallocation_date',
        'u.reason as unallocation_reason',
      ])
      .where('a.tenant_id', '=', tenantId)
      .where('a.payment_id', '=', paymentId)
      .where('a.event_type', '=', 'allocate')
      .orderBy('a.created_at')
      .orderBy(documentLabel)
      .execute();
    return {
      id: payment.id,
      direction: payment.direction,
      documentNumber: payment.document_number,
      partnerId: payment.partner_id,
      partnerCode: payment.partner_code,
      partnerName: payment.partner_name,
      branchCode: payment.branch_code,
      postingDate: payment.posting_date,
      documentDate: payment.document_date,
      paymentMeans: payment.payment_means,
      accountId: payment.account_id,
      accountCode: payment.account_code,
      accountName: payment.account_name,
      reference: payment.reference,
      remarks: payment.remarks,
      currency: payment.currency,
      amount: payment.amount,
      allocatedAmount: payment.allocated_amount,
      unappliedAmount: unapplied(payment),
      status: payment.status,
      isCancellation: payment.is_cancellation,
      cancellationOfId: payment.cancellation_of_id,
      cancelledById: payment.cancelled_by_id,
      cancellationReason: payment.cancellation_reason,
      journalId: payment.journal_id,
      journalNumber: payment.journal_number,
      postedAt: payment.posted_at.toISOString(),
      allocations: allocations.map((row) => ({
        id: row.id,
        documentType: row.invoice_id ? ('ap_invoice' as const) : row.ar_invoice_id ? ('ar_invoice' as const) : ('opening_balance' as const),
        invoiceId: row.invoice_id ?? row.ar_invoice_id,
        openingLineId: row.opening_line_id,
        invoiceNumber: row.document_label,
        reference: row.reference,
        vendorReference: row.reference,
        amount: row.amount,
        allocationDate: row.event_date,
        active: row.unallocation_id === null,
        unallocationId: row.unallocation_id,
        unallocationDate: row.unallocation_date,
        unallocationReason: row.unallocation_reason,
      })),
    };
  }
}

function unapplied(row: { status: string; is_cancellation: boolean; amount: string; allocated_amount: string }): string {
  return row.status === 'posted' && !row.is_cancellation ? formatMoney(parseMoney(row.amount) - parseMoney(row.allocated_amount)) : '0.0000';
}
