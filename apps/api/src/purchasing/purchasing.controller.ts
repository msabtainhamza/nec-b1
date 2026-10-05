import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import {
  apInvoiceListQuery,
  cancelApInvoiceRequest,
  createApInvoiceRequest,
  updatePurchasingSettingsRequest,
  type ApprovalSubmitted,
  type ApInvoice,
  type ApInvoiceSummary,
  type InvoiceableReceiptLine,
  type PurchasingSettings,
  cancelGoodsReceiptRequest,
  changeOrderStatusRequest,
  createGoodsReceiptRequest,
  createPurchaseOrderRequest,
  goodsReceiptListQuery,
  purchaseOrderListQuery,
  type GoodsReceipt,
  type GoodsReceiptSummary,
  type Page,
  type PurchaseOrder,
  type PurchaseOrderSummary,
} from '@nec/contracts';
import type { Response } from 'express';
import { RequirePermission } from '../auth/auth.guard.js';
import { parseInput } from '../common/errors.js';
import { CorrelationId, CurrentPrincipal, tenantPrincipal, type Principal } from '../common/request-context.js';
import { z } from 'zod';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { ApInvoicesService } from './ap-invoices.service.js';
import { GoodsReceiptsService } from './goods-receipts.service.js';
import { PurchaseOrdersService } from './purchase-orders.service.js';

@Controller('v1/pur')
export class PurchasingController {
  constructor(
    private readonly orders: PurchaseOrdersService,
    private readonly receipts: GoodsReceiptsService,
    private readonly invoices: ApInvoicesService,
    private readonly approvals: ApprovalsService,
  ) {}

  @RequirePermission('pur.invoice.view')
  @Get('settings')
  settings(@CurrentPrincipal() principal: Principal): Promise<PurchasingSettings> {
    return this.invoices.settings(tenantPrincipal(principal));
  }

  @RequirePermission('pur.setup.administer')
  @Put('settings')
  updateSettings(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<PurchasingSettings> {
    return this.invoices.updateSettings(tenantPrincipal(principal), parseInput(updatePurchasingSettingsRequest, body), correlationId);
  }

  @RequirePermission('pur.invoice.view')
  @Get('invoiceable')
  invoiceable(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<InvoiceableReceiptLine[]> {
    const { vendorId } = parseInput(z.object({ vendorId: z.uuid() }), query);
    return this.invoices.invoiceable(tenantPrincipal(principal), vendorId);
  }

  @RequirePermission('pur.invoice.view')
  @Get('invoices')
  listInvoices(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<ApInvoiceSummary>> {
    return this.invoices.list(tenantPrincipal(principal), parseInput(apInvoiceListQuery, query));
  }

  @RequirePermission('pur.invoice.view')
  @Get('invoices/:id')
  getInvoice(@CurrentPrincipal() principal: Principal, @Param('id', new ParseUUIDPipe()) id: string): Promise<ApInvoice> {
    return this.invoices.get(tenantPrincipal(principal), id);
  }

  @RequirePermission('pur.invoice.post')
  @Post('invoices')
  async createInvoice(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApInvoice> {
    const result = await this.invoices.create(tenantPrincipal(principal), parseInput(createApInvoiceRequest, body), correlationId);
    response.status(result.replayed ? 200 : 201);
    response.setHeader('idempotent-replayed', String(result.replayed));
    return result.invoice;
  }

  @RequirePermission('pur.invoice.cancel')
  @Post('invoices/:id/cancel')
  async cancelInvoice(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApInvoice> {
    const result = await this.invoices.cancel(tenantPrincipal(principal), id, parseInput(cancelApInvoiceRequest, body), correlationId);
    response.status(result.replayed ? 200 : 201);
    response.setHeader('idempotent-replayed', String(result.replayed));
    return result.invoice;
  }

  @RequirePermission('pur.order.view')
  @Get('orders')
  listOrders(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<PurchaseOrderSummary>> {
    return this.orders.list(tenantPrincipal(principal), parseInput(purchaseOrderListQuery, query));
  }

  @RequirePermission('pur.order.view')
  @Get('orders/:id')
  getOrder(@CurrentPrincipal() principal: Principal, @Param('id', new ParseUUIDPipe()) id: string): Promise<PurchaseOrder> {
    return this.orders.get(tenantPrincipal(principal), id);
  }

  @RequirePermission('pur.order.create')
  @Post('orders')
  async createOrder(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PurchaseOrder | ApprovalSubmitted> {
    const input = parseInput(createPurchaseOrderRequest, body);
    const submitted = await this.approvals.submitIfRequired(tenantPrincipal(principal), 'purchase_order', input, correlationId);
    if (submitted) {
      response.status(202);
      return { approvalRequired: true, request: submitted };
    }
    const result = await this.orders.create(tenantPrincipal(principal), input, correlationId);
    response.status(result.replayed ? 200 : 201);
    response.setHeader('idempotent-replayed', String(result.replayed));
    return result.order;
  }

  @RequirePermission('pur.order.edit')
  @Patch('orders/:id/status')
  changeOrderStatus(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
  ): Promise<PurchaseOrder> {
    return this.orders.changeStatus(tenantPrincipal(principal), id, parseInput(changeOrderStatusRequest, body), correlationId);
  }

  @RequirePermission('pur.receipt.view')
  @Get('receipts')
  listReceipts(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<GoodsReceiptSummary>> {
    return this.receipts.list(tenantPrincipal(principal), parseInput(goodsReceiptListQuery, query));
  }

  @RequirePermission('pur.receipt.view')
  @Get('receipts/:id')
  getReceipt(@CurrentPrincipal() principal: Principal, @Param('id', new ParseUUIDPipe()) id: string): Promise<GoodsReceipt> {
    return this.receipts.get(tenantPrincipal(principal), id);
  }

  @RequirePermission('pur.receipt.post')
  @Post('receipts')
  async createReceipt(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<GoodsReceipt> {
    const result = await this.receipts.create(tenantPrincipal(principal), parseInput(createGoodsReceiptRequest, body), correlationId);
    response.status(result.replayed ? 200 : 201);
    response.setHeader('idempotent-replayed', String(result.replayed));
    return result.receipt;
  }

  @RequirePermission('pur.receipt.cancel')
  @Post('receipts/:id/cancel')
  async cancelReceipt(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<GoodsReceipt> {
    const result = await this.receipts.cancel(tenantPrincipal(principal), id, parseInput(cancelGoodsReceiptRequest, body), correlationId);
    response.status(result.replayed ? 200 : 201);
    response.setHeader('idempotent-replayed', String(result.replayed));
    return result.receipt;
  }
}
