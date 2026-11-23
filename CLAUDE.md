# PromoLedger — Claude Code Guide

## 1. Spec-Driven Workflow (Mandatory)

This project follows a strict Design-First methodology.

- **Single Source of Truth (SSOT):**
  - Product requirements & flows: `docs/prd.md`
  - Data models, invariants & OCC: `docs/erm.md`
  - API routes, contracts & error codes: `docs/api.md`
- Always read the relevant spec files in `/docs` BEFORE generating plans or writing code.
- Always propose a concise vertical slice plan and wait for human confirmation before writing files.

## 2. Core Domain Invariants

- **Zero floating-point money:** Always `Decimal` / `Numeric(10,2)` in Python/Postgres and exact strings in JSON.
- **Offline-first & idempotency:** Mobile mutations require `idempotency_key` (UUIDv4) and `version` (OCC, return `409 Conflict` on mismatch).
- **Immutable audit trail:** Every status transition appends to `ORDER_AUDIT_EVENT` (no destructive updates/deletes).
- **Price snapshotting:** `ORDER_ITEM.unit_price` is frozen from `PRODUCT.price` upon insertion.

## 3. Monorepo Structure & File Layout

```text
/backend
  ├── app/
  │   ├── api/          # FastAPI routers (/api/v1/...)
  │   ├── core/         # Config (pydantic-settings), security (JWT, hashing), database session
  │   ├── models/       # SQLAlchemy 2.0 Mapped models
  │   ├── schemas/      # Pydantic v2 schemas (Create, Update, Response)
  │   └── services/     # Business logic & transition handlers
  ├── alembic/          # Async database migrations
  ├── tests/            # pytest suite
  └── pyproject.toml
/frontend               # Next.js (App Router), TypeScript, Tailwind CSS
/docs                   # SSOT Specifications
docker-compose.yml      # Local dev services (PostgreSQL 16)
```

## 4. Technical Stack Rules & Known Traps

### Backend Tooling & Database

- **Package Manager:** Use `uv` (fast Python package manager). Run commands via `uv run pytest`, `uv add ...`.
- **Database Driver:** Use `postgresql+asyncpg://`.
- **Session Factory:** Always set `expire_on_commit=False` on `async_sessionmaker`.
- **Relationship Loading:** Never rely on implicit lazy-loading (avoids `MissingGreenlet`). Always use explicit eager loading (`selectinload` or `joinedload`).
- **Alembic in Async:** Ensure `alembic/env.py` uses `connection.run_sync()` for migrations with `async_engine_from_config`.
- **Testing Mandate:** **DO NOT use SQLite in-memory for testing.** SQLite lacks native PostgreSQL `TEXT[]` arrays, partial unique indexes, and native `UUID`. Run `pytest` against PostgreSQL (e.g., `promoledger_test` in Docker Compose via `TEST_DATABASE_URL`).
- **Auth & JWT:** Use `bcrypt` or `argon2` for password hashing (`User.password_hash`). JWT payload contains `sub` (User UUID) and `exp`. RBAC is checked dynamically against `PROMOTION_MEMBER(user_id, promotion_id)`.
- **Linting & Formatting:** `uv run ruff check .` and `uv run ruff format .`.

### Local Infrastructure & Verification Commands

- **Service:** `postgres:16-alpine` on port `5432` (`docker-compose.yml`).
- **Default credentials:** user `promoledger`, password `promoledger`, database `promoledger` (test db `promoledger_test`).
- **Start Local Services:** `docker compose up -d`
- **Run Backend Tests:** `DATABASE_URL=postgresql+asyncpg://promoledger:promoledger@localhost:5432/promoledger_test uv run pytest -v`
- **Run Migrations:** `uv run alembic upgrade head`
- **Format & Lint:** `uv run ruff check .` and `uv run ruff format .`

### Frontend Tooling (Slice 4)

