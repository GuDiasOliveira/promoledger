# API Specification & Route Matrix — PromoLedger

This document specifies the RESTful API design conventions, HTTP status codes, header contracts, and endpoint matrices for **PromoLedger** (`/api/v1`). It serves as the single source of truth for the backend API contracts consumed by the Next.js Web/PWA clients and third-party integrations.

---

## 1. Global Architectural Conventions

### 1.1 Base URL & Content Type

- **Base URL:** `/api/v1`
- **Request & Response Body:** `application/json; charset=utf-8`
- **Date/Time Standard:** ISO 8601 UTC strings (`YYYY-MM-DDTHH:MM:SSZ`).
- **Date Standard:** ISO 8601 Date (`YYYY-MM-DD`).

### 1.2 Monetary Representation

- **Strict Rule:** Currency values MUST be serialized as exact decimal strings (e.g., `"19.90"`) or integer cents (e.g., `1990`). Floating-point numbers are prohibited in requests and responses.
- **Implementation:** PromoLedger uses decimal strings. Request money fields MUST be JSON strings matching `^\d{1,8}(\.\d{1,2})?$` (e.g. `"19.9"` or `"19.90"`); JSON numbers are rejected with `422`. Responses always use exactly two decimal places (`"19.90"`).

- **Currency:** every amount belongs to its promotion's `currency` (ISO 4217, returned on the promotion resource). Amounts carry no currency symbol; clients format them with the promotion currency and the viewer's locale.

### 1.3 Standard Headers

| Header            | Type     | Description                                                                                                                                                              | Mandatory On                                                                               |
| :---------------- | :------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------- |
| `Authorization`   | `string` | Standard Bearer JWT: `Bearer <token>`.                                                                                                                                   | All protected endpoints.                                                                   |
| `Idempotency-Key` | `UUIDv4` | Unique client-generated key preventing duplicate submissions upon network retries.                                                                                       | `POST /promotions/{id}/orders` and state transitions (`/payment`, `/delivery`, `/cancel`). |
| `If-Match`        | `string` | Optional HTTP concurrency header containing the entity `version`. (Alternatively passed in payload). **Not supported in the MVP** — send `expected_version` in the body. | State transition endpoints.                                                                |

### 1.4 Pagination Standard

All collection endpoints returning multiple resources (such as `GET /promotions/{id}/orders`, `GET /promotions/{id}/customers`) follow a standardized envelope and query parameters:

- **Query Parameters:**
  - `page`: Integer >= 1 (default: `1`).
  - `size`: Integer between 1 and 100 (default: `20`).
- **Response Envelope:**
  ```json
  {
    "items": [],
    "total": 100,
    "page": 1,
    "size": 20
  }
  ```

### 1.5 Error Response Standard (RFC 7807 Problem Details)

All error responses (4xx, 5xx) follow RFC 7807:

```json
{
  "type": "https://api.promoledger.org/errors/concurrency-conflict",
  "title": "Conflict",
  "status": 409,
  "code": "CONCURRENCY_CONFLICT",
  "detail": "Order version mismatch (expected: 2, current: 3). Please refresh and retry.",
  "instance": "/api/v1/promotions/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d/orders/e2b6a984-9584-486a-86c8-1123456789ab/payment",
  "errors": []
}
```

Standard Status Codes:

- `200 OK`: Successful synchronous retrieval or state transition.
- `201 Created`: Resource successfully created (includes `Location` header).
- `400 Bad Request`: Validation failure (malformed payload, domain invariant violated).
- `401 Unauthorized`: Missing or expired JWT.
- `403 Forbidden`: Authenticated, but lacks required `PromotionMember` role.
- `404 Not Found`: Resource does not exist or user lacks visibility.
- `409 Conflict`: Concurrency conflict (OCC version mismatch) or idempotency payload collision.
- `422 Unprocessable Entity`: Semantic Pydantic schema validation failure.

---

## 1.6 Operational Endpoints

