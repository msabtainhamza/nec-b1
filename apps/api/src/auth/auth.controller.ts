import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  loginRequest,
  refreshRequest,
  selectTenantRequest,
  type LoginResponse,
  type SelectTenantResponse,
  type SessionInfo,
  type TenantSummary,
  type TokenPair,
} from '@nec/contracts';
import { parseInput } from '../common/errors.js';
import { CorrelationId, CurrentPrincipal, userPrincipal, type Principal } from '../common/request-context.js';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';
import { Public } from './auth.guard.js';
import { AuthService } from './auth.service.js';

@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tenantAccess: TenantAccessService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown, @Headers('user-agent') userAgent?: string): Promise<LoginResponse> {
    return this.auth.login(parseInput(loginRequest, body), userAgent ?? null);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: unknown): Promise<TokenPair> {
    return this.auth.refresh(parseInput(refreshRequest, body).refreshToken);
  }

  @Get('tenants')
  tenants(@CurrentPrincipal() principal: Principal): Promise<TenantSummary[]> {
    return this.tenantAccess.listForUser(userPrincipal(principal).userId);
  }

  @Post('select-tenant')
  @HttpCode(200)
  selectTenant(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
  ): Promise<SelectTenantResponse> {
    return this.auth.selectTenant(userPrincipal(principal), parseInput(selectTenantRequest, body).tenantId, correlationId);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentPrincipal() principal: Principal): Promise<void> {
    await this.auth.logout(userPrincipal(principal).sessionId);
  }

  @Get('sessions')
  sessions(@CurrentPrincipal() principal: Principal): Promise<SessionInfo[]> {
    return this.auth.listSessions(userPrincipal(principal));
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.auth.revokeSession(userPrincipal(principal), id);
  }
}
