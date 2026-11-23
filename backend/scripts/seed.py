#!/usr/bin/env python3
"""Dev seed: fills a demo promotion with data, through the REST API.

Everything here goes over HTTP, like any other client; nothing is INSERTed
straight into Postgres. The invariants that make PromoLedger worth anything --
the frozen `ORDER_ITEM.unit_price` snapshot, the monotonic `ORDER.version`, one
`ORDER_AUDIT_EVENT` per transition -- live in the application, not in the
schema. Hand-written rows look right in a listing and are wrong exactly where
the product has value, so the seed drives the real endpoints instead.

The single exception is `--spread-days` (see `spread_order_dates`), which
backdates `CUSTOMER_ORDER.created_at` so the sales-velocity chart has a curve.
The audit log is never touched.

Needs the API running (default http://localhost:8000):

    uv run python scripts/seed.py
    uv run python scripts/seed.py --grant-to you@example.com
    uv run python scripts/seed.py --new          # fresh promotion, not a top-up
    uv run python scripts/seed.py --spread-days 0
    uv run python scripts/seed.py --lang en      # English names (README screenshots)

Re-running is safe: accounts, institution, promotion and catalog are
find-or-created; orders are always appended.
"""

import argparse
import asyncio
import sys
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

DEFAULT_API_URL = "http://localhost:8000"
API_PREFIX = "/api/v1"

# RFC 2606 reserved TLD: accepted by the e-mail validator, never deliverable.
# (`.test` and `.local` are rejected as special-use names -- don't switch to them.)
EMAIL_DOMAIN = "promoledger.example"
SEED_PASSWORD = "promoledger-seed-2026"

CURRENCY = "BRL"
MCP_TOKEN_NAME = "Seed - MCP"


@dataclass(frozen=True)
class SeedUser:
    key: str
    name: str
    roles: tuple[str, ...]

    @property
    def email(self) -> str:
        return f"seed.{self.key}@{EMAIL_DOMAIN}"


# The admin also gets `seller`: creating a promotion only grants `promotion_admin`,
# and order creation is seller-only, so without this one login cannot do both.
PEOPLE = (
    SeedUser("admin", "Ana Moreira", ("promotion_admin", "seller")),
    SeedUser("viewer", "Eduardo Lima", ("promotion_viewer",)),
    SeedUser("seller1", "Bruna Carvalho", ("seller",)),
    SeedUser("seller2", "Caio Ferreira", ("seller",)),
    SeedUser("seller3", "Dayane Rocha", ("seller",)),
)
SELLER_KEYS = ("seller1", "seller2", "seller3")


@dataclass(frozen=True)
class SeedProduct:
    key: str
    name: str
    price: str
    description: str | None = None
    active: bool = True


PRODUCTS_PT = (
    SeedProduct("brigadeiro", "Caixa de brigadeiros (12 un.)", "38.00", "Receita tradicional."),
    SeedProduct("beijinho", "Caixa de beijinhos (12 un.)", "38.00", "Coco fresco ralado."),
    SeedProduct("bolo", "Bolo de pote (300 g)", "22.50", "Sabores do dia."),
    SeedProduct("pudim", "Pudim individual", "14.90", "Porcao de 150 g."),
    SeedProduct("trufa", "Trufa sortida (un.)", "6.75"),
    SeedProduct("cocada", "Cocada cremosa", "9.00", "Embalagem de 200 g."),
    # Archived on purpose: exercises the soft-archive and `?include_inactive=true`.
    SeedProduct("pacoca", "Pacoca artesanal", "7.50", "Fora de catalogo nesta campanha.", False),
)

CUSTOMERS = (
    ("Alice Prado", "+55 11 98811-0101"),
    ("Bernardo Alves", "+55 11 98811-0102"),
    ("Camila Nogueira", "+55 11 98811-0103"),
    ("Diego Barreto", "+55 21 98811-0104"),
    ("Elisa Monteiro", "+55 21 98811-0105"),
    ("Fabio Queiroz", "+55 31 98811-0106"),
    ("Gabriela Pinto", "+55 31 98811-0107"),
    ("Heitor Salgado", "+55 41 98811-0108"),
    ("Isabela Fonseca", "+55 41 98811-0109"),
    ("Joao Vitor Rezende", "+55 51 98811-0110"),
    ("Karina Esteves", "+55 51 98811-0111"),
    ("Lucas Andrade", "+55 62 98811-0112"),
    ("Marina Caldeira", "+55 62 98811-0113"),
    ("Nicolas Bastos", "+55 71 98811-0114"),
    ("Olivia Tavares", "+55 71 98811-0115"),
)

