# Requirements review - draft 1.1

Date: 24 September 2026

Scope: Internal consistency, workflow completeness, delivery ownership and acceptance coverage of `ERP_Product_Requirements_v1.md`, checked against `DECISIONS.md` and the current handoff. This is a requirements review, not an implementation or accounting-compliance audit. Recommendations below are proposals; they do not amend the product baseline or record approved decisions.

## Assessment

The baseline is sufficient to start repository setup and foundational architecture. Tenant isolation, server-side authorization, immutable posting, idempotency and reversal safeguards are explicit. The new posting dependency gate resolves the earlier sequencing ambiguity at a principle level. Transaction workflows still need the decisions below before their implementation can have objective acceptance criteria. No application source or tests exist to validate behavior.

## Findings requiring resolution

### R-01 - High: General dependency rule conflicts with payment reversal

Evidence: REV-05 blocks reversal while active allocations depend on the original. Section 6.2's payment row and acceptance scenario 18 require remaining allocations to be undone atomically inside payment reversal.

Impact: One implementation could reject a payment reversal that another implementation and its acceptance scenario expect to succeed.

Proposed resolution: Explicitly exempt eligible erroneous-payment reversal from the general allocation block. Require both reverse and unallocate permissions, any applicable approval, and one atomic transaction. Invoice reversal continues to require prior unallocation. Test both missing-unallocate permission and a concurrent allocation attempt.

### R-02 - High: Supplier invoices and outgoing payments lack delivery ownership

Evidence: PUR-03 and PUR-04 are V1 requirements. Section 20 M3 names purchase orders, receipts, stock, transfers, adjustments and valuation; M4 describes sales; M5 does not explicitly assign the supplier invoice/payment workflow. Section 18 has no dedicated purchase-to-pay completion scenario.

Impact: The team could finish every named milestone while procurement cannot complete through supplier settlement.

Proposed resolution: Assign supplier invoices, matching and outgoing payments explicitly to M3 or a named subsequent slice. Add partial receipt/invoice/payment, duplicate supplier invoice reference policy, matching override, concurrent allocation and reversal tests.

### R-03 - High: Service sales have no explicit fulfillment-to-invoice path

Evidence: Section 1.2 and MD-02 include non-stock services. SAL-04 generates invoices from deliveries, while SAL-03 defines inventory deduction. Purchasing explicitly says service receipts do not affect stock; sales has no equivalent rule.

Impact: A service-only order may be impossible to invoice, or may incorrectly require a warehouse movement.

Proposed resolution: Choose either a non-stock service fulfillment document/line or direct order-to-invoice eligibility for services. Define mixed stock/service orders, partial service fulfillment and reversal behavior. Test that service lines never create inventory or stock-cost effects.

### R-04 - High: Posting and valuation ownership remain underspecified

Evidence: PUR-02 specifies stock increases; PUR-03 specifies payable/accounting entries; SAL-04 includes cost-related entries; INV-05 makes adjustment accounting conditional on perpetual inventory. REV-04 requires reversing only effects owned by the source document. FIN-02 and INV-06 deliberately defer the approved posting matrix and costing details.

Impact: The same inventory cost could be recognized twice, or receipt/delivery stock could fail to reconcile to accounts. The dependency gate prevents premature release but does not resolve these missing rules.

Proposed resolution: Before financial posting, decide whether V1 supports one inventory-accounting mode or multiple. Produce an accountant-reviewed matrix assigning each stock/accounting effect to exactly one document. Include receipt/invoice price differences, uninvoiced receipts, delivery-before-invoice, service lines, transfers, opening stock and reversals. Specify valuation scope (tenant/item or warehouse/item), decimal precision, zero-stock residual value and backdated movement behavior. This is an existing open decision requiring concrete examples, not a new claim about accounting standards.

### R-05 - High: Subledger reconciliation can be bypassed by manual journals or opening imports

Evidence: FIN-03 permits journals, FIN-04 requires partner balances to reconcile to control accounts, and FIN-06/REP-03 allow opening balances. There is no explicit rule governing direct manual postings to receivable/payable control accounts or coordinating stock and general-ledger opening imports.

Impact: A balanced journal could still leave aging inconsistent with the control account. Importing both stock valuation and ledger balances could count the same opening amount twice.

Proposed resolution: Restrict control-account postings to subledger-aware operations, or require sufficient partner/open-item data and reconciliation. Define cutover date, import order, opening offset accounts, outstanding invoice due dates, rerun protection and who approves reconciliation. Test balanced-but-unreconciled imports as failures.

### R-06 - Medium: Document lifecycle and approval behavior are incomplete

