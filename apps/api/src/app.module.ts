import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuditService } from './audit/audit.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { LoginLimiter } from './auth/login-limiter.js';
import { SessionService } from './auth/session.service.js';
import { TokenService } from './auth/token.service.js';
import { BranchesController } from './branches/branches.controller.js';
import { BusinessPartnersController } from './business-partners/business-partners.controller.js';
import { BusinessPartnersService } from './business-partners/business-partners.service.js';
import { BranchesService } from './branches/branches.service.js';
import { ErrorFilter } from './common/error.filter.js';
import { APP_CONFIG, type AppConfig } from './config.js';
import { DatabaseService } from './database/database.service.js';
import { EntitlementService } from './entitlements/entitlement.service.js';
import { FinanceController, NumberingController } from './finance/finance.controller.js';
import { FinanceSetupService } from './finance/finance-setup.service.js';
import { JournalsService } from './finance/journals.service.js';
import { PostingService } from './finance/posting.service.js';
import { TaxService } from './finance/tax.service.js';
import { HealthController } from './health.controller.js';
import { InventoryController } from './inventory/inventory.controller.js';
import { InventoryService } from './inventory/inventory.service.js';
import { StockService } from './inventory/stock.service.js';
import { ApInvoicesService } from './purchasing/ap-invoices.service.js';
import { GoodsReceiptsService } from './purchasing/goods-receipts.service.js';
import { PurchaseOrdersService } from './purchasing/purchase-orders.service.js';
import { PurchasingController } from './purchasing/purchasing.controller.js';
import { MAILER, MailDispatcher, SmtpMailer, type Mailer } from './mail/mailer.js';
import { PlatformController } from './platform/platform.controller.js';
import { PlatformService } from './platform/platform.service.js';
import { InvitationAcceptController, TenantController } from './tenancy/tenant.controller.js';
import { InvitationsService } from './tenancy/invitations.service.js';
import { MembersService } from './tenancy/members.service.js';
import { TenantAccessService } from './tenancy/tenant-access.service.js';

export interface AppModuleOptions {
  config: AppConfig;
  mailer?: Mailer;
}

@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    const mailer: Provider = options.mailer ? { provide: MAILER, useValue: options.mailer } : { provide: MAILER, useClass: SmtpMailer };
    return {
      module: AppModule,
      controllers: [
        HealthController,
        AuthController,
        TenantController,
        InvitationAcceptController,
        BranchesController,
        BusinessPartnersController,
        FinanceController,
        NumberingController,
        InventoryController,
        PurchasingController,
        PlatformController,
      ],
      providers: [
        { provide: APP_CONFIG, useValue: options.config },
        mailer,
        DatabaseService,
        AuditService,
        TokenService,
        SessionService,
        LoginLimiter,
        TenantAccessService,
        EntitlementService,
        MailDispatcher,
        AuthService,
        InvitationsService,
        MembersService,
        BranchesService,
        BusinessPartnersService,
        PostingService,
        FinanceSetupService,
        JournalsService,
        TaxService,
        StockService,
        InventoryService,
        PurchaseOrdersService,
        GoodsReceiptsService,
        ApInvoicesService,
        PlatformService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
      exports: [DatabaseService, PlatformService, InvitationsService],
    };
  }
}