# Lifecycles, and the `status_classification` each one lands on (ERM section 3):
#   unpaid            -> UNPAID_PENDING
#   paid              -> PAID_PENDING
#   divergence        -> DIVERGENCE      (delivered and never paid)
#   settled           -> SETTLED
#   cancelled         -> CANCELLED
#   payment_revoked   -> UNPAID_PENDING  (with PAYMENT_MARKED + PAYMENT_REVOKED in the trail)
#   delivery_revoked  -> PAID_PENDING    (with DELIVERY_MARKED + DELIVERY_REVOKED)
LIFECYCLES_PAYING = frozenset({"paid", "settled", "payment_revoked", "delivery_revoked"})
LIFECYCLES_DELIVERING = frozenset({"divergence", "settled", "delivery_revoked"})


@dataclass(frozen=True)
class SeedOrder:
    days_ago: int
    seller: str
    customer: int
    items: tuple[tuple[str, int], ...]
    lifecycle: str
    paid_at_creation: bool = False


# Oldest first, thinning out toward today, so the velocity chart ramps up and the
# older orders are the ones already settled.
ORDERS = (
    SeedOrder(9, "seller1", 0, (("brigadeiro", 2),), "settled"),
    SeedOrder(9, "seller2", 1, (("beijinho", 3), ("bolo", 1)), "settled"),
    SeedOrder(8, "seller1", 2, (("trufa", 6),), "divergence"),
    SeedOrder(7, "seller3", 3, (("brigadeiro", 1), ("pudim", 2)), "settled"),
    SeedOrder(7, "seller2", 4, (("cocada", 4),), "delivery_revoked"),
    SeedOrder(6, "seller1", 5, (("bolo", 2),), "settled"),
    SeedOrder(6, "seller3", 6, (("brigadeiro", 3),), "paid", True),
    SeedOrder(5, "seller2", 7, (("beijinho", 2), ("trufa", 4)), "divergence"),
    SeedOrder(5, "seller1", 8, (("pudim", 3),), "settled"),
    SeedOrder(5, "seller3", 9, (("brigadeiro", 2), ("cocada", 2)), "paid"),
    SeedOrder(4, "seller2", 10, (("bolo", 1),), "cancelled"),
    SeedOrder(4, "seller1", 11, (("trufa", 10),), "paid", True),
    SeedOrder(3, "seller3", 12, (("beijinho", 1),), "payment_revoked"),
    SeedOrder(3, "seller2", 13, (("brigadeiro", 4), ("bolo", 2)), "paid"),
    SeedOrder(3, "seller1", 14, (("pudim", 1), ("cocada", 1)), "divergence"),
    SeedOrder(2, "seller3", 0, (("brigadeiro", 1),), "paid"),
    SeedOrder(2, "seller2", 2, (("trufa", 3),), "unpaid"),
    SeedOrder(2, "seller1", 4, (("bolo", 3),), "paid", True),
    SeedOrder(1, "seller3", 6, (("beijinho", 2),), "unpaid"),
    SeedOrder(1, "seller2", 8, (("cocada", 5),), "cancelled"),
    SeedOrder(1, "seller1", 9, (("brigadeiro", 2), ("pudim", 1)), "paid"),
    SeedOrder(0, "seller3", 11, (("trufa", 2),), "unpaid"),
    SeedOrder(0, "seller2", 13, (("bolo", 1), ("beijinho", 1)), "unpaid"),
    SeedOrder(0, "seller1", 14, (("brigadeiro", 5),), "unpaid"),
)