Evidence: DOC-02, ID-03 and individual purchasing/sales requirements mention drafts, submission, approval, issue, posting, cancellation and closure without a transition table. REV-02 specifies approval invalidation for reversals, but equivalent behavior for ordinary approved documents is not explicit. DOC-01 also treats business partner as universal even for transfers and manual journals.

Impact: Approved quantities/prices could change before posting, different modules could implement incompatible states, and a literal common schema could require irrelevant fields.

Proposed resolution: Define allowed transitions and actions per document type, version checks, edit-after-approval behavior, rejection/resubmission, manual closure and source quantity eligibility. Distinguish universal header fields from type-specific fields. Test modified approved documents and concurrent conversion/partial fulfillment.

### R-07 - Medium: Reservations and quantity units are not implementable policies yet

Evidence: INV-02 leaves reservation behavior configurable, MD-02 names a unit, and purchasing/sales allow quantities without defining conversions, precision or reservation lifecycle.

Impact: Two users may reserve or fulfill the same available stock; purchasing in boxes and selling in pieces may produce inconsistent quantities if implicitly allowed.

Proposed resolution: For the first slice, explicitly select one base unit per item or define conversion rules and rounding. Define when reservations start, which warehouse owns them, release on delivery/cancel/close, expiry, and how concurrent requests are serialized. State whether available stock includes on-order stock. Test partial fulfillment and delivery of another order's reserved stock.

### R-08 - Medium: Entitlement and subscription transitions lack a complete access policy

Evidence: PL-03 defines atomic limits on creation and excludes disabled users from active seats. PL-04 lists subscription states and leaves access mapping configurable. Acceptance scenario 1 describes invitation limits without saying whether invitations reserve seats.

Impact: Reactivation, concurrent invitation acceptance or plan downgrade could produce inconsistent limits. Different endpoints could disagree on grace/suspended access, especially exports and correction operations.

Proposed resolution: Define when seats are consumed, invitation expiry, membership reactivation, branch reactivation and over-limit downgrade behavior. Specify a state/action table for trial, active, past due, grace, suspended and cancelled. Define storage reservation/finalization and the export retention window. Test every limit-increasing transition, not only creation.

### R-09 - Medium: Queue and file failure recovery has no acceptance contract

Evidence: Sections 14-16 require workers, private files, jobs and isolation; DOC-07 requires malware policy. DOC-05 defines transactional posting but does not define behavior when the database commits and enqueueing or file generation fails.

Impact: A document may be posted successfully while its export, PDF or downstream task is lost or duplicated. File upload authorization may outlive membership or quota changes.

Proposed resolution: Define durable dispatch after commit, duplicate-safe workers, retry/dead-letter behavior, job status, permission checks on execution/download, upload quarantine and orphan cleanup. An outbox is one possible design, not yet a mandated implementation. Test worker crash/retry, revoked access, tenant mismatch and upload completion after quota changes.

### R-10 - Medium: Pilot scope may exclude routine customer correction needs

Evidence: Section 2 defers returns and credit notes, and REV-01 correctly states that reversals cannot represent real returns or refunds. Section 19 now identifies unsupported required corrective workflows as pilot blockers.

Impact: A pilot business that needs these workflows cannot complete them within the stated V1 even if all included features work. The new rule identifies this risk but does not establish that the pilot is viable.

Proposed resolution: Validate representative customer workflows before committing the pilot scope. Either commission a bounded returns/credit-note/refund slice or explicitly document and approve how the pilot operates with that limitation. Do not use reversal as a workaround.

## Additional acceptance details to schedule

- Money/tax: quantity, unit-price and amount scales; rounding mode and stage; discount order; inclusive/exclusive tax; zero/exempt behavior. These are mentioned as policies but not selected.
- Reporting: aging as-of date, due-date basis, allocation/unallocation dates, unapplied balances and whether a historical report reflects subsequently posted backdated corrections.
- Security: invitation/reset expiry and reuse, membership revocation during sessions/jobs, support-access expiry and tenant context absent on a pooled database connection.
- Operations: concrete recovery targets, retention periods, restore evidence and supported client/API rollback combinations before pilot acceptance.
- Traceability: map every requirement to a milestone, acceptance scenario and eventual test. The 23 current scenarios cover major flows but do not cover the entire baseline.

## Recommended order

1. Continue M1 scaffolding; resolve R-08 and the identity/tenant permission details before implementing entitlements and authentication behavior.
2. Resolve the textual conflict R-01 and workflow ownership R-02/R-03 before designing transactional APIs.
3. Approve the posting/valuation matrix and opening reconciliation rules (R-04/R-05) before accounting-affecting M2-M4 work.
4. Define lifecycle, reservation and job contracts (R-06/R-07/R-09) alongside their vertical slices.
5. Confirm the pilot's correction needs and measurable operational gates before treating V1 as commercially ready.

