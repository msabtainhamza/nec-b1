# Codex project instructions

This repository contains a multi-tenant desktop ERP with its own backend. Use `ERP_Product_Requirements_v1.md` as the product baseline when present. The first target is a trading and distribution company. The planned stack is Electron, React, TypeScript, NestJS, PostgreSQL, Redis and private object storage. Do not assume SAP integration is required.

## At the start of every session

1. Read `docs/IMPLEMENTATION_STATUS.md` and `docs/DECISIONS.md` completely.
2. Read the relevant requirements and inspect `git status`, the current branch and recent commits. If a referenced requirements file is absent, say so and continue with the available handoff and code.
3. Inspect the code and tests relevant to the next task. Treat verified code and tests as evidence of implementation; treat the status file as a handoff that may be stale.
4. If uncommitted work exists, inspect it and preserve it. Do not reset, overwrite or reimplement another agent's changes.
5. Continue the highest-priority unfinished task unless the user asks for something else. Resolve small implementation choices from existing decisions. Record material new decisions.

## While implementing

- Keep tenant resolution on the authenticated server side. Enforce authorization and plan limits in the API, not only in Electron.
- Maintain tenant isolation for queries, mutations, imports, exports, files and jobs.
- Treat posting as an atomic, idempotent operation. Preserve immutable stock movements and balanced journal entries where applicable.
- Do not claim country-specific accounting or tax compliance until reviewed and approved for the target jurisdiction.
- Do not introduce SAP branding, names, logos, icons, copied assets, pixel-identical UI or an SAP connector. A visual style and layout resembling SAP Business One is permitted by product-owner decision ADR-021.
- Do not add comments to code.
- Implement a coherent vertical slice and run checks relevant to its behavior. Avoid broad unrelated rewrites.

## Before finishing each session

1. Run relevant tests, build, lint or migration checks and record their exact results, including failures.
2. Update `docs/IMPLEMENTATION_STATUS.md` with completed work, remaining work, blockers, changed files, verification and one concrete next action.
3. Update `docs/DECISIONS.md` for a material architecture, business-rule or scope decision. Never silently erase earlier decisions; mark superseded entries.
4. Report what changed and whether the changes are committed. Do not claim a commit or push that did not occur.

Both Codex and Claude use the same tracked handoff files and Git history. A chat transcript is not the source of truth. If status and code disagree, inspect the discrepancy, correct the handoff and continue safely.
