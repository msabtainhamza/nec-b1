# Implementation status

**Updated:** 1 October 2026 (Codex database readiness follow-up)
**Current milestone:** M4 Sales (M1, M2 and M5 partially complete; see table)
**Project state:** Foundation, business partners, inventory master data, financials core, purchasing (PO, goods receipt, A/P invoice with tax and revaluation), stock ledger, outgoing payments with allocation, stock transfers and adjustments, A/P aging, G/L, business partner and inventory opening balances with CSV import, incoming payments, customer aging and the sales flow (quotations, orders, deliveries, A/R invoices) implemented and tested. Initial commit `5d47008` on `master`; the outgoing-payments, stock-transaction, A/P aging, opening-balance, incoming-payment/import, customer aging, sales, quotation and credit-policy slices are uncommitted.

## Milestones

| Milestone | Scope | State |
| --- | --- | --- |
| M1 Foundation | Monorepo, local infrastructure, tenant membership, authentication, RBAC, subscriptions, RLS and audit | In progress: core slice done; remaining items below |
| M2 Master data | Company settings, branches, periods, numbering, partners, items and warehouses | In progress: business partners, items, units, item groups, warehouses, price lists, periods, numbering and opening balances (G/L accounts, business partners, inventory; ADR-031) with CSV import (ADR-033) and partner, item and price imports (ADR-045) done |
| M3 Purchasing and inventory | Purchase orders, receipts, stock ledger, transfers and adjustments | Done for V1 scope: purchase orders, goods receipts, A/P invoices, stock ledger, moving average, transfers, adjustments, inventory opening balance, cancellations, Inventory Status and Inventory Valuation reports (ADR-044); stock counts are deferred by the PRD |
| M4 Sales | Quotes, orders, deliveries, customer invoices and payments | In progress: sales orders, partial deliveries, A/R invoices (ADR-035), incoming payments with allocation to A/R invoices and opening lines (ADR-032) and quotations with draft/issue/expiry and conversion to orders (ADR-036) customer credit policy (ADR-038, lock scope ADR-039), A/R invoice price control (ADR-040), printable A/R invoices (ADR-041) and order price-list defaults, payment terms, addresses and stock warnings (ADR-042) done; returns and credit notes are deferred from V1 by the PRD; order approvals and reservation policy remain |
| M5 Finance and pilot | Journals, aging, trial balance, reports, installer, recovery and pilot testing | In progress: financial core (posting-gate prerequisites per ADR-012) A/P aging, A/R aging (ADR-034), general ledger detail and period-close checks (ADR-046) and opening balances (ADR-031) done; installer, recovery and pilot remain; financial statements are deferred by the PRD |

## Completed

- Requirements baseline, handoff instructions and requirements review (R-01 to R-17).
- pnpm monorepo: `apps/api`, `apps/worker`, `apps/desktop`, `packages/contracts`, `packages/ui`, `packages/config`, `infrastructure`, one-command `pnpm run setup`, `docs/DEVELOPMENT.md`.
- Docker Compose for PostgreSQL 17, Redis 8, SeaweedFS (S3) and Mailpit, with separate owner, app and worker database roles.
- Migration `0001_foundation.sql`: platform catalog, sessions and refresh tokens, memberships, roles and permissions, invitations, branches, tenant and platform audit; forced RLS with per-transaction tenant context; composite tenant foreign keys; append-only audit.
- API (PL-01 to PL-04, ID-01 partial, ID-02, ID-04, ID-05): login, refresh rotation with reuse detection, logout and session revocation, tenant listing and selection, tenant context, `module.resource.action` permission guard with audited denials, invitations with emailed tokens, members with enable/disable, roles, branches, paginated audit log, operator login with TOTP, atomic tenant provisioning, subscription state changes and restricted access mapping.
- Atomic seat and branch limits under concurrency (ADR-016).
- Seed with two tenants whose branch codes overlap, a user in both tenants, and a platform operator.
- Worker skeleton: BullMQ worker that checks the tenant membership and subscription again, using the worker database role, before running tenant jobs.
- Desktop: Electron main process holds tokens; sandboxed preload exposes a narrow IPC bridge; renderer requests limited to an allowlist of `/v1/tenant` and `/v1/invitations` paths; production CSP; screens for sign-in, invitation acceptance, company chooser and shell with overview, branches, users and audit.

## In progress

- M1 remainder: Redis-backed rate limiting (current limiter is in-memory, per process); worker integration tests with Redis; desktop launch verification, installer and auto-update (UX-08). Done on 2026-10-01: password reset (ADR-047), MFA and secret encryption (ADR-048), custom roles (ADR-049), support access (ADR-050), export and deletion request (ADR-051); idempotency keys already cover posting writes.

## Next action

Launch the desktop in Electron against the live API (`pnpm dev:api`, `pnpm dev:desktop`) and walk through the screens added on 2026-09-30 and 2026-10-01 (Sales including invoice Print/Save as PDF, Data Import, inventory and finance reports, Posting Periods close checks, Forgot Password, Two-Factor Authentication, Authorizations, Support Access, Cockpit); none of them has run inside Electron, and several were not checked in a browser. Then the product owner should review ADR-039 to ADR-053 and decide whether to commit. Then review ADR-053 (approval procedures). Next feature candidates: Redis-backed rate limiting once Redis is available, installer and auto-update (UX-08), multi-stage approvals and approvals for invoices and payments.

## Blockers and open decisions

- Earlier sessions could not start Docker/WSL. On 2026-10-01 at 22:32:49 PKT, a PostgreSQL server started on the configured localhost:55432 endpoint with data directory `/var/lib/postgresql/data`; API health is now good. The automation cannot inspect Docker containers because access to the Docker configuration and daemon pipe is denied. Redis, SeaweedFS and Mailpit remain unverified.
- The Electron binary has not been downloaded; the desktop UI has been built and unit tested but not launched.
- Confirm ADR-016 and ADR-017 (seat reservation by invitations, subscription access mapping, retention window).
- Earlier open decisions remain: first production country and its accountant validation (the V1 tax model is set by ADR-030), customer vertical, billing provider, R-01 to R-03 and R-11 before transactional APIs.

## Verification

See the latest session entry below for exact commands and results.

## Latest handoff

