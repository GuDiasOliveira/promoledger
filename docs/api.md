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

### 1.3 Standard Headers

| Header            | Type     | Description                                                                                          | Mandatory On                                                                               |
| :---------------- | :------- | :--------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------- |
| `Authorization`   | `string` | Standard Bearer JWT: `Bearer <token>`.                                                               | All protected endpoints.                                                                   |
| `Idempotency-Key` | `UUIDv4` | Unique client-generated key preventing duplicate submissions upon network retries.                   | `POST /promotions/{id}/orders` and state transitions (`/payment`, `/delivery`, `/cancel`). |
| `If-Match`        | `string` | Optional HTTP concurrency header containing the entity `version`. (Alternatively passed in payload). | State transition endpoints.                                                                |

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

## 2. Authentication & User Profile (`/auth`)

| Method | Endpoint                | Min Role      | Description                                                                              |
| :----- | :---------------------- | :------------ | :--------------------------------------------------------------------------------------- |
| `POST` | `/api/v1/auth/register` | Public        | Register a new user account (`name`, `email`, `password`). Returns created user profile. |
| `POST` | `/api/v1/auth/token`    | Public        | Authenticate user via email/credentials; returns JWT access token.                       |
| `GET`  | `/api/v1/auth/me`       | Authenticated | Retrieve current user profile and list of active `PromotionMember` campaigns.            |

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

| Method | Endpoint                    | Min Role      | Description                                                    |
| :----- | :-------------------------- | :------------ | :------------------------------------------------------------- |
| `GET`  | `/api/v1/institutions`      | Authenticated | List all participating institutions.                           |
| `POST` | `/api/v1/institutions`      | Authenticated | Register a new organizational tenant (school, NGO, committee). |
| `GET`  | `/api/v1/institutions/{id}` | Authenticated | Get institution details and associated campaigns.              |

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
  "delivery_date": "2026-03-30"
}
```

> **Creation Guarantees:** Upon creation, the creator user is automatically registered in `PROMOTION_MEMBER` with `roles = ['promotion_admin']`, and the designated `institution_id` is linked in `PROMOTION_INSTITUTION` with `is_lead = true`.

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
- **Side Effect:** Appends `ORDER_CANCELLED` to `ORDER_AUDIT_EVENT`, sets `cancelled_at = NOW()`, increments `version`. Fails with `400 Bad Request` if `delivered_at` is already set.

---

## 9. Reconciliation & Operational Analytics (`/reconciliation`)

Endpoints powering the audit dashboards, divergence alerts, and KPIs.

| Method | Endpoint                                              | Min Role           | Description                                                                                                                                     |
| :----- | :---------------------------------------------------- | :----------------- | :---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/promotions/{id}/reconciliation/summary`      | `PROMOTION_VIEWER` | Aggregated campaign balances: Total Revenue, Settled (`PAID & DELIVERED`), Paid Pending Delivery, and Total Divergences (`DELIVERED & UNPAID`). |
| `GET`  | `/api/v1/promotions/{id}/reconciliation/divergences`  | `PROMOTION_VIEWER` | Filtered list of all orders flagged in divergence state (`paid_at IS NULL AND delivered_at IS NOT NULL`).                                       |
| `GET`  | `/api/v1/promotions/{id}/reconciliation/leaderboard`  | `PROMOTION_VIEWER` | Seller rankings: units sold, gross revenue, settlement percentage.                                                                              |
| `GET`  | `/api/v1/promotions/{id}/reconciliation/audit-events` | `PROMOTION_ADMIN`  | Comprehensive chronological stream of all `ORDER_AUDIT_EVENT` rows for forensic verification.                                                   |
