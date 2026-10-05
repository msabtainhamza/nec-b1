import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import {
  adjustmentListQuery,
  cancelStockDocumentRequest,
  createInventoryAdjustmentRequest,
  createInventoryOpeningBalanceRequest,
  inventoryOpeningImportRequest,
  type OpeningImportResult,
  createStockTransferRequest,
  stockDocumentListQuery,
  type AdjustmentPreview,
  type InventoryAdjustment,
  type Page,
  type StockDocumentSummary,
  type StockTransfer,
} from '@nec/contracts';
import type { Response } from 'express';
import { RequirePermission } from '../auth/auth.guard.js';
import { parseInput } from '../common/errors.js';
import { CorrelationId, CurrentPrincipal, tenantPrincipal, type Principal } from '../common/request-context.js';
import { OpeningImportService } from '../finance/opening-import.service.js';
import { StockTransactionsService } from './stock-transactions.service.js';

@Controller('v1/inv')
export class StockTransactionsController {
  constructor(
    private readonly transactions: StockTransactionsService,
    private readonly openingImport: OpeningImportService,
  ) {}

  @RequirePermission('inv.stock.view')
  @Get('transfers')
  listTransfers(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<StockDocumentSummary>> {
    return this.transactions.listTransfers(tenantPrincipal(principal), parseInput(stockDocumentListQuery, query));
  }

  @RequirePermission('inv.stock.view')
  @Get('transfers/:id')
  getTransfer(@CurrentPrincipal() principal: Principal, @Param('id', new ParseUUIDPipe()) id: string): Promise<StockTransfer> {
    return this.transactions.getTransfer(tenantPrincipal(principal), id);
  }

  @RequirePermission('inv.transfer.post')
  @Post('transfers')
  async createTransfer(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StockTransfer> {
    const result = await this.transactions.createTransfer(tenantPrincipal(principal), parseInput(createStockTransferRequest, body), correlationId);
    response.status(result.replayed ? 200 : 201);
    response.setHeader('idempotent-replayed', String(result.replayed));
    return result.transfer;
  }

  @RequirePermission('inv.transfer.cancel')
  @Post('transfers/:id/cancel')
  async cancelTransfer(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StockTransfer> {
    const result = await this.transactions.cancelTransfer(tenantPrincipal(principal), id, parseInput(cancelStockDocumentRequest, body), correlationId);
    response.status(result.replayed ? 200 : 201);
    response.setHeader('idempotent-replayed', String(result.replayed));
    return result.transfer;
  }

  @RequirePermission('inv.stock.view')
  @Get('adjustments')
  listAdjustments(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<StockDocumentSummary>> {
    return this.transactions.listAdjustments(tenantPrincipal(principal), parseInput(adjustmentListQuery, query));
  }

  @RequirePermission('inv.stock.view')
  @Get('adjustments/:id')
  getAdjustment(@CurrentPrincipal() principal: Principal, @Param('id', new ParseUUIDPipe()) id: string): Promise<InventoryAdjustment> {
    return this.transactions.getAdjustment(tenantPrincipal(principal), id);
  }

  @RequirePermission('inv.adjustment.post')
  @Post('adjustments/preview')
  @HttpCode(200)
  previewAdjustment(@CurrentPrincipal() principal: Principal, @Body() body: unknown): Promise<AdjustmentPreview> {
    return this.transactions.previewAdjustment(tenantPrincipal(principal), parseInput(createInventoryAdjustmentRequest, body));
  }

  @RequirePermission('inv.adjustment.post')
  @Post('adjustments')
  async createAdjustment(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<InventoryAdjustment> {
    const result = await this.transactions.createAdjustment(tenantPrincipal(principal), parseInput(createInventoryAdjustmentRequest, body), correlationId);
    response.status(result.replayed ? 200 : 201);
    response.setHeader('idempotent-replayed', String(result.replayed));
    return result.adjustment;
  }

  @RequirePermission('inv.stock.view')
  @Get('opening-balances')
  listOpenings(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<StockDocumentSummary>> {
    return this.transactions.listOpenings(tenantPrincipal(principal), parseInput(stockDocumentListQuery, query));
  }

  @RequirePermission('inv.stock.view')
  @Get('opening-balances/:id')
  getOpening(@CurrentPrincipal() principal: Principal, @Param('id', new ParseUUIDPipe()) id: string): Promise<InventoryAdjustment> {
    return this.transactions.getOpening(tenantPrincipal(principal), id);
  }

  @RequirePermission('inv.opening.post')
  @Post('opening-balances/preview')
  @HttpCode(200)
  previewOpening(@CurrentPrincipal() principal: Principal, @Body() body: unknown): Promise<AdjustmentPreview> {
    return this.transactions.previewOpening(tenantPrincipal(principal), parseInput(createInventoryOpeningBalanceRequest, body));
  }

  @RequirePermission('inv.opening.post')
  @Post('opening-balances')
  async createOpening(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<InventoryAdjustment> {
    const result = await this.transactions.createOpening(tenantPrincipal(principal), parseInput(createInventoryOpeningBalanceRequest, body), correlationId);
    response.status(result.replayed ? 200 : 201);
    response.setHeader('idempotent-replayed', String(result.replayed));
    return result.adjustment;
  }

  @RequirePermission('inv.opening.post')
  @Post('opening-balances/import')
  async importOpening(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OpeningImportResult> {
    const result = await this.openingImport.importInventory(tenantPrincipal(principal), parseInput(inventoryOpeningImportRequest, body), correlationId);
    response.status(result.committed && !result.replayed ? 201 : 200);
    return result;
  }

  @RequirePermission('inv.opening.cancel')
  @Post('opening-balances/:id/cancel')
  async cancelOpening(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<InventoryAdjustment> {
    const result = await this.transactions.cancelOpening(tenantPrincipal(principal), id, parseInput(cancelStockDocumentRequest, body), correlationId);
    response.status(result.replayed ? 200 : 201);
    response.setHeader('idempotent-replayed', String(result.replayed));
    return result.adjustment;
  }

  @RequirePermission('inv.adjustment.cancel')
  @Post('adjustments/:id/cancel')
  async cancelAdjustment(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<InventoryAdjustment> {
    const result = await this.transactions.cancelAdjustment(tenantPrincipal(principal), id, parseInput(cancelStockDocumentRequest, body), correlationId);
    response.status(result.replayed ? 200 : 201);
    response.setHeader('idempotent-replayed', String(result.replayed));
    return result.adjustment;
  }
}
