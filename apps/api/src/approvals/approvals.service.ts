import { Injectable } from '@nestjs/common';
import type {
  ApprovalDecisionRequest,
  ApprovalDocumentType,
  ApprovalListQuery,
  ApprovalRequestSummary,
  ApprovalTemplate,
  ApprovalTemplateRequest,
  CompleteApprovalRequest,
  CreatePurchaseOrderRequest,
  CreateSalesOrderRequest,
  PurchaseOrder,
  SalesOrder,
  UpdateApprovalTemplateRequest,
} from '@nec/contracts';
import { AuditService } from '../audit/audit.service.js';
import { AppError, conflict, forbidden, notFound, versionConflict } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { DatabaseService, type Trx } from '../database/database.service.js';
import { claimIdempotencyKey, completeIdempotencyKey } from '../finance/idempotency.js';
import { formatMoney, parseMoney, sumMoney } from '../finance/money.js';
import { PurchaseOrdersService } from '../purchasing/purchase-orders.service.js';
import { SalesOrdersService } from '../sales/sales-orders.service.js';

type Payload = CreateSalesOrderRequest | CreatePurchaseOrderRequest;

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sales: SalesOrdersService,
    private readonly purchases: PurchaseOrdersService,
    private readonly audit: AuditService,
  ) {}

  private run<T>(principal: TenantPrincipal, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.database.withContext({ tenantId: principal.tenantId, userId: principal.userId }, fn);
  }

  async templates(principal: TenantPrincipal): Promise<ApprovalTemplate[]> {
    return this.run(principal, async (trx) => {
      const rows = await trx
        .selectFrom('approval_templates as t')
        .innerJoin('roles as r', (join) => join.onRef('r.id', '=', 't.approver_role_id').onRef('r.tenant_id', '=', 't.tenant_id'))
        .select(['t.id', 't.name', 't.document_type', 't.min_total', 't.approver_role_id', 'r.name as role_name', 't.required_approvals', 't.active', 't.version'])
        .where('t.tenant_id', '=', principal.tenantId)
        .orderBy('t.document_type')
        .orderBy('t.min_total')
        .execute();
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        documentType: row.document_type,
        minTotal: row.min_total,
        approverRoleId: row.approver_role_id,
        approverRoleName: row.role_name,
        requiredApprovals: row.required_approvals,
        active: row.active,
        version: row.version,
      }));
    });
  }

  private async assertRole(trx: Trx, tenantId: string, roleId: string): Promise<void> {
    const role = await trx.selectFrom('roles').select('id').where('tenant_id', '=', tenantId).where('id', '=', roleId).executeTakeFirst();
    if (!role) throw new AppError(400, 'VALIDATION_FAILED', 'Choose an existing approver role', [{ path: 'approverRoleId', message: 'Unknown role' }]);
  }

  async createTemplate(principal: TenantPrincipal, input: ApprovalTemplateRequest, correlationId: string): Promise<ApprovalTemplate> {
    const id = await this.run(principal, async (trx) => {
      await this.assertRole(trx, principal.tenantId, input.approverRoleId);
      const row = await trx
        .insertInto('approval_templates')
        .values({
          tenant_id: principal.tenantId,
          name: input.name,
          document_type: input.documentType,
          min_total: formatMoney(parseMoney(input.minTotal)),
          approver_role_id: input.approverRoleId,
          required_approvals: input.requiredApprovals,
          active: input.active,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, { tenantId: principal.tenantId, actor: { type: 'user', id: principal.userId }, action: 'approval_template.created', entityType: 'approval_template', entityId: row.id, after: { ...input }, correlationId });
      return row.id;
    });
    return (await this.templates(principal)).find((template) => template.id === id) as ApprovalTemplate;
  }

  async updateTemplate(principal: TenantPrincipal, id: string, input: UpdateApprovalTemplateRequest, correlationId: string): Promise<ApprovalTemplate> {
    await this.run(principal, async (trx) => {
      const current = await trx.selectFrom('approval_templates').selectAll().where('tenant_id', '=', principal.tenantId).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!current) throw notFound();
      if (current.version !== input.version) throw versionConflict();
      await this.assertRole(trx, principal.tenantId, input.approverRoleId);
      await trx
        .updateTable('approval_templates')
        .set({
          name: input.name,
          document_type: input.documentType,
          min_total: formatMoney(parseMoney(input.minTotal)),
          approver_role_id: input.approverRoleId,
          required_approvals: input.requiredApprovals,
          active: input.active,
          version: current.version + 1,
          updated_at: new Date(),
        })
        .where('tenant_id', '=', principal.tenantId)
        .where('id', '=', id)
        .execute();
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'approval_template.updated',
        entityType: 'approval_template',
        entityId: id,
        before: { name: current.name, minTotal: current.min_total, requiredApprovals: current.required_approvals, active: current.active },
        after: { ...input },
        correlationId,
      });
    });
    return (await this.templates(principal)).find((template) => template.id === id) as ApprovalTemplate;
  }

  private async evaluate(trx: Trx, tenantId: string, documentType: ApprovalDocumentType, payload: Payload) {
    const rest: Record<string, unknown> = { ...payload };
    delete rest.idempotencyKey;
    const prepared =
      documentType === 'sales_order'
        ? await this.sales.prepare(trx, tenantId, rest as Omit<CreateSalesOrderRequest, 'idempotencyKey'>)
        : await this.purchases.prepare(trx, tenantId, rest as Omit<CreatePurchaseOrderRequest, 'idempotencyKey'>);
    const total = sumMoney(prepared.lines.map((line) => line.lineTotal));
    const partnerId = 'customer' in prepared ? prepared.customer.id : prepared.vendor.id;
    const template = await trx
      .selectFrom('approval_templates')
      .select(['id', 'required_approvals'])
      .where('tenant_id', '=', tenantId)
      .where('document_type', '=', documentType)
      .where('active', '=', true)
      .where('min_total', '<=', formatMoney(total))
      .orderBy('min_total', 'desc')
      .executeTakeFirst();
    return { template: template ?? null, total, partnerId };
  }

  async submitIfRequired(principal: TenantPrincipal, documentType: ApprovalDocumentType, payload: Payload, correlationId: string): Promise<ApprovalRequestSummary | null> {
    const id = await this.run(principal, async (trx) => {
      const { template, total, partnerId } = await this.evaluate(trx, principal.tenantId, documentType, payload);
      if (!template) return null;
      const existing = await claimIdempotencyKey(trx, principal.tenantId, payload.idempotencyKey, `approval.submit.${documentType}`, payload);
      if (existing) return existing;
      const row = await trx
        .insertInto('approval_requests')
        .values({
          tenant_id: principal.tenantId,
          template_id: template.id,
          document_type: documentType,
          originator_id: principal.userId,
          partner_id: partnerId,
          total: formatMoney(total),
          payload: JSON.stringify(payload),
          remarks: payload.remarks ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await completeIdempotencyKey(trx, principal.tenantId, payload.idempotencyKey, row.id);
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'approval_request.submitted',
        entityType: 'approval_request',
        entityId: row.id,
        after: { documentType, templateId: template.id, total: formatMoney(total) },
        correlationId,
      });
      return row.id;
    });
    return id ? this.get(principal, id) : null;
  }

  private async approverRoles(trx: Trx, principal: TenantPrincipal): Promise<Set<string>> {
    const rows = await trx.selectFrom('membership_roles').select('role_id').where('tenant_id', '=', principal.tenantId).where('membership_id', '=', principal.membershipId).execute();
    return new Set(rows.map((row) => row.role_id));
  }

  private async summaries(trx: Trx, principal: TenantPrincipal, ids: string[] | null, query?: ApprovalListQuery): Promise<ApprovalRequestSummary[]> {
    let base = trx
      .selectFrom('approval_requests as a')
      .innerJoin('approval_templates as t', (join) => join.onRef('t.id', '=', 'a.template_id').onRef('t.tenant_id', '=', 'a.tenant_id'))
      .innerJoin('users as u', 'u.id', 'a.originator_id')
      .innerJoin('business_partners as p', (join) => join.onRef('p.id', '=', 'a.partner_id').onRef('p.tenant_id', '=', 'a.tenant_id'))
      .leftJoin('sales_orders as so', (join) => join.onRef('so.id', '=', 'a.document_id').onRef('so.tenant_id', '=', 'a.tenant_id'))
      .leftJoin('purchase_orders as po', (join) => join.onRef('po.id', '=', 'a.document_id').onRef('po.tenant_id', '=', 'a.tenant_id'))
      .select([
        'a.id',
        'a.document_type',
        't.name as template_name',
        't.required_approvals',
        't.approver_role_id',
        'a.originator_id',
        'u.display_name as originator_name',
        'p.code as partner_code',
        'p.name as partner_name',
        'a.total',
        'a.status',
        'a.document_id',
        'so.document_number as so_number',
        'po.document_number as po_number',
        'a.created_at',
        'a.version',
      ])
      .where('a.tenant_id', '=', principal.tenantId);
    if (ids) base = base.where('a.id', 'in', ids);
    if (query?.status) base = base.where('a.status', '=', query.status);
    if (query?.scope === 'mine') base = base.where('a.originator_id', '=', principal.userId);
    const rows = await base.orderBy('a.created_at', 'desc').limit(200).execute();
    if (rows.length === 0) return [];
    const decisions = await trx
      .selectFrom('approval_decisions as d')
      .innerJoin('users as u', 'u.id', 'd.approver_id')
      .select(['d.request_id', 'd.approver_id', 'u.display_name', 'd.decision', 'd.remarks', 'd.decided_at'])
      .where('d.tenant_id', '=', principal.tenantId)
      .where('d.request_id', 'in', rows.map((row) => row.id))
      .orderBy('d.decided_at')
      .execute();
    const roles = await this.approverRoles(trx, principal);
    const result = rows.map((row) => {
      const own = decisions.filter((decision) => decision.request_id === row.id);
      const canDecide = row.status === 'pending' && row.originator_id !== principal.userId && roles.has(row.approver_role_id) && !own.some((decision) => decision.approver_id === principal.userId);
      return {
        id: row.id,
        documentType: row.document_type,
        templateName: row.template_name,
        originatorId: row.originator_id,
        originatorName: row.originator_name,
        partnerCode: row.partner_code,
        partnerName: row.partner_name,
        total: row.total,
        status: row.status,
        approvals: own.filter((decision) => decision.decision === 'approved').length,
        requiredApprovals: row.required_approvals,
        canDecide,
        documentId: row.document_id,
        documentNumber: row.so_number ?? row.po_number ?? null,
        createdAt: row.created_at.toISOString(),
        version: row.version,
        decisions: own.map((decision) => ({ approverName: decision.display_name, decision: decision.decision, remarks: decision.remarks, decidedAt: decision.decided_at.toISOString() })),
      };
    });
    return query?.scope === 'to_decide' ? result.filter((row) => row.canDecide) : result;
  }

  async list(principal: TenantPrincipal, query: ApprovalListQuery): Promise<ApprovalRequestSummary[]> {
    return this.run(principal, (trx) => this.summaries(trx, principal, null, query));
  }

  async get(principal: TenantPrincipal, id: string): Promise<ApprovalRequestSummary> {
    const [summary] = await this.run(principal, (trx) => this.summaries(trx, principal, [id]));
    if (!summary) throw notFound();
    return summary;
  }

  async decide(principal: TenantPrincipal, id: string, input: ApprovalDecisionRequest, correlationId: string): Promise<ApprovalRequestSummary> {
    await this.run(principal, async (trx) => {
      const request = await trx.selectFrom('approval_requests').selectAll().where('tenant_id', '=', principal.tenantId).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!request) throw notFound();
      if (request.version !== input.version) throw versionConflict();
      if (request.status !== 'pending') throw conflict(`This approval request is already ${request.status}`);
      if (request.originator_id === principal.userId) throw forbidden('You cannot approve or reject your own document');
      const template = await trx.selectFrom('approval_templates').select(['approver_role_id', 'required_approvals']).where('tenant_id', '=', principal.tenantId).where('id', '=', request.template_id).executeTakeFirstOrThrow();
      if (!(await this.approverRoles(trx, principal)).has(template.approver_role_id)) throw forbidden('You are not an approver for this approval template');
      const already = await trx.selectFrom('approval_decisions').select('id').where('tenant_id', '=', principal.tenantId).where('request_id', '=', id).where('approver_id', '=', principal.userId).executeTakeFirst();
      if (already) throw conflict('You have already decided on this request');
      await trx.insertInto('approval_decisions').values({ tenant_id: principal.tenantId, request_id: id, approver_id: principal.userId, decision: input.decision, remarks: input.remarks ?? null }).execute();
      const approvals = await trx
        .selectFrom('approval_decisions')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('tenant_id', '=', principal.tenantId)
        .where('request_id', '=', id)
        .where('decision', '=', 'approved')
        .executeTakeFirstOrThrow();
      const status = input.decision === 'rejected' ? 'rejected' : Number(approvals.count) >= template.required_approvals ? 'approved' : 'pending';
      await trx.updateTable('approval_requests').set({ status, version: request.version + 1, updated_at: new Date() }).where('tenant_id', '=', principal.tenantId).where('id', '=', id).execute();
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: `approval_request.${input.decision}`,
        entityType: 'approval_request',
        entityId: id,
        after: { status, remarks: input.remarks ?? null },
        correlationId,
      });
    });
    return this.get(principal, id);
  }

  async cancel(principal: TenantPrincipal, id: string, correlationId: string): Promise<ApprovalRequestSummary> {
    await this.run(principal, async (trx) => {
      const request = await trx.selectFrom('approval_requests').selectAll().where('tenant_id', '=', principal.tenantId).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!request) throw notFound();
      if (request.originator_id !== principal.userId) throw forbidden('Only the originator can cancel an approval request');
      if (request.status !== 'pending' && request.status !== 'approved') throw conflict(`This approval request is already ${request.status}`);
      await trx.updateTable('approval_requests').set({ status: 'cancelled', version: request.version + 1, updated_at: new Date() }).where('tenant_id', '=', principal.tenantId).where('id', '=', id).execute();
      await this.audit.record(trx, { tenantId: principal.tenantId, actor: { type: 'user', id: principal.userId }, action: 'approval_request.cancelled', entityType: 'approval_request', entityId: id, correlationId });
    });
    return this.get(principal, id);
  }

  async complete(principal: TenantPrincipal, id: string, input: CompleteApprovalRequest, correlationId: string): Promise<{ request: ApprovalRequestSummary; document: SalesOrder | PurchaseOrder }> {
    const request = await this.run(principal, (trx) => trx.selectFrom('approval_requests').selectAll().where('tenant_id', '=', principal.tenantId).where('id', '=', id).executeTakeFirst());
    if (!request) throw notFound();
    if (request.originator_id !== principal.userId) throw forbidden('Only the originator can add the approved document');
    if (request.status !== 'approved' && request.status !== 'completed') throw conflict(`This approval request is ${request.status}; only approved requests can be added`);
    const payload = { ...(request.payload as Payload), idempotencyKey: `approval-${id}` };
    const document =
      request.document_type === 'sales_order'
        ? (await this.sales.create(principal, { ...(payload as CreateSalesOrderRequest), creditAcknowledged: input.creditAcknowledged, creditOverrideReason: input.creditOverrideReason }, correlationId)).order
        : (await this.purchases.create(principal, payload as CreatePurchaseOrderRequest, correlationId)).order;
    await this.run(principal, async (trx) => {
      const current = await trx.selectFrom('approval_requests').select(['status', 'version']).where('tenant_id', '=', principal.tenantId).where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
      if (current.status === 'completed') return;
      await trx.updateTable('approval_requests').set({ status: 'completed', document_id: document.id, version: current.version + 1, updated_at: new Date() }).where('tenant_id', '=', principal.tenantId).where('id', '=', id).execute();
      await this.audit.record(trx, {
        tenantId: principal.tenantId,
        actor: { type: 'user', id: principal.userId },
        action: 'approval_request.completed',
        entityType: 'approval_request',
        entityId: id,
        after: { documentId: document.id, documentNumber: document.documentNumber },
        correlationId,
      });
    });
    return { request: await this.get(principal, id), document };
  }
}
