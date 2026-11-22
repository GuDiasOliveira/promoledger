"""Audited order lifecycle transitions with OCC and idempotency (docs/api.md §8.4)."""

import hashlib
import json
import uuid
from dataclasses import dataclass

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import violates_constraint
from app.core.errors import AppError
from app.models import Order, OrderAuditEvent
from app.models.enums import AuditEventType, Role
from app.schemas.transition import DeliveryAction, PaymentAction
from app.services.access import PromotionContext
from app.services.orders import get_order, get_visible_order

EVENT_KEY_CONSTRAINT = "uq_order_audit_event_idempotency_key"


@dataclass(frozen=True)
class Transition:
    event_type: AuditEventType
    field: str  # timestamp column on Order
    sets: bool  # True: set to now(); False: clear (revoke)


ACTION_TRANSITIONS: dict[PaymentAction | DeliveryAction, Transition] = {
    PaymentAction.MARK_PAID: Transition(AuditEventType.PAYMENT_MARKED, "paid_at", True),
    PaymentAction.REVOKE_PAYMENT: Transition(AuditEventType.PAYMENT_REVOKED, "paid_at", False),
    DeliveryAction.MARK_DELIVERED: Transition(AuditEventType.DELIVERY_MARKED, "delivered_at", True),
    DeliveryAction.REVOKE_DELIVERY: Transition(
        AuditEventType.DELIVERY_REVOKED, "delivered_at", False
    ),
}
CANCEL_TRANSITION = Transition(AuditEventType.ORDER_CANCELLED, "cancelled_at", True)

_FIELD_LABEL = {"paid_at": "paid", "delivered_at": "delivered", "cancelled_at": "cancelled"}


def _fingerprint(
    order_id: uuid.UUID,
    actor_member_id: uuid.UUID,
    transition: Transition,
    expected_version: int,
    reason: str | None,
) -> str:
    canonical = {
        "order_id": str(order_id),
        "actor_member_id": str(actor_member_id),
        "event_type": transition.event_type.value,
        "expected_version": expected_version,
        "reason": reason,
    }
    encoded = json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _invalid(detail: str) -> AppError:
    return AppError(400, "INVALID_TRANSITION", detail)


def _check_rule(order: Order, transition: Transition) -> None:
    if order.cancelled_at is not None:
        raise _invalid("Cancelled orders cannot be modified.")
    current = getattr(order, transition.field)
    label = _FIELD_LABEL[transition.field]
    if transition.sets and current is not None:
        raise _invalid(f"Order is already {label}.")
    if not transition.sets and current is None:
        raise _invalid(f"Order is not {label}; nothing to revoke.")
    if transition.event_type is AuditEventType.ORDER_CANCELLED:
        if order.delivered_at is not None:
            raise _invalid("Delivered orders cannot be cancelled.")
        if order.paid_at is not None:
            raise _invalid("Revoke the payment (e.g. refund) before cancelling a paid order.")


def _ensure_can_modify(ctx: PromotionContext, order: Order) -> None:
    """Admins modify any order; sellers only their own."""
    if ctx.has_any_role(Role.PROMOTION_ADMIN):
        return
    if ctx.has_any_role(Role.SELLER) and order.seller_member_id == ctx.member.id:
        return
    raise AppError(
        403, "INSUFFICIENT_ROLE", "Only the order's seller or a promotion_admin can do this."
    )


@dataclass(frozen=True)
class _Request:
    promotion_id: uuid.UUID
    order_id: uuid.UUID
    key: str
    fingerprint: str
    expected_version: int


async def _replay(session: AsyncSession, req: _Request) -> Order | None:
    """Return the order if `req.key` was already processed; 409 if it was for something else."""
    stmt = select(OrderAuditEvent.order_id, OrderAuditEvent.idempotency_fingerprint).where(
        OrderAuditEvent.idempotency_key == req.key
    )
    row = (await session.execute(stmt)).first()
    if row is None:
        return None
    if row.idempotency_fingerprint != req.fingerprint:
        raise AppError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "This Idempotency-Key was already used for a different request.",
        )
    return await get_order(session, req.promotion_id, row.order_id)


async def _conflict(session: AsyncSession, req: _Request, current_version: int) -> Order:
    """Version mismatch: a replay if the winner was this same request, else 409."""
    if (replayed := await _replay(session, req)) is not None:
        return replayed
    raise AppError(
        409,
        "CONCURRENCY_CONFLICT",
        f"Order version mismatch (expected: {req.expected_version}, current: {current_version}). "
        "Please refresh and retry.",
    )


async def apply_transition(
    session: AsyncSession,
    ctx: PromotionContext,
    order_id: uuid.UUID,
    transition: Transition,
    *,
    expected_version: int,
    reason: str | None,
    idempotency_key: uuid.UUID,
) -> tuple[Order, bool]:
    """Return (order, applied). `applied=False` means an idempotent replay."""
    # Plain values up front: a rollback expires every ORM instance.
    actor_member_id = ctx.member.id
    req = _Request(
        promotion_id=ctx.promotion.id,
        order_id=order_id,
        key=str(idempotency_key),
        fingerprint=_fingerprint(order_id, actor_member_id, transition, expected_version, reason),
        expected_version=expected_version,
    )

    # 1. Idempotent replay first (returns the *current* order state).
    if (replayed := await _replay(session, req)) is not None:
        return replayed, False

    # 2. Visibility (404) and permission (403).
    order = await get_visible_order(session, ctx, order_id)
    _ensure_can_modify(ctx, order)

    # 3. OCC against the state we read.
    if order.version != expected_version:
        return await _conflict(session, req, order.version), False

    # 4. Transition rule, evaluated on the exact version the WHERE clause below will match.
    _check_rule(order, transition)

    # 5. Atomic compare-and-swap; 0 rows = someone else won the race since step 2.
    stmt = (
        update(Order)
        .where(Order.id == order_id, Order.version == expected_version)
        .values(
            {
                transition.field: func.now() if transition.sets else None,
                "version": Order.version + 1,
                "updated_at": func.now(),
            }
        )
        .returning(Order.version)
        .execution_options(synchronize_session=False)
    )
    if (await session.execute(stmt)).scalar_one_or_none() is None:
        await session.rollback()
        current = (
            await session.execute(select(Order.version).where(Order.id == order_id))
        ).scalar_one()
        return await _conflict(session, req, current), False

    session.add(
        OrderAuditEvent(
            order_id=order_id,
            actor_member_id=actor_member_id,
            event_type=transition.event_type,
            reason=reason,
            idempotency_key=req.key,
            idempotency_fingerprint=req.fingerprint,
        )
    )
    try:
        await session.flush()
    except IntegrityError as exc:
        # Same key used concurrently: everything (incl. the UPDATE) is rolled back.
        await session.rollback()
        if not violates_constraint(exc, EVENT_KEY_CONSTRAINT):
            raise
        if (replayed := await _replay(session, req)) is None:  # pragma: no cover
            raise
        return replayed, False

    await session.commit()
    result = await get_order(session, req.promotion_id, order_id)
    assert result is not None
    return result, True
