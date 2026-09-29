import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  createGroupRequest,
  createPartnerRequest,
  createPaymentTermsRequest,
  partnerListQuery,
  updatePartnerRequest,
  type BusinessPartner,
  type Page,
  type PartnerBalance,
  type PartnerGroup,
  type PartnerSummary,
  type PaymentTerms,
} from '@nec/contracts';
import { RequirePermission } from '../auth/auth.guard.js';
import { parseInput } from '../common/errors.js';
import { CorrelationId, CurrentPrincipal, tenantPrincipal, type Principal } from '../common/request-context.js';
import { BusinessPartnersService } from './business-partners.service.js';

@Controller('v1/bp')
export class BusinessPartnersController {
  constructor(private readonly partners: BusinessPartnersService) {}

  @RequirePermission('bp.partner.view')
  @Get('partners')
  list(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<PartnerSummary>> {
    return this.partners.list(tenantPrincipal(principal), parseInput(partnerListQuery, query));
  }

  @RequirePermission('bp.partner.view')
  @Get('partners/:id')
  get(@CurrentPrincipal() principal: Principal, @Param('id', new ParseUUIDPipe()) id: string): Promise<BusinessPartner> {
    return this.partners.get(tenantPrincipal(principal), id);
  }

  @RequirePermission('bp.partner.view')
  @Get('partners/:id/balance')
  balance(@CurrentPrincipal() principal: Principal, @Param('id', new ParseUUIDPipe()) id: string): Promise<PartnerBalance> {
    return this.partners.balance(tenantPrincipal(principal), id);
  }

  @RequirePermission('bp.partner.create')
  @Post('partners')
  create(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<BusinessPartner> {
    return this.partners.create(tenantPrincipal(principal), parseInput(createPartnerRequest, body), correlationId);
  }

  @RequirePermission('bp.partner.edit')
  @Put('partners/:id')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
  ): Promise<BusinessPartner> {
    return this.partners.update(tenantPrincipal(principal), id, parseInput(updatePartnerRequest, body), correlationId);
  }

  @RequirePermission('bp.partner.view')
  @Get('groups')
  groups(@CurrentPrincipal() principal: Principal): Promise<PartnerGroup[]> {
    return this.partners.groups(tenantPrincipal(principal));
  }

  @RequirePermission('bp.setup.administer')
  @Post('groups')
  createGroup(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<PartnerGroup> {
    return this.partners.createGroup(tenantPrincipal(principal), parseInput(createGroupRequest, body), correlationId);
  }

  @RequirePermission('bp.partner.view')
  @Get('payment-terms')
  paymentTerms(@CurrentPrincipal() principal: Principal): Promise<PaymentTerms[]> {
    return this.partners.paymentTerms(tenantPrincipal(principal));
  }

  @RequirePermission('bp.setup.administer')
  @Post('payment-terms')
  createPaymentTerms(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<PaymentTerms> {
    return this.partners.createPaymentTerms(tenantPrincipal(principal), parseInput(createPaymentTermsRequest, body), correlationId);
  }
}