# Same product keys as PRODUCTS_PT, so ORDERS works with either catalog.
PRODUCTS_EN = (
    SeedProduct("brigadeiro", "Brigadeiro box (12 pcs)", "38.00", "Classic chocolate fudge balls."),
    SeedProduct("beijinho", "Coconut kisses box (12 pcs)", "38.00", "Freshly grated coconut."),
    SeedProduct("bolo", "Cake in a jar (300 g)", "22.50", "Flavor of the day."),
    SeedProduct("pudim", "Caramel flan", "14.90", "150 g serving."),
    SeedProduct("trufa", "Assorted truffle (each)", "6.75"),
    SeedProduct("cocada", "Creamy coconut candy", "9.00", "200 g pack."),
    SeedProduct("pacoca", "Handmade peanut candy", "7.50", "Not offered this campaign.", False),
)


@dataclass(frozen=True)
class SeedTexts:
    """Every free-text value the seed writes, per `--lang`. People and customers stay as-is."""

    institution: str
    promotion: str
    products: tuple[SeedProduct, ...]
    reason_payment_revoked: str
    reason_delivery_revoked: str
    reason_cancelled: str


TEXTS = {
    # Default: the dev seed, in the language of the people who run it.
    "pt": SeedTexts(
        institution="Colegio Santa Clara",
        promotion="Campanha de Pascoa (seed)",
        products=PRODUCTS_PT,
        reason_payment_revoked=(
            "Comprovante de transferencia nao localizado na conciliacao bancaria."
        ),
        reason_delivery_revoked=(
            "Caixa devolvida pelo cliente: dois itens danificados no transporte."
        ),
        reason_cancelled="Cliente desistiu antes do dia da entrega.",
    ),
    # For the README screenshots (`npm run screenshots`), which are taken in en-US.
    "en": SeedTexts(
        institution="Santa Clara School",
        promotion="Holiday Sweets Fundraiser",
        products=PRODUCTS_EN,
        reason_payment_revoked="Bank transfer receipt not found during reconciliation.",
        reason_delivery_revoked="Box returned by the customer: two items damaged in transit.",
        reason_cancelled="Customer changed their mind before delivery day.",
    ),
}


# --- HTTP client ----------------------------------------------------------------------------


class ApiError(RuntimeError):
    """An RFC 7807 error response, with `code` kept for flow control."""

    def __init__(self, response: httpx.Response) -> None:
        self.status = response.status_code
        self.code = ""
        detail = response.text
        try:
            body = response.json()
        except ValueError:
            body = None
        if isinstance(body, dict):
            self.code = str(body.get("code") or "")
            detail = str(body.get("detail") or detail)
            if body.get("errors"):
                detail = f"{detail} {body['errors']}"
        request = response.request
        super().__init__(
            f"{request.method} {request.url.path} -> {self.status} {self.code}: {detail}"
        )


class Api:
    def __init__(self, base_url: str) -> None:
        self._client = httpx.Client(base_url=base_url.rstrip("/") + API_PREFIX, timeout=30.0)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "Api":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def request(
        self,
        method: str,
        path: str,
        *,
        token: str | None = None,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        idempotent: bool = False,
    ) -> Any:
        headers: dict[str, str] = {}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if idempotent:
            headers["Idempotency-Key"] = str(uuid.uuid4())
        response = self._client.request(method, path, json=json, params=params, headers=headers)
        if response.is_error:
            raise ApiError(response)
        return response.json() if response.content else None


# --- idempotent setup steps -----------------------------------------------------------------


def ensure_account(api: Api, person: SeedUser) -> str:
    """Register the account if new, then sign in. Returns the JWT."""
    try:
        api.request(
            "POST",
            "/auth/register",
            json={"name": person.name, "email": person.email, "password": SEED_PASSWORD},
        )
    except ApiError as exc:
        if exc.code != "EMAIL_ALREADY_REGISTERED":
            raise
    body = api.request(
        "POST", "/auth/token", json={"email": person.email, "password": SEED_PASSWORD}
    )
    return str(body["access_token"])


def ensure_institution(api: Api, token: str, name: str) -> str:
    page = api.request(
        "GET", "/institutions", token=token, params={"q": name, "page": 1, "size": 50}
    )
    for item in page["items"]:
        if item["name"] == name:
            return str(item["id"])
    created = api.request("POST", "/institutions", token=token, json={"name": name})
    return str(created["id"])