- **Framework & UI:** Next.js (App Router), TypeScript, Tailwind CSS.
- **Offline Storage & Queue:** `Dexie.js` for IndexedDB mutations and local order caching.
- **Server State & Cache:** `@tanstack/react-query` v5 for caching and retry/reconnection sync.
- **Package Manager:** `npm` (run from `/frontend`). Next.js **16** with Cache Components: read `frontend/AGENTS.md` and the bundled docs in `frontend/node_modules/next/dist/docs/` before using Next.js APIs.
- **API Access:** the browser only calls the Next.js origin; `next.config.ts` rewrites `/api/v1/*` to `BACKEND_URL` (default `http://localhost:8000`). No CORS.
- **API Contract:** types are generated from the FastAPI OpenAPI schema — never hand-write request/response types. Re-run `npm run gen:api` after any backend contract change.
- **i18n:** `next-intl`, locales `en-US` (default), `pt-BR`, `es-ES`; all UI text goes through `messages/*.json` (key parity is tested). Format numbers/dates/money with `Intl` in the viewer's locale; never assume a region-specific payment method in UI copy.
- **Money:** never `Number`/`parseFloat` for amounts — use `lib/money.ts` (`bigint` cents, exact decimal strings to `Intl`).
- **Offline model (Slice 4.2):** the UI reads from IndexedDB (Dexie, `lib/db.ts`) and refreshes it from the API when online; mutations go through the outbox (`lib/sync/`), written atomically with their optimistic record, with the `Idempotency-Key` fixed at creation. **Every local row is scoped by `userId`** (shared devices).
- **Order actions offline (Slice 4.3):** displayed order state = last server snapshot + **pending** queued actions (`lib/orders/state.ts`); rejected actions are never overlaid. Queued actions chain `expected_version` locally. Outbox items declare `deps`; anything depending on a rejected/held item is **held, not sent** (`blockedItems`). A `CONCURRENCY_CONFLICT` is resolved by the user ("Reapply" rebased on the server state with new keys, skipping already-satisfied actions, or "Discard") — never auto-rebased.
- **Routes:** promotion-scoped pages are **static routes with `?id=`** (`/promotion/sell?id=…`), never dynamic segments, so one cached HTML serves every promotion offline. New pages must be added to `lib/pwa/shell.ts` (enforced by a test).
- **Service worker (`app/sw.ts`, Serwist):** `/api/*` is `NetworkOnly` — API responses must never be cached by the SW (offline data lives per user in IndexedDB). `reloadOnOnline` stays disabled (it would wipe forms being typed).
- **Known Trap — `<Activity>` route preservation:** Cache Components keeps up to 3 visited routes mounted but hidden, *with their state*. Wipe sensitive/transient state in a `useLayoutEffect` cleanup (see `components/auth-form.tsx`), and scope E2E locators to visible elements.
- **Known Trap — horizontal overflow on phones:** anything wider than the screen widens the mobile layout viewport and pushes `position: fixed; bottom: 0` bars (e.g. "Save order") off-screen. E2E asserts `expectNoHorizontalOverflow`.
- **Admin/viewer screens (Slice 4.4):** **online-only** (React Query straight from the API; no IndexedDB, no outbox). On `CONCURRENCY_CONFLICT` the admin screen reloads the order and asks the admin to act again — no automatic retry. Role gating mirrors the API (viewer = read-only, audit trail admin-only). Admin E2E specs are `e2e/admin-*.spec.ts` and run in the `desktop` Playwright project.
- **Admin management (Slice 4.4b):** price inputs use `parseMoneyInput` (`lib/admin/forms.ts`): comma **or** dot as decimal separator, thousands separators **rejected** (ambiguous across locales), output is the exact API string. Screens with several mutations show the **most recent** error via `useLastError` (never `a.error ?? b.error`, which hides newer errors). After promotion create/status changes, call `refreshPromotions` so offline seller screens reflect them.
- **Known Trap — pt-BR plural of zero:** CLDR puts **0 in the `one` category for `pt-BR`** (unlike en-US, es-ES and pt-PT), so `{count, plural, one {# pedido} …}` renders "0 pedido". Add an explicit `=0` case wherever 0 can be shown (tested in `lib/i18n/config.test.ts`).
- **Known Trap — Next's route announcer is a `role="alert"`:** scope E2E alert locators to `main`.
- **Known Trap — `<output>` has role `status`:** don't locate messages with `getByRole("status")` on screens with quantity steppers.

### Frontend Verification Commands

- **Install:** `npm install` (Playwright browser: `npx playwright install chromium`)
- **Dev server:** `npm run dev` (backend must be running on `:8000`)
- **Regenerate API types:** `npm run gen:api`
- **Lint / Types / Unit tests / Build:** `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`
- **E2E (Playwright, production build):** `npm run test:e2e` — starts its own backend (`:8001`) and frontend (`:3001`) and recreates the `promoledger_e2e` database on every run (never `promoledger_test`).
- **PWA icons:** edit `public/icons/icon.svg`, then `node scripts/gen-icons.mjs`.

## 5. MVP Execution Roadmap (Vertical Slices)

Implement features sequentially in small, verified vertical slices:

- **Slice 1.1 — Scaffold & Async Database Engine:** `docker-compose.yml` (PostgreSQL 16), backend skeleton with `uv`, async SQLAlchemy 2.0 engine, Alembic configuration, and basic healthcheck route with test.
- **Slice 1.2 — Authentication & Identity:** `User` model & migration, password hashing, JWT auth routes (`/api/v1/auth/register`, `/token`, `/me`) and authenticated tests.
- **Slice 1.3 — Core Tenants & Membership:** `Institution` & `Promotion` CRUD, `PromotionMember` contextual RBAC dependency, and membership management endpoints (`/api/v1/promotions/{id}/members`).
- **Slice 2 — Catalog & Orders Core:** `Product` CRUD (with `is_active` soft-archive), `Customer` creation, `Order` + `OrderItem` creation (with frozen `unit_price` snapshot and `Idempotency-Key` header), basic order listing per role with pagination (`?page=1&size=20`).
- **Slice 3 — Reconciliation & Transitions:** Audited transition endpoints (`/payment`, `/delivery`, `/cancel`) with OCC (`expected_version` returning `409 Conflict`), `Idempotency-Key` retries, immutable `ORDER_AUDIT_EVENT` logging, and divergence queries (`GET /reconciliation/divergences`).
- **Slice 4 — Frontend Web & Mobile PWA:** Next.js client with Tailwind CSS, Seller mobile order capture flow (offline queue with IndexedDB / Dexie.js), Admin reconciliation dashboard.
- **Slice 5 — MCP Server & Insights:** Read-only Model Context Protocol server exposing promotion health, seller rankings, and divergence alerts to external AI agents.
