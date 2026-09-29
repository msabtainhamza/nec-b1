# Desktop ERP Product Requirements Document

**Version:** 1.1 draft  
**Date:** 24 September 2026  
**Product owner:** Muhammad Sabtain Hamza  
**Status:** Requirements baseline for estimation and design; open decisions are listed in section 19.

## 1. Purpose and product definition

Build an original Windows desktop ERP for small trading and distribution companies. It uses a centrally hosted API and PostgreSQL database. Each purchasing company is a tenant, with users, data, configuration, subscription and usage limits isolated from other companies. The product supports the operational breadth and document-driven work patterns familiar in established ERPs, with its own name, interface and implementation. It has no SAP Business One connection or dependency.

This document defines the first commercially usable release (V1), the subsequent functional roadmap, business rules, screens, data, infrastructure, security, tests and acceptance gates. V1 is a connected desktop application; offline transaction posting is outside scope.

### 1.1 Goals

- A company can create and manage its business data without another ERP.
- Authorized staff can complete purchasing, inventory and sales processes end to end.
- Posted documents produce traceable stock and accounting effects.
- A platform operator can onboard tenants, control subscriptions, measure entitlements and provide support without exposing one company's data to another.
- The same desktop application serves all tenants; application and database deployments are centrally maintained.

### 1.2 V1 assumptions

- Target: trading/distribution businesses selling stocked products, with optional non-stock service lines.
- First client: Windows 11 desktop; keyboard and mouse. The API remains client-neutral.
- Online connection required for login, reads, writes, approvals and posting.
- One shared PostgreSQL database initially, with tenant-scoped rows and database-enforced isolation.
- One base currency per tenant. Foreign-currency documents, tax localization and country-specific statutory reports require separately approved rules.
- Prices and subscription amounts are not specified by this document.
- Native ERP only; no SAP connector. Manufacturing, MRP, payroll and full CRM are later phases.

## 2. Scope and release boundaries

| Area | V1 release | Later release |
| --- | --- | --- |
| Platform | Tenant provisioning, memberships, RBAC, subscriptions, seat/employee/branch limits, audit | Self-service billing, metered add-ons, dedicated databases |
| Administration | Company, branches, fiscal periods, document series, currencies, tax codes, configuration | Complex approval routing, localization packs |
| Master data | Customers, suppliers, contacts, items, units, categories, price lists, warehouses | Customer hierarchy, item variants, advanced attributes |
| Purchasing | Purchase orders, goods receipts, supplier invoices, supplier payments | Purchase requests, RFQs, returns, supplier credit notes |
| Inventory | Movement ledger, stock views, transfers, adjustments, reservation policy | Batch/serial, bin locations, counts, costing alternatives |
| Sales | Quotations, orders, deliveries, customer invoices, incoming payments | Returns, credit notes, opportunities, campaigns |
| Finance | Chart of accounts, balanced journals, subledger allocations, trial balance, aging | Bank reconciliation, financial statements, period-end automation |
| Reporting | Sales, purchasing, stock, aging, audit and exports | Custom report designer, forecast analytics |
| Extensibility | CSV templates, import validation, documented API | Webhooks, commerce/CRM connectors |

A V1 customer may operate only in a jurisdiction for which tax, accounting, invoice and retention behavior has been validated and configured. The product must not present incomplete tax logic as compliant.

## 3. Users and responsibilities

| Persona | Main tasks |
| --- | --- |
| Platform operator | Provision/suspend tenants; assign plans; inspect usage, health and billing state |
| Company owner/admin | Manage company settings, branches, users, roles, entitlements and fiscal settings |
| Sales clerk/manager | Maintain customers; quote, order, deliver and invoice; collect and review payments |
| Buyer | Maintain suppliers; issue purchase orders and match receipts/invoices |
| Warehouse operator | Receive, deliver, transfer and adjust stock; inspect movements |
| Accountant | Maintain accounts, posting configuration, periods, journals, allocations and reports |
| Auditor | Read permitted records and audit history without editing or posting |

A user can belong to multiple tenants. Tenant membership, role and status are independent in each. Employee records and login seats are different entities: an employee does not automatically gain a login.

## 4. Platform and subscription requirements

