import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import {
  acceptInvitationRequest,
  changeStatusRequest,
  createInvitationRequest,
  paginationQuery,
  updateCompanyProfileRequest,
  createRoleRequest,
  updateRoleRequest,
  changeMemberRolesRequest,
  grantSupportAccessRequest,
  deletionRequest,
  type SupportGrant,
  type Dashboard,
  updateSecuritySettingsRequest,
  type AcceptInvitationResponse,
  type AuditEvent,
  type CompanyProfile,
  type SecuritySettings,
  type CreateInvitationResponse,
  type Member,
  type Page,
  type Role,
  type TenantContextResponse,
} from '@nec/contracts';
import { Public, RequirePermission, TenantScoped } from '../auth/auth.guard.js';
import { parseInput } from '../common/errors.js';
import { CorrelationId, CurrentPrincipal, tenantPrincipal, type Principal } from '../common/request-context.js';
import { MfaService } from '../auth/mfa.service.js';
import { CompanyProfileService } from './company-profile.service.js';
import { RolesService } from './roles.service.js';
import { SupportAccessService } from './support-access.service.js';
import { TenantLifecycleService } from './tenant-lifecycle.service.js';
import { DashboardService } from './dashboard.service.js';
import { InvitationsService, type InvitationSummary } from './invitations.service.js';
import { MembersService } from './members.service.js';

@Controller('v1/tenant')
export class TenantController {
  constructor(
    private readonly members: MembersService,
    private readonly invitations: InvitationsService,
    private readonly companyProfile: CompanyProfileService,
    private readonly mfa: MfaService,
    private readonly roleAdmin: RolesService,
    private readonly support: SupportAccessService,
    private readonly lifecycle: TenantLifecycleService,
    private readonly dashboards: DashboardService,
  ) {}

  @TenantScoped()
  @Get('dashboard')
  dashboard(@CurrentPrincipal() principal: Principal): Promise<Dashboard> {
    return this.dashboards.dashboard(tenantPrincipal(principal));
  }

  @RequirePermission('admin.tenant.export')
  @Get('export')
  exportCompany(@CurrentPrincipal() principal: Principal, @CorrelationId() correlationId: string): Promise<Record<string, unknown>> {
    return this.lifecycle.export(tenantPrincipal(principal), correlationId);
  }

  @RequirePermission('admin.tenant.export')
  @Post('deletion-request')
  @HttpCode(204)
  async requestDeletion(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<void> {
    await this.lifecycle.requestDeletion(tenantPrincipal(principal), parseInput(deletionRequest, body), correlationId);
  }

  @RequirePermission('admin.user.view')
  @Get('support-access')
  listSupportAccess(@CurrentPrincipal() principal: Principal): Promise<SupportGrant[]> {
    return this.support.list(tenantPrincipal(principal));
  }

  @RequirePermission('admin.user.administer')
  @Post('support-access')
  grantSupportAccess(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<SupportGrant> {
    return this.support.grant(tenantPrincipal(principal), parseInput(grantSupportAccessRequest, body), correlationId);
  }

  @RequirePermission('admin.user.administer')
  @Delete('support-access/:id')
  @HttpCode(204)
  async revokeSupportAccess(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @CorrelationId() correlationId: string): Promise<void> {
    await this.support.revoke(tenantPrincipal(principal), id, correlationId);
  }

  @RequirePermission('admin.role.administer')
  @Post('roles')
  createRole(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<Role> {
    return this.roleAdmin.create(tenantPrincipal(principal), parseInput(createRoleRequest, body), correlationId);
  }

  @RequirePermission('admin.role.administer')
  @Put('roles/:id')
  updateRole(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<Role> {
    return this.roleAdmin.update(tenantPrincipal(principal), id, parseInput(updateRoleRequest, body), correlationId);
  }

  @RequirePermission('admin.role.administer')
  @Delete('roles/:id')
  @HttpCode(204)
  async deleteRole(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @CorrelationId() correlationId: string): Promise<void> {
    await this.roleAdmin.remove(tenantPrincipal(principal), id, correlationId);
  }

  @RequirePermission('admin.user.administer')
  @Put('members/:id/roles')
  @HttpCode(204)
  async changeMemberRoles(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<void> {
    await this.roleAdmin.changeMemberRoles(tenantPrincipal(principal), id, parseInput(changeMemberRolesRequest, body), correlationId);
  }

  @RequirePermission('admin.company.view')
  @Get('security-settings')
  getSecuritySettings(@CurrentPrincipal() principal: Principal): Promise<SecuritySettings> {
    return this.mfa.settings(tenantPrincipal(principal));
  }

  @RequirePermission('admin.user.administer')
  @Put('security-settings')
  updateSecuritySettings(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<SecuritySettings> {
    return this.mfa.updateSettings(tenantPrincipal(principal), parseInput(updateSecuritySettingsRequest, body), correlationId);
  }

  @RequirePermission('admin.company.view')
  @Get('company-profile')
  getCompanyProfile(@CurrentPrincipal() principal: Principal): Promise<CompanyProfile> {
    return this.companyProfile.get(tenantPrincipal(principal));
  }

  @RequirePermission('admin.company.edit')
  @Put('company-profile')
  updateCompanyProfile(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<CompanyProfile> {
    return this.companyProfile.update(tenantPrincipal(principal), parseInput(updateCompanyProfileRequest, body), correlationId);
  }

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
