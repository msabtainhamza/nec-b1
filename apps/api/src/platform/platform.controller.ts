import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  changeSubscriptionRequest,
  operatorLoginRequest,
  provisionTenantRequest,
  type OperatorLoginResponse,
  type ProvisionTenantResponse,
} from '@nec/contracts';
import { PlatformOnly, Public } from '../auth/auth.guard.js';
import { parseInput } from '../common/errors.js';
import { CorrelationId, CurrentPrincipal, operatorPrincipal, type Principal } from '../common/request-context.js';
import { PlatformService, type PlatformTenant } from './platform.service.js';

@Controller('v1/platform')
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

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
}