**PL-01 Provisioning.** An operator creates a tenant with stable ID, legal/display name, status, default branch, base currency, time zone and plan. Provisioning is atomic and logs the operator and timestamp.

**PL-02 Membership.** Invite, accept, disable and revoke memberships. A user chooses among authorized tenants; every API request resolves an active membership server-side. Switching tenants invalidates tenant-specific cached client state.

**PL-03 Entitlements.** A plan defines named module grants and independently configurable maxima for active seats, employee records, active branches and storage. Usage is derived server-side. Creation operations enforce limits atomically to prevent simultaneous requests exceeding a maximum. Disabled users do not consume active seats; archival rules for employees are configurable and shown in plan policy.

**PL-04 Subscription.** States are trial, active, past due, grace, suspended and cancelled. Operator changes are audited. State-to-access mapping is policy-controlled: suspended tenants retain a read-only export path for authorized administrators during a defined retention window. No client-only license checks.

**PL-05 Tenant lifecycle.** Support tenant creation, suspension, restoration, export and deletion request. Destructive deletion is a separately authorized operational process with retention and legal-hold checks.

**PL-06 Platform access.** Platform operators have a separate administrative surface and identities. Support access to customer data requires explicit, time-limited authorization, audit logging and visible tenant identification.

## 5. Identity, roles and authorization

**ID-01** Password login, verified email, reset, short-lived access sessions, refresh rotation, logout and session revocation. MFA is required for platform operators and configurable for company administrators.

**ID-02** Permissions use `module.resource.action`, including view, create, edit, submit, approve, post, reverse, unallocate, cancel, export and administer. The API checks them for every request; desktop controls reflect them for usability.

**ID-03** Posting and approval can have separate permissions. A user cannot approve their own document where segregation of duties is configured.

**ID-04** Every audit event records tenant, actor, action, entity ID, time, outcome and relevant before/after fields, excluding secrets. Audit records are append-only to application users.

**ID-05** Tenant ID in request parameters or payloads cannot override the active authenticated tenant. Cross-tenant object references fail with a non-disclosing error.

## 6. Shared document and posting rules

**DOC-01** Each document has stable ID, tenant ID, type, series, human-readable number, branch, business partner, currency, dates, lines, totals, status, creator, timestamps and version. Number uniqueness is scoped to tenant, document type and series; assignment occurs transactionally.

**DOC-02** Drafts are editable according to permission; submitted documents follow approval policy; posted documents are immutable for financial and stock-impacting fields. Corrections use a linked reversal or corrective document. A `cancelled` state must not silently erase previously posted effects.

**DOC-03** Header/line totals use a declared rounding policy. Monetary values use fixed decimal types, never floating-point arithmetic. Tax is calculated from a versioned configuration and persisted on posting.

**DOC-04** Source/target relationships and quantities carried forward are retained: quotation → order → delivery → invoice → payment; purchase order → receipt → supplier invoice → payment. Partial deliveries, receipts and payments are supported, with remaining quantities and balances visible.

**DOC-05** Posting is atomic and idempotent. The same document/action/idempotency key cannot create duplicate inventory movements or journal entries. Concurrent posting uses optimistic version checks and database constraints.

**DOC-06** Closed fiscal periods reject posting and backdating except through an authorized reopening process. Documents retain both business date and actual creation/posting time.

**DOC-07** Attachments have tenant-scoped permissions, file limits, malware screening policy and immutable links to posted records. All downloads are authorized through the API or short-lived signed access.

### 6.1 Reversal and correction rules

**REV-01 Scope and history.** V1 supports full-document reversals of posting mistakes. A reversal is a separately numbered, immutable posted document linked to its original and resulting stock movements, journals and allocation events. Preserve the original values, number and posting date; record its reversed status through an audited transition. Draft cancellation creates no reversal. Partial returns, credit notes and actual refunds are separate business workflows, deferred from V1; a reversal must not pretend that goods or money physically moved. Where a legally required corrective document is unsupported, block the operation and treat that workflow as a pilot scope blocker.

