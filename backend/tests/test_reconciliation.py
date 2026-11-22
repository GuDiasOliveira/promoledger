import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Customer, Order, Promotion, PromotionMember, User
from app.models.enums import Role
from tests.conftest import (
    MemberFactory,
    ProductFactory,
    bearer,
    new_key,
    order_payload,
    orders_url,
    place_order,
)


def recon_url(promotion: Promotion, path: str) -> str:
    return f"/api/v1/promotions/{promotion.id}/reconciliation/{path}"


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
    """Two sellers, five orders covering every classification.

    seller (Alice): o1 A×2 = 20.00 SETTLED      | o2 B×3 = 0.30 PAID_PENDING
    other  (Bob):   o3 A×1 = 10.00 DIVERGENCE   | o4 A×1 = 10.00 UNPAID | o5 B×1 = 0.10 CANCELLED
    """
    seller.user.name = "Alice"
    other = await member_factory(active_promotion, Role.SELLER)
    other.user.name = "Bob"
    a = await product_factory(active_promotion, name="A", price="10.00")
    b = await product_factory(active_promotion, name="B", price="0.10")

    now = datetime.now(UTC)
    plan = [
        ("o1", seller, (a, 2), {"paid_at": now, "delivered_at": now}),
        ("o2", seller, (b, 3), {"paid_at": now}),
        ("o3", other, (a, 1), {"delivered_at": now}),
        ("o4", other, (a, 1), {}),
        ("o5", other, (b, 1), {"cancelled_at": now}),
    ]
    ids: dict[str, str] = {}
    for name, member, line, state in plan:
        response = await place_order(
            client, active_promotion, member, order_payload(customer, line)
        )
        ids[name] = response.json()["id"]
        order = await db_session.get(Order, uuid.UUID(ids[name]))
        assert order is not None
        for field, value in state.items():
            setattr(order, field, value)
    await db_session.flush()
    return {"ids": ids, "seller": seller, "other": other}


# --- summary --------------------------------------------------------------------------------


async def test_summary_has_exact_totals_per_classification(
    client: AsyncClient, active_promotion: Promotion, user: User, ledger: dict
) -> None:
    response = await client.get(recon_url(active_promotion, "summary"), headers=bearer(user))

    assert response.status_code == 200
    assert response.json() == {
        "total_revenue": "40.30",  # cancelled o5 excluded
        "collected_amount": "20.30",
        "outstanding_amount": "20.00",
        "units_ordered": 7,
        "units_delivered": 3,
        "by_classification": {
            "UNPAID_PENDING": {"count": 1, "amount": "10.00"},
            "PAID_PENDING": {"count": 1, "amount": "0.30"},
            "DIVERGENCE": {"count": 1, "amount": "10.00"},
            "SETTLED": {"count": 1, "amount": "20.00"},
            "CANCELLED": {"count": 1, "amount": "0.10"},
        },
    }


async def test_summary_of_empty_promotion_is_zero(
    client: AsyncClient, active_promotion: Promotion, user: User
) -> None:
    body = (await client.get(recon_url(active_promotion, "summary"), headers=bearer(user))).json()

    assert body["total_revenue"] == body["collected_amount"] == body["outstanding_amount"] == "0.00"
    assert all(b == {"count": 0, "amount": "0.00"} for b in body["by_classification"].values())


# --- divergences ----------------------------------------------------------------------------


async def test_divergences_lists_delivered_unpaid_orders(
    client: AsyncClient, active_promotion: Promotion, user: User, ledger: dict
) -> None:
    response = await client.get(recon_url(active_promotion, "divergences"), headers=bearer(user))

    body = response.json()
    assert body["total"] == 1
    assert body["items"][0]["id"] == ledger["ids"]["o3"]
    assert body["items"][0]["status_classification"] == "DIVERGENCE"


# --- leaderboard ----------------------------------------------------------------------------


async def test_leaderboard_ranks_sellers_by_gross_revenue(
    client: AsyncClient, active_promotion: Promotion, user: User, ledger: dict
) -> None:
    response = await client.get(recon_url(active_promotion, "leaderboard"), headers=bearer(user))

    assert response.status_code == 200
    assert response.json() == [
        {
            "member_id": str(ledger["seller"].id),
            "user_id": str(ledger["seller"].user_id),
            "name": "Alice",
            "order_count": 2,
            "units_sold": 5,
            "gross_revenue": "20.30",
            "settled_amount": "20.00",
            "settlement_percentage": "98.52",  # 20.00 / 20.30
        },
        {
            "member_id": str(ledger["other"].id),
            "user_id": str(ledger["other"].user_id),
            "name": "Bob",
            "order_count": 2,  # cancelled o5 excluded
            "units_sold": 2,
            "gross_revenue": "20.00",
            "settled_amount": "0.00",
            "settlement_percentage": "0.00",
        },
    ]


# --- audit events ---------------------------------------------------------------------------


async def test_audit_events_stream_is_chronological_and_filterable(
    client: AsyncClient,
    active_promotion: Promotion,
    seller: PromotionMember,
    user: User,
    customer: Customer,
    product_factory: ProductFactory,
) -> None:
    product = await product_factory(active_promotion)
    created = await place_order(
        client,
        active_promotion,
        seller,
        order_payload(customer, (product, 1), mark_paid_now=True),
    )
    order_id = created.json()["id"]
    await client.post(
        f"{orders_url(active_promotion)}/{order_id}/delivery",
        json={"action": "MARK_DELIVERED", "expected_version": 1},
        headers={**bearer(seller.user), **new_key()},
    )

    stream = await client.get(recon_url(active_promotion, "audit-events"), headers=bearer(user))
    filtered = await client.get(
        recon_url(active_promotion, "audit-events"),
        params={"event_type": "DELIVERY_MARKED", "order_id": order_id},
        headers=bearer(user),
    )

    assert [e["event_type"] for e in stream.json()["items"]] == [
        "PAYMENT_MARKED",
        "DELIVERY_MARKED",
    ]
    assert all(e["order_id"] == order_id for e in stream.json()["items"])
    assert filtered.json()["total"] == 1


# --- permissions ----------------------------------------------------------------------------


@pytest.mark.parametrize("path", ["summary", "divergences", "leaderboard", "audit-events"])
async def test_seller_only_member_is_forbidden(
    client: AsyncClient, active_promotion: Promotion, seller: PromotionMember, path: str
) -> None:
    response = await client.get(recon_url(active_promotion, path), headers=bearer(seller.user))

    assert response.status_code == 403


@pytest.mark.parametrize(
    ("path", "status"),
    [("summary", 200), ("divergences", 200), ("leaderboard", 200), ("audit-events", 403)],
)
async def test_viewer_access(
    client: AsyncClient,
    active_promotion: Promotion,
    member_factory: MemberFactory,
    path: str,
    status: int,
) -> None:
    viewer = await member_factory(active_promotion, Role.PROMOTION_VIEWER)

    response = await client.get(recon_url(active_promotion, path), headers=bearer(viewer.user))

    assert response.status_code == status
