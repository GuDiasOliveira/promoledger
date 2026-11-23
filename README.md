# PromoLedger

An operational ledger and field-reconciliation platform for offline-first fundraising
campaigns: distributed sellers collect pre-orders and payments during a sales window,
and everything converges on a single batch delivery and reconciliation event.

The product's value is in its guarantees, not its CRUD: frozen price snapshots, idempotent
mutations from flaky mobile networks, optimistic concurrency control, and an immutable audit
trail behind every status change. See [`docs/prd.md`](docs/prd.md) for the problem,
[`docs/erm.md`](docs/erm.md) for the data model and invariants, and
[`docs/api.md`](docs/api.md) for the API contract.

## What runs where

```
browser ──► Next.js :3000 ──rewrite /api/v1/*──► FastAPI :8000 ──► PostgreSQL :5432
```

| Process       | Port   | Started with                                        |
| ------------- | ------ | --------------------------------------------------- |
| PostgreSQL 16 | `5432` | `docker compose up -d` (repo root)                  |
| FastAPI API   | `8000` | `uv run uvicorn app.main:app --reload` (`/backend`) |
| Next.js web   | `3000` | `npm run dev` (`/frontend`)                         |

The browser only ever talks to the Next.js origin. `next.config.ts` rewrites `/api/v1/*` to
`BACKEND_URL` (default `http://localhost:8000`), so there is no CORS configuration and no
second URL exposed to clients. Start the backend first: the frontend is useless without it.

## Prerequisites

