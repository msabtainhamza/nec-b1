import { Injectable } from '@nestjs/common';
import type { ChangePeriodStatusRequest, PeriodCloseCheck, PeriodCloseChecks, PostingPeriod } from '@nec/contracts';
import { AppError, forbidden, notFound } from '../common/errors.js';
import type { TenantPrincipal } from '../common/request-context.js';
import { InventoryReportsService } from '../inventory/inventory-reports.service.js';
import { AgingService } from './aging.service.js';
import { FinanceSetupService } from './finance-setup.service.js';
import { JournalsService } from './journals.service.js';
import { parseMoney } from './money.js';

@Injectable()
export class PeriodCloseService {
  constructor(
    private readonly setup: FinanceSetupService,
    private readonly journals: JournalsService,
    private readonly aging: AgingService,
    private readonly inventory: InventoryReportsService,
  ) {}

  private async period(principal: TenantPrincipal, periodId: string): Promise<PostingPeriod> {
    const period = (await this.setup.periods(principal)).find((row) => row.id === periodId);
    if (!period) throw notFound();
    return period;
  }

  async checks(principal: TenantPrincipal, periodId: string): Promise<PeriodCloseChecks> {
    const period = await this.period(principal, periodId);
    const asOf = period.endDate;
    const trial = await this.journals.trialBalance(principal, { from: period.startDate, to: period.endDate });
    const unbalanced = parseMoney(trial.totals.debit) - parseMoney(trial.totals.credit);
    const cumulative = parseMoney(trial.totals.closingBalance);
    const receivables = await this.aging.receivables(principal, { asOf, basis: 'due_date' });
    const payables = await this.aging.payables(principal, { asOf, basis: 'due_date' });
    const stock = await this.inventory.valuation(principal, { asOf });
    const stockDifferences = stock.accounts.filter((account) => account.difference !== '0.0000');
    const checks: PeriodCloseCheck[] = [
      {
        key: 'trial_balance',
        label: 'Trial balance',
        passed: unbalanced === 0n && cumulative === 0n,
        detail:
          unbalanced === 0n && cumulative === 0n
            ? `Debits and credits for ${period.code} both total ${trial.totals.debit}`
            : `Debits ${trial.totals.debit}, credits ${trial.totals.credit}, cumulative balance ${trial.totals.closingBalance}`,
      },
      {
        key: 'receivables',
        label: 'Customer receivables reconcile to the control account',
        passed: receivables.difference === '0.0000',
        detail: `Aging ${receivables.totals.total}, control account ${receivables.controlAccount.code} ${receivables.controlAccount.balance}, difference ${receivables.difference}`,
      },
      {
        key: 'payables',
        label: 'Vendor liabilities reconcile to the control account',
        passed: payables.difference === '0.0000',
        detail: `Aging ${payables.totals.total}, control account ${payables.controlAccount.code} ${payables.controlAccount.balance}, difference ${payables.difference}`,
      },
      {
        key: 'inventory',
        label: 'Stock value reconciles to the inventory accounts',
        passed: stockDifferences.length === 0,
        detail:
          stockDifferences.length === 0
            ? `Stock value ${stock.totalValue} agrees with the inventory accounts`
            : stockDifferences.map((account) => `${account.accountCode}: stock ${account.stockValue}, ledger ${account.ledgerBalance}, difference ${account.difference}`).join('; '),
      },
    ];
    return { periodId, periodCode: period.code, endDate: asOf, passed: checks.every((check) => check.passed), checks };
  }

  async change(principal: TenantPrincipal, periodId: string, input: ChangePeriodStatusRequest, correlationId: string): Promise<PostingPeriod> {
    if (input.status === 'closed') {
      if (!principal.permissions.has('fin.period.close')) throw forbidden('Closing a posting period requires the period close permission');
      const result = await this.checks(principal, periodId);
      if (!result.passed) {
        throw new AppError(422, 'PERIOD_CLOSE_CHECKS_FAILED', `Posting period ${result.periodCode} cannot be closed until every reconciliation check passes`, { checks: result.checks });
      }
      return this.setup.changePeriodStatus(principal, periodId, input, correlationId, { checks: result.checks.map((check) => ({ key: check.key, passed: check.passed })) });
    }
    if (!principal.permissions.has('fin.period.reopen')) throw forbidden('Reopening a posting period requires the period reopen permission');
    return this.setup.changePeriodStatus(principal, periodId, input, correlationId);
  }
}
