import uuid
from typing import Any

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Customer, Order, OrderAuditEvent, Product, Promotion, PromotionMember, User
from app.models.enums import Role
from app.services import transitions as transition_service
from app.services.access import PromotionContext
from tests.conftest import MemberFactory, bearer, new_key, order_payload, orders_url, place_order


@pytest.fixture
async def order(
    client: AsyncClient,
    active_promotion: Promotion,
    seller: PromotionMember,
    customer: Customer,
    product: Product,
) -> dict[str, Any]:
    response = await place_order(
        client, active_promotion, seller, order_payload(customer, (product, 1))
    )
    assert response.status_code == 201
    return response.json()


async def transition(
    client: AsyncClient,
    promotion: Promotion,
    member_or_user: PromotionMember | User,
    order_id: str,
    kind: str,
    body: dict[str, Any],
    key: dict[str, str] | None = None,
) -> Response:
    user = member_or_user.user if isinstance(member_or_user, PromotionMember) else member_or_user
    return await client.post(
        f"{orders_url(promotion)}/{order_id}/{kind}",
        json=body,
        headers={**bearer(user), **(key or new_key())},
    )


async def count_events(db_session: AsyncSession) -> int:
    return (
        await db_session.execute(select(func.count()).select_from(OrderAuditEvent))
    ).scalar_one()


# --- happy paths ----------------------------------------------------------------------------


