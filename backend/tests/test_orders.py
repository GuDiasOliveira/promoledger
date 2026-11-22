import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Customer, Order, OrderAuditEvent, Product, Promotion, PromotionMember, User
from app.models.enums import PromotionStatus, Role
from app.services import orders as order_service
from tests.conftest import (
    CustomerFactory,
    MemberFactory,
    ProductFactory,
    PromotionFactory,
    UserFactory,
    bearer,
)


def orders_url(promotion: Promotion) -> str:
    return f"/api/v1/promotions/{promotion.id}/orders"


def new_key() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


@pytest.fixture
async def product(active_promotion: Promotion, product_factory: ProductFactory) -> Product:
    return await product_factory(active_promotion, name="Ovo 400g", price="19.90")


@pytest.fixture
async def customer(active_promotion: Promotion, customer_factory: CustomerFactory) -> Customer:
    return await customer_factory(active_promotion)


def order_payload(customer: Customer, *lines: tuple[Product, int], **extra: Any) -> dict[str, Any]:
    return {
        "customer_id": str(customer.id),
        "items": [{"product_id": str(p.id), "quantity": q} for p, q in lines],
        **extra,
    }


async def place_order(
    client: AsyncClient,
    promotion: Promotion,
    member: PromotionMember,
    payload: dict[str, Any],
    headers: dict[str, str] | None = None,
) -> Response:
    return await client.post(
        orders_url(promotion),
        json=payload,
        headers={**bearer(member.user), **(headers or new_key())},
    )


async def count_orders(db_session: AsyncSession) -> int:
    return (await db_session.execute(select(func.count()).select_from(Order))).scalar_one()


# --- creation, snapshot & money -------------------------------------------------------------


async def test_create_order_snapshots_prices_and_sums_exactly(
    client: AsyncClient,
    active_promotion: Promotion,
    seller: PromotionMember,
    customer: Customer,
    product_factory: ProductFactory,
) -> None:
    dime = await product_factory(active_promotion, name="Bala", price="0.10")
    egg = await product_factory(active_promotion, name="Ovo", price="19.90")

    response = await place_order(
        client, active_promotion, seller, order_payload(customer, (dime, 3), (egg, 2))
    )

    assert response.status_code == 201
    body = response.json()
    lines = {i["product_id"]: i for i in body["items"]}
    assert lines[str(dime.id)]["unit_price"] == "0.10"
    assert lines[str(dime.id)]["line_total"] == "0.30"  # float would give 0.30000000000000004
    assert lines[str(egg.id)]["line_total"] == "39.80"
    assert body["total_amount"] == "40.10"
    assert body["version"] == 1
    assert body["seller_member_id"] == str(seller.id)
    assert body["customer"]["name"] == customer.name
    assert body["status_classification"] == "UNPAID_PENDING"
    assert body["paid_at"] is None
    assert body["audit_events"] == []
    assert response.headers["location"] == f"{orders_url(active_promotion)}/{body['id']}"


async def test_later_price_change_does_not_affect_existing_order(
    client: AsyncClient,
    active_promotion: Promotion,
    seller: PromotionMember,
    user: User,
    customer: Customer,
    product: Product,
) -> None:
    created = await place_order(
        client, active_promotion, seller, order_payload(customer, (product, 1))
    )
    order_id = created.json()["id"]

    patch = await client.patch(
        f"/api/v1/promotions/{active_promotion.id}/products/{product.id}",
        json={"price": "25.00"},
        headers=bearer(user),
    )
    assert patch.status_code == 200

    order = await client.get(f"{orders_url(active_promotion)}/{order_id}", headers=bearer(user))
    assert order.json()["items"][0]["unit_price"] == "19.90"
    assert order.json()["total_amount"] == "19.90"


