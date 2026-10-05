# Local development

## Requirements

- Node.js 22 or later (verified with 24.11.1) and pnpm 10 (`corepack enable`).
- Docker Desktop with WSL 2 for the local services, or an existing PostgreSQL 17+ installation (see "Without Docker").

## One-command setup

```bash
pnpm run setup
```

This copies `.env.example` to `.env` if needed, installs dependencies, builds `@nec/contracts`, starts Docker services, resets and migrates the development database, and seeds two tenants. Add `-- --skip-infra` when PostgreSQL is already running.

All values in `.env.example` are local-only test values. Never reuse them in staging or production.

## Services

| Service | Host port | Purpose |
| --- | --- | --- |
| PostgreSQL 17 | 55432 | `nec_erp` (development) and `nec_erp_test` (tests) |
| Redis 8 | 56379 | Background job queue |
| SeaweedFS S3 | 59000 | Private object storage (not yet used by the API) |
| Mailpit | 51025 SMTP, 58025 web UI | Captures invitation emails |

Ports are offset from defaults so they do not collide with a native PostgreSQL or Redis. The SeaweedFS image is pinned to `latest` because no stable version tag was found; pin it once one is chosen.

## Database roles

| Role | Used by | Notes |
| --- | --- | --- |
| `erp_owner` | Migrations and seed catalog data | Owns all objects; row-level security is forced, so it is not a bypass path |
| `erp_app` | API | No `BYPASSRLS`; append-only audit tables; no insert on plans or operators |
| `erp_worker` | Worker | Read-only tenant catalog plus audit insert |

Tenant context is set per transaction with `set_config(..., true)`, so it cannot leak across pooled connections. Queries without tenant context return no tenant rows.

## Daily commands

```bash
pnpm dev:api
```

```bash
pnpm dev:desktop
```

```bash
pnpm db:reset
```

```bash
pnpm db:seed
```

```bash
pnpm test
```

```bash
pnpm lint
```

`pnpm test` resets `nec_erp_test` for each API test file. The first desktop launch downloads the Electron binary from Electron's GitHub releases.

## Seed data

- Plans: `starter` (5 seats, 3 branches) and `micro` (2 seats, 1 branch).
- Tenants: `acme-trading` (starter, active) and `globex-distribution` (micro, trial), both with a branch coded `HQ` to exercise tenant-scoped uniqueness.
- Users: `owner.acme@nec-erp.localhost`, `owner.globex@nec-erp.localhost`, and `shared.user@nec-erp.localhost` (administrator in Acme, auditor in Globex). The shared password is `SEED_USER_PASSWORD` in `.env`.
- Platform operator: `SEED_OPERATOR_EMAIL` with `SEED_OPERATOR_PASSWORD` and a TOTP code generated from `SEED_OPERATOR_TOTP_SECRET` (any authenticator app, SHA-1, 6 digits, 30 seconds).

## Without Docker

If Docker Desktop cannot start, a separate PostgreSQL cluster can run from an existing PostgreSQL installation without touching the installed service. Run these from Git Bash in the repository root, with `PGBIN` pointing at your PostgreSQL `bin` directory and `PGDATA_DIR` at an empty directory outside the repository:

```bash
set -a; . ./.env; set +a; printf '%s' "$POSTGRES_SUPERUSER_PASSWORD" > "$PGDATA_DIR.pw"; "$PGBIN/initdb" -D "$PGDATA_DIR" -U "$POSTGRES_SUPERUSER" --pwfile="$PGDATA_DIR.pw" --auth=scram-sha-256 -E UTF8 --locale=C
```

```bash
"$PGBIN/pg_ctl" -D "$PGDATA_DIR" -o "-p 55432 -c listen_addresses=localhost" -l "$PGDATA_DIR.log" start
```

```bash
set -a; . ./.env; set +a; PGHOST=localhost PGPORT=$POSTGRES_PORT PGPASSWORD=$POSTGRES_SUPERUSER_PASSWORD POSTGRES_USER=$POSTGRES_SUPERUSER PATH="$PGBIN:$PATH" sh infrastructure/postgres/init/01-roles-and-databases.sh
```

```bash
pnpm run setup -- --skip-infra
```

Redis, object storage and Mailpit are unavailable in this mode. The API still runs; invitation emails fail to send and are logged as `mail.failed`.

### Recovering a refused database connection

`ECONNREFUSED` from `/health` means the API could not connect to its configured PostgreSQL endpoint. Check `DB_HOST` and `POSTGRES_PORT` in `.env`; the ERP defaults to port 55432. A running Windows PostgreSQL service on port 5432 does not establish that the ERP cluster is available.

For the native Windows installation, check readiness from PowerShell:

```powershell
& 'C:/Program Files/PostgreSQL/18/bin/pg_isready.exe' -h localhost -p 55432
```

For a stopped cluster, set `$erpDataDir` to its existing data directory, then check and start it using the matching PostgreSQL major version:

```powershell
$erpDataDir = 'C:/path/to/existing/pgdata'
& 'C:/Program Files/PostgreSQL/18/bin/pg_ctl.exe' -D $erpDataDir status
```

Only if that cluster is stopped and the configured port is free:

```powershell
& 'C:/Program Files/PostgreSQL/18/bin/pg_ctl.exe' -D $erpDataDir -o '-p 55432 -c listen_addresses=localhost' -l "$erpDataDir.log" -w start
Invoke-RestMethod http://127.0.0.1:4000/health
```

See the [PostgreSQL pg_ctl reference](https://www.postgresql.org/docs/18/app-pg-ctl.html) for status and startup behavior. Use `pnpm infra:up` for the Docker-managed cluster. Do not run `initdb`, `pnpm run setup` or `pnpm db:reset` to recover an existing database: setup resets the development schema. Retain the existing cluster and data. Scratch-directory clusters must be started again after a restart and can disappear during temporary-file cleanup; move development data to persistent storage through a planned backup and restore.

`/health` returns 200 with `database: "ok"` after a successful database query, or 503 with `DATABASE_UNAVAILABLE` while that query fails. Restore connectivity, then retry; the API connection pool can reconnect without resetting data.

## API overview

All routes are under `/v1` except `/health`. Errors use `{ "error": { "code", "message", "details?", "correlationId" } }`.

| Route | Access |
| --- | --- |
| `POST /v1/auth/login`, `POST /v1/auth/refresh` | Public |
| `GET /v1/auth/tenants`, `POST /v1/auth/select-tenant`, `POST /v1/auth/logout`, `GET/DELETE /v1/auth/sessions` | Signed-in user |
| `GET /v1/tenant/context` | Selected tenant |
| `/v1/tenant/members`, `/roles`, `/invitations`, `/audit-events`, `/branches` | Selected tenant plus `admin.*` permission |
| `POST /v1/invitations/accept` | Public, invitation code required |
| `/v1/platform/*` | Platform operator (password and TOTP) |