async def test_mark_paid_increments_version_and_audits(
    client: AsyncClient, active_promotion: Promotion, seller: PromotionMember, order: dict
) -> None:
    response = await transition(
        client,
        active_promotion,
        seller,
        order["id"],
        "payment",
        {"action": "MARK_PAID", "expected_version": 1},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["version"] == 2
    assert body["paid_at"] is not None
    assert body["status_classification"] == "PAID_PENDING"
    assert [(e["event_type"], e["actor_member_id"]) for e in body["audit_events"]] == [
        ("PAYMENT_MARKED", str(seller.id))
    ]


async def test_full_lifecycle_paid_then_delivered_is_settled(
    client: AsyncClient, active_promotion: Promotion, seller: PromotionMember, order: dict
) -> None:
    await transition(
        client, active_promotion, seller, order["id"], "payment",
        {"action": "MARK_PAID", "expected_version": 1},
    )  # fmt: skip
    response = await transition(
        client, active_promotion, seller, order["id"], "delivery",
        {"action": "MARK_DELIVERED", "expected_version": 2},
    )  # fmt: skip

    body = response.json()
    assert body["version"] == 3
    assert body["status_classification"] == "SETTLED"
    assert [e["event_type"] for e in body["audit_events"]] == ["PAYMENT_MARKED", "DELIVERY_MARKED"]


async def test_delivery_without_payment_is_a_divergence(
    client: AsyncClient, active_promotion: Promotion, seller: PromotionMember, order: dict
) -> None:
    response = await transition(
        client, active_promotion, seller, order["id"], "delivery",
        {"action": "MARK_DELIVERED", "expected_version": 1},
    )  # fmt: skip

    assert response.status_code == 200
    assert response.json()["status_classification"] == "DIVERGENCE"


async def test_revoke_payment_requires_reason_and_records_it(
    client: AsyncClient, active_promotion: Promotion, seller: PromotionMember, order: dict
) -> None:
    await transition(
        client, active_promotion, seller, order["id"], "payment",
        {"action": "MARK_PAID", "expected_version": 1},
    )  # fmt: skip

    no_reason = await transition(
        client, active_promotion, seller, order["id"], "payment",
        {"action": "REVOKE_PAYMENT", "expected_version": 2},
    )  # fmt: skip
    revoked = await transition(
        client, active_promotion, seller, order["id"], "payment",
        {"action": "REVOKE_PAYMENT", "expected_version": 2, "reason": "  forged receipt  "},
    )  # fmt: skip

    assert no_reason.status_code == 422
    assert revoked.status_code == 200
    body = revoked.json()
    assert body["paid_at"] is None
    assert body["audit_events"][-1]["event_type"] == "PAYMENT_REVOKED"
    assert body["audit_events"][-1]["reason"] == "forged receipt"


async def test_cancel_unpaid_order(
    client: AsyncClient, active_promotion: Promotion, seller: PromotionMember, order: dict
) -> None:
    response = await transition(
        client, active_promotion, seller, order["id"], "cancel",
        {"expected_version": 1, "reason": "Customer gave up"},
    )  # fmt: skip

    assert response.status_code == 200
    body = response.json()
    assert body["cancelled_at"] is not None
    assert body["status_classification"] == "CANCELLED"
    assert body["audit_events"][-1]["event_type"] == "ORDER_CANCELLED"


@pytest.mark.parametrize("body", [{"expected_version": 1}, {"expected_version": 1, "reason": " "}])
async def test_cancel_requires_non_blank_reason(
    client: AsyncClient,
    active_promotion: Promotion,
    seller: PromotionMember,
    order: dict,
    body: dict,
) -> None:
    response = await transition(client, active_promotion, seller, order["id"], "cancel", body)

    assert response.status_code == 422


# --- transition rules -----------------------------------------------------------------------


async def test_cannot_cancel_paid_order_until_payment_revoked(
    client: AsyncClient, active_promotion: Promotion, seller: PromotionMember, order: dict
) -> None:
    await transition(
        client, active_promotion, seller, order["id"], "payment",
        {"action": "MARK_PAID", "expected_version": 1},
    )  # fmt: skip

    blocked = await transition(
        client, active_promotion, seller, order["id"], "cancel",
        {"expected_version": 2, "reason": "x"},
    )  # fmt: skip
    await transition(
        client, active_promotion, seller, order["id"], "payment",
        {"action": "REVOKE_PAYMENT", "expected_version": 2, "reason": "Refunded"},
    )  # fmt: skip
    allowed = await transition(
        client, active_promotion, seller, order["id"], "cancel",
        {"expected_version": 3, "reason": "Refunded and cancelled"},
    )  # fmt: skip

    assert blocked.status_code == 400
    assert blocked.json()["code"] == "INVALID_TRANSITION"
    assert "Revoke the payment" in blocked.json()["detail"]
    assert allowed.status_code == 200


async def test_cannot_cancel_delivered_order(
    client: AsyncClient, active_promotion: Promotion, seller: PromotionMember, order: dict
) -> None:
    await transition(
        client, active_promotion, seller, order["id"], "delivery",
        {"action": "MARK_DELIVERED", "expected_version": 1},
    )  # fmt: skip

    response = await transition(
        client, active_promotion, seller, order["id"], "cancel",
        {"expected_version": 2, "reason": "x"},
    )  # fmt: skip

    assert response.status_code == 400
    assert "Delivered orders" in response.json()["detail"]


@pytest.mark.parametrize(
    ("kind", "body", "detail"),
    [
        ("payment", {"action": "REVOKE_PAYMENT", "reason": "x"}, "not paid"),
        ("delivery", {"action": "REVOKE_DELIVERY", "reason": "x"}, "not delivered"),
    ],
)
async def test_cannot_revoke_what_is_not_set(
    client: AsyncClient,
    active_promotion: Promotion,
    seller: PromotionMember,
    order: dict,
    kind: str,
    body: dict,
    detail: str,
) -> None:
    response = await transition(
        client, active_promotion, seller, order["id"], kind, {**body, "expected_version": 1}
    )

    assert response.status_code == 400
    assert detail in response.json()["detail"]


async def test_cannot_mark_paid_twice(
    client: AsyncClient, active_promotion: Promotion, seller: PromotionMember, order: dict
) -> None:
    body = {"action": "MARK_PAID"}
    await transition(
        client, active_promotion, seller, order["id"], "payment", {**body, "expected_version": 1}
    )

    response = await transition(
        client, active_promotion, seller, order["id"], "payment", {**body, "expected_version": 2}
    )

    assert response.status_code == 400
    assert "already paid" in response.json()["detail"]


async def test_cancelled_order_is_frozen(
    client: AsyncClient, active_promotion: Promotion, seller: PromotionMember, order: dict
) -> None:
    await transition(
        client, active_promotion, seller, order["id"], "cancel",
        {"expected_version": 1, "reason": "x"},
    )  # fmt: skip

    response = await transition(
        client, active_promotion, seller, order["id"], "payment",
        {"action": "MARK_PAID", "expected_version": 2},
    )  # fmt: skip

    assert response.status_code == 400
    assert "Cancelled" in response.json()["detail"]


# --- OCC ------------------------------------------------------------------------------------


async def test_stale_version_is_rejected(
    client: AsyncClient, active_promotion: Promotion, seller: PromotionMember, order: dict
) -> None:
    await transition(
        client, active_promotion, seller, order["id"], "payment",
        {"action": "MARK_PAID", "expected_version": 1},
    )  # fmt: skip

    response = await transition(
        client, active_promotion, seller, order["id"], "delivery",
        {"action": "MARK_DELIVERED", "expected_version": 1},  # stale offline client
    )  # fmt: skip

    assert response.status_code == 409
    assert response.json()["code"] == "CONCURRENCY_CONFLICT"
    assert "expected: 1, current: 2" in response.json()["detail"]


async def test_concurrent_write_between_read_and_update_is_rejected(
    client: AsyncClient,
    db_session: AsyncSession,
    active_promotion: Promotion,
    seller: PromotionMember,
    order: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Another writer bumps the version after our read: the guarded UPDATE matches 0 rows."""
    real_get = transition_service.get_visible_order

    async def get_then_concurrent_write(
        session: AsyncSession, ctx: PromotionContext, order_id: uuid.UUID
    ) -> Order:
        loaded = await real_get(session, ctx, order_id)
        await session.execute(
            text("UPDATE customer_order SET version = version + 1 WHERE id = :id"),
            {"id": order_id},
        )
        await session.commit()  # the "other writer" commits first
        return loaded

    monkeypatch.setattr(transition_service, "get_visible_order", get_then_concurrent_write)
    response = await transition(
        client, active_promotion, seller, order["id"], "payment",
        {"action": "MARK_PAID", "expected_version": 1},
    )  # fmt: skip

    assert response.status_code == 409
    assert "expected: 1, current: 2" in response.json()["detail"]
    assert await count_events(db_session) == 0


# --- idempotency ----------------------------------------------------------------------------


async def test_retry_returns_current_state_without_new_event(
    client: AsyncClient,
    db_session: AsyncSession,
    active_promotion: Promotion,
    seller: PromotionMember,
    order: dict,
) -> None:
    key = new_key()
    pay = {"action": "MARK_PAID", "expected_version": 1}
    first = await transition(client, active_promotion, seller, order["id"], "payment", pay, key)
    await transition(
        client, active_promotion, seller, order["id"], "delivery",
        {"action": "MARK_DELIVERED", "expected_version": 2},
    )  # fmt: skip

    retry = await transition(client, active_promotion, seller, order["id"], "payment", pay, key)

    assert first.status_code == retry.status_code == 200
    assert retry.headers["idempotent-replayed"] == "true"
    assert retry.json()["version"] == 3  # current state, not 409
    assert retry.json()["status_classification"] == "SETTLED"
    assert await count_events(db_session) == 2


async def test_same_key_different_transition_conflicts(
    client: AsyncClient, active_promotion: Promotion, seller: PromotionMember, order: dict
) -> None:
    key = new_key()
    await transition(
        client, active_promotion, seller, order["id"], "payment",
        {"action": "MARK_PAID", "expected_version": 1}, key,
    )  # fmt: skip

    response = await transition(
        client, active_promotion, seller, order["id"], "delivery",
        {"action": "MARK_DELIVERED", "expected_version": 2}, key,
    )  # fmt: skip

    assert response.status_code == 409
    assert response.json()["code"] == "IDEMPOTENCY_KEY_REUSED"


async def test_same_key_from_another_member_conflicts(
    client: AsyncClient,
    active_promotion: Promotion,
    seller: PromotionMember,
    user: User,
    order: dict,
) -> None:
    key = new_key()
    body = {"action": "MARK_PAID", "expected_version": 1}
    await transition(client, active_promotion, seller, order["id"], "payment", body, key)

    response = await transition(client, active_promotion, user, order["id"], "payment", body, key)

    assert response.status_code == 409


async def test_race_lost_to_same_request_replays(
    client: AsyncClient,
    db_session: AsyncSession,
    active_promotion: Promotion,
    seller: PromotionMember,
    order: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """2nd in-flight copy passed the replay check before the 1st committed -> replay, not 409."""
    key = new_key()
    body = {"action": "MARK_PAID", "expected_version": 1}
    await transition(client, active_promotion, seller, order["id"], "payment", body, key)

    real_replay = transition_service._replay
    calls = 0

    async def replay_misses_once(session: AsyncSession, req: Any) -> Order | None:
        nonlocal calls
        calls += 1
        return None if calls == 1 else await real_replay(session, req)

    monkeypatch.setattr(transition_service, "_replay", replay_misses_once)
    response = await transition(client, active_promotion, seller, order["id"], "payment", body, key)

    assert calls == 2  # missed -> version conflict -> re-checked key -> replay
    assert response.status_code == 200
    assert response.headers["idempotent-replayed"] == "true"
    assert await count_events(db_session) == 1


async def test_transition_requires_idempotency_key(
    client: AsyncClient, active_promotion: Promotion, seller: PromotionMember, order: dict
) -> None:
    response = await client.post(
        f"{orders_url(active_promotion)}/{order['id']}/payment",
        json={"action": "MARK_PAID", "expected_version": 1},
        headers=bearer(seller.user),
    )

    assert response.status_code == 400
    assert response.json()["code"] == "IDEMPOTENCY_KEY_REQUIRED"


# --- permissions ----------------------------------------------------------------------------


async def test_admin_can_transition_any_order(
    client: AsyncClient, active_promotion: Promotion, user: User, order: dict
) -> None:
    response = await transition(
        client, active_promotion, user, order["id"], "delivery",
        {"action": "MARK_DELIVERED", "expected_version": 1},
    )  # fmt: skip

    assert response.status_code == 200


async def test_viewer_cannot_transition(
    client: AsyncClient, active_promotion: Promotion, member_factory: MemberFactory, order: dict
) -> None:
    viewer = await member_factory(active_promotion, Role.PROMOTION_VIEWER)

    response = await transition(
        client, active_promotion, viewer, order["id"], "payment",
        {"action": "MARK_PAID", "expected_version": 1},
    )  # fmt: skip

    assert response.status_code == 403


async def test_other_seller_cannot_see_order(
    client: AsyncClient, active_promotion: Promotion, member_factory: MemberFactory, order: dict
) -> None:
    other = await member_factory(active_promotion, Role.SELLER)

    response = await transition(
        client, active_promotion, other, order["id"], "payment",
        {"action": "MARK_PAID", "expected_version": 1},
    )  # fmt: skip

    assert response.status_code == 404


async def test_seller_viewer_can_see_but_not_modify_others_order(
    client: AsyncClient, active_promotion: Promotion, member_factory: MemberFactory, order: dict
) -> None:
    hybrid = await member_factory(active_promotion, Role.SELLER, Role.PROMOTION_VIEWER)

    response = await transition(
        client, active_promotion, hybrid, order["id"], "payment",
        {"action": "MARK_PAID", "expected_version": 1},
    )  # fmt: skip

    assert response.status_code == 403
    assert response.json()["code"] == "INSUFFICIENT_ROLE"


# --- atomicity & DB invariants --------------------------------------------------------------


async def test_failed_audit_insert_rolls_back_the_update(
    db_session: AsyncSession, active_promotion: Promotion, seller: PromotionMember, order: dict
) -> None:
    """Bypass schema validation: the DB CHECK rejects a reason-less cancel, and the
    already-executed UPDATE (version/cancelled_at) must be rolled back with it."""
    ctx = PromotionContext(promotion=active_promotion, member=seller)
    order_id = uuid.UUID(order["id"])

    with pytest.raises(IntegrityError, match="ck_order_audit_event_reason_required"):
        await transition_service.apply_transition(
            db_session,
            ctx,
            order_id,
            transition_service.CANCEL_TRANSITION,
            expected_version=1,
            reason=None,
            idempotency_key=uuid.uuid4(),
        )

    row = (
        await db_session.execute(
            select(Order.version, Order.cancelled_at).where(Order.id == order_id)
        )
    ).one()
    assert (row.version, row.cancelled_at) == (1, None)


@pytest.mark.parametrize("reason", [None, "   "])
async def test_db_requires_reason_for_revocations(
    db_session: AsyncSession, seller: PromotionMember, order: dict, reason: str | None
) -> None:
    db_session.add(
        OrderAuditEvent(
            order_id=uuid.UUID(order["id"]),
            actor_member_id=seller.id,
            event_type="PAYMENT_REVOKED",
            reason=reason,
        )
    )

    with pytest.raises(IntegrityError, match="ck_order_audit_event_reason_required"):
        await db_session.flush()


async def test_db_requires_key_and_fingerprint_together(
    db_session: AsyncSession, seller: PromotionMember, order: dict
) -> None:
    db_session.add(
        OrderAuditEvent(
            order_id=uuid.UUID(order["id"]),
            actor_member_id=seller.id,
            event_type="PAYMENT_MARKED",
            idempotency_key=str(uuid.uuid4()),
        )
    )

    with pytest.raises(IntegrityError, match="ck_order_audit_event_idempotency_pair"):
        await db_session.flush()