async def test_mark_paid_now_sets_paid_at_and_appends_audit_event(
    client: AsyncClient,
    db_session: AsyncSession,
    active_promotion: Promotion,
    seller: PromotionMember,
    customer: Customer,
    product: Product,
) -> None:
    response = await place_order(
        client,
        active_promotion,
        seller,
        order_payload(customer, (product, 1), mark_paid_now=True),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["paid_at"] is not None
    assert body["status_classification"] == "PAID_PENDING"
    assert [e["event_type"] for e in body["audit_events"]] == ["PAYMENT_MARKED"]
    assert body["audit_events"][0]["actor_member_id"] == str(seller.id)
    # paid_at and the audit event share the transaction clock.
    assert body["paid_at"] == body["audit_events"][0]["created_at"]


# --- idempotency ----------------------------------------------------------------------------


async def test_retry_with_same_key_returns_existing_order(
    client: AsyncClient,
    db_session: AsyncSession,
    active_promotion: Promotion,
    seller: PromotionMember,
    customer: Customer,
    product: Product,
) -> None:
    key = new_key()
    payload = order_payload(customer, (product, 2))

    first = await place_order(client, active_promotion, seller, payload, key)
    retry = await place_order(client, active_promotion, seller, payload, key)

    assert first.status_code == 201
    assert retry.status_code == 200
    assert retry.headers["idempotent-replayed"] == "true"
    assert retry.json()["id"] == first.json()["id"]
    assert await count_orders(db_session) == 1


async def test_retry_with_reordered_items_is_still_a_replay(
    client: AsyncClient,
    active_promotion: Promotion,
    seller: PromotionMember,
    customer: Customer,
    product_factory: ProductFactory,
) -> None:
    a = await product_factory(active_promotion, name="A")
    b = await product_factory(active_promotion, name="B")
    key = new_key()

    first = await place_order(
        client, active_promotion, seller, order_payload(customer, (a, 1), (b, 2)), key
    )
    retry = await place_order(
        client, active_promotion, seller, order_payload(customer, (b, 2), (a, 1)), key
    )

    assert retry.status_code == 200
    assert retry.json()["id"] == first.json()["id"]


async def test_same_key_with_different_payload_conflicts(
    client: AsyncClient,
    active_promotion: Promotion,
    seller: PromotionMember,
    customer: Customer,
    product: Product,
) -> None:
    key = new_key()
    await place_order(client, active_promotion, seller, order_payload(customer, (product, 1)), key)

    response = await place_order(
        client, active_promotion, seller, order_payload(customer, (product, 5)), key
    )

    assert response.status_code == 409
    assert response.json()["code"] == "IDEMPOTENCY_KEY_REUSED"


async def test_same_key_from_another_seller_conflicts(
    client: AsyncClient,
    active_promotion: Promotion,
    seller: PromotionMember,
    member_factory: MemberFactory,
    customer: Customer,
    product: Product,
) -> None:
    other_seller = await member_factory(active_promotion, Role.SELLER)
    key = new_key()
    payload = order_payload(customer, (product, 1))
    await place_order(client, active_promotion, seller, payload, key)

    response = await place_order(client, active_promotion, other_seller, payload, key)

    assert response.status_code == 409


async def test_retry_succeeds_even_after_promotion_closed(
    client: AsyncClient,
    db_session: AsyncSession,
    active_promotion: Promotion,
    seller: PromotionMember,
    customer: Customer,
    product: Product,
) -> None:
    key = new_key()
    payload = order_payload(customer, (product, 1))
    first = await place_order(client, active_promotion, seller, payload, key)

    active_promotion.status = PromotionStatus.CLOSED
    await db_session.flush()
    retry = await place_order(client, active_promotion, seller, payload, key)
    fresh = await place_order(client, active_promotion, seller, payload)

    assert retry.status_code == 200
    assert retry.json()["id"] == first.json()["id"]
    assert fresh.status_code == 400
    assert fresh.json()["code"] == "PROMOTION_NOT_ACTIVE"


async def test_concurrent_duplicate_loses_race_and_replays_winner(
    client: AsyncClient,
    db_session: AsyncSession,
    active_promotion: Promotion,
    seller: PromotionMember,
    customer: Customer,
    product: Product,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Simulates two in-flight requests: the 2nd passed the lookup before the 1st committed."""
    key = new_key()
    payload = order_payload(customer, (product, 1))
    winner = await place_order(client, active_promotion, seller, payload, key)

    real_find = order_service._find_by_key
    calls = 0

    async def find_misses_once(session: AsyncSession, idempotency_key: str) -> Order | None:
        nonlocal calls
        calls += 1
        return None if calls == 1 else await real_find(session, idempotency_key)

    monkeypatch.setattr(order_service, "_find_by_key", find_misses_once)
    loser = await place_order(client, active_promotion, seller, payload, key)

    assert calls == 2  # lookup missed -> INSERT hit the unique index -> replay lookup
    assert loser.status_code == 200
    assert loser.json()["id"] == winner.json()["id"]
    assert await count_orders(db_session) == 1


@pytest.mark.parametrize(
    ("headers", "code"),
    [
        ({}, "IDEMPOTENCY_KEY_REQUIRED"),
        ({"Idempotency-Key": "not-a-uuid"}, "INVALID_IDEMPOTENCY_KEY"),
        ({"Idempotency-Key": str(uuid.uuid1())}, "INVALID_IDEMPOTENCY_KEY"),
    ],
)
async def test_idempotency_key_header_is_required_uuid4(
    client: AsyncClient,
    active_promotion: Promotion,
    seller: PromotionMember,
    customer: Customer,
    product: Product,
    headers: dict[str, str],
    code: str,
) -> None:
    response = await client.post(
        orders_url(active_promotion),
        json=order_payload(customer, (product, 1)),
        headers={**bearer(seller.user), **headers},
    )

    assert response.status_code == 400
    assert response.json()["code"] == code


# --- business rules -------------------------------------------------------------------------


async def test_cannot_order_in_draft_promotion(
    client: AsyncClient,
    db_session: AsyncSession,
    active_promotion: Promotion,
    seller: PromotionMember,
    customer: Customer,
    product: Product,
) -> None:
    active_promotion.status = PromotionStatus.DRAFT
    await db_session.flush()

    response = await place_order(
        client, active_promotion, seller, order_payload(customer, (product, 1))
    )

    assert response.status_code == 400
    assert response.json()["code"] == "PROMOTION_NOT_ACTIVE"


async def test_inactive_product_is_unavailable(
    client: AsyncClient,
    active_promotion: Promotion,
    seller: PromotionMember,
    customer: Customer,
    product_factory: ProductFactory,
) -> None:
    archived = await product_factory(active_promotion, is_active=False)

    response = await place_order(
        client, active_promotion, seller, order_payload(customer, (archived, 1))
    )

    assert response.status_code == 400
    assert response.json()["code"] == "PRODUCT_UNAVAILABLE"
    assert response.json()["errors"][0]["msg"] == str(archived.id)


async def test_product_from_another_promotion_is_unavailable(
    client: AsyncClient,
    active_promotion: Promotion,
    seller: PromotionMember,
    customer: Customer,
    promotion_factory: PromotionFactory,
    user_factory: UserFactory,
    product_factory: ProductFactory,
) -> None:
    other = await promotion_factory(creator=await user_factory(), name="Other")
    foreign = await product_factory(other)

    response = await place_order(
        client, active_promotion, seller, order_payload(customer, (foreign, 1))
    )

    assert response.status_code == 400
    assert response.json()["code"] == "PRODUCT_UNAVAILABLE"


async def test_customer_from_another_promotion_is_not_found(
    client: AsyncClient,
    active_promotion: Promotion,
    seller: PromotionMember,
    product: Product,
    promotion_factory: PromotionFactory,
    user_factory: UserFactory,
    customer_factory: CustomerFactory,
) -> None:
    other = await promotion_factory(creator=await user_factory(), name="Other")
    foreign_customer = await customer_factory(other)

    response = await place_order(
        client, active_promotion, seller, order_payload(foreign_customer, (product, 1))
    )

    assert response.status_code == 404
    assert response.json()["code"] == "CUSTOMER_NOT_FOUND"


@pytest.mark.parametrize(
    "items",
    [
        [],  # at least one line
        "DUPLICATE",  # same product twice
        [{"quantity": 0}],
        [{"quantity": 1001}],
        [{"quantity": "2"}],  # strict int
        [{"quantity": 1.5}],
    ],
)
async def test_invalid_items_are_rejected(
    client: AsyncClient,
    active_promotion: Promotion,
    seller: PromotionMember,
    customer: Customer,
    product: Product,
    items: Any,
) -> None:
    if items == "DUPLICATE":
        items = [{"quantity": 1}, {"quantity": 2}]
    payload = {
        "customer_id": str(customer.id),
        "items": [{"product_id": str(product.id), **i} for i in items],
    }

    response = await place_order(client, active_promotion, seller, payload)

    assert response.status_code == 422


async def test_admin_without_seller_role_cannot_create_orders(
    client: AsyncClient,
    active_promotion: Promotion,
    user: User,
    customer: Customer,
    product: Product,
) -> None:
    response = await client.post(
        orders_url(active_promotion),
        json=order_payload(customer, (product, 1)),
        headers={**bearer(user), **new_key()},
    )

    assert response.status_code == 403


# --- listing & visibility -------------------------------------------------------------------


async def test_seller_sees_only_own_orders_and_admin_sees_all(
    client: AsyncClient,
    active_promotion: Promotion,
    seller: PromotionMember,
    member_factory: MemberFactory,
    user: User,
    customer: Customer,
    product: Product,
) -> None:
    other_seller = await member_factory(active_promotion, Role.SELLER)
    mine = await place_order(
        client, active_promotion, seller, order_payload(customer, (product, 1))
    )
    theirs = await place_order(
        client, active_promotion, other_seller, order_payload(customer, (product, 1))
    )

    own = await client.get(
        orders_url(active_promotion),
        params={"seller_member_id": str(other_seller.id)},  # ignored for seller-only members
        headers=bearer(seller.user),
    )
    everything = await client.get(orders_url(active_promotion), headers=bearer(user))
    filtered = await client.get(
        orders_url(active_promotion),
        params={"seller_member_id": str(other_seller.id)},
        headers=bearer(user),
    )

    assert [o["id"] for o in own.json()["items"]] == [mine.json()["id"]]
    assert everything.json()["total"] == 2
    assert [o["id"] for o in filtered.json()["items"]] == [theirs.json()["id"]]


async def test_seller_cannot_read_another_sellers_order(
    client: AsyncClient,
    active_promotion: Promotion,
    seller: PromotionMember,
    member_factory: MemberFactory,
    customer: Customer,
    product: Product,
) -> None:
    other_seller = await member_factory(active_promotion, Role.SELLER)
    theirs = await place_order(
        client, active_promotion, other_seller, order_payload(customer, (product, 1))
    )

    response = await client.get(
        f"{orders_url(active_promotion)}/{theirs.json()['id']}", headers=bearer(seller.user)
    )

    assert response.status_code == 404
    assert response.json()["code"] == "ORDER_NOT_FOUND"


async def test_viewer_sees_all_orders(
    client: AsyncClient,
    active_promotion: Promotion,
    seller: PromotionMember,
    member_factory: MemberFactory,
    customer: Customer,
    product: Product,
) -> None:
    viewer = await member_factory(active_promotion, Role.PROMOTION_VIEWER)
    created = await place_order(
        client, active_promotion, seller, order_payload(customer, (product, 1))
    )

    response = await client.get(
        f"{orders_url(active_promotion)}/{created.json()['id']}", headers=bearer(viewer.user)
    )

    assert response.status_code == 200


async def test_filter_by_status_classification(
    client: AsyncClient,
    db_session: AsyncSession,
    active_promotion: Promotion,
    seller: PromotionMember,
    user: User,
    customer: Customer,
    product: Product,
) -> None:
    now = datetime.now(UTC)
    states = {
        "UNPAID_PENDING": {},
        "PAID_PENDING": {"paid_at": now},
        "DIVERGENCE": {"delivered_at": now},
        "SETTLED": {"paid_at": now, "delivered_at": now},
        "CANCELLED": {"cancelled_at": now},
    }
    ids: dict[str, str] = {}
    for classification, fields in states.items():
        created = await place_order(
            client, active_promotion, seller, order_payload(customer, (product, 1))
        )
        ids[classification] = created.json()["id"]
        order = await db_session.get(Order, uuid.UUID(ids[classification]))
        assert order is not None
        for field, value in fields.items():
            setattr(order, field, value)
    await db_session.flush()

    for classification, order_id in ids.items():
        response = await client.get(
            orders_url(active_promotion),
            params={"status_classification": classification},
            headers=bearer(user),
        )
        items = response.json()["items"]
        assert [o["id"] for o in items] == [order_id], classification
        assert items[0]["status_classification"] == classification


async def test_list_orders_pagination(
    client: AsyncClient,
    active_promotion: Promotion,
    seller: PromotionMember,
    customer: Customer,
    product: Product,
) -> None:
    for _ in range(3):
        await place_order(client, active_promotion, seller, order_payload(customer, (product, 1)))

    response = await client.get(
        orders_url(active_promotion), params={"page": 2, "size": 2}, headers=bearer(seller.user)
    )

    body = response.json()
    assert (body["total"], body["page"], body["size"], len(body["items"])) == (3, 2, 2, 1)


# --- audit log immutability -----------------------------------------------------------------


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE order_audit_event SET reason = 'tampered'",
        "DELETE FROM order_audit_event",
    ],
)
async def test_audit_events_are_append_only(
    client: AsyncClient,
    db_session: AsyncSession,
    active_promotion: Promotion,
    seller: PromotionMember,
    customer: Customer,
    product: Product,
    statement: str,
) -> None:
    await place_order(
        client,
        active_promotion,
        seller,
        order_payload(customer, (product, 1), mark_paid_now=True),
    )
    assert (await db_session.execute(select(func.count()).select_from(OrderAuditEvent))).scalar()

    with pytest.raises(DBAPIError, match="append-only"):
        async with db_session.begin_nested():
            await db_session.execute(text(statement))
