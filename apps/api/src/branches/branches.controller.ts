import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { changeStatusRequest, createBranchRequest, type Branch } from '@nec/contracts';
import { RequirePermission } from '../auth/auth.guard.js';
import { parseInput } from '../common/errors.js';
import { CorrelationId, CurrentPrincipal, tenantPrincipal, type Principal } from '../common/request-context.js';
import { BranchesService } from './branches.service.js';

@Controller('v1/tenant/branches')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @RequirePermission('admin.branch.view')
  @Get()
  list(@CurrentPrincipal() principal: Principal): Promise<Branch[]> {
    return this.branches.list(tenantPrincipal(principal));
  }

  @RequirePermission('admin.branch.view')
  @Get(':id')
  get(@CurrentPrincipal() principal: Principal, @Param('id', new ParseUUIDPipe()) id: string): Promise<Branch> {
    return this.branches.get(tenantPrincipal(principal), id);
  }

  @RequirePermission('admin.branch.create')
  @Post()
  create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
  ): Promise<Branch> {
    return this.branches.create(tenantPrincipal(principal), parseInput(createBranchRequest, body), correlationId);
  }

  @RequirePermission('admin.branch.edit')
  @Patch(':id/status')
  changeStatus(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
  ): Promise<Branch> {
    return this.branches.changeStatus(tenantPrincipal(principal), id, parseInput(changeStatusRequest, body), correlationId);
  }
}
