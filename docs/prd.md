# PromoLedger

A high-integrity operational ledger and field-reconciliation platform for distributed offline-first fundraising campaigns, featuring audit trails, idempotency, and contextual RBAC.

## PRD (Product Requirement Document)

## Context

Many philanthropic non-profit entities and organizations promote decentralized fundraising campaigns, for different purposes (e.g., a cause, a project, a trip, an event, institutional expenses, etc.) using a pre-order or batch-fulfillment lifecycle.

In this model, distributed volunteers collect orders and upfront payments across a designated sales window, which culminates in a single, centralized batch delivery and reconciliation event.

### Problem

However, almost all of these stakeholders execute these processes manually, which may incur logistical and processual errors and frictions, and limited control for each stakeholder.

Some consequences of these risks:

- **Overselling divergences:** Occurs when sellers (often the most enthusiastic ones) accept more orders than the actual stock available, creating a shortfall that forces later cancellations or manual reconciliation.

- **Payment/inventory mismatches:** Manual tracking makes it hard to reconcile payments (cash or digital) against physical inventory, leading to “missing” items or unexplained cash shortages.

- **Delayed reconciliation and reporting:** Without real-time visibility, stakeholders cannot quickly assess campaign performance, track pending deliveries, or verify individual seller contributions.

- **High administrative overhead:** Staff members spend significant time manually validating orders, cross-referencing spreadsheets, and resolving discrepancies, diverting focus from strategic activities.

- **Limited accountability:** The lack of a clear, automated audit trail makes it difficult to assign responsibility when errors occur, potentially eroding trust among organizers and participants.

### Solution – Single Source of Truth

This PRD proposes a software application to address these promotion frictions by automating the control of E2E promotion processes.

#### Solution overview proposals

1. **Campaign Lifecycle & Operational Management:** Define a promotion’s lifecycle: sales start date; sales end date; delivery date; campaign status (draft, active, closed); and minimum items/revenue goals.
2. **Inventory Control & Order Tracking:** Control and track orders and deliveries: track payments, orders, item fulfillment, and customer handovers. Attributes to make these features trackable: timestamps, amounts (money, items), seller attribution, identifiers, idempotency.
3. **Campaign Reconciliation:** Control and reconcile collected payments against physical stock disbursed, detecting divergences in real time.
4. **Actionable Insights & Data Context (via MCP & Analytics):** Support data analytics, such as campaign performance tracking, sales velocity, seller leaderboards, and contextual data for AI agents.

## Stakeholders

- Organizations and companies (e.g., schools, universities, churches, charities).

- Sellers (e.g., students, religious people, philanthropists).

- Promotion admins (e.g., staff members).

- Promotion viewers (e.g., staff members, donors).

- Customers (e.g., people who buy the products).

## Personas & Contextual RBAC

| #     | Persona                | Responsibilities                                                                                                                                                         | RBAC Roles         | Features                                                                                                                                                                                                               |
| ----- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | **Seller**             | The responsible user to perform the sales of the products.                                                                                                               | `SELLER`           | - Browse product catalog <br> - Register customer orders <br> - Mark orders as paid / revoke payment <br> - Mark orders as delivered / revoke delivery <br> - Cancel own unfulfilled orders <br> - View own sales data |
| **2** | **Promotion's admin**  | The user that is responsible to admin a specific promotion (e.g., CRUD promotions).                                                                                      | `PROMOTION_ADMIN`  | - Create/update/delete promotions (CRUD) <br> - Assign sellers to promotions <br> - View/edit all sales data <br> - Close/reopen promotions <br> - View financial reports                                              |
| **3** | **Promotion's viewer** | The user who is responsible for tracking a specific promotion, auditing and supervising sellers, tracking sales (e.g., whether the sales are on the expected goal), etc. | `PROMOTION_VIEWER` | - View promotions <br> - View sales data <br> - View leaderboards <br> - Access analytics & reports                                                                                                                    |

## Functional Capabilities

### Target Clients & Interfaces

#### API (Backend Core)