| Method | Endpoint         | Min Role | Description                                                                                                                                              |
| :----- | :--------------- | :------- | :------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/health` | Public   | Liveness & database readiness probe (`SELECT 1`). Returns `200 {"status":"ok","database":"ok"}` or `503 {"status":"degraded","database":"unavailable"}`. |

---

## 2. Authentication & User Profile (`/auth`)

| Method   | Endpoint                         | Min Role                | Description                                                                                                                                                                 |
| :------- | :------------------------------- | :---------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/v1/auth/register`          | Public                  | Register a new user account (`name`, `email`, `password`). Returns created user profile.                                                                                    |
| `POST`   | `/api/v1/auth/token`             | Public                  | Authenticate user via email/credentials; returns JWT access token.                                                                                                          |
| `POST`   | `/api/v1/auth/tokens`            | Signed in (not a token) | Create a read-only personal access token `{name, expires_in_days (1–365, default 90)}` → `201` with the plain `token` **once**.                                             |
| `GET`    | `/api/v1/auth/tokens`            | Signed in (not a token) | List the caller's tokens (never the plain token).                                                                                                                           |
| `DELETE` | `/api/v1/auth/tokens/{token_id}` | Signed in (not a token) | Revoke (soft, idempotent) → `204`.                                                                                                                                          |
| `GET`    | `/api/v1/auth/me`                | Authenticated           | Retrieve current user profile and list of active `PromotionMember` campaigns (`memberships[]`: `member_id`, `promotion_id`, `promotion_name`, `promotion_status`, `roles`). |

### Auth Error Codes

| Status | `code`                     | When                                                                                   |
| :----- | :------------------------- | :------------------------------------------------------------------------------------- |
| `401`  | `NOT_AUTHENTICATED`        | Missing or non-Bearer `Authorization` header.                                          |
| `401`  | `TOKEN_EXPIRED`            | JWT `exp` is in the past.                                                              |
| `401`  | `INVALID_TOKEN`            | Bad signature, malformed token/claims, or `sub` user no longer exists.                 |
| `401`  | `INVALID_CREDENTIALS`      | `/auth/token` with wrong password **or** unknown email (identical response by design). |
| `409`  | `EMAIL_ALREADY_REGISTERED` | `/auth/register` with an email already in use (case-insensitive).                      |
| `422`  | `VALIDATION_ERROR`         | Payload schema failure; per-field details in `errors[]` (`loc`, `msg`, `type`).        |

> Emails are normalized to lowercase. Passwords: 8–128 characters, hashed with Argon2id. All 401 responses include `WWW-Authenticate: Bearer`.

### Personal Access Tokens (read-only)

- Sent like a JWT: `Authorization: Bearer pl_...`. The token acts as its user (same contextual RBAC).
- **Read-only, enforced server-side for every route:** any method other than `GET`/`HEAD`/`OPTIONS` → `403 TOKEN_READ_ONLY`.
- Token management endpoints require a real sign-in: using a token there → `403 TOKEN_NOT_ALLOWED`.
- Revoked or unknown token → `401 INVALID_TOKEN`; expired → `401 TOKEN_EXPIRED`; another user's token id → `404 TOKEN_NOT_FOUND`.

### Sample Payload: Token Authentication (`POST /api/v1/auth/token`)

Body (`application/json`):

```json
{
  "email": "user@example.com",
  "password": "plainpassword123"
}
```

Response (`200 OK`):

```json
{
  "access_token": "eyJhbGciOi...",
  "token_type": "bearer"
}
```

---

## 3. Institutions (`/institutions`)