- **Docker** running (Postgres only; the app itself runs on the host).
- **[uv](https://docs.astral.sh/uv/)** for the Python side. It manages the virtualenv and
  Python 3.13 itself, so no manual `pip install`.
- **Node >= 20.9** — Next.js 16 refuses to start on older versions. If you use `nvm` and your
  shell resolves an older default, run `nvm use 22` in the frontend terminal before `npm`.

No `.env` is needed for local work: `backend/app/core/config.py` already defaults to the
Docker Compose database and a development JWT key. Copy `backend/.env.example` to
`backend/.env` if you want to change anything. **The default `JWT_SECRET_KEY` must be
overridden outside local and test environments.**

## Quick start

Three terminals, in this order.

**1 — Database**

```bash
docker compose up -d          # repo root
```

On the first run only, the init script also creates the `promoledger_test` database used by
the backend test suite.

**2 — API**

```bash
cd backend
uv run alembic upgrade head                        # idempotent; safe to re-run
uv run uvicorn app.main:app --reload --port 8000
```

**3 — Web**

```bash
cd frontend
nvm use 22                    # only if your default Node is older than 20.9
npm install
npm run dev                   # http://localhost:3000
```

### Verify the whole chain

```bash
curl http://localhost:3000/api/v1/health
# {"status":"ok","database":"ok"}
```

Hitting `:3000` rather than `:8000` is deliberate: it proves the Next.js rewrite and the
database are both working, which is the exact path the browser uses. Interactive API docs
(OpenAPI) are at <http://localhost:8000/docs>.

## Seed demo data

An empty database means clicking through registration, a promotion, a catalog and dozens of
orders before any screen is interesting. The seed does it for you:

```bash
cd backend
uv run python scripts/seed.py --grant-to you@example.com
```

It creates a promotion with 7 products, 15 customers, 3 sellers, a viewer, an admin, and 24
orders covering **all five** `status_classification` states — including the delivered-but-unpaid
`DIVERGENCE` orders the reconciliation screens exist for — plus payment and delivery revocations
so the audit trail and exception logs are not empty. `--grant-to` gives an account you already
registered `promotion_admin` + `seller` on the seed promotion, so you can see everything while
signed in as yourself.

| Flag               | Effect                                                                         |
| ------------------ | ------------------------------------------------------------------------------ |
| `--grant-to EMAIL` | Grant an existing account `promotion_admin` + `seller` on the seed promotion.  |
| `--new`            | Create a fresh, date-stamped promotion instead of topping up the existing one. |
| `--spread-days N`  | Backdate orders across the last N days (default `10`; `0` keeps them today).   |
| `--api-url URL`    | Point at a different API (default `http://localhost:8000`).                    |

The seed **drives the REST API, never raw SQL.** The invariants that matter live in the
application, not the schema, so hand-written rows would produce orders that look right in a
listing and are wrong exactly where the product has value. Keep it that way when adding data.
The one exception is `--spread-days`, which backdates `CUSTOMER_ORDER.created_at` so the
sales-velocity chart has a curve; `ORDER_AUDIT_EVENT` is append-only and never touched.

Re-running is safe. Accounts, institution, promotion and catalog are find-or-created, but
**orders are always appended**, so a second run adds another 24. Use `--new` for a clean set.

## Doing it by hand instead

If you would rather build a promotion through the UI, the order is:

1. **Register** at `/register`, then sign in.
2. **New promotion** from `/promotions`. The form finds or creates the institution inline; you
   pick a name, the sales and delivery dates, and one currency from the 2-decimal allowlist
   (`BRL`, `USD`, `EUR`, `GBP`, `CHF`, `SEK`, `NOK`, `DKK`, `PLN`, `CZK`). It lands you on the
   products screen.
3. **Add products.** `ORDER_ITEM.unit_price` is frozen from `PRODUCT.price` at insertion, so
   later price edits never rewrite history.
4. **Settings → set the status to `ACTIVE`.** Order creation returns `400 PROMOTION_NOT_ACTIVE`
   while a promotion is still `DRAFT`.
5. **Members → give yourself the `seller` role.** Creating a promotion grants only
   `promotion_admin`, and order creation is seller-only, so an admin alone gets
   `403 INSUFFICIENT_ROLE` when trying to sell. Roles are a list per member, so hold both — or
   register a second account as the seller, which is closer to real use.
6. **Sell** at `/promotion/sell?id=…`, then reconcile from the admin screens: mark payment and
   delivery, inspect divergences, read the audit trail.

To see the offline queue, open the seller screens, go offline in DevTools, create an order, and
watch `/promotion/sync` drain the outbox when you come back online. Local rows are scoped by
`userId`, so sign in as an actual seller rather than the admin.

## Verification commands

**Backend** (from `/backend`):

```bash
DATABASE_URL=postgresql+asyncpg://promoledger:promoledger@localhost:5432/promoledger_test \
  uv run pytest -v
uv run ruff check . && uv run ruff format .
```

Tests run against PostgreSQL, never SQLite: the schema relies on `TEXT[]`, partial unique
indexes and native `UUID`.

**Frontend** (from `/frontend`):

```bash
npm run lint && npm run typecheck && npm test && npm run build
npm run gen:api        # regenerate the typed API contract from the FastAPI OpenAPI schema
npx playwright install chromium   # once, before the first E2E run
npm run test:e2e       # production build; starts its own API :8001 and web :3001
```

API request and response types are generated, never hand-written. Re-run `npm run gen:api`
after any backend contract change. The E2E suite recreates the `promoledger_e2e` database on
every run and never touches `promoledger_test`.

## MCP server (read-only)

Exposes promotion health, seller rankings, divergence alerts and sales velocity to AI
assistants. It is a client of the REST API with no database access, and its token is refused
for any non-GET request, so it cannot write even if modified. Customer names and contacts are
never returned.

Create a token in the app under **Your promotions → API tokens** (it starts with `pl_` and is shown
once), then see [`backend/app/mcp/README.md`](backend/app/mcp/README.md) for client setup.

```bash
cd backend
PROMOLEDGER_API_URL=http://localhost:8000 PROMOLEDGER_TOKEN=pl_... uv run python -m app.mcp
```

## Stopping and resetting

```bash
# Ctrl+C in the API and web terminals
docker compose stop      # keep the data
docker compose down      # remove the container, keep the volume
docker compose down -v   # delete the database volume: full reset
```

After `down -v`, re-run `uv run alembic upgrade head` and the seed.

## Troubleshooting

| Symptom                                          | Cause                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Next.js exits on startup                         | Node older than 20.9. `nvm use 22`, then `npm run dev` again.                           |
| `{"status":"degraded","database":"unavailable"}` | Postgres is not up, or still starting. Check `docker compose ps` for `(healthy)`.       |
| `403 INSUFFICIENT_ROLE` when creating an order   | The account is `promotion_admin` but not `seller`. See step 5 above.                    |
| `400 PROMOTION_NOT_ACTIVE`                       | The promotion is still `DRAFT`, or has been `CLOSED`.                                   |
| `409 CONCURRENCY_CONFLICT`                       | Working as designed: `expected_version` is stale. Reload the order and act again.       |
| `address already in use` on `:8000` or `:3000`   | A previous dev server is still alive. `lsof -nP -iTCP:8000 -sTCP:LISTEN`, then kill it. |
| Frontend 404s on `/api/v1/*`                     | The backend is not on `:8000`, or `BACKEND_URL` points elsewhere.                       |

## Repository layout

```text
/backend          FastAPI, async SQLAlchemy 2.0, Alembic, pytest, the MCP server
  app/api         routers (/api/v1/...)          app/models    SQLAlchemy models
  app/core        config, security, database     app/schemas   Pydantic v2 schemas
  app/services    business logic & transitions   scripts/      seed.py
/frontend         Next.js 16 App Router, TypeScript, Tailwind, Dexie, TanStack Query
/docs             the specs: prd.md, erm.md, api.md
CLAUDE.md         conventions, invariants and known traps for AI coding agents
```

Contributors and coding agents should read [`CLAUDE.md`](CLAUDE.md) before writing code: it
holds the domain invariants and a list of traps already paid for.