- **Role:** Central REST API and business logic engine for web/mobile clients and third-party integrations.
- **Tech Stack:** Python, FastAPI, OpenAPI, PostgreSQL.

#### Web Application (Admin & Desktop)

- **Role:** Comprehensive management interface for Promotion Admins and Viewers.
- **Tech Stack:** Next.js (React), TypeScript, TailwindCSS.

#### Mobile PWA (Field Seller Client) (Phones & Tablets)

- **Role:** Lightweight, fast interface for Sellers in the field, with responsive design and offline-ready local storage.
- **Tech Stack:** PWA (Progressive Web App via Next.js).

#### MCP Server (AI & Context Layer)

- **Role:** Exposes read-only operational context (campaign stats, sales velocity) to AI agents using the Model Context Protocol.

### ERM (Entity Relationship Model)

[Check the ERM modelling here](erm.md).

## System Guarantees & Non-Functional Requirements (NFRs)

1. **Idempotent Mutations:**
   - Every mutation initiated from mobile clients (such as creating an order or marking a payment) must accept a client-generated `idempotency_key` (UUID v4) to prevent duplicate operations during network retries.

2. **Offline-First Resilience:**
   - Field Sellers must be able to record orders and status changes locally while disconnected. Pending actions are queued in local storage (IndexedDB) and synchronized automatically with exponential backoff when connectivity resumes.

3. **Immutable Audit Trail:**
   - Critical lifecycle transitions (`PAYMENT_MARKED`, `PAYMENT_REVOKED`, `DELIVERY_MARKED`, `DELIVERY_REVOKED`, `ORDER_CANCELLED`) must append records to `ORDER_AUDIT_EVENT`. Destructive overwrites on historical events are prohibited.

4. **Optimistic Concurrency Control:**
   - To prevent race conditions during concurrent field operations, order updates enforce optimistic locking via an incremental `version` counter.

## User flows

1. **Field Seller Flow (Order to Handover):**
   - **Phase 1 (Sales Window):** Collect customer demand → Capture order (online or offline) → Collect informal payment (cash / transfer) and mark `paid_at` → Local queue syncs with backend.
   - **Phase 2 (Delivery Day):** Retrieve customer pending deliveries → Hand over physical items → Mark `delivered_at` (triggers `ORDER_AUDIT_EVENT`).

2. **Promotion Admin Flow (Setup to Final Settlement):**
   - **Setup:** Create or Select Institution → Configure Promotion (Products, Pricing, Sales/Delivery Deadlines, Quotas) → Assign Members & Roles.
   - **Monitoring & Audit:** Track real-time sales velocity → Audit payment collections per seller → Inspect exception logs (`REVOKED` events).
   - **Reconciliation:** Close promotion on delivery day → Reconcile physical units disbursed against digital ledger confirmations.

## Out of scope (MVP)

- **Payment Gateway Processing & Automated Clearing:** The system records operational payment states (`paid_at`), but does not process credit cards, bank slips, or automated bank transfers transactions directly.
- **Direct-to-Consumer (B2C) Public E-commerce:** To prevent quota conflicts and maintain volunteer attribution, all orders must be mediated through an authorized Field Seller.
- **Seller Commissions & Automatic Payouts:** Calculation of monetary commissions or automated seller disbursements (reconciliation focuses strictly on campaign inventory, revenue, and cash collection).

## Success Metrics & KPIs

1. **Reconciliation Discrepancy Rate:** < 0.1% divergence between physical inventory disbursed and orders marked as delivered.
2. **Offline Sync Reliability:** 99.9% successful mutation processing without manual conflict intervention.
3. **Audit Coverage:** 100% of status transitions (`PAID`, `DELIVERED`, `REVOKED`, `CANCELLED`) backed by an immutable `ORDER_AUDIT_EVENT` log.

## Future Phases

- Automated seller commission accounting and distribution.
- Automated hard quota limits per seller with real-time stock reservation locks.
- Mobile-native applications for mobile module interface (Flutter, Dart).
- Customers’ addresses, then plan a GPS route map for the user (Travelling Salesman Problem algorithm) to deliver each client’s orders.