def ensure_promotion(api: Api, token: str, institution_id: str, name: str) -> tuple[dict, bool]:
    page = api.request("GET", "/promotions", token=token, params={"page": 1, "size": 100})
    for item in page["items"]:
        if item["name"] == name:
            return item, False

    today = date.today()
    promotion = api.request(
        "POST",
        "/promotions",
        token=token,
        json={
            "name": name,
            "institution_id": institution_id,
            # Sales window open and delivery ahead, so the promotion stays orderable.
            "sales_start_date": str(today - timedelta(days=21)),
            "last_sales_date": str(today + timedelta(days=10)),
            "delivery_date": str(today + timedelta(days=24)),
            "currency": CURRENCY,
        },
    )
    return promotion, True


def ensure_active(api: Api, token: str, promotion: dict) -> dict:
    """Orders require an ACTIVE promotion; DRAFT -> ACTIVE and CLOSED -> ACTIVE are allowed."""
    if promotion["status"] == "ACTIVE":
        return promotion
    return api.request(
        "PATCH", f"/promotions/{promotion['id']}", token=token, json={"status": "ACTIVE"}
    )


def ensure_member(api: Api, token: str, promotion_id: str, email: str, roles: list[str]) -> None:
    members = api.request(
        "GET",
        f"/promotions/{promotion_id}/members",
        token=token,
        params={"page": 1, "size": 100, "include_revoked": True},
    )
    for member in members["items"]:
        if member["user"]["email"] != email:
            continue
        if member["revoked_at"] is None and sorted(member["roles"]) == sorted(roles):
            return
        api.request(
            "PATCH",
            f"/promotions/{promotion_id}/members/{member['id']}",
            token=token,
            json={"roles": roles, "revoked": False},
        )
        return
    api.request(
        "POST",
        f"/promotions/{promotion_id}/members",
        token=token,
        json={"email": email, "roles": roles},
    )


def ensure_products(
    api: Api, token: str, promotion_id: str, products: tuple[SeedProduct, ...]
) -> dict[str, dict]:
    page = api.request(
        "GET",
        f"/promotions/{promotion_id}/products",
        token=token,
        params={"page": 1, "size": 100, "include_inactive": True},
    )
    existing = {item["name"]: item for item in page["items"]}

    catalog: dict[str, dict] = {}
    for spec in products:
        product = existing.get(spec.name)
        if product is None:
            body: dict[str, Any] = {"name": spec.name, "price": spec.price}
            if spec.description:
                body["description"] = spec.description
            product = api.request(
                "POST", f"/promotions/{promotion_id}/products", token=token, json=body
            )
        if product["is_active"] != spec.active:
            product = api.request(
                "PATCH",
                f"/promotions/{promotion_id}/products/{product['id']}",
                token=token,
                json={"is_active": spec.active},
            )
        catalog[spec.key] = product
    return catalog


def ensure_customers(api: Api, token: str, promotion_id: str) -> list[dict]:
    """Customers are seller-scoped writes, so this runs with a seller token."""
    page = api.request(
        "GET", f"/promotions/{promotion_id}/customers", token=token, params={"page": 1, "size": 100}
    )
    existing = {item["name"]: item for item in page["items"]}

    customers: list[dict] = []
    for name, contact in CUSTOMERS:
        customer = existing.get(name)
        if customer is None:
            customer = api.request(
                "POST",
                f"/promotions/{promotion_id}/customers",
                token=token,
                json={"name": name, "contact": contact},
            )
        customers.append(customer)
    return customers


# --- orders ---------------------------------------------------------------------------------


def create_order(
    api: Api,
    token: str,
    promotion_id: str,
    spec: SeedOrder,
    catalog: dict[str, dict],
    customers: list[dict],
) -> dict:
    items = [
        {"product_id": catalog[key]["id"], "quantity": quantity} for key, quantity in spec.items
    ]
    return api.request(
        "POST",
        f"/promotions/{promotion_id}/orders",
        token=token,
        idempotent=True,
        json={
            "customer_id": customers[spec.customer]["id"],
            "items": items,
            "mark_paid_now": spec.paid_at_creation,
        },
    )


