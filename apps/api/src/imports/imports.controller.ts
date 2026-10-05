import { Body, Controller, Post, Res } from '@nestjs/common';
import { masterImportRequest, type MasterImportResult } from '@nec/contracts';
import type { Response } from 'express';
import { RequirePermission } from '../auth/auth.guard.js';
import { parseInput } from '../common/errors.js';
import { CorrelationId, CurrentPrincipal, tenantPrincipal, type Principal } from '../common/request-context.js';
import { MasterImportService } from './master-import.service.js';

@Controller('v1')
export class ImportsController {
  constructor(private readonly imports: MasterImportService) {}

  @RequirePermission('bp.partner.create')
  @Post('bp/partners/import')
  async partners(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MasterImportResult> {
    const result = await this.imports.importPartners(tenantPrincipal(principal), parseInput(masterImportRequest, body), correlationId);
    response.status(result.committed && !result.replayed ? 201 : 200);
    return result;
  }

  @RequirePermission('inv.item.create')
  @Post('inv/items/import')
  async items(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MasterImportResult> {
    const result = await this.imports.importItems(tenantPrincipal(principal), parseInput(masterImportRequest, body), correlationId);
    response.status(result.committed && !result.replayed ? 201 : 200);
    return result;
  }

  @RequirePermission('inv.price.administer')
  @Post('inv/price-lists/import')
  async prices(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MasterImportResult> {
    const result = await this.imports.importPrices(tenantPrincipal(principal), parseInput(masterImportRequest, body), correlationId);
    response.status(result.committed && !result.replayed ? 201 : 200);
    return result;
  }
}
