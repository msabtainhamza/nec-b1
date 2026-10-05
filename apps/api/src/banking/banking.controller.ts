import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import {
  allocateIncomingPaymentRequest,
  allocatePaymentRequest,
  cancelPaymentRequest,
  createIncomingPaymentRequest,
  createOutgoingPaymentRequest,
  incomingPaymentListQuery,
  outgoingPaymentListQuery,
  unallocatePaymentRequest,
  type IncomingPayment,
  type IncomingPaymentSummary,
  type OpenPaymentItem,
  type OutgoingPayment,
  type OutgoingPaymentSummary,
  type Page,
  type Payment,
  type PaymentDirection,
  type PaymentSummary,
} from '@nec/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/auth.guard.js';
import { parseInput } from '../common/errors.js';
import { CorrelationId, CurrentPrincipal, tenantPrincipal, type Principal } from '../common/request-context.js';
import { PaymentsService } from './payments.service.js';

const asOutgoing = (payment: Payment): OutgoingPayment => ({ ...payment, vendorId: payment.partnerId, vendorCode: payment.partnerCode, vendorName: payment.partnerName });
const asIncoming = (payment: Payment): IncomingPayment => ({ ...payment, customerId: payment.partnerId, customerCode: payment.partnerCode, customerName: payment.partnerName });

function reply<T>(response: Response, result: { replayed: boolean; payment: Payment }, map: (payment: Payment) => T): T {
  response.status(result.replayed ? 200 : 201);
  response.setHeader('idempotent-replayed', String(result.replayed));
  return map(result.payment);
}

@Controller('v1/bank')
export class BankingController {
  constructor(private readonly payments: PaymentsService) {}

  @RequirePermission('bank.payment.view')
  @Get('open-invoices')
  openInvoices(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<OpenPaymentItem[]> {
    const { vendorId } = parseInput(z.object({ vendorId: z.uuid() }), query);
    return this.payments.openItems(tenantPrincipal(principal), 'outgoing', vendorId);
  }

  @RequirePermission('bank.payment.view')
  @Get('open-receivables')
  openReceivables(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<OpenPaymentItem[]> {
    const { customerId } = parseInput(z.object({ customerId: z.uuid() }), query);
    return this.payments.openItems(tenantPrincipal(principal), 'incoming', customerId);
  }

  @RequirePermission('bank.payment.view')
  @Get('outgoing-payments')
  async list(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<OutgoingPaymentSummary>> {
    const { vendorId, ...rest } = parseInput(outgoingPaymentListQuery, query);
    const page = await this.payments.list(tenantPrincipal(principal), 'outgoing', { ...rest, partnerId: vendorId });
    return { ...page, items: page.items.map((row: PaymentSummary) => ({ ...row, vendorName: row.partnerName })) };
  }

  @RequirePermission('bank.payment.view')
  @Get('incoming-payments')
  async listIncoming(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<IncomingPaymentSummary>> {
    const { customerId, ...rest } = parseInput(incomingPaymentListQuery, query);
    const page = await this.payments.list(tenantPrincipal(principal), 'incoming', { ...rest, partnerId: customerId });
    return { ...page, items: page.items.map((row: PaymentSummary) => ({ ...row, customerName: row.partnerName })) };
  }

  @RequirePermission('bank.payment.view')
  @Get('outgoing-payments/:id')
  async get(@CurrentPrincipal() principal: Principal, @Param('id', new ParseUUIDPipe()) id: string): Promise<OutgoingPayment> {
    return asOutgoing(await this.payments.get(tenantPrincipal(principal), 'outgoing', id));
  }

  @RequirePermission('bank.payment.view')
  @Get('incoming-payments/:id')
  async getIncoming(@CurrentPrincipal() principal: Principal, @Param('id', new ParseUUIDPipe()) id: string): Promise<IncomingPayment> {
    return asIncoming(await this.payments.get(tenantPrincipal(principal), 'incoming', id));
  }

  @RequirePermission('bank.payment.post')
  @Post('outgoing-payments')
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OutgoingPayment> {
    const { idempotencyKey, ...request } = parseInput(createOutgoingPaymentRequest, body);
    const { vendorId, ...fields } = request;
    const result = await this.payments.create(tenantPrincipal(principal), 'outgoing', idempotencyKey, request, { ...fields, partnerId: vendorId }, correlationId);
    return reply(response, result, asOutgoing);
  }

  @RequirePermission('bank.payment.post')
  @Post('incoming-payments')
  async createIncoming(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<IncomingPayment> {
    const { idempotencyKey, ...request } = parseInput(createIncomingPaymentRequest, body);
    const { customerId, ...fields } = request;
    const result = await this.payments.create(tenantPrincipal(principal), 'incoming', idempotencyKey, request, { ...fields, partnerId: customerId }, correlationId);
    return reply(response, result, asIncoming);
  }

  @RequirePermission('bank.payment.post')
  @Post('outgoing-payments/:id/allocations')
  async allocate(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OutgoingPayment> {
    return reply(response, await this.payments.allocate(tenantPrincipal(principal), 'outgoing', id, parseInput(allocatePaymentRequest, body), correlationId), asOutgoing);
  }

  @RequirePermission('bank.payment.post')
  @Post('incoming-payments/:id/allocations')
  async allocateIncoming(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<IncomingPayment> {
    return reply(response, await this.payments.allocate(tenantPrincipal(principal), 'incoming', id, parseInput(allocateIncomingPaymentRequest, body), correlationId), asIncoming);
  }

  @RequirePermission('bank.payment.unallocate')
  @Post('outgoing-payments/:id/allocations/:allocationId/unallocate')
  async unallocate(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('allocationId', new ParseUUIDPipe()) allocationId: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OutgoingPayment> {
    return this.unallocateAs('outgoing', principal, id, allocationId, body, correlationId, response, asOutgoing);
  }

  @RequirePermission('bank.payment.unallocate')
  @Post('incoming-payments/:id/allocations/:allocationId/unallocate')
  async unallocateIncoming(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('allocationId', new ParseUUIDPipe()) allocationId: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<IncomingPayment> {
    return this.unallocateAs('incoming', principal, id, allocationId, body, correlationId, response, asIncoming);
  }

  @RequirePermission('bank.payment.cancel')
  @Post('outgoing-payments/:id/cancel')
  async cancel(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OutgoingPayment> {
    return reply(response, await this.payments.cancel(tenantPrincipal(principal), 'outgoing', id, parseInput(cancelPaymentRequest, body), correlationId), asOutgoing);
  }

  @RequirePermission('bank.payment.cancel')
  @Post('incoming-payments/:id/cancel')
  async cancelIncoming(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<IncomingPayment> {
    return reply(response, await this.payments.cancel(tenantPrincipal(principal), 'incoming', id, parseInput(cancelPaymentRequest, body), correlationId), asIncoming);
  }

  private async unallocateAs<T>(
    direction: PaymentDirection,
    principal: Principal,
    id: string,
    allocationId: string,
    body: unknown,
    correlationId: string,
    response: Response,
    map: (payment: Payment) => T,
  ): Promise<T> {
    const result = await this.payments.unallocate(tenantPrincipal(principal), direction, id, allocationId, parseInput(unallocatePaymentRequest, body), correlationId);
    return reply(response, result, map);
  }
}
