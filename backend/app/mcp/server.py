"""PromoLedger read-only MCP server (Slice 5).

Architecture (decision 1): this server is a CLIENT of the PromoLedger REST API. It has no
database access, reuses the API's contextual RBAC and reconciliation math, and authenticates
with a personal access token that the API itself restricts to read-only (decision 2).

Privacy (decision 4): customer names and contacts are NEVER returned — orders are
identified by id / short reference. Member (seller/admin) names are included.

Run (stdio, decision 3):
    PROMOLEDGER_API_URL=http://localhost:8000 PROMOLEDGER_TOKEN=pl_... uv run python -m app.mcp
"""

from __future__ import annotations

import os
import sys
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_EVEN, Decimal
from typing import Annotated, Any, Literal

import httpx
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import ToolAnnotations
from pydantic import BaseModel, Field

API_PREFIX = "/api/v1"
MAX_VELOCITY_PAGES = 10  # sales_velocity analyses at most 1,000 orders (declared in output)
CENT = Decimal("0.01")
READ_ONLY = ToolAnnotations(read_only_hint=True, open_world_hint=False)


class PromoLedgerApi:
    """Thin GET-only client of the REST API (the token is read-only server-side anyway)."""

    def __init__(self, http: httpx.AsyncClient) -> None:
        self._http = http

    async def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        try:
            response = await self._http.get(f"{API_PREFIX}{path}", params=params)
        except httpx.HTTPError as exc:
            raise ToolError(f"PromoLedger API is unreachable: {exc.__class__.__name__}") from exc
        if response.is_success:
            return response.json()
        try:
            problem = response.json()
            message = f"{problem.get('code', response.status_code)}: {problem.get('detail', '')}"
        except ValueError:
            message = f"HTTP {response.status_code}"
        raise ToolError(f"PromoLedger API refused the request ({message})")

    async def get_all(self, path: str, *, size: int = 100, max_pages: int = 10, **params: Any):
        """Follow the standard pagination envelope. Returns (items, total)."""
        items: list[dict[str, Any]] = []
        total = 0
        for page in range(1, max_pages + 1):
            body = await self.get(path, {**params, "page": page, "size": size})
            items.extend(body["items"])
            total = body["total"]
            if page * size >= total:
                break
        return items, total


# --- Output models (structured tool output; money = exact decimal strings) ----------------


class PromotionInfo(BaseModel):
    id: str
    name: str
    status: Literal["DRAFT", "ACTIVE", "CLOSED"]
    currency: str
    sales_start_date: date
    last_sales_date: date
    delivery_date: date
    my_roles: list[str]


class Bucket(BaseModel):
    count: int
    amount: str


class PromotionHealth(BaseModel):
    promotion_id: str
    name: str
    status: str
    currency: str
    sales_window: Literal["not_started", "open", "ended"]
    days_to_delivery: int
    total_revenue: str
    collected_amount: str
    outstanding_amount: str
    collection_rate_percent: str  # collected / revenue, 2 decimals
    units_ordered: int
    units_delivered: int
    divergence_count: int
    divergence_amount: str
    by_status: dict[str, Bucket]


class SellerRank(BaseModel):
    rank: int
    seller_name: str
    order_count: int
    units_sold: int
    gross_revenue: str
    settled_amount: str
    settlement_percentage: str


class SellerRanking(BaseModel):
    currency: str
    sellers: list[SellerRank]


class DivergenceAlert(BaseModel):
    order_id: str
    order_ref: str  # short reference for humans; no customer data by design
    seller_name: str
    amount: str
    delivered_at: datetime
    days_outstanding: int


class DivergenceAlerts(BaseModel):
    currency: str
    count: int
    total_amount: str
    alerts: list[DivergenceAlert]


class DaySales(BaseModel):
    date: date
    orders: int
    revenue: str


