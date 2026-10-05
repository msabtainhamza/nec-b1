import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  changeSubscriptionRequest,
  operatorLoginRequest,
  provisionTenantRequest,
  supportSessionRequest,
  restoreTenantRequest,
  type SupportSessionResponse,
  type OperatorLoginResponse,
  type ProvisionTenantResponse,
} from '@nec/contracts';
import { PlatformOnly, Public } from '../auth/auth.guard.js';
import { parseInput } from '../common/errors.js';
import { CorrelationId, CurrentPrincipal, operatorPrincipal, type Principal } from '../common/request-context.js';
import { SupportAccessService } from '../tenancy/support-access.service.js';
import { TenantLifecycleService } from '../tenancy/tenant-lifecycle.service.js';
import { PlatformService, type PlatformTenant } from './platform.service.js';

@Controller('v1/platform')
export class PlatformController {
  constructor(
    private readonly platform: PlatformService,
    private readonly support: SupportAccessService,
    private readonly lifecycle: TenantLifecycleService,
  ) {}

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  login(@Body() body: unknown, @Headers('user-agent') userAgent?: string): Promise<OperatorLoginResponse> {
    return this.platform.login(parseInput(operatorLoginRequest, body), userAgent ?? null);
  }

  @PlatformOnly()
  @Get('tenants')
  tenants(): Promise<PlatformTenant[]> {
    return this.platform.listTenants();
  }

  @PlatformOnly()
  @Post('tenants')
  provision(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
  ): Promise<ProvisionTenantResponse & { mailSent: boolean }> {
    return this.platform.provision(operatorPrincipal(principal), parseInput(provisionTenantRequest, body), correlationId);
  }

  @PlatformOnly()
  @Post('tenants/:id/subscription')
  @HttpCode(204)
  async changeSubscription(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
  ): Promise<void> {
    await this.platform.changeSubscription(operatorPrincipal(principal), id, parseInput(changeSubscriptionRequest, body), correlationId);
  }

  @PlatformOnly()
  @Post('tenants/:id/support-session')
  @HttpCode(200)
  supportSession(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
  ): Promise<SupportSessionResponse> {
    return this.support.openSession(operatorPrincipal(principal), id, parseInput(supportSessionRequest, body), correlationId);
  }

  @PlatformOnly()
  @Post('tenants/:id/restore')
  @HttpCode(204)
  async restore(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
  ): Promise<void> {
    await this.lifecycle.restore(operatorPrincipal(principal), id, parseInput(restoreTenantRequest, body), correlationId);
  }
}