| Method | Endpoint                    | Min Role      | Description                                                                                                                         |
| :----- | :-------------------------- | :------------ | :---------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/institutions`      | Authenticated | List all participating institutions. Optional `?q=` case-insensitive name search (LIKE wildcards escaped; results ordered by name). |
| `POST` | `/api/v1/institutions`      | Authenticated | Register a new organizational tenant (school, NGO, committee).                                                                      |
| `GET`  | `/api/v1/institutions/{id}` | Authenticated | Get institution details and associated campaigns.                                                                                   |

---

## 4. Promotions & Membership (`/promotions`)

All campaign sub-resources are scoped under `/promotions/{promotion_id}` to guarantee multi-tenant partition boundaries and RBAC validation.

| Method  | Endpoint                                      | Min Role          | Description                                                                               |
| :------ | :-------------------------------------------- | :---------------- | :---------------------------------------------------------------------------------------- |
| `GET`   | `/api/v1/promotions`                          | Authenticated     | List promotions where the authenticated user is a `PromotionMember`.                      |
| `POST`  | `/api/v1/promotions`                          | Authenticated     | Create a new promotion campaign (creator automatically becomes `PROMOTION_ADMIN`).        |
| `GET`   | `/api/v1/promotions/{id}`                     | `MEMBER`          | Get detailed promotion metadata, operational dates, and current status.                   |
| `PATCH` | `/api/v1/promotions/{id}`                     | `PROMOTION_ADMIN` | Update campaign settings, dates, or lifecycle status (`DRAFT`, `ACTIVE`, `CLOSED`).       |
| `GET`   | `/api/v1/promotions/{id}/members`             | `MEMBER`          | List active members and assigned roles (`seller`, `promotion_admin`, `promotion_viewer`). |
| `POST`  | `/api/v1/promotions/{id}/members`             | `PROMOTION_ADMIN` | Add or invite a user to the campaign with specified roles.                                |
| `PATCH` | `/api/v1/promotions/{id}/members/{member_id}` | `PROMOTION_ADMIN` | Update member roles or revoke membership.                                                 |

### Sample Payload: Promotion Creation (`POST /api/v1/promotions`)

**Body (`application/json`):**

```json
{
  "name": "Easter Chocolate Drive 2026",
  "institution_id": "7f8b9a10-2c3d-4e5f-6a7b-8c9d0e1f2a3b",
  "sales_start_date": "2026-03-01",
  "last_sales_date": "2026-03-25",
  "delivery_date": "2026-03-30",
  "currency": "BRL"
}
```

> **Creation Guarantees:** Upon creation, the creator user is automatically registered in `PROMOTION_MEMBER` with `roles = ['promotion_admin']`, and the designated `institution_id` is linked in `PROMOTION_INSTITUTION` with `is_lead = true`.

### Contextual RBAC Semantics

- Access is checked per request against the caller's **active** `PROMOTION_MEMBER` row (`revoked_at IS NULL`).
- Caller is not an active member of the promotion → `404 PROMOTION_NOT_FOUND` (existence is not disclosed).
- Caller is a member but lacks every accepted role → `403 INSUFFICIENT_ROLE`.
- `GET /institutions/{id}` lists only the associated promotions the caller is an active member of.

### Promotion Update (`PATCH /api/v1/promotions/{id}`)

All fields optional: `name`, `sales_start_date`, `last_sales_date`, `delivery_date`, `status`, `currency`. Dates are validated against the merged (current + new) values. Allowed status transitions: `DRAFT → ACTIVE`, `ACTIVE → CLOSED`, `CLOSED → ACTIVE`.

### Membership Payloads

`POST /api/v1/promotions/{id}/members` — the user must already have an account (no email invitations in the MVP). Re-adding a previously revoked member reactivates the same membership row with the new roles.

```json
{ "email": "seller@example.com", "roles": ["seller"] }
```

`PATCH /api/v1/promotions/{id}/members/{member_id}` — at least one field:

```json
{ "roles": ["seller", "promotion_viewer"], "revoked": true }
```

`revoked: true` soft-revokes (sets `revoked_at`); `revoked: false` reinstates. `GET .../members` returns active members only; pass `?include_revoked=true` to include revoked ones.

### Tenants & Membership Error Codes

| Status | `code`                      | When                                                               |
| :----- | :-------------------------- | :----------------------------------------------------------------- |
| `400`  | `INVALID_DATE_RANGE`        | Not `sales_start_date <= last_sales_date <= delivery_date`.        |
| `400`  | `INVALID_STATUS_TRANSITION` | Status change outside the allowed transitions.                     |
| `400`  | `CURRENCY_LOCKED`           | `PATCH` changes `currency` after the promotion has orders.         |
| `403`  | `INSUFFICIENT_ROLE`         | Active member without a required role.                             |
| `404`  | `INSTITUTION_NOT_FOUND`     | Unknown institution id (path or `institution_id` in body).         |
| `404`  | `PROMOTION_NOT_FOUND`       | Unknown promotion, or caller is not an active member.              |
| `404`  | `USER_NOT_FOUND`            | `POST .../members` with an email that has no account.              |
| `404`  | `MEMBER_NOT_FOUND`          | `member_id` does not belong to this promotion.                     |
| `409`  | `ALREADY_MEMBER`            | `POST .../members` for a user who is already an active member.     |
| `409`  | `LAST_ADMIN`                | Change would leave the promotion with no active `promotion_admin`. |

---

## 5. Products Catalog (`/promotions/{id}/products`)

| Method  | Endpoint                                        | Min Role          | Description                                                                                |
| :------ | :---------------------------------------------- | :---------------- | :----------------------------------------------------------------------------------------- |
| `GET`   | `/api/v1/promotions/{id}/products`              | `MEMBER`          | List catalog items. Defaults to `is_active=true`; admins can pass `include_inactive=true`. |
| `POST`  | `/api/v1/promotions/{id}/products`              | `PROMOTION_ADMIN` | Add a new product to the campaign catalog (`name`, `price`, `description`).                |
| `PATCH` | `/api/v1/promotions/{id}/products/{product_id}` | `PROMOTION_ADMIN` | Update product details, price, or toggle `is_active` (soft-archive).                       |

---

## 6. Customers (`/promotions/{id}/customers`)

| Method | Endpoint                            | Min Role | Description                                                                             |
| :----- | :---------------------------------- | :------- | :-------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/promotions/{id}/customers` | `MEMBER` | Search/list customers registered in this promotion (query param: `?q=name_or_contact`). |
| `POST` | `/api/v1/promotions/{id}/customers` | `SELLER` | Quick-register a customer before or during order capture.                               |

