import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import {
  addTaxRateRequest,
  createTaxCodeRequest,
  type TaxCode,
  changePeriodStatusRequest,
  createAccountRequest,
  createFiscalYearRequest,
  createSeriesRequest,
  journalListQuery,
  postJournalRequest,
  reverseJournalRequest,
  trialBalanceQuery,
  updateAccountRequest,
  updateDeterminationRequest,
  type Account,
  type GlDetermination,
  type JournalEntry,
  type JournalSummary,
  type NumberingSeries,
  type Page,
  type PostingPeriod,
  type TrialBalance,
} from '@nec/contracts';
import type { Response } from 'express';
import { RequirePermission } from '../auth/auth.guard.js';
import { parseInput } from '../common/errors.js';
import { CorrelationId, CurrentPrincipal, tenantPrincipal, type Principal } from '../common/request-context.js';
import { FinanceSetupService } from './finance-setup.service.js';
import { JournalsService } from './journals.service.js';
import { TaxService } from './tax.service.js';

@Controller('v1/fin')
export class FinanceController {
  constructor(
    private readonly setup: FinanceSetupService,
    private readonly journals: JournalsService,
    private readonly tax: TaxService,
  ) {}

  @RequirePermission('fin.account.view')
  @Get('tax-codes')
  taxCodes(@CurrentPrincipal() principal: Principal): Promise<TaxCode[]> {
    return this.tax.list(tenantPrincipal(principal));
  }

  @RequirePermission('fin.setup.administer')
  @Post('tax-codes')
  createTaxCode(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<TaxCode> {
    return this.tax.create(tenantPrincipal(principal), parseInput(createTaxCodeRequest, body), correlationId);
  }

  @RequirePermission('fin.setup.administer')
  @Post('tax-codes/:id/rates')
  addTaxRate(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
  ): Promise<TaxCode> {
    return this.tax.addRate(tenantPrincipal(principal), id, parseInput(addTaxRateRequest, body), correlationId);
  }

  @RequirePermission('fin.account.view')
  @Get('accounts')
  accounts(@CurrentPrincipal() principal: Principal): Promise<Account[]> {
    return this.setup.accounts(tenantPrincipal(principal));
  }

  @RequirePermission('fin.account.administer')
  @Post('accounts')
  createAccount(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<Account> {
    return this.setup.createAccount(tenantPrincipal(principal), parseInput(createAccountRequest, body), correlationId);
  }

  @RequirePermission('fin.account.administer')
  @Put('accounts/:id')
  updateAccount(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
  ): Promise<Account> {
    return this.setup.updateAccount(tenantPrincipal(principal), id, parseInput(updateAccountRequest, body), correlationId);
  }

  @RequirePermission('fin.account.view')
  @Get('gl-determination')
  determination(@CurrentPrincipal() principal: Principal): Promise<GlDetermination[]> {
    return this.setup.determination(tenantPrincipal(principal));
  }

  @RequirePermission('fin.setup.administer')
  @Put('gl-determination')
  updateDetermination(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<GlDetermination[]> {
    return this.setup.updateDetermination(tenantPrincipal(principal), parseInput(updateDeterminationRequest, body), correlationId);
  }

  @RequirePermission('fin.period.view')
  @Get('periods')
  periods(@CurrentPrincipal() principal: Principal): Promise<PostingPeriod[]> {
    return this.setup.periods(tenantPrincipal(principal));
  }

  @RequirePermission('fin.period.administer')
  @Post('fiscal-years')
  createFiscalYear(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<PostingPeriod[]> {
    return this.setup.createFiscalYear(tenantPrincipal(principal), parseInput(createFiscalYearRequest, body), correlationId);
  }

  @RequirePermission('fin.period.administer')
  @Patch('periods/:id/status')
  changePeriodStatus(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
  ): Promise<PostingPeriod> {
    return this.setup.changePeriodStatus(tenantPrincipal(principal), id, parseInput(changePeriodStatusRequest, body), correlationId);
  }

  @RequirePermission('fin.journal.view')
  @Get('journal-entries')
  listJournals(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<JournalSummary>> {
    return this.journals.list(tenantPrincipal(principal), parseInput(journalListQuery, query));
  }

  @RequirePermission('fin.journal.view')
  @Get('journal-entries/:id')
  getJournal(@CurrentPrincipal() principal: Principal, @Param('id', new ParseUUIDPipe()) id: string): Promise<JournalEntry> {
    return this.journals.get(tenantPrincipal(principal), id);
  }

  @RequirePermission('fin.journal.post')
  @Post('journal-entries')
  async postJournal(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<JournalEntry> {
    const result = await this.journals.post(tenantPrincipal(principal), parseInput(postJournalRequest, body), correlationId);
    response.status(result.replayed ? 200 : 201);
    response.setHeader('idempotent-replayed', String(result.replayed));
    return result.entry;
  }

  @RequirePermission('fin.journal.reverse')
  @Post('journal-entries/:id/reverse')
  async reverseJournal(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<JournalEntry> {
    const result = await this.journals.reverse(tenantPrincipal(principal), id, parseInput(reverseJournalRequest, body), correlationId);
    response.status(result.replayed ? 200 : 201);
    response.setHeader('idempotent-replayed', String(result.replayed));
    return result.entry;
  }

  @RequirePermission('fin.report.view')
  @Get('reports/trial-balance')
  trialBalance(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<TrialBalance> {
    return this.journals.trialBalance(tenantPrincipal(principal), parseInput(trialBalanceQuery, query));
  }
}

@Controller('v1/tenant/numbering-series')
export class NumberingController {
  constructor(private readonly setup: FinanceSetupService) {}

  @RequirePermission('admin.numbering.view')
  @Get()
  list(@CurrentPrincipal() principal: Principal): Promise<NumberingSeries[]> {
    return this.setup.series(tenantPrincipal(principal));
  }

  @RequirePermission('admin.numbering.administer')
  @Post()
  create(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<NumberingSeries[]> {
    return this.setup.createSeries(tenantPrincipal(principal), parseInput(createSeriesRequest, body), correlationId);
  }

  @RequirePermission('admin.numbering.administer')
  @Post(':id/default')
  @HttpCode(200)
  setDefault(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @CorrelationId() correlationId: string,
  ): Promise<NumberingSeries[]> {
    return this.setup.setDefaultSeries(tenantPrincipal(principal), id, correlationId);
  }
}
