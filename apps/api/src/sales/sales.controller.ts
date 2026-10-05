import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import {
  creditSettingsRequest,
  createQuotationRequest, updateQuotationRequest, quotationStatusRequest, convertQuotationRequest, quotationListQuery,
  arInvoiceListQuery,
  cancelSalesDocumentRequest,
  changeSalesOrderStatusRequest,
  createArInvoiceRequest,
  createDeliveryRequest,
  createSalesOrderRequest,
  deliveryListQuery,
  salesOrderListQuery,
  salesPriceQuery,
  updateSalesSettingsRequest,
  type ApprovalSubmitted,
  type ArInvoice,
  type ArInvoiceDocument,
  type ArInvoiceSummary,
  type Delivery,
  type DeliverySummary,
  type InvoiceableSalesLine,
  type Page,
  type SalesOrder,
  type SalesOrderSummary,
  type SalesSettings,
  type SalesPrices,
} from '@nec/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/auth.guard.js';
import { parseInput } from '../common/errors.js';
import { CorrelationId, CurrentPrincipal, tenantPrincipal, type Principal } from '../common/request-context.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { ArInvoicesService } from './ar-invoices.service.js';
import { DeliveriesService } from './deliveries.service.js';
import { CreditService } from './credit.service.js';
import { QuotationsService } from './quotations.service.js';
import { SalesOrdersService } from './sales-orders.service.js';

function created<T>(response: Response, result: { replayed: boolean }, value: T): T {
  response.status(result.replayed ? 200 : 201);
  response.setHeader('idempotent-replayed', String(result.replayed));
  return value;
}

@Controller('v1/sal')
export class SalesController {
  constructor(
    private readonly credit: CreditService,
    private readonly quotations: QuotationsService,
    private readonly orders: SalesOrdersService,
    private readonly deliveries: DeliveriesService,
    private readonly invoices: ArInvoicesService,
    private readonly approvals: ApprovalsService,
  ) {}

  @RequirePermission('sal.credit.view')
  @Get('credit-settings')
  getCreditSettings(@CurrentPrincipal() principal: Principal) {
    return this.credit.get(tenantPrincipal(principal));
  }

  @RequirePermission('sal.credit.administer')
  @Put('credit-settings')
  updateCreditSettings(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string) {
    return this.credit.update(tenantPrincipal(principal), parseInput(creditSettingsRequest, body), correlationId);
  }

  @RequirePermission('sal.invoice.view')
  @Get('settings')
  getSettings(@CurrentPrincipal() principal: Principal): Promise<SalesSettings> {
    return this.invoices.settings(tenantPrincipal(principal));
  }