**Body:** `{ "id": "<optional client UUIDv4>", "name": "Ana", "contact": "+55 11 99999-0000" }`

- Without `id`: the server generates it → `201 Created`.
- With `id` (offline capture): first call → `201`; re-sending the same `id` with the same `name`/`contact` → `200 OK` with the existing customer; same `id` with different data (or from another promotion) → `409 CUSTOMER_ID_CONFLICT`.

---

## 7. Orders & Line Items (`/promotions/{id}/orders`)

Orders are the primary transactional ledger entity.

| Method | Endpoint                                    | Min Role | Description                                                                                                                                                                                        |
| :----- | :------------------------------------------ | :------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/promotions/{id}/orders`            | `MEMBER` | List orders with pagination & filters. `SELLER` sees only own orders; `ADMIN`/`VIEWER` see all. <br> **Filters:** `status_classification` (e.g., `DIVERGENCE`), `seller_member_id`, `customer_id`. |
| `POST` | `/api/v1/promotions/{id}/orders`            | `SELLER` | Create an order with line items. Requires `Idempotency-Key` header. Automatically freezes `unit_price` from catalog.                                                                               |
| `GET`  | `/api/v1/promotions/{id}/orders/{order_id}` | `MEMBER` | Retrieve complete order details, line items, and the full `ORDER_AUDIT_EVENT` history.                                                                                                             |

### Sample Payload: Order Creation (`POST /promotions/{id}/orders`)

**Headers:**

```http
Authorization: Bearer <jwt>
Idempotency-Key: 8a5d3f2e-4b6c-4821-b3fa-9d8a1c728e10
Content-Type: application/json
```

**Body:**

```json
{
  "customer_id": "7f8b9a10-2c3d-4e5f-6a7b-8c9d0e1f2a3b",
  "items": [
    {
      "product_id": "3b7d4bad-9bdd-2b0d-7b3d-cb6de2b6a984",
      "quantity": 2
    },
    {
      "product_id": "1c2d3e4f-5a6b-7c8d-9e0f-1a2b3c4d5e6f",
      "quantity": 1
    }
  ],
  "mark_paid_now": false
}
```

### Order Creation Semantics

1. `Idempotency-Key` header is required and must be a UUIDv4 (`400 IDEMPOTENCY_KEY_REQUIRED` / `400 INVALID_IDEMPOTENCY_KEY`).
2. **First request** → `201 Created` + `Location`.
3. **Retry** (same key, same payload, same seller & promotion) → `200 OK` with the existing order and header `Idempotent-Replayed: true`. Checked _before_ any other rule, so a retry succeeds even if the promotion was closed meanwhile.
4. **Same key, different payload** (or another seller/promotion) → `409 IDEMPOTENCY_KEY_REUSED`.
5. Promotion must be `ACTIVE` (`400 PROMOTION_NOT_ACTIVE`). Products must be active and belong to the promotion (`400 PRODUCT_UNAVAILABLE`). Customer must belong to the promotion (`404 CUSTOMER_NOT_FOUND`).
6. `items`: 1–50 lines, `quantity` 1–1000, no repeated `product_id` (consolidate quantities client-side; `422` otherwise).
7. `unit_price` is snapshotted from `PRODUCT.price` in the same transaction. `mark_paid_now: true` sets `paid_at` and appends a `PAYMENT_MARKED` audit event.

### Order Listing & Visibility

- A member whose roles are only `seller` sees only their own orders (the `seller_member_id` filter is ignored for them); `promotion_admin` / `promotion_viewer` see all.
- `status_classification` filter values (ERM §3): `UNPAID_PENDING`, `PAID_PENDING`, `DIVERGENCE`, `SETTLED`, `CANCELLED`.
- Each order includes `customer`, `items` (with `product_name`, `unit_price` and `line_total`), `total_amount`, `version` and `status_classification`. `product_name` is the current catalog name (also for archived products) and is display-only; `unit_price` remains the frozen snapshot. `GET .../orders/{order_id}` also includes `audit_events`. An order outside the caller's visibility → `404 ORDER_NOT_FOUND`.

### Catalog, Customers & Orders Error Codes

| Status | `code`                     | When                                                               |
| :----- | :------------------------- | :----------------------------------------------------------------- |
| `400`  | `IDEMPOTENCY_KEY_REQUIRED` | Missing `Idempotency-Key` header.                                  |
| `400`  | `INVALID_IDEMPOTENCY_KEY`  | Header is not a UUIDv4.                                            |
| `400`  | `PROMOTION_NOT_ACTIVE`     | Order creation while promotion is `DRAFT` or `CLOSED`.             |
| `400`  | `PRODUCT_UNAVAILABLE`      | Item references an inactive product or one from another promotion. |
| `403`  | `INSUFFICIENT_ROLE`        | e.g. non-admin passing `include_inactive=true` on products.        |
| `404`  | `PRODUCT_NOT_FOUND`        | `product_id` not in this promotion.                                |
| `404`  | `CUSTOMER_NOT_FOUND`       | `customer_id` not in this promotion.                               |
| `404`  | `ORDER_NOT_FOUND`          | Unknown order or outside the caller's visibility.                  |
| `409`  | `IDEMPOTENCY_KEY_REUSED`   | Key already used with a different payload / seller / promotion.    |
| `409`  | `CUSTOMER_ID_CONFLICT`     | Client-supplied customer `id` already exists with different data.  |

---

## 8. Lifecycle Transitions & Reconciliation Events

To enforce auditability, status changes (`paid_at`, `delivered_at`, `cancelled_at`) do not use unstructured `PATCH` calls. Instead, they use explicit, audited transition endpoints protected by **Optimistic Concurrency Control (OCC)** and client **Idempotency**.

- **Idempotency Header:** All transition endpoints require the `Idempotency-Key` header (UUIDv4). If a request with an already-processed `Idempotency-Key` is retried due to mobile network reconnects, the server returns the existing order state with `200 OK` rather than raising a `409 Concurrency Conflict`.
- **OCC Invariant:** Every transition payload MUST provide the `expected_version` integer. If the request is not an idempotent retry and the database record's `version != expected_version`, the server aborts the transaction and returns `409 Conflict`.

### 8.1 Payment Transition

- **Endpoint:** `POST /api/v1/promotions/{id}/orders/{order_id}/payment`
- **Roles:** `SELLER` (own orders), `PROMOTION_ADMIN` (any order)
- **Body Schema:**
  ```json
  {
    "action": "MARK_PAID", // or "REVOKE_PAYMENT"
    "expected_version": 1,
    "reason": "Payment revoked: transfer proof was forged" // Mandatory if REVOKE
  }
  ```
- **Side Effect:** Appends event `PAYMENT_MARKED` or `PAYMENT_REVOKED` to `ORDER_AUDIT_EVENT`, increments `version`, and updates `paid_at`.

### 8.2 Delivery Handover Transition

- **Endpoint:** `POST /api/v1/promotions/{id}/orders/{order_id}/delivery`
- **Roles:** `SELLER` (own orders), `PROMOTION_ADMIN` (any order)
- **Body Schema:**
  ```json
  {
    "action": "MARK_DELIVERED", // or "REVOKE_DELIVERY"
    "expected_version": 2,
    "reason": "Item was damaged during handover; returned to stock" // Mandatory if REVOKE
  }
  ```
- **Side Effect:** Appends event `DELIVERY_MARKED` or `DELIVERY_REVOKED` to `ORDER_AUDIT_EVENT`, increments `version`, and updates `delivered_at`.

### 8.3 Order Cancellation

- **Endpoint:** `POST /api/v1/promotions/{id}/orders/{order_id}/cancel`
- **Roles:** `SELLER` (unfulfilled own orders only), `PROMOTION_ADMIN`
- **Body Schema:**
  ```json
  {
    "expected_version": 1,
    "reason": "Customer cancelled order before fulfillment day"
  }
  ```
- **Side Effect:** Appends `ORDER_CANCELLED` to `ORDER_AUDIT_EVENT`, sets `cancelled_at = NOW()`, increments `version`. Fails with `400 Bad Request` if `delivered_at` is already set, or if `paid_at` is set (revoke the payment first).

### 8.4 Transition Processing Order & Responses

Each transition runs in a single transaction, evaluated in this order:

1. **Idempotent replay** — key already used with the same payload by the same member → `200 OK` with the _current_ order state and `Idempotent-Replayed: true` (even if later transitions changed the version). Same key, different payload/actor → `409 IDEMPOTENCY_KEY_REUSED`.
2. **Visibility & permission** — order outside the caller's visibility → `404 ORDER_NOT_FOUND`; visible but not modifiable (e.g. a seller+viewer on another seller's order) → `403 INSUFFICIENT_ROLE`.
3. **OCC** — `expected_version` ≠ current `version` → `409 CONCURRENCY_CONFLICT` (detail: `expected: N, current: M`).
4. **Transition rule** — not allowed in the current state → `400 INVALID_TRANSITION` (detail explains why).
5. **Write** — `UPDATE ... SET <timestamp>, version = version + 1 WHERE id = :id AND version = :expected`; 0 rows (concurrent change) → `409 CONCURRENCY_CONFLICT`, unless the concurrent winner was this same idempotent request (→ replay `200`). Then the audit event is appended.

Success → `200 OK` with the full order (`items`, `audit_events`, new `version`). `reason` is required (non-blank) for `REVOKE_PAYMENT`, `REVOKE_DELIVERY` and cancellation (`422` otherwise).

| Status | `code`                   | When                                                  |
| :----- | :----------------------- | :---------------------------------------------------- |
| `400`  | `INVALID_TRANSITION`     | Transition not allowed in the order's current state.  |
| `409`  | `CONCURRENCY_CONFLICT`   | `expected_version` does not match (stale client).     |
| `409`  | `IDEMPOTENCY_KEY_REUSED` | Key already used for a different transition or actor. |

---

## 9. Reconciliation & Operational Analytics (`/reconciliation`)

Endpoints powering the audit dashboards, divergence alerts, and KPIs.

| Method | Endpoint                                              | Min Role           | Description                                                                                                                                     |
| :----- | :---------------------------------------------------- | :----------------- | :---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/promotions/{id}/reconciliation/summary`      | `PROMOTION_VIEWER` | Aggregated campaign balances: Total Revenue, Settled (`PAID & DELIVERED`), Paid Pending Delivery, and Total Divergences (`DELIVERED & UNPAID`). |
| `GET`  | `/api/v1/promotions/{id}/reconciliation/divergences`  | `PROMOTION_VIEWER` | Filtered list of all orders flagged in divergence state (`paid_at IS NULL AND delivered_at IS NOT NULL`).                                       |
| `GET`  | `/api/v1/promotions/{id}/reconciliation/leaderboard`  | `PROMOTION_VIEWER` | Seller rankings: units sold, gross revenue, settlement percentage.                                                                              |
| `GET`  | `/api/v1/promotions/{id}/reconciliation/audit-events` | `PROMOTION_ADMIN`  | Comprehensive chronological stream of all `ORDER_AUDIT_EVENT` rows for forensic verification.                                                   |

- `PROMOTION_VIEWER` endpoints are also open to `PROMOTION_ADMIN`; seller-only members get `403 INSUFFICIENT_ROLE`.
- All amounts are exact decimal strings computed in SQL over `quantity × unit_price` (`NUMERIC`). Cancelled orders are excluded from revenue.
- **`summary`** — `total_revenue`, `collected_amount` (paid), `outstanding_amount` (revenue − collected), `units_ordered`, `units_delivered`, and `by_classification`: `{count, amount}` for each of `UNPAID_PENDING`, `PAID_PENDING`, `DIVERGENCE`, `SETTLED`, `CANCELLED`.
- **`divergences`** — paginated orders with `paid_at IS NULL AND delivered_at IS NOT NULL AND cancelled_at IS NULL` (same shape as the order list).
- **`leaderboard`** — per seller with at least one non-cancelled order: `member_id`, `user_id`, `name`, `order_count`, `units_sold`, `gross_revenue`, `settled_amount`, `settlement_percentage` (`"75.00"`), ordered by `gross_revenue` desc.
- **`audit-events`** — paginated, chronological (oldest first); optional filters `order_id`, `event_type`.
