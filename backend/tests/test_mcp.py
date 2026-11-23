"""MCP server tests: an in-memory MCP client drives the real server, which calls the real
FastAPI app in-process (test database) with a real read-only personal access token."""

import json
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from httpx import AsyncClient
from mcp.client import Client
from sqlalchemy.ext.asyncio import AsyncSession

from app.mcp import server as mcp_server
from app.mcp.server import PromoLedgerApi, build_server
from app.models import Customer, Order, Promotion, PromotionMember, User
from app.models.enums import Role
from tests.conftest import MemberFactory, ProductFactory, bearer, order_payload, place_order

TODAY = date(2026, 3, 10)  # inside the 2026-03-01..03-25 sales window; delivery 03-30


async def pat_for(client: AsyncClient, user: User) -> str:
    response = await client.post("/api/v1/auth/tokens", json={"name": "mcp"}, headers=bearer(user))
    assert response.status_code == 201
    return response.json()["token"]


async def mcp_client_for(client: AsyncClient, user: User, today: date = TODAY) -> Client:
    """MCP client -> MCP server -> FastAPI (in-process) authenticated with the user's PAT."""
    client.headers["Authorization"] = f"Bearer {await pat_for(client, user)}"
    return Client(build_server(PromoLedgerApi(client), today=lambda: today))


def structured(result: Any) -> Any:
    assert not result.is_error, result.content
    return result.structured_content


@pytest.fixture
async def ledger(
    client: AsyncClient,
    db_session: AsyncSession,
    active_promotion: Promotion,
    seller: PromotionMember,
    member_factory: MemberFactory,
    customer: Customer,
    product_factory: ProductFactory,
) -> dict[str, Any]:
    """Same shape as test_reconciliation: revenue 40.30, collected 20.30, 1 divergence (10.00)."""
    seller.user.name = "Alice"
    other = await member_factory(active_promotion, Role.SELLER)
    other.user.name = "Bob"
    a = await product_factory(active_promotion, name="A", price="10.00")
    b = await product_factory(active_promotion, name="B", price="0.10")
    now = datetime.now(UTC)
    plan = [
        (seller, (a, 2), {"paid_at": now, "delivered_at": now}),
        (seller, (b, 3), {"paid_at": now}),
        (other, (a, 1), {"delivered_at": now - timedelta(days=3)}),
        (other, (a, 1), {}),
        (other, (b, 1), {"cancelled_at": now}),
    ]
    ids = []
    for member, line, state in plan:
        response = await place_order(
            client, active_promotion, member, order_payload(customer, line)
        )
        ids.append(response.json()["id"])
        order = await db_session.get(Order, response.json()["id"])
        assert order is not None
        for field, value in state.items():
            setattr(order, field, value)
    await db_session.flush()
    client.headers.pop("Authorization", None)
    return {"ids": ids, "divergence_id": ids[2], "customer": customer}


async def test_all_tools_are_declared_read_only(client: AsyncClient, user: User) -> None:
    async with await mcp_client_for(client, user) as mcp:
        tools = (await mcp.list_tools()).tools

    assert {t.name for t in tools} == {
        "list_promotions",
        "promotion_health",
        "seller_ranking",
        "divergence_alerts",
        "sales_velocity",
    }
    assert all(t.annotations and t.annotations.read_only_hint for t in tools)


async def test_list_promotions_shows_my_roles(
    client: AsyncClient, user: User, promotion: Promotion
) -> None:
    async with await mcp_client_for(client, user) as mcp:
        result = structured(await mcp.call_tool("list_promotions", {}))

    [info] = result["result"]
    assert info["id"] == str(promotion.id)
    assert info["currency"] == "BRL"
    assert info["my_roles"] == ["promotion_admin"]


async def test_promotion_health_has_exact_amounts(
    client: AsyncClient, user: User, active_promotion: Promotion, ledger: dict
) -> None:
    async with await mcp_client_for(client, user) as mcp:
        health = structured(
            await mcp.call_tool("promotion_health", {"promotion_id": str(active_promotion.id)})
        )

    assert health["total_revenue"] == "40.30"
    assert health["collected_amount"] == "20.30"
    assert health["outstanding_amount"] == "20.00"
    assert health["collection_rate_percent"] == "50.37"  # 20.30 / 40.30
    assert (health["units_ordered"], health["units_delivered"]) == (7, 3)
    assert (health["divergence_count"], health["divergence_amount"]) == (1, "10.00")
    assert health["sales_window"] == "open"
    assert health["days_to_delivery"] == 20
    assert health["by_status"]["CANCELLED"] == {"count": 1, "amount": "0.10"}