  @RequirePermission('sal.setup.administer')
  @Put('settings')
  updateSettings(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<SalesSettings> {
    return this.invoices.updateSettings(tenantPrincipal(principal), parseInput(updateSalesSettingsRequest, body), correlationId);
  }

  @RequirePermission('sal.quotation.view')
  @Get('quotations')
  listQuotations(@CurrentPrincipal() principal: Principal, @Query() query: unknown) {
    return this.quotations.list(tenantPrincipal(principal), parseInput(quotationListQuery, query));
  }

  @RequirePermission('sal.quotation.view')
  @Get('quotations/:id')
  getQuotation(@CurrentPrincipal() principal: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.quotations.get(tenantPrincipal(principal), id);
  }

  @RequirePermission('sal.quotation.create')
  @Post('quotations')
  async createQuotation(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.quotations.create(tenantPrincipal(principal), parseInput(createQuotationRequest, body), correlationId);
    return created(response, result, result.quotation);
  }

  @RequirePermission('sal.quotation.edit')
  @Patch('quotations/:id')
  updateQuotation(@CurrentPrincipal() principal: Principal, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @CorrelationId() correlationId: string) {
    return this.quotations.update(tenantPrincipal(principal), id, parseInput(updateQuotationRequest, body), correlationId);
  }

  @RequirePermission('sal.quotation.edit')
  @Patch('quotations/:id/status')
  changeQuotationStatus(@CurrentPrincipal() principal: Principal, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @CorrelationId() correlationId: string) {
    return this.quotations.changeStatus(tenantPrincipal(principal), id, parseInput(quotationStatusRequest, body), correlationId);
  }

  @RequirePermission('sal.quotation.edit', 'sal.order.create')
  @Post('quotations/:id/convert')
  async convertQuotation(@CurrentPrincipal() principal: Principal, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @CorrelationId() correlationId: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.quotations.convert(tenantPrincipal(principal), id, parseInput(convertQuotationRequest, body), correlationId);
    return created(response, result, result.order);
  }

  @RequirePermission('sal.order.view')
  @Get('prices')
  prices(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<SalesPrices> {
    return this.orders.prices(tenantPrincipal(principal), parseInput(salesPriceQuery, query));
  }

  @RequirePermission('sal.order.view')
  @Get('orders')
  listOrders(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<SalesOrderSummary>> {
    return this.orders.list(tenantPrincipal(principal), parseInput(salesOrderListQuery, query));
  }

  @RequirePermission('sal.order.view')
  @Get('orders/:id')
  getOrder(@CurrentPrincipal() principal: Principal, @Param('id', new ParseUUIDPipe()) id: string): Promise<SalesOrder> {
    return this.orders.get(tenantPrincipal(principal), id);
  }

  @RequirePermission('sal.order.create')
  @Post('orders')
  async createOrder(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string, @Res({ passthrough: true }) response: Response): Promise<SalesOrder | ApprovalSubmitted> {
    const input = parseInput(createSalesOrderRequest, body);
    const submitted = await this.approvals.submitIfRequired(tenantPrincipal(principal), 'sales_order', input, correlationId);
    if (submitted) {
      response.status(202);
      return { approvalRequired: true, request: submitted };
    }
    const result = await this.orders.create(tenantPrincipal(principal), input, correlationId);
    return created(response, result, result.order);
  }

  @RequirePermission('sal.order.edit')
  @Patch('orders/:id/status')
  changeOrderStatus(@CurrentPrincipal() principal: Principal, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<SalesOrder> {
    return this.orders.changeStatus(tenantPrincipal(principal), id, parseInput(changeSalesOrderStatusRequest, body), correlationId);
  }

  @RequirePermission('sal.delivery.view')
  @Get('deliveries')
  listDeliveries(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<DeliverySummary>> {
    return this.deliveries.list(tenantPrincipal(principal), parseInput(deliveryListQuery, query));
  }

  @RequirePermission('sal.delivery.view')
  @Get('deliveries/:id')
  getDelivery(@CurrentPrincipal() principal: Principal, @Param('id', new ParseUUIDPipe()) id: string): Promise<Delivery> {
    return this.deliveries.get(tenantPrincipal(principal), id);
  }

  @RequirePermission('sal.delivery.post')
  @Post('deliveries')
  async createDelivery(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string, @Res({ passthrough: true }) response: Response): Promise<Delivery> {
    const result = await this.deliveries.create(tenantPrincipal(principal), parseInput(createDeliveryRequest, body), correlationId);
    return created(response, result, result.delivery);
  }

  @RequirePermission('sal.delivery.cancel')
  @Post('deliveries/:id/cancel')
  async cancelDelivery(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Delivery> {
    const result = await this.deliveries.cancel(tenantPrincipal(principal), id, parseInput(cancelSalesDocumentRequest, body), correlationId);
    return created(response, result, result.delivery);
  }

  @RequirePermission('sal.invoice.view')
  @Get('invoiceable')
  invoiceable(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<InvoiceableSalesLine[]> {
    const { customerId } = parseInput(z.object({ customerId: z.uuid() }), query);
    return this.invoices.invoiceable(tenantPrincipal(principal), customerId);
  }

  @RequirePermission('sal.invoice.view')
  @Get('invoices')
  listInvoices(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<ArInvoiceSummary>> {
    return this.invoices.list(tenantPrincipal(principal), parseInput(arInvoiceListQuery, query));
  }

  @RequirePermission('sal.invoice.view')
  @Get('invoices/:id')
  getInvoice(@CurrentPrincipal() principal: Principal, @Param('id', new ParseUUIDPipe()) id: string): Promise<ArInvoice> {
    return this.invoices.get(tenantPrincipal(principal), id);
  }

  @RequirePermission('sal.invoice.view')
  @Get('invoices/:id/document')
  invoiceDocument(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<ArInvoiceDocument> {
    return this.invoices.document(tenantPrincipal(principal), id);
  }

  @RequirePermission('sal.invoice.post')
  @Post('invoices')
  async createInvoice(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string, @Res({ passthrough: true }) response: Response): Promise<ArInvoice> {
    const result = await this.invoices.create(tenantPrincipal(principal), parseInput(createArInvoiceRequest, body), correlationId);
    return created(response, result, result.invoice);
  }

  @RequirePermission('sal.invoice.cancel')
  @Post('invoices/:id/cancel')
  async cancelInvoice(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ArInvoice> {
    const result = await this.invoices.cancel(tenantPrincipal(principal), id, parseInput(cancelSalesDocumentRequest, body), correlationId);
    return created(response, result, result.invoice);
  }
}
