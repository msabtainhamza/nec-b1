# Implementation status

**Updated:** 29 September 2026  
**Current milestone:** M3 Purchasing and inventory / M4 Banking (M1, M2 and M5 partially complete; see table)  
**Project state:** Foundation, business partners, inventory master data, financials core, purchasing (PO, goods receipt, A/P invoice with tax and revaluation) and stock ledger implemented and tested. Nothing committed; `master` has no commits.

## Milestones

| Milestone | Scope | State |
| --- | --- | --- |
| M1 Foundation | Monorepo, local infrastructure, tenant membership, authentication, RBAC, subscriptions, RLS and audit | In progress: core slice done; remaining items below |
| M2 Master data | Company settings, branches, periods, numbering, partners, items and warehouses | In progress: business partners, items, units, item groups, warehouses, price lists, periods and numbering done; imports and opening balances remain |
| M3 Purchasing and inventory | Purchase orders, receipts, stock ledger, transfers and adjustments | In progress: purchase orders, goods receipts, A/P invoices, stock ledger, moving average and cancellations done; transfers, adjustments and opening stock remain |
| M4 Sales | Quotes, orders, deliveries, customer invoices and payments | Not started |
| M5 Finance and pilot | Journals, aging, trial balance, reports, installer, recovery and pilot testing | In progress: financial core (posting-gate prerequisites per ADR-012) done; aging, period-close checks, opening balances, reports, installer, recovery and pilot remain |

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

- M1 remainder (not started): password reset and forgotten-password email; MFA option for company administrators; support access with time-limited authorization (PL-06); tenant export and deletion-request lifecycle (PL-05); idempotency keys for writes (REP-04); Redis-backed rate limiting (current login limiter is in-memory, per process); encryption of TOTP secrets; custom role administration; worker integration tests with Redis; desktop launch verification, installer and auto-update (UX-08).

## Next action

Build outgoing payments with A/P invoice allocation (Banking), then stock transfers and adjustments (which also enables testing the partial revaluation split). Separately, the product owner should launch Electron against the live API (`pnpm dev:api`, `pnpm dev:desktop`), which has never been done, and decide on an initial commit.

## Blockers and open decisions

- Docker Desktop failed to start on this machine ("Docker Desktop is unable to start"); `wsl.exe --status` returned "The system cannot find the path specified." Installing or repairing WSL requires the user. Redis, SeaweedFS and Mailpit were therefore not run.
- The Electron binary has not been downloaded; the desktop UI has been built and unit tested but not launched.
- Confirm ADR-016 and ADR-017 (seat reservation by invitations, subscription access mapping, retention window).
- Earlier open decisions remain: first country and tax regime, customer vertical, billing provider, R-01 to R-03 and R-11 before transactional APIs.

## Verification

See the 2026-09-28 implementation entry below for exact commands and results.

## Latest handoff

- **Agent:** Claude
- **Branch and commit:** `master`; no commits yet.
- **Changed files this session:** see the 2026-09-28 implementation entry.
- **Uncommitted work:** The original five files remain staged as the user left them (`docs/DECISIONS.md` and this file also have unstaged changes). All new source files are untracked. Nothing was staged, committed or pushed by Claude.
- **Exact next action:** As in "Next action" above.

## Latest session update

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
