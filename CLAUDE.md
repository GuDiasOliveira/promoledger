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

## 5. MVP Execution Roadmap (Vertical Slices)

Implement features sequentially in small, verified vertical slices:

- **Slice 1.1 — Scaffold & Async Database Engine:** `docker-compose.yml` (PostgreSQL 16), backend skeleton with `uv`, async SQLAlchemy 2.0 engine, Alembic configuration, and basic healthcheck route with test.
- **Slice 1.2 — Authentication & Identity:** `User` model & migration, password hashing, JWT auth routes (`/api/v1/auth/register`, `/token`, `/me`) and authenticated tests.
- **Slice 1.3 — Core Tenants & Membership:** `Institution` & `Promotion` CRUD, `PromotionMember` contextual RBAC dependency, and membership management endpoints (`/api/v1/promotions/{id}/members`).
- **Slice 2 — Catalog & Orders Core:** `Product` CRUD (with `is_active` soft-archive), `Customer` creation, `Order` + `OrderItem` creation (with frozen `unit_price` snapshot and `Idempotency-Key` header), basic order listing per role with pagination (`?page=1&size=20`).
- **Slice 3 — Reconciliation & Transitions:** Audited transition endpoints (`/payment`, `/delivery`, `/cancel`) with OCC (`expected_version` returning `409 Conflict`), `Idempotency-Key` retries, immutable `ORDER_AUDIT_EVENT` logging, and divergence queries (`GET /reconciliation/divergences`).
- **Slice 4 — Frontend Web & Mobile PWA:** Next.js client with Tailwind CSS, Seller mobile order capture flow (offline queue with IndexedDB / Dexie.js), Admin reconciliation dashboard.
- **Slice 5 — MCP Server & Insights:** Read-only Model Context Protocol server exposing promotion health, seller rankings, and divergence alerts to external AI agents.