**REV-02 Authorization and audit.** Resolve the tenant and active membership server-side. Require the document-specific reverse permission, a reason and a permitted business date. Unallocating payments requires its own permission. Apply configured approval and segregation-of-duties rules; approval covers the document version, reason, date and effects and is invalidated if these change. Record requester, approver where required, poster, timestamps, original/reversal IDs and outcome. Subscription restrictions apply to reversals as posting operations.

**REV-03 Atomicity and concurrency.** Commit the reversal document, stock movements, balanced journals, allocation effects, derived balances, source quantities, status transition and success audit event in one database transaction. Any failure leaves no partial business effects. Enforce at most one successful full reversal per original document with tenant-scoped database constraints, regardless of idempotency key. An identical authorized retry returns the existing result; conflicting retry parameters fail. Recheck permissions, approval, document versions, periods, dependencies and stock under concurrency protection at commit. V1 does not reverse a reversal; a further correction uses a new linked corrective transaction under approved policy.

**REV-04 Amounts and costing.** Negate the original posted quantities and amounts and swap original debit/credit effects using the original accounts, dimensions, currency, tax snapshot and rounding. Do not recalculate using current prices, tax rates or account mappings. Reverse only effects owned by the source document, avoiding duplicate cost reversal across delivery and invoice. Reject negative or reservation-conflicting stock. Validate resulting inventory value and weighted-average cost using accountant-approved examples. Where intervening movements or cost changes require retrospective recosting or an unapproved valuation adjustment, block automatic reversal and route to an approved correction process; sufficient quantity alone is not proof of safe valuation. Never fabricate stock adjustments to bypass the check.

**REV-05 Dependencies and remaining quantities.** Block reversal while active downstream documents or allocations depend on the original. Display authorized blocking references and required actions without exposing another tenant's data. Do not automatically reverse a chain of documents. Separately approved corrections address dependencies from downstream to upstream. Restore received, delivered or invoiced quantities only for the reversed document's contribution; retain all links and other partial documents. Recalculate fulfillment status and availability; do not silently reopen a manually closed order or recreate reservations outside the tenant's policy.

**REV-06 Dates and closed periods.** Ordinary reversals require an authorized date in an open fiscal period and retain both original and reversal business dates plus actual timestamps. Never reopen a period automatically. A closed-period or prior-year error requires accountant review of the applicable reporting framework, materiality and financial-statement authorization status. Posting into a current open period alone must not be treated as sufficient for every prior-period error. A controlled reopening, adjustment or externally prepared restatement must preserve audit history and reconcile to ERP balances under an approved procedure. If the required treatment is unsupported, block routine reversal pending that procedure.

**REV-07 Preview and reconciliation.** Before confirmation, display the original reference, reason, date, required approvals, stock/value changes, debit/credit effects, payment and invoice balance changes, and source quantities. Revalidate on posting; a preview is not authorization to bypass changed conditions. Reports retain both original and reversal, respect each business date, and show the correct net effect for the selected period. Stock, journal and partner balances must reconcile after reversal.

### 6.2 Document-specific reversal behavior

| Document | Required behavior |
| --- | --- |
| Goods receipt | Resolve linked supplier invoices first. Reverse receipt stock and its own accounting effects only after quantity, dependency and valuation checks pass; restore the purchase order's remaining receipt quantity. Service lines create no stock movement. |
| Delivery | Resolve linked customer invoices first. Reverse its stock and accounting effects together; restore the order's remaining delivery quantity, subject to reservation and closure policy. |
| Customer or supplier invoice | Undo active payment allocations first. Reverse only the invoice's accounting and source-invoiced quantities. Separately posted deliveries and receipts remain posted. Apply the jurisdiction's corrective-document rules before allowing reversal. |
| Payment allocation | Append a linked unallocation event restoring invoice outstanding and payment unapplied amounts; do not delete allocation history or reverse cash/bank entries. Reallocation uses the existing real payment and normal allocation limits. |
| Incoming or outgoing payment | Reverse only an erroneous payment record. Undo any remaining active allocations atomically with payment reversal; restore invoice balances and reverse the payment journal. A real payment or refund requires its appropriate business record, not a fictional cancellation of cash movement. |
| Stock transfer | Reverse both warehouse movements and associated accounting atomically; validate available quantity at the original destination and valuation in both warehouses. |
| Stock adjustment | Reverse the complete original adjustment and its journal, subject to stock, valuation and dependency checks. |
| Manual journal | Reverse the whole balanced journal. A journal generated by an ERP document can only be reversed through that source document. |