## Addendum - Claude review, 28 September 2026

Independently re-read draft 1.1 against R-01 to R-10. The evidence cited for R-01, R-02 and R-03 matches the requirement text. The findings below are additional proposals; they do not amend the baseline.

### R-11 - High: Payments have no cash/bank account model or on-account policy

Evidence: SAL-05 records a payment "method" and PUR-04 posts payments, but FIN-02's mapping list covers inventory, COGS, revenue, tax, receivable and payable only. No master data defines cash/bank accounts. Scenario 18 refers to an "unapplied payment" amount, while PUR-04 posts payment and allocations together and SAL-05 describes allocation to posted invoices.

Impact: Payment journals have no defined debit/credit account. It is unclear whether a payment can exist unallocated (advance or on-account), and how aging and partner balances show it.

Proposed resolution: Add cash/bank accounts (or payment-method-to-account mapping) to FIN-02 and settings. Decide whether V1 permits unallocated and partially allocated payments. If it does, define how they appear in aging and partner balances and how they are later allocated.

### R-12 - Medium: Currency fields exist without a V1 rule

Evidence: Section 2 includes currencies in V1 administration. DOC-01 gives every document a currency and MD-03 gives price lists a currency. Section 1.2 and section 19 exclude foreign-currency transaction posting in V1.

Impact: The schema invites non-base-currency documents that the posting engine must reject. Trading/distribution pilots commonly buy from foreign suppliers; this may be a pilot blocker similar to R-10.

Proposed resolution: State that V1 documents and price lists must use the tenant base currency, and have the API validate this. Confirm with the pilot customer whether they have foreign-currency purchases.

### R-13 - Medium: Employee records are limited but never specified

Evidence: PL-03 and ADR-006 put limits on employee records. Section 3 separates employees from seats, and section 15 lists employees as tenant data. No requirement defines employee fields, screens, lifecycle or archival, and UX-06 does not list them.

Impact: The team must build a plan limit for an entity that has no defined feature.

Proposed resolution: Either add a minimal employee record requirement (fields, archive rule, link to user) or remove employee limits from V1 plans.

### R-14 - Medium: Branch-level data access is undefined

Evidence: ID-02 permissions are `module.resource.action`. UX-01 shows branch context, and documents carry a branch, but no rule limits a user to specific branches or warehouses.

Impact: A multi-branch distributor may need branch staff to see only their own branch's documents or stock. Adding this after the fact affects every query and every report.

Proposed resolution: Decide for V1 whether authorization is tenant-wide or scoped by branch/warehouse. If it is scoped, it must be applied in the API and data layer on the same terms as tenant isolation.

### R-15 - Medium: Source-to-target document cardinality is ambiguous

Evidence: PUR-02 limits a receipt to one purchase order. PUR-03 links "to purchase order/receipt". SAL-03 creates a delivery from an order, and SAL-04 generates an invoice "from delivery". None of these says whether one invoice can cover several receipts or deliveries.

Impact: Consolidated invoicing is common in distribution. Supporting it changes the line-link model, matching, reversal dependency checks (REV-05) and quantity restoration.

Proposed resolution: Specify 1:1 or N:1 for each link (order-to-delivery, delivery-to-invoice, receipt-to-supplier-invoice) in V1, and add a matching scenario.

### R-16 - Medium: Open decisions have no owner or deadline tied to milestones

Evidence: Section 2 allows a V1 customer to operate only in a validated jurisdiction, and section 19 blocks tax-enabled production invoices until validation. The section 19 table has no owner, due date or blocked-milestone column.

Impact: The jurisdiction/tax, costing and posting-matrix decisions sit on the critical path to M3-M5 (per ADR-012) but nothing schedules them.

Proposed resolution: For each open decision, add the owner, the milestone it blocks and the latest date it can be made.

### R-17 - Low: Acceptance scenario wording issues

- Scenario 17 is conditional ("where stock or valuation checks fail"), so it cannot be tested as written. State the expected outcome instead: reversing a receipt of ten after six were delivered is rejected because on-hand would become negative.
- SAL-06 "pending exposure" is undefined (open orders, uninvoiced deliveries or both).
- Discounts appear in PUR-01 but not in the sales requirements.
- The IFRS links in section 6.3 were not verified in this review.

## Verification and limitations

Reviewed the requirements and both handoff documents, the staged file summary and the existing unstaged status diff. The repository is on `master` with no commits; five baseline documents are staged. No code, build configuration or application tests are present. These findings are based on document text and do not establish implementation defects or accounting compliance. Existing staged content was preserved; no product decisions were silently changed.
