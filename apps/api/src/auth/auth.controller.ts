import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  mfaDisableRequest,
  mfaEnableRequest,
  mfaLoginRequest,
  type LoginResult,
  type MfaEnableResponse,
  type MfaSetupResponse,
  type MfaStatus,
  changePasswordRequest,
  passwordResetConfirmRequest,
  passwordResetRequest,
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
import { MfaService } from './mfa.service.js';
import { PasswordService } from './password.service.js';

@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tenantAccess: TenantAccessService,
    private readonly passwords: PasswordService,
    private readonly mfa: MfaService,
  ) {}

  @Public()
  @Post('login/mfa')
  @HttpCode(200)
  completeMfaLogin(@Body() body: unknown, @CorrelationId() correlationId: string): Promise<LoginResponse> {
    return this.auth.completeMfaLogin(parseInput(mfaLoginRequest, body), correlationId);
  }

  @Get('mfa')
  mfaStatus(@CurrentPrincipal() principal: Principal): Promise<MfaStatus> {
    return this.mfa.status(userPrincipal(principal));
  }

  @Post('mfa/setup')
  @HttpCode(200)
  setupMfa(@CurrentPrincipal() principal: Principal): Promise<MfaSetupResponse> {
    return this.mfa.setup(userPrincipal(principal));
  }

  @Post('mfa/enable')
  @HttpCode(200)
  enableMfa(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<MfaEnableResponse> {
    return this.mfa.enable(userPrincipal(principal), parseInput(mfaEnableRequest, body).code, correlationId);
  }

  @Post('mfa/disable')
  @HttpCode(204)
  async disableMfa(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<void> {
    await this.mfa.disable(userPrincipal(principal), parseInput(mfaDisableRequest, body), correlationId);
  }

  @Public()
  @Post('password-reset/request')
  @HttpCode(202)
  async requestPasswordReset(@Body() body: unknown, @CorrelationId() correlationId: string): Promise<void> {
    await this.passwords.requestReset(parseInput(passwordResetRequest, body).email, correlationId);
  }

  @Public()
  @Post('password-reset/confirm')
  @HttpCode(204)
  async confirmPasswordReset(@Body() body: unknown, @CorrelationId() correlationId: string): Promise<void> {
    await this.passwords.confirmReset(parseInput(passwordResetConfirmRequest, body), correlationId);
  }

  @Post('password')
  @HttpCode(204)
  async changePassword(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<void> {
    await this.passwords.change(userPrincipal(principal), parseInput(changePasswordRequest, body), correlationId);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown, @Headers('user-agent') userAgent?: string): Promise<LoginResult> {
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