class SalesVelocity(BaseModel):
    currency: str
    days: int
    total_orders: int
    total_revenue: str
    average_orders_per_day: str
    daily: list[DaySales]
    analyzed_orders: int
    truncated: bool  # true if the promotion has more orders than were analysed


# --- Pure helpers ---------------------------------------------------------------------------


def _money(value: Decimal) -> str:
    return str(value.quantize(CENT))


def _percent(part: Decimal, whole: Decimal) -> str:
    if whole == 0:
        return "0.00"
    return str((part / whole * 100).quantize(CENT, rounding=ROUND_HALF_EVEN))


def _sales_window(today: date, start: date, last: date) -> Literal["not_started", "open", "ended"]:
    if today < start:
        return "not_started"
    return "open" if today <= last else "ended"


# --- Server -----------------------------------------------------------------------------------


def build_server(
    api: PromoLedgerApi, *, today: Callable[[], date] = lambda: datetime.now(UTC).date()
) -> MCPServer:
    server = MCPServer(
        name="promoledger",
        instructions=(
            "Read-only access to PromoLedger fundraising promotions: health, seller ranking, "
            "divergences (delivered but unpaid) and sales velocity. Amounts are exact decimal "
            "strings in the promotion's currency. Call list_promotions first to get ids."
        ),
    )

    async def members_directory(promotion_id: str) -> dict[str, str]:
        members, _ = await api.get_all(f"/promotions/{promotion_id}/members", include_revoked=True)
        return {m["id"]: m["user"]["name"] for m in members}

    @server.tool(annotations=READ_ONLY)
    async def list_promotions() -> list[PromotionInfo]:
        """List the promotions the token's user is a member of, with their roles."""
        me = await api.get("/auth/me")
        roles = {m["promotion_id"]: m["roles"] for m in me["memberships"]}
        promotions, _ = await api.get_all("/promotions")
        return [
            PromotionInfo(
                id=p["id"],
                name=p["name"],
                status=p["status"],
                currency=p["currency"],
                sales_start_date=p["sales_start_date"],
                last_sales_date=p["last_sales_date"],
                delivery_date=p["delivery_date"],
                my_roles=roles.get(p["id"], []),
            )
            for p in promotions
        ]

    @server.tool(annotations=READ_ONLY)
    async def promotion_health(promotion_id: str) -> PromotionHealth:
        """Financial and fulfilment health of one promotion (requires admin or viewer role)."""
        promotion = await api.get(f"/promotions/{promotion_id}")
        summary = await api.get(f"/promotions/{promotion_id}/reconciliation/summary")
        revenue = Decimal(summary["total_revenue"])
        collected = Decimal(summary["collected_amount"])
        divergence = summary["by_classification"]["DIVERGENCE"]
        delivery = date.fromisoformat(promotion["delivery_date"])
        return PromotionHealth(
            promotion_id=promotion["id"],
            name=promotion["name"],
            status=promotion["status"],
            currency=promotion["currency"],
            sales_window=_sales_window(
                today(),
                date.fromisoformat(promotion["sales_start_date"]),
                date.fromisoformat(promotion["last_sales_date"]),
            ),
            days_to_delivery=(delivery - today()).days,
            total_revenue=summary["total_revenue"],
            collected_amount=summary["collected_amount"],
            outstanding_amount=summary["outstanding_amount"],
            collection_rate_percent=_percent(collected, revenue),
            units_ordered=summary["units_ordered"],
            units_delivered=summary["units_delivered"],
            divergence_count=divergence["count"],
            divergence_amount=divergence["amount"],
            by_status={k: Bucket(**v) for k, v in summary["by_classification"].items()},
        )

    @server.tool(annotations=READ_ONLY)
    async def seller_ranking(
        promotion_id: str, limit: Annotated[int, Field(ge=1, le=50)] = 10
    ) -> SellerRanking:
        """Sellers ranked by gross revenue, with settlement percentage (admin or viewer role)."""
        promotion = await api.get(f"/promotions/{promotion_id}")
        rows = await api.get(f"/promotions/{promotion_id}/reconciliation/leaderboard")
        return SellerRanking(
            currency=promotion["currency"],
            sellers=[
                SellerRank(
                    rank=i + 1,
                    seller_name=r["name"],
                    order_count=r["order_count"],
                    units_sold=r["units_sold"],
                    gross_revenue=r["gross_revenue"],
                    settled_amount=r["settled_amount"],
                    settlement_percentage=r["settlement_percentage"],
                )
                for i, r in enumerate(rows[:limit])
            ],
        )

    @server.tool(annotations=READ_ONLY)
    async def divergence_alerts(promotion_id: str) -> DivergenceAlerts:
        """Orders delivered but not paid, oldest first (admin or viewer role). No customer data."""
        promotion = await api.get(f"/promotions/{promotion_id}")
        orders, _ = await api.get_all(f"/promotions/{promotion_id}/reconciliation/divergences")
        names = await members_directory(promotion_id)
        now = datetime.now(UTC)
        alerts = sorted(
            (
                DivergenceAlert(
                    order_id=o["id"],
                    order_ref=o["id"][:8].upper(),
                    seller_name=names.get(o["seller_member_id"], "unknown"),
                    amount=o["total_amount"],
                    delivered_at=o["delivered_at"],
                    days_outstanding=(now - datetime.fromisoformat(o["delivered_at"])).days,
                )
                for o in orders
            ),
            key=lambda a: a.delivered_at,
        )
        return DivergenceAlerts(
            currency=promotion["currency"],
            count=len(alerts),
            total_amount=_money(sum((Decimal(a.amount) for a in alerts), Decimal("0"))),
            alerts=alerts,
        )

    @server.tool(annotations=READ_ONLY)
    async def sales_velocity(
        promotion_id: str, days: Annotated[int, Field(ge=1, le=90)] = 7
    ) -> SalesVelocity:
        """Orders and revenue per day over the last `days` days (UTC), cancelled orders excluded."""
        promotion = await api.get(f"/promotions/{promotion_id}")
        orders, total = await api.get_all(
            f"/promotions/{promotion_id}/orders", max_pages=MAX_VELOCITY_PAGES
        )
        end = today()
        start = end - timedelta(days=days - 1)
        daily = {start + timedelta(days=i): [0, Decimal("0")] for i in range(days)}
        for order in orders:
            if order["cancelled_at"]:
                continue
            day = datetime.fromisoformat(order["created_at"]).astimezone(UTC).date()
            if day in daily:
                daily[day][0] += 1
                daily[day][1] += Decimal(order["total_amount"])
        total_orders = sum(count for count, _ in daily.values())
        total_revenue = sum((revenue for _, revenue in daily.values()), Decimal("0"))
        return SalesVelocity(
            currency=promotion["currency"],
            days=days,
            total_orders=total_orders,
            total_revenue=_money(total_revenue),
            average_orders_per_day=str((Decimal(total_orders) / days).quantize(CENT)),
            daily=[
                DaySales(date=d, orders=c, revenue=_money(r)) for d, (c, r) in sorted(daily.items())
            ],
            analyzed_orders=len(orders),
            truncated=len(orders) < total,
        )

    return server


def main() -> None:
    base_url = os.environ.get("PROMOLEDGER_API_URL", "http://localhost:8000")
    token = os.environ.get("PROMOLEDGER_TOKEN", "")
    if not token.startswith("pl_"):
        # Least privilege: only read-only personal access tokens are accepted, never a
        # login JWT (which could write). Create one in the app under "API tokens".
        print(
            "PROMOLEDGER_TOKEN must be a read-only personal access token (pl_...).", file=sys.stderr
        )
        sys.exit(2)
    http = httpx.AsyncClient(
        base_url=base_url,
        headers={"Authorization": f"Bearer {token}", "User-Agent": "promoledger-mcp"},
        timeout=30,
    )
    build_server(PromoLedgerApi(http)).run("stdio")
