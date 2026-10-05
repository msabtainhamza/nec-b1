import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  approvalDecisionRequest,
  approvalListQuery,
  approvalTemplateRequest,
  completeApprovalRequest,
  updateApprovalTemplateRequest,
  type ApprovalRequestSummary,
  type ApprovalTemplate,
  type PurchaseOrder,
  type SalesOrder,
} from '@nec/contracts';
import { RequirePermission } from '../auth/auth.guard.js';
import { parseInput } from '../common/errors.js';
import { CorrelationId, CurrentPrincipal, tenantPrincipal, type Principal } from '../common/request-context.js';
import { ApprovalsService } from './approvals.service.js';

@Controller('v1/tenant')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @RequirePermission('admin.approval.view')
  @Get('approval-templates')
  templates(@CurrentPrincipal() principal: Principal): Promise<ApprovalTemplate[]> {
    return this.approvals.templates(tenantPrincipal(principal));
  }

  @RequirePermission('admin.approval.administer')
  @Post('approval-templates')
  createTemplate(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<ApprovalTemplate> {
    return this.approvals.createTemplate(tenantPrincipal(principal), parseInput(approvalTemplateRequest, body), correlationId);
  }

  @RequirePermission('admin.approval.administer')
  @Put('approval-templates/:id')
  updateTemplate(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<ApprovalTemplate> {
    return this.approvals.updateTemplate(tenantPrincipal(principal), id, parseInput(updateApprovalTemplateRequest, body), correlationId);
  }

  @RequirePermission('admin.approval.view')
  @Get('approvals')
  list(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<ApprovalRequestSummary[]> {
    return this.approvals.list(tenantPrincipal(principal), parseInput(approvalListQuery, query));
  }

  @RequirePermission('admin.approval.view')
  @Get('approvals/:id')
  get(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<ApprovalRequestSummary> {
    return this.approvals.get(tenantPrincipal(principal), id);
  }

  @RequirePermission('admin.approval.view')
  @Post('approvals/:id/decision')
  @HttpCode(200)
  decide(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<ApprovalRequestSummary> {
    return this.approvals.decide(tenantPrincipal(principal), id, parseInput(approvalDecisionRequest, body), correlationId);
  }

  @RequirePermission('admin.approval.view')
  @Post('approvals/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @CorrelationId() correlationId: string): Promise<ApprovalRequestSummary> {
    return this.approvals.cancel(tenantPrincipal(principal), id, correlationId);
  }

  @RequirePermission('admin.approval.view')
  @Post('approvals/:id/complete')
  @HttpCode(200)
  complete(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
  ): Promise<{ request: ApprovalRequestSummary; document: SalesOrder | PurchaseOrder }> {
    return this.approvals.complete(tenantPrincipal(principal), id, parseInput(completeApprovalRequest, body), correlationId);
  }
}