def apply_lifecycle(
    api: Api,
    promotion_id: str,
    order: dict,
    spec: SeedOrder,
    seller_token: str,
    admin_token: str,
    texts: SeedTexts,
) -> dict:
    """Walk the order to its target state, threading `expected_version` from each response."""
    base = f"/promotions/{promotion_id}/orders/{order['id']}"

    def transition(kind: str, token: str, body: dict[str, Any]) -> dict:
        return api.request("POST", f"{base}/{kind}", token=token, json=body, idempotent=True)

    if spec.lifecycle in LIFECYCLES_PAYING and order["paid_at"] is None:
        order = transition(
            "payment",
            seller_token,
            {"action": "MARK_PAID", "expected_version": order["version"]},
        )

    if spec.lifecycle in LIFECYCLES_DELIVERING:
        # A DIVERGENCE is delivered-but-unpaid, so no payment precedes this one.
        # Handed over by the admin on delivery day, which also varies the audit actor.
        order = transition(
            "delivery",
            admin_token,
            {"action": "MARK_DELIVERED", "expected_version": order["version"]},
        )

    if spec.lifecycle == "payment_revoked":
        order = transition(
            "payment",
            admin_token,
            {
                "action": "REVOKE_PAYMENT",
                "expected_version": order["version"],
                "reason": texts.reason_payment_revoked,
            },
        )

    if spec.lifecycle == "delivery_revoked":
        order = transition(
            "delivery",
            admin_token,
            {
                "action": "REVOKE_DELIVERY",
                "expected_version": order["version"],
                "reason": texts.reason_delivery_revoked,
            },
        )

    if spec.lifecycle == "cancelled":
        order = transition(
            "cancel",
            seller_token,
            {"expected_version": order["version"], "reason": texts.reason_cancelled},
        )

    return order


# --- the one direct database write ----------------------------------------------------------


def resolve_database_url(override: str | None) -> str:
    if override is None:
        # Read the app's own setting rather than duplicating the default here.
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from app.core.config import get_settings

        override = get_settings().DATABASE_URL
    return override.replace("+asyncpg", "", 1)


def spread_order_dates(rows: list[tuple[uuid.UUID, datetime]], database_url: str) -> None:
    """Backdate `CUSTOMER_ORDER.created_at` so sales velocity has more than one bar.

    The only direct database write in this seed, and it touches exactly one column.
    `ORDER_AUDIT_EVENT` is deliberately left alone: a BEFORE UPDATE OR DELETE trigger
    (`trg_order_audit_event_append_only`) rejects changes to it, and that immutability
    is a product invariant, not a seed detail. The visible cost is that audit events
    carry today's timestamp on orders dated earlier -- harmless for test data.
    """
    import asyncpg

    async def run() -> None:
        connection = await asyncpg.connect(database_url)
        try:
            await connection.executemany(
                "UPDATE customer_order SET created_at = $2 WHERE id = $1", rows
            )
        finally:
            await connection.close()

    asyncio.run(run())


# --- reporting ------------------------------------------------------------------------------


def ensure_mcp_token(api: Api, token: str) -> str | None:
    """Create the MCP token once; it can never be shown again, so re-runs skip it."""
    for item in api.request("GET", "/auth/tokens", token=token):
        if item["name"] == MCP_TOKEN_NAME and item["revoked_at"] is None:
            return None
    created = api.request(
        "POST", "/auth/tokens", token=token, json={"name": MCP_TOKEN_NAME, "expires_in_days": 365}
    )
    return str(created["token"])


def report(
    api: Api, token: str, promotion: dict, mcp_token: str | None, grant_to: str | None
) -> None:
    summary = api.request(
        "GET", f"/promotions/{promotion['id']}/reconciliation/summary", token=token
    )
    leaderboard = api.request(
        "GET", f"/promotions/{promotion['id']}/reconciliation/leaderboard", token=token
    )
    currency = promotion["currency"]

    print()
    print(f"Promotion   {promotion['name']}  [{promotion['status']}]  {promotion['id']}")
    print(f"Revenue     {summary['total_revenue']} {currency}")
    print(f"Collected   {summary['collected_amount']} {currency}")
    print(f"Outstanding {summary['outstanding_amount']} {currency}")
    print(
        f"Units       {summary['units_delivered']} delivered / {summary['units_ordered']} ordered"
    )
    print()
    print("By classification")
    for name, bucket in summary["by_classification"].items():
        print(f"  {name:<16} {bucket['count']:>3} orders  {bucket['amount']:>10} {currency}")
    print()
    print("Leaderboard")
    for entry in leaderboard:
        print(
            f"  {entry['name']:<18} {entry['order_count']:>3} orders  "
            f"{entry['gross_revenue']:>10} {currency}  {entry['settlement_percentage']}% settled"
        )

    print()
    print(f"Sign in with any of these (password: {SEED_PASSWORD})")
    for person in PEOPLE:
        print(f"  {person.email:<38} {', '.join(person.roles)}")
    if grant_to:
        print(f"  {grant_to:<38} promotion_admin, seller  (your own account)")

    if mcp_token:
        print()
        print("MCP token (shown once, belongs to the seed admin):")
        print(f"  PROMOLEDGER_TOKEN={mcp_token}")


