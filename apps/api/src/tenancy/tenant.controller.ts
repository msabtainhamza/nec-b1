import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  acceptInvitationRequest,
  changeStatusRequest,
  createInvitationRequest,
  paginationQuery,
  type AcceptInvitationResponse,
  type AuditEvent,
  type CreateInvitationResponse,
  type Member,
  type Page,
  type Role,
  type TenantContextResponse,
} from '@nec/contracts';
import { Public, RequirePermission, TenantScoped } from '../auth/auth.guard.js';
import { parseInput } from '../common/errors.js';
import { CorrelationId, CurrentPrincipal, tenantPrincipal, type Principal } from '../common/request-context.js';
import { InvitationsService, type InvitationSummary } from './invitations.service.js';
import { MembersService } from './members.service.js';

@Controller('v1/tenant')
export class TenantController {
  constructor(
    private readonly members: MembersService,
    private readonly invitations: InvitationsService,
  ) {}

  @TenantScoped()
  @Get('context')
  context(@CurrentPrincipal() principal: Principal): Promise<TenantContextResponse> {
    return this.members.context(tenantPrincipal(principal));
  }

  @RequirePermission('admin.user.view')
  @Get('members')
  listMembers(@CurrentPrincipal() principal: Principal): Promise<Member[]> {
    return this.members.list(tenantPrincipal(principal));
  }

  @RequirePermission('admin.user.administer')
  @Patch('members/:id/status')
  @HttpCode(204)
  async changeMemberStatus(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
  ): Promise<void> {
    await this.members.changeStatus(tenantPrincipal(principal), id, parseInput(changeStatusRequest, body), correlationId);
  }

  @RequirePermission('admin.role.view')
  @Get('roles')
  roles(@CurrentPrincipal() principal: Principal): Promise<Role[]> {
    return this.members.roles(tenantPrincipal(principal));
  }

  @RequirePermission('admin.user.view')
  @Get('invitations')
  listInvitations(@CurrentPrincipal() principal: Principal): Promise<InvitationSummary[]> {
    return this.invitations.listPending(tenantPrincipal(principal));
  }

  @RequirePermission('admin.user.invite')
  @Post('invitations')
  createInvitation(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
  ): Promise<CreateInvitationResponse> {
    return this.invitations.create(tenantPrincipal(principal), parseInput(createInvitationRequest, body), correlationId);
  }

  @RequirePermission('admin.user.invite')
  @Delete('invitations/:id')
  @HttpCode(204)
  async revokeInvitation(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @CorrelationId() correlationId: string,
  ): Promise<void> {
    await this.invitations.revoke(tenantPrincipal(principal), id, correlationId);
  }

  @RequirePermission('admin.audit.view')
  @Get('audit-events')
  auditEvents(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<AuditEvent>> {
    return this.members.auditEvents(tenantPrincipal(principal), parseInput(paginationQuery, query));
  }
}

@Controller('v1/invitations')
export class InvitationAcceptController {
  constructor(private readonly invitations: InvitationsService) {}

  @Public()
  @Post('accept')
  @HttpCode(200)
  accept(@Body() body: unknown, @CorrelationId() correlationId: string): Promise<AcceptInvitationResponse> {
    return this.invitations.accept(parseInput(acceptInvitationRequest, body), correlationId);
  }
}