@pytest.mark.parametrize(
    ("today", "window"),
    [(date(2026, 2, 28), "not_started"), (date(2026, 3, 25), "open"), (date(2026, 3, 26), "ended")],
)
async def test_sales_window(
    client: AsyncClient, user: User, active_promotion: Promotion, today: date, window: str
) -> None:
    async with await mcp_client_for(client, user, today) as mcp:
        health = structured(
            await mcp.call_tool("promotion_health", {"promotion_id": str(active_promotion.id)})
        )

    assert health["sales_window"] == window


async def test_seller_ranking_respects_limit(
    client: AsyncClient, user: User, active_promotion: Promotion, ledger: dict
) -> None:
    async with await mcp_client_for(client, user) as mcp:
        ranking = structured(
            await mcp.call_tool(
                "seller_ranking", {"promotion_id": str(active_promotion.id), "limit": 1}
            )
        )

    assert ranking["currency"] == "BRL"
    assert ranking["sellers"] == [
        {
            "rank": 1,
            "seller_name": "Alice",
            "order_count": 2,
            "units_sold": 5,
            "gross_revenue": "20.30",
            "settled_amount": "20.00",
            "settlement_percentage": "98.52",
        }
    ]


async def test_divergence_alerts_never_expose_customer_data(
    client: AsyncClient, user: User, active_promotion: Promotion, ledger: dict
) -> None:
    async with await mcp_client_for(client, user) as mcp:
        raw = await mcp.call_tool("divergence_alerts", {"promotion_id": str(active_promotion.id)})
    alerts = structured(raw)

    assert (alerts["count"], alerts["total_amount"]) == (1, "10.00")
    [alert] = alerts["alerts"]
    assert alert["order_id"] == ledger["divergence_id"]
    assert alert["order_ref"] == ledger["divergence_id"][:8].upper()
    assert alert["seller_name"] == "Bob"
    assert alert["days_outstanding"] == 3
    # Decision 4: nothing about the customer leaves the system through MCP.
    everything = json.dumps(raw.model_dump(mode="json"))
    assert ledger["customer"].name not in everything
    assert str(ledger["customer"].id) not in everything
    assert "contact" not in everything


async def test_sales_velocity_counts_live_orders_per_day(
    client: AsyncClient, user: User, active_promotion: Promotion, ledger: dict
) -> None:
    today = datetime.now(UTC).date()
    async with await mcp_client_for(client, user, today) as mcp:
        velocity = structured(
            await mcp.call_tool(
                "sales_velocity", {"promotion_id": str(active_promotion.id), "days": 7}
            )
        )

    assert velocity["days"] == 7 and len(velocity["daily"]) == 7
    assert velocity["daily"][-1] == {"date": today.isoformat(), "orders": 4, "revenue": "40.30"}
    assert (velocity["total_orders"], velocity["total_revenue"]) == (
        4,
        "40.30",
    )  # cancelled excluded
    assert velocity["average_orders_per_day"] == "0.57"
    assert (velocity["analyzed_orders"], velocity["truncated"]) == (5, False)


async def test_rbac_is_the_apis_own(
    client: AsyncClient, active_promotion: Promotion, seller: PromotionMember
) -> None:
    """A seller-only token cannot read reconciliation data: the API says no, MCP relays it."""
    async with await mcp_client_for(client, seller.user) as mcp:
        result = await mcp.call_tool("promotion_health", {"promotion_id": str(active_promotion.id)})

    assert result.is_error
    assert "INSUFFICIENT_ROLE" in result.content[0].text


async def test_invalid_arguments_are_rejected(
    client: AsyncClient, user: User, promotion: Promotion
) -> None:
    async with await mcp_client_for(client, user) as mcp:
        result = await mcp.call_tool(
            "seller_ranking", {"promotion_id": str(promotion.id), "limit": 500}
        )

    assert result.is_error


@pytest.mark.parametrize("token", ["", "eyJhbGciOiJIUzI1NiJ9.e30.x"])
def test_main_refuses_anything_but_a_read_only_token(
    monkeypatch: pytest.MonkeyPatch, token: str
) -> None:
    monkeypatch.setenv("PROMOLEDGER_TOKEN", token)
    with pytest.raises(SystemExit) as exit_info:
        mcp_server.main()
    assert exit_info.value.code == 2