# --- main -----------------------------------------------------------------------------------


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Seed PromoLedger with demo data via the API.")
    parser.add_argument("--api-url", default=DEFAULT_API_URL, help="default: %(default)s")
    parser.add_argument(
        "--spread-days",
        type=int,
        default=10,
        metavar="N",
        help="backdate orders over the last N days (0 = all today); default: %(default)s",
    )
    parser.add_argument(
        "--grant-to",
        metavar="EMAIL",
        help="give this existing account promotion_admin + seller on the seed promotion",
    )
    parser.add_argument(
        "--new",
        action="store_true",
        help="create a fresh promotion instead of topping up the existing seed one",
    )
    parser.add_argument("--database-url", help="only used by --spread-days")
    parser.add_argument(
        "--lang",
        choices=sorted(TEXTS),
        default="pt",
        help="language of names, products and reasons; default: %(default)s",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    with Api(args.api_url) as api:
        try:
            api.request("GET", "/health")
        except httpx.HTTPError:
            print(f"The API is not answering at {args.api_url}.", file=sys.stderr)
            print(
                "Start it with: uv run uvicorn app.main:app --reload --port 8000", file=sys.stderr
            )
            return 1

        tokens = {person.key: ensure_account(api, person) for person in PEOPLE}
        admin_token = tokens["admin"]
        print(f"{len(PEOPLE)} accounts ready")

        texts = TEXTS[args.lang]
        institution_id = ensure_institution(api, admin_token, texts.institution)
        name = texts.promotion
        if args.new:
            name = f"{texts.promotion} {datetime.now(UTC):%Y-%m-%d %H:%M}"
        promotion, created = ensure_promotion(api, admin_token, institution_id, name)
        promotion = ensure_active(api, admin_token, promotion)
        print(f"Promotion {'created' if created else 'reused'}: {promotion['name']}")

        for person in PEOPLE:
            ensure_member(api, admin_token, promotion["id"], person.email, list(person.roles))
        if args.grant_to:
            try:
                ensure_member(
                    api,
                    admin_token,
                    promotion["id"],
                    args.grant_to.lower(),
                    ["promotion_admin", "seller"],
                )
                print(f"Granted promotion_admin + seller to {args.grant_to}")
            except ApiError as exc:
                if exc.code != "USER_NOT_FOUND":
                    raise
                print(f"No account for {args.grant_to}; register it first to be granted access.")

        catalog = ensure_products(api, admin_token, promotion["id"], texts.products)
        customers = ensure_customers(api, tokens["seller1"], promotion["id"])
        print(f"{len(catalog)} products, {len(customers)} customers ready")

        backdate: list[tuple[uuid.UUID, datetime]] = []
        for index, spec in enumerate(ORDERS):
            seller_token = tokens[spec.seller]
            order = create_order(api, seller_token, promotion["id"], spec, catalog, customers)
            order = apply_lifecycle(
                api, promotion["id"], order, spec, seller_token, admin_token, texts
            )
            if args.spread_days > 0:
                days = min(spec.days_ago, max(args.spread_days - 1, 0))
                # A plausible hour of the day, so same-day orders don't share a timestamp.
                when = datetime.now(UTC) - timedelta(days=days, hours=index % 9, minutes=index * 7)
                backdate.append((uuid.UUID(order["id"]), when))
        print(f"{len(ORDERS)} orders created and walked to their target states")

        if backdate:
            spread_order_dates(backdate, resolve_database_url(args.database_url))
            print(f"Order dates spread across the last {args.spread_days} days")

        mcp_token = ensure_mcp_token(api, admin_token)
        report(api, admin_token, promotion, mcp_token, args.grant_to)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