### 6.3 Accounting standards and validation boundary

These are ERP product controls, not a claim of IFRS certification or jurisdiction-specific compliance. Full-document-only reversal, duplicate prevention, permission checks, dependency blocking and transaction atomicity are implementation policies, not individually prescribed IFRS reversal rules. Confirm the reporting framework applicable to the pilot before approving accounting behavior.

- **IAS 8:** Material prior-period errors generally require retrospective restatement unless impracticable. Distinguish errors from changes in estimates; the latter are generally recognized prospectively. REV-06 must support an accountant-approved treatment rather than route every error into current-period profit or loss. [IFRS Foundation: IAS 8](https://www.ifrs.org/issued-standards/list-of-standards/ias-8-basis-of-preparation-of-financial-statements/).
- **IAS 10:** Errors discovered after the reporting date but before financial statements are authorized can require adjusting those statements. A software period lock is not the sole determinant of accounting treatment. [IFRS Foundation: IAS 10, paragraph 9(e)](https://www.ifrs.org/content/dam/ifrs/publications/pdf-standards/english/2022/issued/part-a/ias-10-events-after-the-reporting-period.pdf?bypass=on).
- **IAS 2:** Weighted-average costing is an allowed formula for ordinarily interchangeable inventories, applied consistently to inventory of similar nature and use. This supports the chosen costing direction but does not validate the complete valuation implementation. [IFRS Foundation: IAS 2, paragraphs 25-27](https://www.ifrs.org/content/dam/ifrs/publications/pdf-standards/english/2022/issued/part-a/ias-2-inventories.pdf?bypass=on).

Local accountant sign-off must cover invoice/credit-note legality, tax corrections, valuation examples, materiality, period adjustments, reporting reconciliation and retention before production use. Automated financial-statement restatement and retrospective inventory recosting remain outside V1; the pilot must have an approved, reconciled procedure for any required treatment outside the application.

## 7. Administration and master data

**ADM-01 Company.** Legal name, registration/tax identifiers where applicable, addresses, contact details, logo, base currency, time zone and invoice display settings. Configuration changes are audited.

**ADM-02 Branches.** Code, name, address, status and default warehouse. Disabled branches cannot receive new documents; history remains readable.

**ADM-03 Fiscal periods.** Year, start/end, status open/closed and posting permissions. Dates cannot overlap within a tenant.

**ADM-04 Numbering.** Separate series per tenant, document type and optionally branch/fiscal year; uniqueness and gap policy documented. Draft numbers may be provisional if the jurisdiction requires contiguous posted numbering.

**MD-01 Business partners.** Unique tenant-scoped code; customer/supplier type; legal/display name; contacts, billing/shipping addresses, tax identifier, payment terms, credit limit and active status. A partner with posted history is archived, not hard deleted.

**MD-02 Items.** Unique SKU; name, description, stock/service classification, unit, category, tax code, sale/purchase price, inventory flag, reorder point and status. Transactional fields are locked after item use where changes would compromise history.

**MD-03 Prices.** Price lists have currency, effective dates and item prices. Sales documents store the selected unit price and any authorized override; changing a list does not rewrite posted documents.

**MD-04 Warehouses.** Tenant-scoped code, branch, active status and applicable default accounts. Existing movements remain traceable after deactivation.

## 8. Purchasing

**PUR-01 Purchase order.** Create draft with supplier, branch, destination warehouse, delivery date, item/service lines, quantities, prices, discounts and tax. Submit, approve if required, issue and close. Cannot receive more than ordered quantity unless tolerance policy explicitly allows it.

**PUR-02 Goods receipt.** Create from one purchase order in V1; support partial receipt. Posting adds stock movement for stocked items and updates received/remaining quantities. Duplicate receipt requests cannot duplicate stock. Service lines do not change stock.

**PUR-03 Supplier invoice.** Link to purchase order/receipt; show ordered, received and invoiced quantities. Apply configured two/three-way match tolerances and require an override permission for exceptions. Posting creates payable and accounting entries.

**PUR-04 Outgoing payment.** Apply a payment to one or more posted supplier invoices, including partial allocation. Over-allocation is rejected. Payment and allocations are posted atomically.

## 9. Inventory

**INV-01 Stock ledger.** Every quantity-affecting event creates an immutable movement with source document, item, warehouse, signed quantity, unit, cost basis, time and actor. On-hand is reconciled to movement history.

**INV-02 Availability.** Display on-hand, committed/reserved, on-order and available quantities separately. V1 reservation behavior is configurable per tenant; a committed order must not be confused with an actual stock movement.

**INV-03 Delivery posting.** Verify available stock and configured negative-stock policy, then deduct stock atomically. Default V1 policy rejects negative stock.

**INV-04 Transfer.** From/to warehouses, item, quantity and reason. Posting creates balanced paired movements in one transaction; source and destination must belong to the same tenant.

**INV-05 Adjustment.** Require reason and authorized poster; show valuation impact before posting. Positive and negative adjustments have linked accounting effects if perpetual inventory is enabled.

**INV-06 Costing.** V1 uses a single documented valuation method per tenant, initially weighted average. Landed costs, FIFO, serial-specific costing and retrospective recosting are out of scope. Cost changes and journal effects require accountant-reviewed examples before implementation.

## 10. Sales

**SAL-01 Quotation.** Draft, issue, expire, convert to order; quote prices and validity period persist. Conversion retains source link.

**SAL-02 Order.** Create directly or from quotation; customer, addresses, payment terms, warehouse and priced lines. Check credit and inventory warnings. Approval and reservation policies determine ability to proceed.

**SAL-03 Delivery.** Create from order, support partial deliveries, validate quantity and stock, post inventory deduction, update delivered balances and preserve source linkage.

**SAL-04 Customer invoice.** Generate from delivery; prevent invoicing more than eligible quantity without an authorized exception. Posting creates receivable, revenue/tax and cost-related entries according to the approved accounting policy. PDF/print includes required company and tax fields.

**SAL-05 Incoming payment.** Record method, reference, date and allocation to posted invoices; support partial payment and prevent over-allocation. Update outstanding balance through ledger-backed allocation.

**SAL-06 Credit limit.** Warn or block order/fulfillment based on tenant policy, current balance and pending exposure. Override requires permission and audit event.

## 11. Finance and accounting

**FIN-01 Chart of accounts.** Hierarchical tenant-scoped account codes and account types (asset, liability, equity, income, expense). Accounts used in posted journals cannot be deleted.

**FIN-02 Posting setup.** Map inventory, cost of goods sold, revenue, tax, receivable and payable accounts by documented precedence. Validate mappings before transaction posting and provide actionable missing-mapping errors.

**FIN-03 Journal.** Every posted journal has balanced debit/credit lines in base currency, origin document, date, period and actor. Reject unbalanced entries. Correct posted journals using reversals.

**FIN-04 Subledgers.** Customer/supplier balances reconcile with posted receivable/payable journal control accounts; allocations preserve history.

**FIN-05 Reports.** Trial balance, general ledger detail, customer aging and supplier aging with filters and export. Reports show generation date, tenant, date range and accounting basis.

**FIN-06 Periods.** Close requires reconciliation checks and authorized accountant approval. Reopen is auditable. Initial go-live balances need a controlled opening-balance import.

## 12. Reporting, search and data exchange

**REP-01** Dashboard widgets depend on role and permission; numbers link to filtered source records. Minimum V1 metrics: open orders, overdue invoices, low stock, purchases and sales by period.

**REP-02** Saved filters, pagination, search by code/name/document number, export to CSV, print/PDF of posted documents, and consistent date/currency formats.

**REP-03** Imports provide downloadable templates, dry-run validation, row-level errors and authorized commit. Support partner, item, opening stock and opening balance imports in a documented migration order. An import never bypasses tenant, permission or posting rules.

**REP-04** API is versioned and documented with authentication, pagination, error codes, idempotency for writes and rate limits. Public integration credentials, webhooks and connectors are later-phase features unless explicitly commissioned.

## 13. Desktop user experience and screens

**UX-01 Shell.** Login, tenant chooser, branch context, module navigation, global search, recent work, notifications, account menu and connection status. A user always sees the active company prominently.

**UX-02 Home.** Role-based dashboard, pending approvals/tasks, alerts for low stock, expiring subscription and overdue payments.

**UX-03 Lists.** Search, filters, saved views, sortable columns, status badges, pagination, role-controlled actions, export and empty/loading/error states. Show the tenant and branch context when relevant.

**UX-04 Forms.** Clear required fields; searchable partner/item lookups; keyboard-driven line editing; inline validation; calculated totals; unsaved-change guard; duplicate submit prevention; understandable error recovery.

**UX-05 Document detail.** Header, line items, totals, status, related documents, approval history, audit activity and attachments. Show the effects of posting before confirmation.

**UX-06 Settings.** Company, branches, users, roles, subscription usage, document series, tax and posting configuration. Risky changes require confirmation and appropriate permission.

**UX-07 Accessibility.** Core workflows operable by keyboard; visible focus; readable contrast; scalable text; labels and error text exposed to assistive technology.

**UX-08 Desktop behavior.** Signed Windows installer, secure auto-update with rollback policy, crash reporting that excludes business content, remembered window settings, OS print dialog, file import/export, and a clear required-update state for incompatible API versions.

**UX-09 Network behavior.** Connection loss displays a persistent status and preserves unsent draft input in memory where practical; the user must know whether a posting succeeded before retrying. Server-side idempotency resolves ambiguous retries. No offline accounting or stock posting in V1.

## 14. Architecture and local environment

```text
Windows desktop client (Electron, React, TypeScript)
                    | HTTPS
                    v
NestJS API: identity, tenancy, entitlement, ERP domains
          |                    |
          v                    v
PostgreSQL database      Redis queue and workers
          |
          v
Private object storage for attachments and exports
```

Use a pnpm monorepo with `apps/desktop`, `apps/api`, `apps/worker`, `packages/contracts`, `packages/ui`, `packages/config` and `infrastructure`. The desktop never connects directly to PostgreSQL or object storage using privileged credentials. Shared contracts describe request/response types, not database entities as a public API.

**Local development:** Docker Compose for PostgreSQL, Redis and S3-compatible storage; run API, worker and desktop processes locally with hot reload. Seed two or more tenants, distinct memberships and overlapping item/document codes. Include repeatable migrations, seed reset, local email sink, mock billing events and one-command setup instructions. Do not commit credentials or production data.

**Environments:** local, staging and production, each with independent databases, keys, storage and tenant data. CI builds and tests on pull requests; deployment applies reviewed migrations and checks health before traffic cutover. Staging uses synthetic data.

## 15. Data architecture and isolation

Platform catalog: tenants, tenant database placement, plans, subscriptions, users and memberships. Tenant business data: branches, employees, roles, master data, documents/lines, stock movements, accounts/journals, allocations, attachments and audit events. Each business table has `tenant_id`, foreign keys and tenant-scoped unique indexes. Cross-tenant relationships are prohibited by composite keys or application/database checks.

Use PostgreSQL row-level security for tenant-owned data with a per-transaction tenant context set from authenticated server context. Use a database role that does not bypass RLS; ensure context cannot leak across pooled connections. Migrations and background workers use narrowly scoped privileged paths. Test reads, writes, joins, aggregate reports, exports and queued jobs for isolation. Keep a central repository/data-access boundary so a future tenant placement router can select a shared or dedicated database without changing business services; build actual routing only when justified.

Keep operational truth in posted documents, inventory movements and journal entries. Derived balances/caches must be rebuildable. Store timestamps in UTC, render tenant time zone, and persist business posting dates separately. Define referential retention so posted records cannot be orphaned by deletion.

## 16. Security, reliability and operations

- HTTPS and secure session/token handling; no long-lived privileged token in the renderer process. Electron context isolation, sandboxed rendering, minimal IPC surface and navigation restrictions.
- Encryption at rest for database backups and files; managed secret storage and key rotation; least-privilege service and operator access.
- Rate limiting, input validation, output escaping, file validation, dependency updates and security scanning.
- Structured logs with correlation ID, tenant ID and document ID where permitted; never log passwords, tokens or sensitive attachment content.
- Metrics and alerts for API error rate, queue lag, failed posting, database health, storage, backup failure and entitlement enforcement.
- Automated backups and point-in-time recovery; documented restore and tenant export procedures, rehearsed before production launch.
- Define measurable service-level objectives and recovery point/time targets during infrastructure planning; do not claim them until verified by load and restore tests.
- Retention and deletion policies cover documents, audit logs, files, backups and cancelled subscriptions, subject to the first jurisdiction's legal requirements.

## 17. Nonfunctional targets and verification

These are proposed acceptance targets for a V1 pilot, measured in staging with representative records and concurrency; revise after sizing the first customers.

| Category | Initial target / gate |
| --- | --- |
| Availability | Production target agreed with pilot customer; monitor uptime and incident response |
| Read performance | P95 list/search API response under 1 second for indexed, paginated requests at pilot load |
| Posting performance | P95 simple document posting under 3 seconds at pilot load, excluding file generation |
| Capacity | Demonstrate 10 tenants, 50 concurrent active users, 100,000 movements and 100,000 document lines in staging; reassess with actual demand |
| Correctness | Zero unbalanced posted journals; no negative stock under default policy; no duplicate posting on retry |
| Isolation | Automated tests establish that no tenant can read, mutate, export or attach another tenant's records |
| Restore | Restore a staging backup, reconcile key counts and posting totals, document recovery time |
| Accessibility | Keyboard-complete critical workflows and documented screen-reader checks |
| Upgrade | Signed installer, verified rollback strategy and compatible API/client version policy |

## 18. Acceptance scenarios for V1

1. Operator provisions Company A with five seats and Company B with two; each can invite users within its limit. A concurrent attempt to exceed a limit is rejected with a useful message.
2. One user belongs to A and B, switches companies, and sees separate dashboards, items, documents and settings. Deep links from A fail while B is active.
3. User without posting permission can draft but cannot post a delivery through either the UI or direct API request.
4. Buyer issues a purchase order for ten items, posts a receipt of six, then another of four. On-hand rises by ten; a duplicate submission does not add another ten.
5. Salesperson quotes ten, orders ten, delivers six, invoices six, and later delivers/invoices the remainder. Source links and remaining quantities are correct at every step.
6. Accountant applies a partial payment to an invoice; outstanding balance and aging report match the allocation. A payment exceeding the balance is rejected.
7. Posting an invoice creates the expected balanced journal entries using configured accounts and tax. Missing account mapping prevents posting without partial side effects.
8. Two warehouses transfer five units; source decreases and destination increases once. An insufficient-stock transfer fails with neither movement posted.
9. Posting into a closed period is rejected. An authorized reopening action is auditable.
10. A posted document cannot have its financial fields edited. An authorized correction produces linked reversing entries and retains history.
11. Customer A cannot retrieve Company B records by replacing IDs in URLs, request bodies, exports, attachment links or queued-job inputs.
12. Suspended subscription prevents new postings according to policy, while authorized administrators can access permitted read/export functionality during retention.
13. A connection drops during posting; retry using the same idempotency key reports the original result without duplicating stock or journal effects.
14. An approved backup is restored in staging and balances, document counts, attachments and audit samples reconcile.
15. Reverse an eligible receipt of six against an order of ten: its stock and accounting effects net to zero, remaining receipt quantity increases by six, and both posted records remain visible. Other partial receipts are unchanged.
16. Concurrent reversal requests, including requests with different keys, produce one reversal only. A network retry returns the original result; a conflicting payload is rejected. Injected failure between stock and journal writes leaves all business records unchanged.
17. A receipt of ten followed by a sale of six cannot be routinely reversed where stock or valuation checks fail. A delivery with an active invoice and an invoice with active payment allocations are blocked with authorized dependency references.
18. Unallocate a real payment applied to the wrong invoice: the invoice balance and unapplied payment are restored, cash/bank entries are unchanged, and the payment can be allocated correctly without exceeding either balance. Reversing an erroneous payment atomically undoes its remaining allocations and its journal.
19. Reverse an invoice after permitted unallocation: invoice accounting and invoiced quantities are corrected while its separately posted delivery remains unchanged. Changed tax rates, prices or mappings do not change the original reversal amounts.
20. A transfer reversal fails entirely if the destination lacks available stock or either warehouse's valuation fails validation. An unsafe weighted-average reversal remains blocked even when stock quantity is sufficient.
21. Ordinary reversal into a closed period fails. A material prior-period error is routed to an accountant-approved correction/restatement procedure; current-period posting alone cannot mark that treatment complete. Original records remain available for audit.
22. Missing reverse permission, cross-tenant references, invalidated approval, self-approval where prohibited and suspended posting access all prevent reversal through the direct API as well as the desktop.
23. Reports before the reversal date retain the original effects; reports including both dates show the net effects. Stock, journals, source quantities and partner balances reconcile. Reversal of a reversal and direct reversal of a document-generated journal are rejected.

## 19. Open decisions requiring product-owner and specialist sign-off

| Decision | Why it matters | Default assumption for design |
| --- | --- | --- |
| First country and tax regime | Invoice fields, tax calculation, filing and retention | Do not ship tax-enabled production invoices until validated |
| First customer vertical | Determines item, warehouse and document nuances | Small trading/distribution business |
| Billing provider and currency | Subscription collection and accounting | Manual operator-managed subscription in first pilot |
| Employee vs seat limits and archived records | Pricing and user expectations | Separate active seats, employee records and branches |
| Weighted-average costing details | Stock valuation and cost of goods sold | Accountant-approved rule with worked examples |
| Negative stock and reservations | Delivery feasibility and availability | Negative stock prohibited; reservations policy configured |
| Approval thresholds | Separation of duties | Optional per document type in V1 |
| Multi-currency | Exchange gain/loss and report complexity | One base currency; no foreign-currency transaction posting in V1 |
| Returns and credit notes | Actual returns, refunds and legally required corrections | Deferred; reversals correct posting mistakes only where legally valid; unsupported required workflows block pilot scope |
| Deployment region and retention | Data residency, latency and recovery | Decide with first commercial customer |
| Tax/accounting sign-off | Financial correctness | Qualified local accountant reviews posting matrix and examples |

## 20. Delivery milestones and definition of done

**M1 Foundation:** Local setup, migrations, two-tenant seed, login, tenant selection, RBAC, entitlements, RLS, audit, platform administration. Gate: cross-tenant and concurrent-limit tests pass.

**M2 Master data:** Company configuration, fiscal periods, numbering, customers/suppliers, items, warehouses, opening balances and imports. Gate: validated imports and tenant-scoped uniqueness.

**M3 Purchasing and inventory:** Purchase order, partial receipt, ledger, transfers, adjustments, valuation. Gate: stock reconciliation and duplicate-post prevention.

**M4 Sales:** Quotation, order, partial delivery, invoice, payments and PDFs. Gate: full order-to-cash acceptance scenarios.

**M5 Finance and pilot:** Posting matrix, journals, aging, trial balance, period close, operational reports, installer, backups, observability and pilot migration. Gate: accountant approval, restore rehearsal, security review, acceptance scenarios and first customer UAT.

**Posting dependency gate:** Although M5 completes finance and pilot validation, the chart of accounts, applicable posting matrix, balanced journal engine, fiscal-period controls and reversal rules must be implemented and verified before enabling accounting-affecting opening balances/imports in M2, stock valuation/posting in M3 or invoices/payments in M4. Do not defer these prerequisites until M5. Relevant reversal scenarios in section 18 are part of each posting feature's acceptance gate.

A requirement is done only when its UI and API behavior, permission checks, tenant isolation, migration, audit effects, error states, appropriate automated tests, documentation and deployment/rollback procedure are complete. Production launch additionally requires jurisdiction-specific accounting/tax review, real-user workflow testing and an exercised recovery plan.

## 21. Exclusions and change control

The first release does not include an SAP connector; direct database access from Electron; offline posting; manufacturing/MRP; payroll; serial/batch tracking; custom report designer; guaranteed statutory compliance for unspecified countries; or pixel-for-pixel reproduction of another vendor's UI. New features must state the affected documents, stock/accounting effects, permission, data migration, subscription entitlement and acceptance tests before entering the release scope.