- **Agent:** Codex automation nec-b1
- **Branch and commit:** `master`; initial commit `5d47008` (made by Claude at the user's request on 2026-09-29, not pushed).
- **Changed files this session:** apps/api/src/health.controller.ts, apps/api/test/health.test.ts, docs/DEVELOPMENT.md and this file; see the newest session entry.
- **Uncommitted work:** The outgoing-payments, stock-transaction, A/P aging, opening-balance, incoming-payment/import, customer aging, sales, quotation and credit-policy slices and these handoff updates are uncommitted. Nothing was pushed.
- **Exact next action:** As in "Next action" above.

## Latest session update

### 2026-10-01 - Claude approval procedures (ADR-053)

- Approval templates for sales and purchase orders (amount threshold, approver role, required approvals); matching new orders become approval requests (HTTP 202); approvers decide (segregation of duties: never on their own requests; one rejection rejects); the originator adds the approved document through the normal creation path (credit policy included, idempotent) or cancels the request; Cockpit shows pending approvals. Purchase order validation was extracted into PurchaseOrdersService.prepare for the pre-check.
- Files added: apps/api/migrations/0023_approvals.sql, apps/api/src/approvals/{approvals.service.ts,approvals.controller.ts}, apps/api/test/approvals.test.ts, packages/contracts/src/approvals.ts, apps/desktop/src/renderer/forms/ApprovalForms.tsx. Modified: apps/api/src/{app.module.ts,database/schema.ts,purchasing/purchase-orders.service.ts,purchasing/purchasing.controller.ts,sales/sales.controller.ts,tenancy/dashboard.service.ts}, apps/api/test/dashboard.test.ts, packages/contracts/src/{api,permissions,index}.ts, apps/desktop/src/renderer/{screens/Shell.tsx,forms/CockpitForm.tsx,forms/SalesForms.tsx,forms/PurchasingForms.tsx}, docs/DECISIONS.md, this file.
- Verification: pnpm build, typecheck and lint exit 0; pnpm test exit 0: API 170/170, worker 4/4, desktop 8/8; pnpm db:migrate applied 0023. Mutation check removing the own-request rule failed the approval test (the first sed attempt did not match the compiled code; applied with a script, then restored). Desktop approval screens were not exercised in a browser.

### 2026-10-01 - Claude home dashboard (ADR-052) and line-ending cleanup

- GET /v1/tenant/dashboard with permission-filtered widgets (open sales and purchase orders, overdue customer and vendor invoices, low stock, six months of sales and purchases); desktop Cockpit opens after choosing a company and links each figure to its source screen (Inventory Status can open pre-filtered to low stock).
- Files added: apps/api/src/tenancy/dashboard.service.ts, apps/api/test/dashboard.test.ts, apps/desktop/src/renderer/forms/CockpitForm.tsx. Modified: apps/api/src/{app.module.ts,tenancy/tenant.controller.ts}, packages/contracts/src/api.ts, apps/desktop/src/renderer/{screens/Shell.tsx,forms/InventoryReportForms.tsx,app.css}, docs/DECISIONS.md, this file.
- Housekeeping: scripted edits during this run had written CRLF line endings into 55 files; all edited files were converted back to LF (git diff --check now reports only the existing blank line at EOF in packages/ui/src/components.tsx). A trailing blank line left in apps/api/src/platform/platform.service.ts was removed.
- Verification: pnpm build, typecheck and lint exit 0; pnpm test exit 0: API 167/167, worker 4/4, desktop 8/8.

### 2026-10-01 - Claude account and security (ADR-047 to ADR-051)

- Password reset and change (ADR-047): migration 0020; public request/confirm endpoints, authenticated change; desktop Forgot Password and Change Password through dedicated main-process calls.
- Two-factor authentication (ADR-048): migration 0021; TOTP enrolment with recovery codes, two-step login with main-process challenge, company setting requiring administrators to enrol, AES-256-GCM encryption of user and operator TOTP secrets (MFA_ENCRYPTION_KEY optional, documented in .env.example; operator secrets re-encrypted at next sign-in).
- Custom roles (ADR-049): create/update/delete custom roles and change member roles with no-escalation and last-owner rules; desktop Authorizations window and role editing in Users - Setup.
- Support access (ADR-050): migration 0022; company-granted, time-limited, read-only erp-support sessions for operators, re-checked and audited per request; desktop Support Access window.
- Export and deletion request (ADR-051): GET /v1/tenant/export, POST /v1/tenant/deletion-request, operator restore; desktop Company Data section.
- Files added: apps/api/migrations/{0020_password_reset,0021_mfa,0022_support_access}.sql; apps/api/src/auth/{password.service,mfa.service,secret-box,totp}.ts; apps/api/src/tenancy/{roles.service,support-access.service,tenant-lifecycle.service}.ts; apps/api/test/{password,mfa,roles,support-access,tenant-lifecycle}.test.ts; apps/desktop/src/renderer/screens/ForgotPasswordScreen.tsx; apps/desktop/src/renderer/forms/{ChangePasswordForm,TwoFactorForm,AuthorizationsForm,SupportAccessForm}.tsx. Modified: apps/api/src/{app.module.ts,config.ts,auth/auth.controller.ts,auth/auth.service.ts,auth/auth.guard.ts,auth/token.service.ts,common/request-context.ts,database/schema.ts,platform/platform.service.ts,platform/platform.controller.ts,tenancy/tenant.controller.ts}, packages/contracts/src/api.ts, apps/desktop/src/{main/main.ts,main/api-session.ts,main/api-session.test.ts,preload/preload.cts,renderer/erp.d.ts,renderer/App.tsx,renderer/screens/{LoginScreen,TenantChooser,Shell}.tsx,renderer/forms/{UsersForm,CompanyDetailsForm}.tsx}, .env.example, docs/DECISIONS.md, this file.
- Verification: pnpm build exit 0; pnpm typecheck exit 0; pnpm lint exit 0; pnpm test exit 0: API 165/165, worker 4/4, desktop 8/8. pnpm db:migrate applied 0020-0022. Mutation checks (compiled output, restored): TOTP replay, last-owner rule, support read-only rule (after tightening the assertion; the first run was masked by the view-only rule), export secret-column exclusion each failed their tests. Intermediate failures: two ECONNREFUSED test-harness errors (await inside a request chain), a support test that tried to change expires_at as the app role (correctly denied by column grants; switched to an owner connection) and an expiry simulation that was still in the future; all corrected. Desktop screens for this slice were not exercised in a browser (the pane was not rendering earlier); the API running on port 4000 belongs to the user and was left untouched.
- Remaining M1: Redis-backed rate limiting and worker integration tests (Redis unavailable locally), segregation of duties and approvals (ID-03), desktop installer, auto-update and Electron launch verification.

### 2026-10-01 - Claude general ledger and period close checks (ADR-046)

- General Ledger report: GET /v1/fin/reports/general-ledger (fin.report.view); desktop Financials > Financial Reports > Accounting > General Ledger with CSV export. Period close: GET /v1/fin/periods/:id/close-checks; PATCH /v1/fin/periods/:id/status now runs trial balance, receivables, payables and inventory reconciliation checks before closing (fin.period.close) and requires fin.period.reopen to reopen; migration 0019 grants the permissions (close: owner, administrator, accountant; reopen: owner, administrator). Desktop Posting Periods shows the checks before Close Period.
- Files added: apps/api/migrations/0019_period_close.sql, apps/api/src/finance/{general-ledger.service.ts,period-close.service.ts}, apps/api/test/finance-close.test.ts, apps/desktop/src/renderer/forms/GeneralLedgerForm.tsx. Modified: apps/api/src/{app.module.ts,finance/finance.controller.ts,finance/finance-setup.service.ts}, packages/contracts/src/{finance,permissions}.ts, apps/desktop/src/renderer/{forms/FinanceSetupForms.tsx,screens/Shell.tsx}, docs/DECISIONS.md, this file.
- Verification: API suite 151/151 (2 new finance tests); mutation check making the inventory check always pass failed the close test; restored. Desktop typecheck exit 0. pnpm db:migrate applied 0019. Browser check not completed: the browser pane stopped rendering (window not on screen), so General Ledger and Posting Periods screens were not exercised visually; the temporary preview configuration was removed and .claude/launch.json restored.

### 2026-10-01 - Claude inventory reports and master data import (ADR-044, ADR-045)

- Autonomous run requested by the product owner (inventory, then imports, finance, account and security; Business One conventions for decisions). Nothing committed.
- Inventory (ADR-044): GET /v1/inv/reports/inventory-status (In Stock, Committed, Ordered, Available per item and warehouse; reorder-point flag and filter) and GET /v1/inv/reports/inventory-valuation (as-of quantity, value, average cost; per inventory account reconciliation to the ledger). Desktop Inventory > Inventory Reports > Inventory Status and Inventory Valuation with CSV export. Reservation policy resolved: no hard reservations. The PRD defers stock counts, so they are not a V1 gap.
- Imports (ADR-045): POST /v1/bp/partners/import, /v1/inv/items/import, /v1/inv/price-lists/import (validate/commit, add or update existing, savepoint per row, all-or-nothing, idempotent, audit). Service create/update logic extracted into ...Within(trx) methods; CSV table reader shared with the opening balance import (apps/api/src/common/csv-table.ts). Desktop Administration > Data Import/Export > Data Import with templates and migration order; Shell menu nodes support anyPermission.
- Files added: apps/api/src/inventory/inventory-reports.service.ts, apps/api/src/imports/{master-import.service.ts,imports.controller.ts}, apps/api/src/common/csv-table.ts, apps/api/test/{inventory-reports,master-import}.test.ts, packages/contracts/src/imports.ts, apps/desktop/src/renderer/forms/{InventoryReportForms,DataImportForm}.tsx. Modified: apps/api/src/{app.module.ts,bootstrap.ts,inventory/inventory.controller.ts,inventory/inventory.service.ts,business-partners/business-partners.service.ts,finance/opening-import.service.ts}, packages/contracts/src/{inventory,index}.ts, apps/desktop/src/renderer/{screens/Shell.tsx,forms/ReportForms.tsx,app.css}, docs/DECISIONS.md, this file.
- Verification: pnpm build exit 0; pnpm typecheck exit 0; pnpm lint exit 0 after replacing a literal byte-order mark (first run failed no-irregular-whitespace); pnpm test exit 0: API 149/149, worker 4/4, desktop 7/7. Mutation checks: removing the ledger as-of filter and letting validate mode commit each failed the new tests; restored. Browser check against the API already running on port 4000 (current code, watch mode) via the temporary preview bridge: Inventory Status showed A-100 20 in stock, 2 committed, 18 available; Inventory Valuation reconciled account 1300 (84.00 stock = 84.00 ledger); Data Import rendered with the three kinds and migration order (text corrected). File selection was not exercised in the browser.

### 2026-10-01 - Claude Business One defaults for sales sign-off (ADR-043)

- Product owner asked to resolve the four open sales points as Business One does. Implemented ADR-043: optional sales price tolerance (blank = unrestricted, the default for new and existing tenants); override permissions unchanged (owner, administrator); A/R invoices accept paymentTermsId and billToAddressId overriding the base-order defaults, store payment terms and print them; generic invoice layout kept.
- Files: new apps/api/migrations/0018_sales_b1_defaults.sql; modified apps/api/src/{database/schema.ts,sales/ar-invoices.service.ts}, apps/api/test/sales.test.ts, packages/contracts/src/sales.ts, apps/desktop/src/main/{invoice-document.ts,invoice-document.test.ts}, apps/desktop/src/renderer/forms/{SalesForms,SettingsForms}.tsx, docs/DECISIONS.md, this file.
- Verification: pnpm build, typecheck and lint exit 0; pnpm test exit 0: API 141/141, worker 4/4, desktop 7/7; pnpm db:migrate applied 0018. Two intermediate test failures were test-setup errors (quantity already invoiced; reused fully invoiced order), corrected. Desktop changes not checked in a browser this run.

### 2026-10-01 - Claude sales fixes: credit lock, price control, invoice printing, order header (ADR-039 to ADR-042)

- Branch and commit: master at 5d47008; all prior uncommitted work preserved; nothing staged, committed or pushed.
- Completed:
  - ADR-039: credit-exposure lock only for exposure-changing writes and only under Warn/Block; shared/exclusive credit-policy lock for policy changes; reads take no credit lock.
  - ADR-040: sales price tolerance (sales_settings, Document Settings), PRICE_VARIANCE, sal.invoice.override and sal.setup.administer, price_override flag, source_price per line, audited override; desktop override checkbox.
  - ADR-041: company profile (Company Details, admin.company.edit), invoice print snapshot, GET /v1/sal/invoices/:id/document, Electron main-process HTML rendering with Print and Save as PDF.
  - ADR-042: price-list defaults and blank-price rejection (orders and quotations), GET /v1/sal/prices, order payment terms and bill-to/ship-to snapshots, invoice terms and bill-to from the first line's order, non-blocking stock warnings.
  - Defect fixed: the desktop renderer allowlist omitted `sal`, so every Sales request would have been rejected in Electron; earlier browser checks used a bridge that bypassed it. Added `sal` and allowlist tests.
  - DECISIONS.md: ADR-036 to ADR-038 rejoined to the table; ADR-038 and ADR-035 statuses cross-referenced.
- Files added: apps/api/migrations/{0015_sales_price_control,0016_invoice_print,0017_sales_order_header}.sql, apps/api/src/tenancy/company-profile.service.ts, packages/contracts/src/company.ts, apps/desktop/src/main/{invoice-document.ts,invoice-document.test.ts}. Files modified: apps/api/src/{database/database.service.ts,database/schema.ts,app.module.ts,tenancy/tenant.controller.ts,sales/*.ts,banking/payments.service.ts,finance/{journals,opening-balances}.service.ts,business-partners/business-partners.service.ts}, apps/api/test/{sales,credit}.test.ts, packages/contracts/src/{sales,quotations,permissions,index}.ts, apps/desktop/src/main/{main.ts,api-session.ts,api-session.test.ts}, apps/desktop/src/preload/preload.cts, apps/desktop/src/renderer/{erp.d.ts,screens/Shell.tsx,forms/{SalesForms,QuotationForm,SettingsForms,CompanyDetailsForm}.tsx}, docs/DECISIONS.md, this file.
- Verification: pnpm build exit 0 (Vite bundle warning, 608 kB); pnpm typecheck exit 0; pnpm lint exit 0; pnpm test exit 0: API 141/141, worker 4/4, desktop 7/7. pnpm db:migrate applied 0015-0017 to the development database (0015 backfilled existing invoice lines). git diff --check: only the existing blank line at EOF in packages/ui/src/components.tsx. Mutation checks (compiled output, restored after each): unconditional credit lock, disabled price-variance check, ignored print snapshot, ignored other-order commitments and customer instead of order terms each failed the corresponding new test.
- Intermediate failures: a shell heredoc quoting error (no change applied); a test with an await inside send() failed with ECONNREFUSED, corrected; the price-list PUT returns 204, test expectation corrected; a sed edit of the allowlist did not match, so the new allowlist test failed until the exact edit was applied.
- Browser check: built-in browser against the live API, with a temporary Vite config (removed) whose middleware reused the compiled desktop ApiSession and signed in with the seed credentials from the environment; .claude/launch.json restored. Saved a company profile; Document Settings showed both tolerances; a sales order with a blank price was rejected with the price-list message; SO2 at 9.00 showed price list SALES; DN2 posted; an A/R invoice at 9.50 was rejected with PRICE_VARIANCE and posted as IN2 with the override; the IN2 printable invoice rendered with the profile snapshot, tax summary, totals and footer. No console or server errors. Not verified in Electron (hidden-window printToPDF, print dialog and native save dialog).
- Remaining: SAL-02 approvals and reservation policy; customer-specific price lists; Electron runtime verification; earlier blockers unchanged.
- Next action: as in "Next action" above.

### 2026-10-01 - Claude state analysis and re-verification

- Branch and commit: master at 5d47008; all slices from 2026-09-29 and 2026-09-30 remain uncommitted (32 modified tracked files, about 1,530 added and 256 removed lines; 41 untracked paths outside .claude/, about 14,200 lines). No source changed in this session.
- Verification: pnpm build exit 0 (existing Vite renderer bundle-size warning); pnpm typecheck exit 0; pnpm lint exit 0; pnpm test exit 0: API 135/135, worker 4/4, desktop 4/4, against the PostgreSQL instance listening on 127.0.0.1:55432. git diff --check reports one issue: a blank line at EOF in packages/ui/src/components.tsx. No SAP or Business One strings in apps or packages source; no comment lines in changed or new source files.
- Findings: ADR-036 to ADR-038 in docs/DECISIONS.md are separated from the table by blank lines, so they do not render as table rows. The uncommitted work is large and exists only in this working copy.
- Sales review (read-only): every sales, quotation and payment request, including list and get, takes the exclusive per-tenant credit-exposure advisory lock even when the policy is Disabled; A/R invoice unit prices can be changed without permission, tolerance or audit (unlike A/P ADR-025 c); orders take typed prices with no price-list default and the desktop sends 0 for an empty price; order headers have no bill-to/ship-to address or payment terms (SAL-02); no inventory availability warning on orders (SAL-02); invoices spanning orders from different branches take the first line's branch; the credit check evaluates total exposure, so a customer already over the limit is blocked on deliveries of previously approved orders. The PRD defers returns and credit notes from V1, while the M4 row above lists them as remaining.
- Next action: product owner decides whether to commit the uncommitted slices; then SAL-04 printable A/R invoice output as in "Next action" above.

### 2026-09-30 - Codex customer credit policy (ADR-038)

- Branch: master at 5d47008. Prior uncommitted changes preserved; nothing staged, committed or pushed.
- Completed SAL-06: tenant Disabled/Warn/Block policy, version-checked settings with API permissions, zero-limit semantics, warning acknowledgement and reasoned permissioned overrides with audit. Orders, deliveries, A/R invoices and quotation conversion check resulting exposure atomically. The shared exposure calculation counts customer journal balance, open order remaining net amounts and uninvoiced deliveries; pending tax is excluded, posted invoice tax included. Customer balance display uses the same calculation.
- Concurrency: credit-sensitive service transactions acquire a common tenant lock before other locks. This includes payments/cancellations, journals/reversals, opening balances/import posting, partner updates and policy changes. Corrections remain allowed when over limit. A blocked sale rolls back stock, quantities, journals, numbering and document/idempotency rows.
- Desktop: Administration > System Initialization > Sales Credit Policy; a native HTML modal shows exposure, limit and acknowledgement or required override reason on the four sales entry paths. The retry preserves the decision payload for idempotency, prevents background edits while pending, and cancels the pending decision on unmount. New tenant policies default Disabled; the owner enables Warn or Block.
- Files added: apps/api/migrations/0014_credit_policy.sql, apps/api/src/sales/{credit.service.ts,credit-exposure.ts}, apps/api/test/credit.test.ts, packages/contracts/src/credit.ts, apps/desktop/src/renderer/forms/CreditControls.tsx. Files modified: apps/api/src/{app.module.ts,database/database.service.ts,database/schema.ts,sales/{sales.controller.ts,sales-orders.service.ts,deliveries.service.ts,ar-invoices.service.ts,quotations.service.ts},business-partners/business-partners.service.ts,banking/payments.service.ts,finance/{journals.service.ts,opening-balances.service.ts}}, packages/contracts/src/{index.ts,permissions.ts,sales.ts,quotations.ts}, apps/desktop/src/renderer/{forms/SalesForms.tsx,forms/QuotationForm.tsx,forms/BusinessPartnerForm.tsx,screens/Shell.tsx,app.css}, docs/DECISIONS.md and this handoff.
- Verification: pnpm build exit 0; pnpm typecheck exit 0; pnpm lint exit 0; pnpm test exit 0: API 135/135, worker 4/4, desktop 4/4 (143 total). After the modal refinement, pnpm --filter @nec/desktop run typecheck and run build both exit 0; final lint and git diff --check exit 0. Vite still warns about the renderer bundle (599.78 kB). pnpm db:migrate exit 0: applied 0014 to development, skipped 0001-0013. Test setup exercised all migrations from empty schema.
- Seven credit tests cover default/versioned/isolated policies and permissions, exact/zero limit, concurrent orders, warnings/override and single audit on replay, blocked delivery rollback, invoice tax, incoming payment and its cancellation, opening receivables, quotation conversion rollback, manual journals, order close and invoice cancellation. A deterministic overlapping-transaction test fails when the credit lock is removed (both orders return 201 instead of 201/409); compiled mutation restored before the full green run.
- Intermediate failures: a test helper typed its body as unknown, corrected to object; the first concurrency fixture incorrectly treated the numbering-series list response as one object, so requests used the default series and the lock-removal mutation passed. Corrected the fixture with explicit IDs and assertions, and held the first decision open to guarantee overlap; the mutation now fails as intended. A PowerShell brace-path command failed before execution. Temporary UI preview file creation initially used the wrong working-directory prefix, then was corrected; preview files removed and server stopped.
- Runtime limitation: browser security rejected http://127.0.0.1:5191 because preview permission was declined. No alternate browser/tool was attempted; visual and Electron runtime verification remain pending. Existing jurisdiction, accountant and infrastructure blockers remain.
- Next action: implement SAL-04 printable A/R invoice PDF output with tenant-scoped access, preserving posted values and cancellation status. Credit-policy implementation is complete; production review and native UI verification remain.

### 2026-09-30 - Codex credit exposure display; limit checkpoint

- Completed SAL-06 prerequisite: customer balance API and Business Partner form now show open order value, uninvoiced deliveries, total exposure and remaining credit. Order-to-delivery-to-invoice quantities avoid double counting; posted invoice tax enters through the account balance. Pending documents exclude tax. This is informational only: tenant policies, transactional warning/block enforcement, locking and audited overrides remain unimplemented.
- Files changed: apps/api/src/business-partners/business-partners.service.ts, packages/contracts/src/purchasing.ts, apps/desktop/src/renderer/forms/BusinessPartnerForm.tsx, apps/api/test/sales.test.ts, docs/DECISIONS.md and this file.
- Verification: pnpm build exit 0 (existing Vite bundle warning); node node_modules/typescript/bin/tsc -p apps/api/tsconfig.json exit 0; node --env-file=../../.env --test dist/test/sales.test.js from apps/api exit 0, 6/6 passed including exposure transition assertions; pnpm lint exit 0. Initial edit script failed with SyntaxError before any changes; replaced by a patch and verified. No migration. Full suite and Electron runtime were not rerun.
- Usage started at 84%, last measured 94%; stopped feature work to respect the 95% threshold. Uncommitted, nothing staged or pushed; prior work preserved.
- Next action: finish SAL-06 tenant credit policy, atomic enforcement across order/fulfillment, permissioned override with audit and concurrency tests. Do not use the display query as posting authorization; revalidate within the posting transaction.

### 2026-09-30 - Codex sales quotations (ADR-036)

- Branch and commit: master at 5d47008; preserved all pre-existing uncommitted work. No commit, staging or push.
- Completed: Sales Quotation API and desktop form: create/save and edit drafts, issue, server-derived expiry in the tenant time zone, close/cancel, list/find, and Copy To Sales Order. Conversion creates one full order atomically, retains quotation and line links, preserves quoted pricing, and closes the quotation. Retries replay the order; concurrent conversions produce one order. Stock and journals are unaffected by quotations. Existing sales-order validation is shared with quote preparation and conversion. Items used by quotations cannot change transactional type or unit.
- Migration 0013_sales_quotations.sql: forced RLS and tenant foreign keys on quotations and lines; source links on orders and lines; unique order per quotation; SQ numbering backfill and provisioning; quotation permissions for owner, administrator and salesperson, read access for accountant and auditor. Both edit-quotation and create-order permissions guard conversion.
- Files changed this run: new apps/api/migrations/0013_sales_quotations.sql, apps/api/src/sales/quotations.service.ts, apps/api/test/quotations.test.ts, packages/contracts/src/quotations.ts, apps/desktop/src/renderer/forms/QuotationForm.tsx; modified apps/api/src/{sales/sales-orders.service.ts,sales/sales.controller.ts,app.module.ts,database/schema.ts,platform/platform.service.ts,inventory/stock.service.ts}, packages/contracts/src/{sales.ts,index.ts,finance.ts,permissions.ts}, apps/desktop/src/renderer/{forms/SalesForms.tsx,screens/Shell.tsx}, docs/DECISIONS.md and this file.
- Verification: pnpm test exit 0: API 128/128, worker 4/4, desktop 4/4 (136 total, no failures). pnpm db:migrate exit 0: applied 0013_sales_quotations.sql to the existing development database, skipped 0001-0012; test setup also ran all migrations from an empty schema. Targeted quotation tests 5/5 passed: lifecycle, pricing/source links, no stock/journal effects, audit, replay/conflict, concurrent conversion, expiry including backdating, rollback, validation, permissions and direct RLS isolation. pnpm lint exit 0; git diff --check exit 0 (line-ending warnings only). pnpm build exit 0 with Vite bundle warning (594.40 kB); pnpm typecheck exit 0. An earlier build/typecheck/test attempt failed on an audit payload TypeScript mismatch; corrected with an object spread. An intermediate typecheck found the test's incorrect audit_log table name; corrected to audit_events. pnpm --filter @nec/api exec tsc failed because exec could not resolve tsc; the workspace scripts and node node_modules/typescript/bin/tsc work. Before the new tests were added, the existing API suite passed 123/123.
- Remaining and limitations: credit-limit checks and invoice PDFs are next; remaining M1/M2/M3/M5 work is unchanged. Full single-order quote conversion is the documented V1 scope; partial/multiple conversion and lead quotes are deferred. No Electron/browser runtime verification in this run. Existing infrastructure and accountant/jurisdiction blockers remain. The daily automation remains active; observed usage was 31% at start and 75% during final verification (weekly 18%), below the 95% stop threshold.
- Exact next action: implement SAL-06 customer credit-limit warnings/blocks and audited permissioned override in the API and sales UI, using verified Business One flow conventions.

### 2026-09-30 - Claude sales flow and A/R invoices in aging (ADR-035)

- Branch and commit: master at 5d47008; builds on the uncommitted slices; nothing committed.
- Completed: Recorded ADR-035.
  - Migration 0012_sales.sql: sales_orders/lines, deliveries/lines, ar_invoices/lines with linked single-use cancellations, payment_allocations.ar_invoice_id (exactly one target via num_nonnulls), SO/DN/IN numbering, sal module for plans and tenants, sal.* permissions and the Salesperson system role, forced RLS on the six new tables.
  - API /v1/sal: orders (list, get, create, status), deliveries (list, get, post, cancel), invoiceable?customerId=, invoices (list, get, post, cancel). Services in apps/api/src/sales. Incoming payments allocate to A/R invoices; open-receivables lists them; A/R aging shows A/R invoice rows; partner balance counts open A/R invoices for customers; item stock reports committed quantity from open orders; stock movement listing shows delivery numbers; items used on sales orders count as in use.
  - Desktop: Sales - A/R > Sales Order, Delivery and A/R Invoice (apps/desktop/src/renderer/forms/SalesForms.tsx) with Copy To Delivery and Copy To A/R Invoice; Incoming Payments grid pays A/R invoices; aging and Inventory Audit labels.
- Files changed: new apps/api/migrations/0012_sales.sql, apps/api/src/sales/{sales-orders,deliveries,ar-invoices}.service.ts, apps/api/src/sales/sales.controller.ts, apps/api/test/sales.test.ts, packages/contracts/src/sales.ts, apps/desktop/src/renderer/forms/SalesForms.tsx; modified apps/api/src/{app.module.ts,database/schema.ts,database/seed.ts,platform/platform.service.ts,banking/payments.service.ts,finance/aging.service.ts,inventory/stock.service.ts,business-partners/business-partners.service.ts}, packages/contracts/src/{index,permissions,finance,banking}.ts, apps/desktop/src/renderer/{screens/Shell.tsx,forms/BankingForms.tsx,forms/ReportForms.tsx,forms/StockForms.tsx,forms/PurchasingForms.tsx,forms/CompanyDetailsForm.tsx}, docs/DECISIONS.md, this file.
- Verification and results: pnpm build exit 0; pnpm lint exit 0; pnpm typecheck exit 0; pnpm test: API 123/123 (6 new sales tests), worker 4/4, desktop 4/4. The tests cover scenario 5 (order 10, deliver 6 with COGS 30 at average 5, invoice 6 with 10% tax 72 + 7.20, over-delivery and over-invoice refused, deliver and invoice the remaining 4, order closed as fulfilled, committed stock, customer balance 132); service lines invoiced from the order with a changed price while stock lines are refused on that path and on deliveries; insufficient stock refused without side effects, non-sales item, vendor as customer and dates validated, idempotent delivery replay, cancellation of an order with deliveries refused; incoming payment on an A/R invoice, over-allocation refused, A/R aging row and reconciliation, invoice cancellation blocked while paid and allowed after unallocation (3 concurrent attempts produce one, reversing journal, invoiced quantities restored), delivery cancellation blocked while invoiced then allowed (stock and order restored); delivery cancellation blocked after a later delivery (VALUATION_BLOCKED); tenant isolation, auditor read-only, Salesperson role without delivery posting, closed period. A test that built a request before awaiting another request inside send() failed with ECONNREFUSED; the test was corrected. Mutation checks: removing the over-delivery check and the paid-invoice cancellation block each failed a test; restored. pnpm db:migrate applied 0012 to the development database. End-to-end in the built-in browser with the temporary proxy renderer against the live API (launch.json restored): SO1 (5 x A-100 at 9.00) -> Copy To Delivery DN1 for 3 (cost 12.60, JE7) -> Copy To A/R Invoice IN1 27.00 (JE8), A/R aging row IN1 reconciling -> Incoming Payment allocating 27.00 to IN1, open amount 0. Not verified in Electron.
- In progress: quotations, credit limits, invoice PDFs; partner, item and price imports.
- Blockers: Accountant and jurisdiction sign-off on ADR-022 to ADR-035; Electron launch still unverified.
- Exact next action: As in "Next action" above.

### 2026-09-30 - Claude customer aging (ADR-034)

- Branch and commit: master at 5d47008; builds on the uncommitted slices; nothing committed.
- Completed: Recorded ADR-034. AgingService now computes both sides from one implementation (A/P output unchanged); GET /v1/fin/reports/ar-aging?asOf=&basis=&customerId= (fin.report.view) with customer opening lines, unapplied incoming payments and other receivable-control postings, control account 1200 balance and difference. Contracts arAgingQuery, ArAgingReport, ArAgingCustomer, ArAgingDocument. Desktop: AgingForm serves Vendor Liabilities Aging and the new Financials > Financial Reports > Aging > Customer Receivables Aging (same filters, expandable rows, reconciliation line, CSV export). The Company Details note no longer lists incoming payments and stock transactions as planned.
- Files changed: new apps/api/test/ar-aging.test.ts; modified apps/api/src/finance/{aging.service.ts,finance.controller.ts}, packages/contracts/src/finance.ts, apps/desktop/src/renderer/{forms/ReportForms.tsx,forms/CompanyDetailsForm.tsx,screens/Shell.tsx}, docs/DECISIONS.md, this file.
- Verification and results: pnpm build exit 0; pnpm lint exit 0; pnpm typecheck exit 0; pnpm test: API 117/117 (4 new A/R aging tests; the 4 A/P aging tests still pass after the refactor), worker 4/4, desktop 4/4. The tests cover buckets for an over-90 partly received opening line, a 61-90 line, a manual customer journal and a payment on account, exact customer and grand totals, control balance with zero difference, vendor items excluded; posting-date basis and customer filter; history after unallocation, payment cancellation and opening balance cancellation; tenant isolation, auditor access, invalid date. Mutation check: removing the partner-type filter on opening lines failed the first test; restored. End-to-end in the built-in browser with the temporary proxy renderer against the live API (launch.json restored): C2000 showed OB2/2 50.00 current and OB3/2 50.00 in 31-60 days, receivables control 100.00 reconciling; Export to CSV produced Customer Aging 2026-09-30.csv. Not verified in Electron.
- In progress: sales flow (orders, deliveries, A/R invoices); partner, item and price imports.
- Blockers: Accountant and jurisdiction sign-off on ADR-022 to ADR-034; Electron launch still unverified.
- Exact next action: As in "Next action" above.

### 2026-09-30 - Claude incoming payments and opening balance import (ADR-032, ADR-033)

- Branch and commit: master at 5d47008; builds on the uncommitted slices; nothing committed.
- Completed: Recorded ADR-032 and ADR-033.
  - Migration 0011_incoming_payments.sql: outgoing_payments renamed to payments (vendor_id to partner_id, direction column, same-direction cancellation foreign key, renamed indexes and policy), IP numbering series via seed_banking_defaults.
  - API: PaymentsService (replaces OutgoingPaymentsService) serves both directions; /v1/bank/incoming-payments (list, get, post, allocations, unallocate, cancel) and /v1/bank/open-receivables?customerId=; outgoing routes and response shape unchanged. Opening balance cancellation lists blocking payments of either direction.
  - API: POST /v1/fin/opening-balances/import (kind account or partner) and POST /v1/inv/opening-balances/import with mode validate or commit; CSV parser in apps/api/src/common/csv.ts; OpeningImportService resolves codes, collects row errors, dry-runs through OpeningBalancesService (new dryRun option) or the inventory preview, and commits with the import source in the audit record. bootstrap.ts now registers JSON body parsing itself: 3 MB for the two import routes, 100 KB elsewhere; express ^5.2.1 added as a direct API dependency (offline install from the existing store; lockfile updated).
  - Contracts: Payment, IncomingPayment, PaymentSummary, incoming request schemas, OpenPaymentItem; OPENING_IMPORT_COLUMNS, OPENING_IMPORT_TEMPLATES, import request and result types; incoming_payment document type.
  - Desktop: Banking > Incoming Payments (PaymentForm with direction, shared with Outgoing Payments); Import from File panel (template download, file choice, Validate with an error table, Import) on G/L Accounts, Business Partners and Inventory Opening Balance windows.
- Files changed: new apps/api/migrations/0011_incoming_payments.sql, apps/api/src/banking/payments.service.ts, apps/api/src/common/csv.ts, apps/api/src/finance/opening-import.service.ts, apps/api/test/{incoming-payments,opening-import}.test.ts, apps/desktop/src/renderer/forms/OpeningImportPanel.tsx; removed apps/api/src/banking/outgoing-payments.service.ts; modified apps/api/{package.json,src/bootstrap.ts,src/app.module.ts,src/banking/banking.controller.ts,src/database/schema.ts,src/finance/{aging,opening-balances}.service.ts,src/finance/finance.controller.ts,src/inventory/{stock-transactions.service,stock-transactions.controller}.ts,src/purchasing/ap-invoices.service.ts}, pnpm-lock.yaml, packages/contracts/src/{banking,finance,opening-balances}.ts, apps/desktop/src/renderer/{screens/Shell.tsx,forms/BankingForms.tsx,forms/OpeningBalanceForms.tsx,forms/InventoryTransactionForms.tsx}, docs/DECISIONS.md, this file.
- Verification and results: pnpm build exit 0; pnpm lint exit 0 (after replacing two literal byte-order marks with escapes); pnpm typecheck exit 0; pnpm test: API 113/113 (4 incoming-payment and 6 import tests new), worker 4/4, desktop 4/4. The tests cover:
  - incoming payment against two customer opening lines with remainder on account, journal 1110/1200 with partner code, partner balance, later allocation, cash account default; vendor, vendor line, A/P invoice and over-allocation rejected; outgoing payment cannot use a customer line; directions separated for get, list and cancel; unallocation and double unallocation, reallocation, 3 concurrent cancellations produce one, reversal journal, opening balance cancellation blocked while allocated and allowed afterwards; tenant isolation and auditor read-only;
  - import: template validate without posting, commit, idempotent replay, audit source; unknown and missing columns, empty file, unclosed quote, unknown code, bad amount, both amounts, duplicate account, posting-rule error mapped to its row, missing period as file-level error; partner import with byte-order mark, lower-case header and codes, quoted comma and quotes, thousands separator, invalid calendar date, future document date, default due date, open items for both directions; 1,800-row file above 100 KB accepted and 2,001 rows refused; inventory import with unknown codes, zero quantity, bad cost, moving average and prior-stock rule mapped to its row; permissions and tenant-scoped code resolution.

  Mutation checks: removing the direction filter on payment lookup failed the direction test; making the dry run post for real failed the validate test; both restored. pnpm db:migrate applied 0011 to the development database. End-to-end in the built-in browser with the temporary proxy renderer against the live API (launch.json restored afterwards): IP1 posted with JE5 allocating 150 to OB2/2; a partner CSV with an unknown BP code and a bad date showed both errors on rows 3 and 4; the corrected file validated (2 rows) and imported as OB3 with JE6 and a NET30 due date; Download Template produced gl-opening-balances.csv with a byte-order mark. Not verified in Electron (native file dialogs not exercised).
- In progress: customer aging; sales documents and A/R invoices; partner, item and price imports.
- Blockers: Accountant and jurisdiction sign-off on ADR-022 to ADR-033; Electron launch still unverified.
- Exact next action: As in "Next action" above.

### 2026-09-30 - Claude opening balances (ADR-030, ADR-031)

- Branch and commit: master at 5d47008; builds on the uncommitted 2026-09-29 slices; nothing committed.
- Completed: Recorded ADR-030 (product owner: tax regime follows the Business One approach of a generic, tenant-configured, date-versioned tax-code model; no country localization or compliance claim; first production country still open) and ADR-031 (opening balances).
  - Migration 0010_opening_balances.sql: opening_balances and opening_balance_lines (account or partner lines, reference, document and due dates, paid amount), linked single-use cancellations, OB and IO numbering series, payment_allocations.opening_line_id with an exactly-one-target check, inventory_adjustments direction 'opening', fin.opening.post/cancel and inv.opening.post/cancel for owner, administrator and accountant, forced RLS on both new tables.
  - API /v1/fin/opening-balances: list, get, POST accounts, POST partners, cancel. Offset defaults to the Opening Balance Offset determination (3900); control and inventory accounts refused on G/L lines and as offset; partner due dates default from payment terms; cancellation blocked while payments are allocated.
  - API /v1/inv/opening-balances: list, get, preview, post, cancel (unit cost required; refused when the item already has non-cancelled stock movements in that warehouse; OPENING_BALANCE_EXISTS). /v1/inv/adjustments no longer lists or accepts opening documents.
  - Outgoing payments allocate to A/P invoices or vendor opening lines (allocations carry invoiceId or openingLineId); open-invoices lists both; A/P aging shows vendor opening lines as opening_balance rows aged from their document dates.
  - Desktop: Administration > System Initialization > Opening Balances > G/L Accounts Opening Balance and Business Partners Opening Balance (new OpeningBalanceForms.tsx), Inventory > Inventory Transactions > Inventory Opening Balance (InventoryAdjustmentForm with direction 'opening'), Outgoing Payments grid handles opening lines, aging and Inventory Audit labels. Fixed a CSS specificity bug that left-aligned all numeric table cells (.ui-table td.numeric).
- Files changed: new apps/api/migrations/0010_opening_balances.sql, apps/api/src/finance/opening-balances.service.ts, apps/api/test/opening-balances.test.ts, packages/contracts/src/opening-balances.ts, apps/desktop/src/renderer/forms/OpeningBalanceForms.tsx; modified apps/api/src/{app.module.ts,database/schema.ts,platform/platform.service.ts,finance/finance.controller.ts,finance/aging.service.ts,banking/outgoing-payments.service.ts,inventory/stock-transactions.service.ts,inventory/stock-transactions.controller.ts}, packages/contracts/src/{index,permissions,finance,banking,stock-transactions}.ts, apps/desktop/src/renderer/{app.css,screens/Shell.tsx,forms/BankingForms.tsx,forms/InventoryTransactionForms.tsx,forms/ReportForms.tsx,forms/StockForms.tsx}, docs/DECISIONS.md, this file.
- Verification and results: pnpm build exit 0; pnpm lint exit 0; pnpm typecheck exit 0; pnpm test: API 103/103 (8 new opening-balance tests), worker 4/4, desktop 4/4. Tests ran against a new PostgreSQL 18 scratch cluster on port 55432 (the previous one no longer existed). The tests cover:
  - G/L opening with offset credit, balanced entry without offset, idempotent replay and conflicting key, manual journal reversal refused;
  - rejection of control, inventory, title, offset-as-line and duplicate accounts, ambiguous amounts, control or inventory offset; custom offset;
  - cancellation: 3 concurrent attempts produce one, reversing journal, cancellation of a cancellation refused, date before the document refused;
  - partner opening for a vendor and a customer: journal on 2100/1200 with partner codes, partner balances, open items in open-invoices, aging buckets by due date and control-account reconciliation, allocation to another vendor's or a customer's line refused, both targets refused, over-allocation, payment of two lines, historical aging unchanged, cancellation blocked while allocated then allowed after unallocation;
  - due date from NET30 terms, document date after posting date, due before document date, unknown partner;
  - inventory opening preview without side effects, journal 1300/3900, moving average across two warehouses, second opening refused, duplicate lines, missing cost, control offset, list separation from adjustments, direction 'opening' refused on /adjustments;
  - opening refused after a goods receipt, re-entry allowed after cancellation, cancellation blocked by a later goods issue (VALUATION_BLOCKED);
  - tenant isolation (404 and cross-tenant partner and account 400), auditor read-only, closed period for both documents and for cancellation.

  Mutation checks: disabling the allocated-cancellation guard failed the partner test; removing the cancelled-opening exclusion failed the re-entry test; both restored. pnpm db:migrate applied 0010 to the development database. End-to-end in the built-in browser: the Vite renderer ran with a temporary scratch config that proxied /v1 to the live API (pnpm dev:api) and injected a fetch-based bridge in place of the Electron preload (not committed; .claude/launch.json restored). Signed in as the Acme owner and posted OB1 (G/L, JE1), OB2 (vendor and customer lines, JE2, NET30 due date), OP1 paying 200 of OB2/1 (JE3; aging 300 open, difference 0) and IO1 (25 at 4.20, JE4); a second opening for the same item and warehouse returned 409. Not verified in Electron.
- In progress: A/R side (sales documents, incoming payments, customer aging); REP-03 spreadsheet import for opening balances.
- Blockers: Accountant and jurisdiction sign-off on ADR-022 to ADR-031; Electron launch still unverified.
- Exact next action: As in "Next action" above.

### 2026-09-30 - Claude state analysis and re-verification

- Branch and commit: master at 5d47008; the three slices from 2026-09-29 (outgoing payments, stock transactions, A/P aging) remain uncommitted (22 modified, 17 untracked paths). No code changed in this session.
- Verification and results: pnpm build exit 0; pnpm lint exit 0; pnpm typecheck exit 0. The first pnpm test run failed all API tests with ECONNREFUSED on 127.0.0.1:55432 because the previous scratch PostgreSQL cluster no longer existed; a new PostgreSQL 18 cluster was created in this session's scratch directory per docs/DEVELOPMENT.md "Without Docker" and pnpm run setup -- --skip-infra applied 0001-0009 and seeded. pnpm test then: API 95/95, worker 4/4, desktop 4/4. Migrations 0008 and 0009 force RLS with a policy on every new table; payment_allocations has an update/delete trigger.
- Blockers: unchanged (Docker/WSL, Electron never launched, accountant sign-off on ADR-022 to ADR-029).
- Exact next action: product owner decides whether to commit the three uncommitted slices; then opening balances and opening stock (FIN-06).

### 2026-09-29 - Claude A/P aging (ADR-029)

- Branch and commit: master; builds on the uncommitted payment and stock slices; nothing committed in this slice.
- Completed: Recorded ADR-029.
  - API GET /v1/fin/reports/ap-aging?asOf=&basis=due_date|posting_date&vendorId= (fin.report.view): as-of reconstruction from posted invoices, payments and allocation events; unapplied payments negative; other supplier postings to the payables control account as journal rows; five buckets; per-vendor documents and totals; payables control balance and difference; tenant, basis and generation time.
  - Desktop: Financials > Financial Reports > Aging > Vendor Liabilities Aging (aging date, age by, vendor filter, expandable vendor rows, totals, reconciliation line, Export to CSV). New IPC erp:save-text-file with native save dialog, .csv name pattern and 10 MB limit (apps/desktop/src/main/export-file.ts); CSV has a UTF-8 BOM and formula-injection protection.
- Files changed: new apps/api/src/finance/aging.service.ts, apps/api/test/ap-aging.test.ts, apps/desktop/src/main/{export-file.ts,export-file.test.ts}, apps/desktop/src/renderer/forms/ReportForms.tsx; modified packages/contracts/src/finance.ts, apps/api/src/{finance/finance.controller.ts,app.module.ts}, apps/desktop/src/main/main.ts, apps/desktop/src/preload/preload.cts, apps/desktop/src/renderer/{erp.d.ts,app.css,screens/Shell.tsx}, docs/DECISIONS.md, this file.
- Verification and results: pnpm build exit 0; pnpm lint exit 0; pnpm typecheck exit 0; pnpm test: API 95/95 (4 new aging tests), worker 4/4, desktop 4/4 (1 new export-validation test). The aging tests cover:
  - scenario 6: invoice of 100 partly paid by 40 shows 60 in the over-90 bucket (91 days past its NET30 due date); invoice 50, payment on account -15 and a manual journal of 7 in 1-30; exact vendor and grand totals; control account 2100 balance equal to the aging total (difference 0);
  - posting-date basis and vendor filter with a vendor-level control balance;
  - earlier as-of dates reproduce earlier positions; after an unallocation (7/5) and a payment cancellation (7/15), the 6/30 aging is unchanged and the 7/20 aging shows the restored invoice and the unapplied payment, still reconciling;
  - invoices cancelled by the as-of date drop out; tenant isolation for another tenant's auditor; invalid date rejected.

  Mutation check: removing the as-of filter on invoice allocation events failed the history test; restored. The report and CSV export were checked in the built-in browser with a temporary mock bridge (reconciliation line, expandable rows, BOM, quoted comma, neutralised formula text). Not verified in Electron: the native save dialog has not been exercised. No migration in this slice.
- In progress: opening balances and opening stock; A/R side.
- Blockers: Accountant confirmation of aging conventions and ADR-022 to ADR-029; Electron launch still unverified.
- Exact next action: As in "Next action" above.

### 2026-09-29 - Claude stock transfers and adjustments (ADR-028)

- Branch and commit: master; builds on uncommitted outgoing payments; nothing committed in this slice.
- Completed: Recorded ADR-028.
  - Migration 0009_stock_transfers_adjustments.sql: stock transfers and lines, inventory adjustments (receipt/issue) and lines, linked single-use cancellation documents, ST/SR/SI numbering series, permission grants for existing roles.
  - API /v1/inv: transfers (list, get, post, cancel), adjustments (list with direction filter, get, preview, post, cancel). The preview performs the full posting in a transaction and rolls it back.
  - StockService: document-level latest-movement check (assertDocumentIsLatest) replaces the per-movement check in goods receipt and A/P invoice cancellation, fixing a false VALUATION_BLOCKED on documents with two lines of the same item; issueValue helper; stock movement listing now shows document numbers for A/P invoices, transfers and adjustments.
  - Desktop: Inventory > Inventory Transactions > Goods Receipt, Goods Issue (Add shows the server valuation impact and journal preview, then Post) and Inventory Transfer (source warehouse stock per line); Inventory Audit Report labels for new source types.
- Files changed: new apps/api/migrations/0009_stock_transfers_adjustments.sql, apps/api/src/inventory/{stock-transactions.service.ts,stock-transactions.controller.ts}, apps/api/test/stock-transactions.test.ts, packages/contracts/src/stock-transactions.ts, apps/desktop/src/renderer/forms/InventoryTransactionForms.tsx; modified apps/api/src/{app.module.ts,database/schema.ts,platform/platform.service.ts,inventory/stock.service.ts,purchasing/goods-receipts.service.ts,purchasing/ap-invoices.service.ts}, packages/contracts/src/{index,permissions,finance}.ts, apps/desktop/src/renderer/{screens/Shell.tsx,forms/StockForms.tsx}, docs/DECISIONS.md, this file.
- Verification and results: pnpm build exit 0; pnpm lint exit 0; pnpm typecheck exit 0; pnpm test: API 91/91 (7 new stock-transaction tests), worker 4/4, desktop 3/3. The tests cover:
  - preview without side effects (no stock, no document, same number when posted), receipt journal, default cost from average, unit cost required without stock;
  - goods issue at moving average with no residue (3 x 3.3333 issued as 3.3333 + 6.6666), over-issue and wrong-warehouse rejection, custom offset account, control and inventory accounts rejected as offset;
  - transfers: same-warehouse rejection, insufficient stock, idempotent replay, per-warehouse quantities, unchanged item value, journal only across different inventory accounts, movement document numbers;
  - cancellation: VALUATION_BLOCKED after later movements, 3 concurrent attempts produce one, reversal journals, stock restored, cancellation of a cancellation refused;
  - documents with two lines of the same item (adjustment and goods receipt) can be cancelled;
  - scenario 17 (receipt of 10, issue of 6, receipt reversal blocked) and the previously untested partial revaluation split (invoice 10 at 6 against 4 on hand: revaluation 4.00, price difference 6.00, stock value 24.00, average 6.00);
  - closed period, tenant isolation (404 and cross-tenant warehouse 400), auditor read-only.

  A defect found by the tests (an empty IN list produced invalid SQL and a 500 for a cross-tenant transfer) was fixed. Mutation check: restricting the document-level check to one movement failed 2 tests; restored. pnpm db:migrate applied 0009 to the seeded development database. Goods Issue (add, preview, post, view) and Inventory Transfer (add with source stock) were checked visually in the built-in browser with a temporary mock bridge. Not verified in Electron against the live API.
- In progress: A/P aging; opening stock and balances; A/R side.
- Blockers: Accountant and jurisdiction sign-off on ADR-022 to ADR-028; an approved correction procedure for documents blocked by the strict latest-movement rule.
- Exact next action: As in "Next action" above.

### 2026-09-29 - Claude outgoing payments (ADR-027)

- Branch and commit: master; initial commit 5d47008 created at the user's request (everything up to the A/P refinements); this slice is uncommitted.
- Completed: Recorded ADR-027.
  - Migration 0008_outgoing_payments.sql: outgoing payments (payment means, cash/bank account, amount, allocated amount, linked cancellation documents with a single-cancellation index) and append-only payment_allocations events (allocate/unallocate, one unallocation per allocation, update/delete blocked by trigger and grants); OP numbering series; bank module and bank.payment.view/post/cancel/unallocate permissions for owner, administrator and accountant, view for auditor.
  - API /v1/bank: open-invoices?vendorId=, outgoing-payments (list, get, post with allocations, allocate unapplied amount, unallocate one allocation, cancel). Journal Dr vendor payable / Cr cash or bank; account defaults from the cash or bank determination key.
  - A/P invoice cancellation now locks the invoice row and names the blocking payments (REV-05).
  - Desktop: Banking > Outgoing Payments (open-invoice grid with Total Payment, payment means and G/L account, on-account confirmation, view with allocation history, Unallocate, Allocate Unapplied and Cancel Payment); renderer allowlist includes /v1/bank; the Company Details note no longer calls Banking planned.
  - Added .claude/launch.json (Vite renderer only) for browser previews.
- Files changed: new apps/api/migrations/0008_outgoing_payments.sql, apps/api/src/banking/{outgoing-payments.service.ts,banking.controller.ts}, apps/api/test/outgoing-payments.test.ts, packages/contracts/src/banking.ts, apps/desktop/src/renderer/forms/BankingForms.tsx, .claude/launch.json; modified apps/api/src/{app.module.ts,database/schema.ts,database/seed.ts,platform/platform.service.ts,purchasing/ap-invoices.service.ts}, packages/contracts/src/{index,permissions,finance}.ts, apps/desktop/src/main/{api-session.ts,api-session.test.ts}, apps/desktop/src/renderer/{screens/Shell.tsx,forms/CompanyDetailsForm.tsx}, docs/DECISIONS.md, this file.
- Verification and results: pnpm build exit 0; pnpm lint exit 0; pnpm typecheck exit 0; pnpm test: API 84/84 (7 new payment tests), worker 4/4, desktop 3/3. The payment tests cover:
  - scenario 6: partial payment, exact journal accounts, invoice open amount, vendor and bank balances, over-allocation against the invoice and against the payment;
  - multi-invoice payment in cash with an on-account remainder, later allocation, allocation date before the payment rejected;
  - scenario 18: invoice cancellation blocked with the payment reference, unallocation with replay and double-unallocation 409, journal count and bank balance unchanged, reallocation to the correct invoice, invoice cancellation then allowed;
  - payment cancellation: 3 concurrent attempts produce one, allocations undone, reversal journal accounts, balances restored, cancellation of a cancellation and allocation to a cancelled payment refused;
  - idempotent replay, conflicting key, 4 concurrent payments against one invoice producing exactly 2;
  - validation of vendor, customer partner, invoice vendor and date, duplicates, zero amount, control and expense accounts;
  - database-level append-only allocations, closed period for payment and cancellation, tenant isolation, auditor read-only access.

  Mutation check: loosening the invoice open-amount check made 2 tests fail (over-allocation and concurrency); restored. pnpm db:migrate applied 0008 to the seeded development database (backfill path). The form was checked visually in the built-in browser against the Vite dev server with a temporary in-page mock bridge (not committed): add mode, on-account confirmation, posted payload and view mode rendered correctly. Not verified in Electron against the live API.
- In progress: stock transfers and adjustments; A/P aging; incoming payments with the A/R side.
- Blockers: Accountant and jurisdiction sign-off on ADR-022 to ADR-027; product-owner confirmation of the ADR-027 invoice-date rule.
- Exact next action: As in "Next action" above.

### 2026-09-29 - Claude verification and handoff correction

- Branch and commit: master; no commits yet.
- Completed: Analysis and re-verification only; no source changes. Corrected the stale header and "Next action" in this file, which still described the M1 state.
- Files changed: docs/IMPLEMENTATION_STATUS.md.
- Verification and results: The previous scratch PostgreSQL cluster no longer existed, so a new PostgreSQL 18 cluster was created with initdb in this session's scratch directory on port 55432 and infrastructure/postgres/init/01-roles-and-databases.sh was run against it; the native service on 5432 was not touched. pnpm build exit 0; pnpm lint exit 0; pnpm db:reset applied 0001-0007; pnpm db:seed exit 0; pnpm test: API 77/77, worker 4/4, desktop 3/3. A search for SAP or Business One names in apps and packages source found none. The earlier live sample data (JE1-JE4, GR1, AP1) was lost with the old cluster.
- In progress: Unchanged from the entry below.
- Blockers: Unchanged. Additionally, about 143 untracked files (roughly 19,600 lines of TypeScript) exist with no commit, and the development database lives only in a temporary directory.
- Exact next action: As in "Next action" above.

### 2026-09-28 - Claude A/P refinements to Business One behaviour (ADR-026)

- Branch and commit: master; no commits yet.
- Completed: The product owner asked for the ADR-025 open points to follow Business One. Recorded ADR-026 and marked ADR-025 partially superseded.
  - Migration 0007_ap_b1_refinements.sql allows value-only stock movements; adds tax codes and dated rates (seeded 0% No tax only); adds document type, subtotal and tax total on A/P invoices; and adds line kinds (receipt, item, account), account, warehouse, tax code, rate, tax amount, stock revaluation and price difference on A/P invoice lines.
  - A/P invoice service rewritten:
    - stock revaluation for on-hand quantity, remainder to price difference;
    - direct item lines (stock receipt by invoice) and service-type G/L lines;
    - line tax by posting-date rate, with input tax posting;
    - cancellation reversing stock and revaluation movements under the valuation check.
  - Tax code API: /v1/fin/tax-codes, add-rate endpoint.
  - Desktop: A/P Invoice rewritten (Item/Service type, Copy From receipts with tax code, items without goods receipt, G/L account lines, tax totals, view with revaluation and price difference columns); Administration > Setup > Financials > Tax Codes; Administration > System Initialization > Document Settings (price tolerance).
- Files changed: apps/api/migrations/0007_ap_b1_refinements.sql, packages/contracts/src/purchasing.ts, apps/api/src/purchasing/ap-invoices.service.ts, new apps/api/src/finance/tax.service.ts, apps/api/src/{finance/finance.controller.ts,inventory/stock.service.ts,app.module.ts,platform/platform.service.ts,database/schema.ts}, apps/api/test/ap-invoices.test.ts, apps/desktop/src/renderer/forms/ApInvoiceForm.tsx, new apps/desktop/src/renderer/forms/SettingsForms.tsx, apps/desktop/src/renderer/{screens/Shell.tsx,app.css}, docs/DECISIONS.md.
- Verification and results: pnpm build exit 0; pnpm lint exit 0; pnpm test: API 77/77 (4 new A/P tests, 1 updated for revaluation), worker 4/4, desktop 3/3.
  - The A/P tests cover: dated tax rates and a duplicate-rate rejection; input tax on receipt and service lines; purpose check; service G/L lines with control-account and mixed-kind rejection; a direct stock item invoice and its cancellation; stock revaluation (value 100 to 110, average cost 11) and the VALUATION_BLOCKED cancellation after a later receipt; the tolerance test now expecting inventory revaluation (stock value 200.50).
  - Two migration defects found and fixed before applying: a constraint name collided with the auto-named total >= 0 check; and the backfill UPDATE matched no rows under forced RLS, which failed safely on the development database with a null-subtotal error and rolled back. The fix lifts RLS around the backfill, following the pattern of earlier migrations.
  - pnpm db:migrate then applied 0007 to the development database; the live API shows AP1 with subtotal 30.00 and tax 0.00, and the NOTAX code.
  - The service-type A/P Invoice form was checked visually in the built-in browser with a mock bridge (500 + 10% test tax = 550).
  - Not tested: the proportional revaluation split when stock on hand is less than the invoiced quantity (needs outbound stock transactions; to be covered with deliveries or adjustments). Not verified in Electron against the live API.
- In progress: outgoing payments; stock transfers and adjustments; A/P credit memo; A/R side.
- Blockers: Accountant and jurisdiction sign-off on ADR-022 to ADR-026, tax codes and rates.
- Exact next action: Build outgoing payments with invoice allocation (Banking), then stock transfers and adjustments (which also enables testing the partial revaluation split).

### 2026-09-28 - Claude A/P Invoice

- Branch and commit: `master`; no commits yet.
- Completed: Recorded ADR-025.
  - Migration `0006_ap_invoices.sql` adds purchasing settings (price tolerance), A/P invoices and lines, a unique vendor invoice number per vendor among posted invoices, and single-cancellation links.
  - `seed_ap_defaults()` adds settings, the AP numbering series, account 5400 Purchased Services and Supplies and its determination key; it was backfilled and runs at provisioning.
  - Permissions `pur.invoice.view/post/cancel/override` and `pur.setup.administer` granted to system roles (accountant: view, post and cancel; buyer and auditor: view).
  - API: `/v1/pur/invoiceable?vendorId=`, `/v1/pur/invoices` (list, get, post, cancel), `/v1/pur/settings`, `/v1/bp/partners/:id/balance`.
  - Desktop: Purchasing - A/P > A/P Invoice (vendor, multi-receipt Copy From grid with received, invoiced, quantity, receipt price and invoice price, override checkbox, view with balance due and cancellation). Goods Receipt PO gains Copy To A/P Invoice. The Business Partner form shows the account balance and open invoices.
- Files changed: `apps/api/migrations/0006_ap_invoices.sql`, `packages/contracts/src/{purchasing,permissions,finance}.ts`, new `apps/api/src/purchasing/ap-invoices.service.ts`, `apps/api/src/{purchasing/purchasing.controller.ts,business-partners/business-partners.service.ts,business-partners/business-partners.controller.ts,app.module.ts,platform/platform.service.ts,database/schema.ts}`, new `apps/api/test/ap-invoices.test.ts`, new `apps/desktop/src/renderer/forms/ApInvoiceForm.tsx`, `apps/desktop/src/renderer/{screens/Shell.tsx,forms/PurchasingForms.tsx,forms/BusinessPartnerForm.tsx,forms/CompanyDetailsForm.tsx,app.css}`, `docs/DECISIONS.md`.
- Verification and results: `pnpm build` exit 0; `pnpm lint` exit 0; `pnpm test`: API 73/73 (5 new A/P tests), worker 4/4, desktop 3/3. The A/P tests cover:
  - N:1 invoicing of two receipts with a service line;
  - exact journal accounts; due date from terms; vendor balance;
  - receipt cancellation blocked by the invoice;
  - over-invoice, wrong vendor, date before receipt;
  - duplicate vendor reference (case-insensitive), with a different reference allowed;
  - price variance rejected, then override posting a 2.50 debit price difference; tolerance setting allowing a 2.00 credit difference; audited override;
  - idempotent replay; 3 concurrent cancellations producing one; balance and invoiced quantities restored; reference reusable after cancellation; cancellation of a cancellation refused;
  - closed period; tenant isolation; auditor read-only access.

  A mutation check disabling the tolerance check failed the tolerance test; restored. `pnpm db:migrate` applied 0006 to the development database. A live run invoiced sample receipt GR1 (6 x 5.00) as AP1 with journal JE4 for vendor V-DEMO (sample data kept); vendor balance 30.00, GRNI 0.00 and a balanced trial balance. The A/P Invoice add form was checked visually in the built-in browser with a mock bridge. Not verified in Electron against the live API.
- In progress: outgoing and incoming payments (Banking, M4); stock transfers and adjustments; opening balances and stock; tax.
- Blockers: Accountant and jurisdiction sign-off on ADR-022 to ADR-025.
- Exact next action: Build Banking step 1, outgoing payments with allocation to A/P invoices (partial, no over-allocation, cash or bank account, unallocation per REV table, payment cancellation that atomically undoes allocations per ADR-022 a), then stock transfers and adjustments.

### 2026-09-28 - Claude Purchasing (PO, goods receipt) and stock ledger

- Branch and commit: `master`; no commits yet.
- Completed: Recorded ADR-024.
  - Migration `0005_purchasing_stock.sql` adds purchase orders and lines, goods receipts and lines (cancellation documents link to their original through a unique partial index), immutable stock movements, item valuations (on hand, value, average cost, last movement) and per-warehouse stock. Constraints prevent negative stock and value.
  - `seed_purchasing_defaults()` adds PO and GR numbering series (backfilled and run at provisioning). New system roles Buyer and Warehouse Operator; `pur.*` and `inv.stock.view` permissions; `pur` module added to plans and entitlements (development only).
  - API `/v1/pur`:
    - Purchase order create (idempotent) requires an active vendor, a purchase item and a warehouse for stocked lines, and respects unit decimals and discounts; manual close and cancel (cancel only when nothing has been received).
    - Goods receipt post (idempotent, open period, no over-receipt, stock and moving-average update, journal Dr inventory / Cr GRNI, order quantities, auto-close).
    - Goods receipt cancellation (full reversal, single use, valuation and dependency checks, reopens auto-closed orders).
  - API `/v1/inv/items/:id/stock` (on hand, on order, available, value, average cost per warehouse) and `/v1/inv/stock-movements`.
  - Item type and unit locked after use (MD-02); a warehouse holding stock cannot be deactivated.
  - Desktop: Purchasing - A/P menu enabled (Purchase Order with Copy To Goods Receipt PO, Close and Cancel Order; Goods Receipt PO with Copy From an open PO, per-line quantity and warehouse, and Cancel Document); Inventory > Inventory Reports > Inventory Audit Report; Item Master Data Inventory Data tab now shows real per-warehouse stock.
- Files changed: `apps/api/migrations/0005_purchasing_stock.sql`, `packages/contracts/src/{purchasing,permissions,finance,index}.ts`, new `apps/api/src/purchasing/*`, new `apps/api/src/inventory/stock.service.ts`, `apps/api/src/{finance/money.ts,inventory/inventory.service.ts,inventory/inventory.controller.ts,app.module.ts,platform/platform.service.ts,database/schema.ts,database/seed.ts}`, new `apps/api/test/purchasing.test.ts`, `apps/api/test/finance.test.ts` (series lookup by type), `apps/desktop/src/main/api-session.ts` and its test, new `apps/desktop/src/renderer/forms/{PurchasingForms,StockForms}.tsx`, `apps/desktop/src/renderer/{screens/Shell.tsx,forms/ItemMasterDataForm.tsx,forms/CompanyDetailsForm.tsx,app.css}`, `docs/DECISIONS.md`.
- Verification and results: `pnpm build` exit 0; `pnpm lint` exit 0; `pnpm test`: API 68/68 (10 new purchasing tests), worker 4/4, desktop 3/3. The purchasing tests cover:
  - scenario 4 (6 + 4 received, duplicate submission not double-counted);
  - over-receipt; service lines kept out of stock; journal accounts;
  - discount rounding; moving average;
  - cancellation restoring stock, value, order quantities and ledger, with 3 concurrent cancellations producing one;
  - cancellation of a cancellation refused;
  - REV-04 valuation block;
  - manual-close preservation;
  - item lock and warehouse stock protection;
  - closed period; trial balance netting; tenant isolation, permissions and new roles.

  A mutation check removing the latest-movement check made the REV-04 test fail (201 instead of 409); restored. A defect found by the tests (Postgres checks the proposed insert row before ON CONFLICT, so negative warehouse movements used an upsert that violated the on-hand check) was fixed with an explicit update path. `pnpm db:migrate` applied 0005 to the development database. A live API run created sample records in Acme (vendor V-DEMO, item DEMO-001, PO1 for 10 at 5.00, GR1 receiving 6 with journal JE3) and confirmed stock 6 on hand and 4 on order at average cost 5.00, with a balanced trial balance. Purchase Order view checked visually in the built-in browser with a mock bridge. Not verified in Electron against the live API.
- In progress: A/P invoice with receipt matching (PUR-03), transfers and adjustments (INV-04/05), opening stock, PO editing, tax.
- Blockers: Accountant sign-off on ADR-022 to ADR-024 and the posting matrix; tax regime.
- Exact next action: Build the A/P Invoice (copy from goods receipts, N:1 per ADR-022, clearing GRNI to the vendor payable with price differences, receipt invoiced quantities, and the dependency block on receipt cancellation), then stock transfers and adjustments.

### 2026-09-28 - Claude Inventory master data

- Branch and commit: `master`; no commits yet.
- Completed: Recorded ADR-023.
  - Migration `0004_inventory_master_data.sql` adds units of measure, item groups (optional inventory, COGS and revenue accounts), warehouses (per branch, optional inventory account), `branches.default_warehouse_id`, items, price lists and item prices, all with forced RLS and composite tenant keys.
  - `seed_inventory_defaults()` creates units EA, BOX, KG and L, item groups GENERAL and SERVICES, warehouse WH01 as the default branch's warehouse, and default Sales and Purchase price lists. It runs at provisioning and was backfilled for existing tenants.
  - New `inv.*` permissions granted to system roles; `inv` module added to plans and entitlements (development only).
  - API under `/v1/inv` covers units, item groups, warehouses, price lists and entries, and items. Rules enforced:
    - item type rules: only inventory items have a default warehouse or reorder point; every item is a sales item, a purchase item or both;
    - quantity decimals limited by the unit;
    - active group, unit, warehouse and price list required;
    - preferred vendor must be an active supplier;
    - item codes and barcodes unique per tenant;
    - item-group and warehouse accounts validated by type;
    - a default warehouse or default price list cannot be deactivated;
    - prices are replaced in full on item update.
  - Desktop: Inventory menu enabled (Item Master Data with Find/Add/record navigation and General, Prices, Inventory Data and Remarks tabs; Price Lists with bulk price editing) and Administration > Setup > Inventory (Warehouses, Units of Measure, Item Groups).
- Files changed: `apps/api/migrations/0004_inventory_master_data.sql`, `packages/contracts/src/{inventory,permissions,index}.ts`, new `apps/api/src/inventory/*`, `apps/api/src/{app.module.ts,platform/platform.service.ts,database/schema.ts,database/seed.ts}`, new `apps/api/test/inventory.test.ts`, `apps/desktop/src/main/api-session.ts` and its test, new `apps/desktop/src/renderer/forms/{ItemMasterDataForm,InventorySetupForms}.tsx`, `apps/desktop/src/renderer/{screens/Shell.tsx,app.css,forms/CompanyDetailsForm.tsx}`, `docs/DECISIONS.md`.
- Verification and results: `pnpm build` exit 0; `pnpm lint` exit 0; desktop typecheck exit 0; `pnpm test`: API 58/58 (8 new inventory tests), worker 4/4, desktop 3/3. `pnpm db:migrate` applied 0004 to the development database; read-only live API checks confirmed the defaults and 6 `inv.*` permissions for Acme. Item Master Data was checked visually in the built-in browser with a mock bridge. Not verified in Electron against the live API.
- Known gap: MD-02 requires transactional item fields (type, unit) to lock after first use; there are no stock transactions yet, so the lock must be added with the stock ledger.
- In progress: M1 remainder; M2 imports and opening balances; FIN-06 close checks; aging.
- Blockers: Unchanged. Accountant sign-off, tax regime and ADR-022/023 confirmation.
- Exact next action: Build Purchasing - A/P step 1 (purchase orders, goods receipt PO, stock ledger with weighted-average cost, and receipt posting through `PostingService` and G/L determination), including the MD-02 item-field lock and the first REV reversal rules for receipts.

### 2026-09-28 - Claude Financials core (posting-gate prerequisites)

- Branch and commit: `master`; no commits yet.
- Completed:
  - Migration `0003_financials_core.sql` adds accounts (title/active, receivable/payable control kinds), G/L account determination, fiscal years and monthly posting periods, numbering series, idempotency keys, and journal entries and lines.
  - Journals are append-only (grants and triggers), every posted journal must balance (a deferred constraint trigger checks debits equal credits and there are at least two lines), and at most one reversal is allowed per journal (partial unique index).
  - `seed_finance_defaults()` loads a generic 29-account template (not jurisdiction-specific), 14 determination keys, a JE numbering series and the current fiscal year. It runs at tenant provisioning and was backfilled for existing tenants.
  - New system role Accountant; `fin.*` and `admin.numbering.*` permissions granted to existing system roles; `fin` module added to plans and entitlements (development only).
  - Posting engine (`PostingService`): open-period check with a shared lock against concurrent close, postable active accounts only, control accounts only through a business partner (B1 convention, ADR-022; addresses review R-05 for manual journals), leads rejected, fixed-point BigInt money, numbering assigned under a row lock in the posting transaction.
  - Manual journal entries require an idempotency key: an identical retry replays the result and a conflicting reuse gets 409.
  - Reversal of manual journals: whole-entry swap using original accounts and partners, reason, date on or after the original in an open period, no reversal of a reversal, document-generated journals refused.
  - Period close and reopen with reason and audit; fiscal-year creation with overlap check; numbering series with prefix and default; trial balance by posting date.
  - Desktop: Financials menu enabled (Chart of Accounts, Journal Entry, Posting Periods, G/L Account Determination, Financial Reports > Trial Balance) and Administration > System Initialization > Document Numbering, all in the Business One style.
- Files changed: `apps/api/migrations/0003_financials_core.sql`, `packages/contracts/src/{finance,permissions,index}.ts`, new `apps/api/src/finance/*` (money, idempotency, posting, finance-setup, journals, controller), `apps/api/src/{app.module.ts,platform/platform.service.ts,database/schema.ts,database/database.service.ts (date columns now parsed as strings),database/seed.ts}`, new `apps/api/test/finance.test.ts`, `apps/desktop/src/main/api-session.ts` and its test, new `apps/desktop/src/renderer/{format.ts,forms/JournalEntryForm.tsx,forms/FinanceSetupForms.tsx}`, `apps/desktop/src/renderer/{screens/Shell.tsx,app.css,forms/CompanyDetailsForm.tsx}`.
- Verification and results: `pnpm build` exit 0; `pnpm lint` exit 0; `pnpm test`: API 50/50 (13 new finance tests), worker 4/4, desktop 3/3. The finance tests cover:
  - balanced, sequential posting;
  - rejection of unbalanced, title, control, both-sided and cross-tenant lines;
  - partner control posting, and lead rejection;
  - idempotent replay, conflicting key reuse, and 5 concurrent same-key submissions producing one journal;
  - closed-period rejection and audited reopen;
  - 3 concurrent reversals producing exactly one;
  - reversal of a reversal refused;
  - trial balance netting before and after the reversal date;
  - database-level immutability and a deferred-trigger balance violation;
  - tenant isolation and auditor read-only access;
  - account, determination and fiscal-year validation, and a new default series.

  A trigger bug found by the tests (PL/pgSQL reading `NEW.journal_id` on header rows) was fixed before the migration was applied anywhere persistent. `pnpm db:migrate` applied 0003 to the development database. A live API smoke test on it posted JE1, replayed it with the same key, reversed it as JE2 (both remain in the development database and net to zero), and the trial balance balanced. The Journal Entry form was checked visually in the built-in browser with a mock bridge. Not verified in Electron against the live API.
- In progress: remaining M1 items; M2 items, warehouses, price lists and imports; FIN-06 period-close reconciliation checks; opening balances (R-05 import rules); aging reports.
- Blockers: The posting matrix, chart template and ADR-022 conventions need accountant approval before any production posting; the first country and tax regime are still undecided.
- Exact next action: Build Inventory master data (items, units, item groups, warehouses, price lists), then goods receipts and the stock ledger, which will post through `PostingService` and G/L determination.

### 2026-09-28 - Claude Business One conventions and Business Partner master data

- Branch and commit: `master`; no commits yet.
- Completed: Recorded ADR-022 (provisional Business One conventions for open rules R-01, R-02, R-03, R-04, R-06, R-11 and R-15, plus BP master-data structure) and pending decision 11. Added migration `0002_business_partners.sql`: payment terms, BP groups, business partners, contact persons and addresses with forced RLS and composite tenant keys. It grants `bp.*` permissions to existing system roles and backfills default groups and payment terms for existing tenants. It also appends the `bp` module to all plans and tenant entitlements; that is acceptable only because no production tenants exist. New tenants get default groups (Customers, Suppliers) and payment terms (Immediate, Net 30). The API now enforces plan module grants (PL-03) as well as permissions (`MODULE_NOT_ENTITLED`). BP API under `/v1/bp` supports search and list, get, create, full update with version check, groups and payment terms. Rules: base currency only (ADR-007), group type must match partner type, a lead may change only to customer, one default contact and one default address per type, no hard delete (inactive status instead). Desktop: Business Partners folder enabled in the Main Menu; Business Partner Master Data form with Find/Add/OK/Update modes, toolbar Find, Add and record navigation, List of Business Partners chooser, and General, Contact Persons, Addresses and Payment Terms tabs.
- Files changed: `docs/DECISIONS.md`, `apps/api/migrations/0002_business_partners.sql`, `packages/contracts/src/{business-partners,permissions,api,index}.ts`, `apps/api/src/{app.module.ts,auth/auth.guard.ts,common/request-context.ts,tenancy/tenant-access.service.ts,platform/platform.service.ts,database/schema.ts,database/seed.ts}`, new `apps/api/src/business-partners/*`, new `apps/api/test/business-partners.test.ts`, `apps/desktop/src/main/api-session.ts` and its test (allowlist now includes `/v1/bp` and PUT), `apps/desktop/src/renderer/{toolbar.tsx,app.css,erp.d.ts,screens/Shell.tsx,forms/BusinessPartnerForm.tsx,forms/CompanyDetailsForm.tsx}`.
- Verification and results: `pnpm build` exit 0; `pnpm lint` exit 0; `pnpm test`: API 37/37 (8 new BP tests covering tenant-scoped codes, cross-tenant 404 and foreign-group rejection, currency, group-type and default rules, version conflict and type changes, auditor read-only access, module gating), worker 4/4, desktop 3/3. `pnpm db:migrate` applied 0002 to the development database; the live API confirmed default groups, `bp.*` permissions and the `bp` module for an existing tenant. Visual check in the built-in browser with a temporary mock bridge: BP form, record navigation and Addresses tab rendered correctly. Not verified in Electron against the live API.
- In progress: M1 remainder; M2 items, units, warehouses, price lists, fiscal periods, numbering series and imports.
- Blockers: ADR-022 conventions need product-owner and accountant confirmation before posting features; they were recalled from general knowledge of Business One and may differ from the actual product.
- Exact next action: Build item master data (items, units, item groups, warehouses, price lists) in the same Business One style, then fiscal periods and numbering series.

### 2026-09-28 - Claude Business One-style desktop UI (ADR-021)

- Branch and commit: `master`; no commits yet.
- Completed: The product owner chose a visual style resembling SAP Business One. Recorded ADR-021 (ADR-001 marked partially superseded for UI style only) and updated the UI rule in `AGENTS.md` and `CLAUDE.md`; SAP names, logos, icons, copied assets, pixel-identical UI and connectors remain prohibited. Rebuilt the desktop renderer: Log On and Choose Company dialogs, menu bar (Modules, View, Window, Help), toolbar, collapsible Main Menu tree (Administration > System Initialization, Setup > General, Utilities; future modules shown disabled with their milestone), form windows with OK/Add/Cancel footers, status bar, compact grey theme, grids with row numbers, drill-down link arrows (own SVG), an add row in the Branches grid, and Esc and Ctrl+M shortcuts. Fixed a Windows-encoding corruption in `packages/ui/src/components.tsx` introduced by a script edit.
- Files changed: `AGENTS.md`, `CLAUDE.md`, `docs/DECISIONS.md`, `docs/DEVELOPMENT.md` (setup command corrected to `pnpm run setup`), `packages/ui/src/components.tsx`, `packages/ui/src/styles.css`, `apps/desktop/src/renderer/app.css`, `apps/desktop/src/renderer/screens/*` (Shell, LoginScreen, TenantChooser, AcceptInvitationScreen), new `apps/desktop/src/renderer/forms/*` (CompanyDetails, Branches, Users, AuditLog, About); removed the old Overview, Branches, Users and Audit view files.
- Verification and results: desktop and ui typecheck passed; `pnpm lint` passed; desktop build passed; desktop tests 3/3 passed. Visual check in the built-in browser against the running Vite dev server, using a temporary in-page mock bridge (not committed) with sample data: Log On, Choose Company, shell with Company Details, Branches and Users forms rendered as intended; found and fixed a disabled OK button on an unchanged Branches form. Not verified: the restyled UI inside Electron against the live API, and the Audit Log and Accept Invitation forms visually.
- In progress: M1 remainder as listed above.
- Blockers: Legal review of the ADR-021 trade-dress risk before commercial release; the resemblance was built from general knowledge, not reference screenshots, and needs product-owner review.
- Exact next action: Product owner to review the new UI in Electron (`pnpm dev:api` and `pnpm dev:desktop`) and list the differences that matter; then continue M1 with password reset and write idempotency keys.

### 2026-09-28 - Claude M1 foundation implementation

- Branch and commit: `master`; no commits yet.
- Completed: Everything listed under "Completed" above except the requirements documents. Recorded ADR-013 to ADR-020 and pending decision 10.
- Files changed: new `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.gitignore`, `.gitattributes`, `.editorconfig`, `.env.example`, `scripts/setup.mjs`, `infrastructure/**`, `apps/api/**`, `apps/worker/**`, `apps/desktop/**`, `packages/contracts/**`, `packages/ui/**`, `packages/config/**`, `docs/DEVELOPMENT.md`; updated `docs/DECISIONS.md` and this file. Local `.env` created (git-ignored).
- Verification and results:
  - Docker was unavailable (see blockers). As a substitute, a separate PostgreSQL 18.1 cluster was created in the session scratch directory with `initdb` on port 55432, and `infrastructure/postgres/init/01-roles-and-databases.sh` was run against it. The native PostgreSQL service on 5432 was not touched. Compose targets PostgreSQL 17.11, so behavior on 17 is unverified.
  - `pnpm db:reset` applied `0001_foundation.sql`; `pnpm db:seed` created both tenants, three users and the operator.
  - `pnpm build`: passed for contracts, worker, desktop (Vite 8.3.1) and API.
  - `pnpm test`: API 29/29 passed (isolation, auth/sessions, entitlements/roles, platform/subscription); worker 4/4 passed (unit only); desktop 3/3 passed (main-process unit tests).
  - Mutation check: removing the seat advisory lock made the concurrent-invitation test fail (4 accepted instead of 3); the lock was restored and tests re-run green.
  - `pnpm lint`: passed with no findings. `pnpm -r run typecheck`: passed for all five packages.
  - Live smoke test of `node dist/src/main.js`: `/health` 200 with helmet headers and correlation ID; seeded login 200 returning both tenants; unknown route 404 in the standard error shape.
  - Not run: Docker Compose, Redis, SeaweedFS, Mailpit, worker against Redis, Electron launch.
- In progress: M1 remainder listed above.
- Blockers: Docker/WSL on this machine; Electron binary download approval; ADR-016 and ADR-017 confirmation.
- Exact next action: As in "Next action" above.

### 2026-09-28 - Claude requirements analysis

- Branch and commit: `master`; no commits yet.
- Completed: Re-read draft 1.1, both handoffs and the Codex review. Confirmed the evidence for R-01 to R-03 against the requirement text. Added addendum findings R-11 to R-17 to `docs/REQUIREMENTS_REVIEW.md`: cash/bank and on-account payments, V1 currency rule, undefined employee records, branch-level access, document cardinality, owners and deadlines for open decisions, and scenario wording.
- Files changed: `docs/REQUIREMENTS_REVIEW.md` (addendum appended; earlier content preserved), this file.
- Verification and results: Documentation review only. No code, build, lint, migrations or tests exist. `git status --short` showed five staged files and the untracked review, unchanged by this session apart from the edits above.
- In progress: None. All milestones remain not started.
- Blockers: Same open decisions as before, plus R-11 to R-16 pending product-owner input. No requirement or decision was changed.
- Exact next action: Product owner to resolve R-01 to R-03 and R-11. In parallel, scaffold the M1 monorepo and local infrastructure.

### 2026-09-24 - Codex requirements re-analysis

- Completed: Reviewed draft 1.1 for consistency, missing workflows, milestone ownership and acceptance coverage. Recorded ten prioritized findings and proposed resolutions in `docs/REQUIREMENTS_REVIEW.md`; requirements and approved decisions were not changed.
- Main findings: REV-05 conflicts with atomic unallocation during payment reversal; supplier invoices/payments lack explicit milestone ownership; service sales lack an explicit invoicing path. Posting/valuation ownership, control-account restrictions and opening reconciliation need definition before financial workflows. Foundation scaffolding can proceed.
- Files changed: `docs/REQUIREMENTS_REVIEW.md` and this handoff; previous unstaged changes preserved.
- Verification and results: Read requirements and both handoffs, inspected staged summaries and existing unstaged diff. Review structure check passed with ten unique R-01 through R-10 findings. `git diff --check` passed with an LF-to-CRLF warning for this file. `git log -5 --oneline` failed because `master` has no commits. No application tests, build, lint or migration checks are available.
- Remaining work and blockers: Recommendations are not approved rule changes. Existing accounting/jurisdiction decisions remain open; all implementation milestones remain not started. No commit, push or staging performed.
- Exact next action: Start M1 monorepo/local infrastructure scaffolding; define the entitlement state/action policy before implementing its behavior, as identified in review R-08.

### 2026-09-24 - Codex Git initialization verification

- Completed: Verified the user-created repository and inspected staged files. Updated current handoff metadata while retaining historical session entries.
- Files changed: `docs/IMPLEMENTATION_STATUS.md` only; no staging, commit or push performed.
- Verification and results: `git status --short` showed five staged additions; `git branch --show-current` returned `master`; `git rev-parse --show-toplevel` returned this workspace. `git diff --cached --stat` confirmed five staged documents; the initial `git diff --stat` was empty. `git log -5 --oneline` failed because `master` has no commits yet. Final `git diff --check` passed. No application build, lint, migration or tests exist.
- Remaining work and blockers: M1 application/infrastructure work remains not started. Existing product and accounting sign-offs remain open; missing Git initialization is no longer a blocker.
- Exact next action: Scaffold the pnpm monorepo and local PostgreSQL, Redis and object-storage infrastructure.

### 2026-09-24 - Codex reversal requirements update

- Completed: Updated requirements to draft 1.1 with REV-01 through REV-07, document-specific behavior, accounting-standard qualifications and acceptance scenarios 15-23. Added accounting prerequisite gate for M2-M4. Recorded ADR-010 through ADR-012 without replacing earlier decisions.
- Files changed: `ERP_Product_Requirements_v1.md`, `docs/DECISIONS.md`, `docs/IMPLEMENTATION_STATUS.md`.
- Verification and results: Documentation checks verified unique REV-01 through REV-07 definitions, sequential acceptance scenarios 1-23, unique ADR-001 through ADR-012 entries and required section references. No application code, tests, build, lint or migrations exist. `git status --short`, `git branch --show-current` and `git log -5 --oneline` each failed with `fatal: cannot change to 'C:/Users/muhammad.sabtain'`.
- Remaining work and blockers: Rules and acceptance scenarios are documented, not implemented. All milestones remain not started. Reporting framework, jurisdiction, valuation examples and accountant sign-off remain pending; the prior milestone dependency finding is addressed by the new posting gate.
- Branch and commit: Unavailable; no commit or push performed.
- Exact next action: Initialize the M1 monorepo and local infrastructure; apply the documented accounting prerequisite gate before enabling later posting features.

### 2026-09-24 - Codex handoff relocation

- Completed: Moved the two root-level handoff files into `docs/` as authorized by the user. The paths now match `AGENTS.md` and `CLAUDE.md`.
- Files changed: `IMPLEMENTATION_STATUS.md` moved to `docs/IMPLEMENTATION_STATUS.md`; `DECISIONS.md` moved to `docs/DECISIONS.md`. Added this status entry; decisions content is unchanged.
- Verification and results: Verified both destination files exist, both old root paths are absent, and both agent instruction files reference the destination paths. No application code exists, so build, lint, migration and application tests are not applicable.
- Remaining work and blockers: All implementation milestones remain not started; accounting milestone dependencies and reversal acceptance scenarios identified in the preceding review remain unresolved.
- Branch and commit: No local Git repository; no commit or push performed.
- Exact next action: Initialize the M1 monorepo and local infrastructure using the requirements baseline.

## Session update template

### 2026-09-24 - Codex review

- Completed: Read all five supplied Markdown files and reviewed requirements, milestone dependencies and handoff consistency. No implementation was requested or started.
- Files changed: `IMPLEMENTATION_STATUS.md` only, to record this review in the existing root-level handoff.
- Verification and results: `rg --files --hidden` found only the five Markdown documents; `Test-Path .git` returned `False`. Initial reads of `docs/IMPLEMENTATION_STATUS.md` and `docs/DECISIONS.md` failed because those paths do not exist; both root-level files were subsequently read completely. `git status --short`, `git branch --show-current` and `git log -5 --oneline` each failed with `fatal: cannot change to 'C:/Users/muhammad.sabtain'`. No application tests, build, lint or migration checks are available.
- Findings: Agent instructions reference missing `docs/` handoff paths. M3 valuation and M4 invoice/payment posting depend on accounting setup and journals currently scheduled in M5. Controlled reversals are required, but their effects on allocations, source quantities, stock valuation and closed periods need explicit acceptance scenarios before implementation.
- In progress: None. All milestones remain not started.
- Blockers: No application source or local Git metadata is present. Existing product/accounting decisions remain open.
- Branch and commit: Unavailable; no commit or push performed.
- Exact next action: Align the handoff file locations with the agent instructions before initializing the M1 monorepo and local infrastructure; schedule accounting prerequisites before stock valuation and invoice posting.

### Date and agent

- Branch and commit:
- Completed:
- Files changed:
- Verification and results:
- In progress:
- Blockers:
- Exact next action:
