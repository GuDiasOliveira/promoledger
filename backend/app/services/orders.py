import hashlib
import json
import uuid
from dataclasses import dataclass

from sqlalchemy import ColumnElement, Select, and_, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import violates_constraint
from app.core.errors import AppError
from app.models import Customer, Order, OrderAuditEvent, OrderItem, Product
from app.models.enums import AuditEventType, PromotionStatus, Role, StatusClassification
from app.schemas.order import OrderCreate
from app.schemas.pagination import PageParams
from app.services.access import PromotionContext
from app.services.pagination import paginate

IDEMPOTENCY_KEY_CONSTRAINT = "uq_customer_order_idempotency_key"


def _order_not_found() -> AppError:
    return AppError(404, "ORDER_NOT_FOUND", "Order not found.")


def sees_all_orders(ctx: PromotionContext) -> bool:
    """Admins/viewers see every order; seller-only members see just their own."""
    return ctx.has_any_role(Role.PROMOTION_ADMIN, Role.PROMOTION_VIEWER)


# --- queries --------------------------------------------------------------------------------


def _orders_query(*, with_audit: bool = False) -> Select[tuple[Order]]:
    options = [selectinload(Order.customer), selectinload(Order.items)]
    if with_audit:
        options.append(selectinload(Order.audit_events))
    # populate_existing: always reflect DB state, even for objects already in the identity map.
    return select(Order).options(*options).execution_options(populate_existing=True)


_CLASSIFICATION_FILTERS: dict[StatusClassification, ColumnElement[bool]] = {
    StatusClassification.CANCELLED: Order.cancelled_at.is_not(None),
    StatusClassification.SETTLED: and_(
        Order.cancelled_at.is_(None), Order.paid_at.is_not(None), Order.delivered_at.is_not(None)
    ),
    StatusClassification.PAID_PENDING: and_(
        Order.cancelled_at.is_(None), Order.paid_at.is_not(None), Order.delivered_at.is_(None)
    ),
    StatusClassification.DIVERGENCE: and_(
        Order.cancelled_at.is_(None), Order.paid_at.is_(None), Order.delivered_at.is_not(None)
    ),
    StatusClassification.UNPAID_PENDING: and_(
        Order.cancelled_at.is_(None), Order.paid_at.is_(None), Order.delivered_at.is_(None)
    ),
}


@dataclass(frozen=True)
class OrderFilters:
    status_classification: StatusClassification | None = None
    seller_member_id: uuid.UUID | None = None
    customer_id: uuid.UUID | None = None


async def list_orders(
    session: AsyncSession, ctx: PromotionContext, filters: OrderFilters, params: PageParams
) -> tuple[list[Order], int]:
    stmt = _orders_query().where(Order.promotion_id == ctx.promotion.id)
    if not sees_all_orders(ctx):
        stmt = stmt.where(Order.seller_member_id == ctx.member.id)
    elif filters.seller_member_id is not None:
        stmt = stmt.where(Order.seller_member_id == filters.seller_member_id)
    if filters.customer_id is not None:
        stmt = stmt.where(Order.customer_id == filters.customer_id)
    if filters.status_classification is not None:
        stmt = stmt.where(_CLASSIFICATION_FILTERS[filters.status_classification])
    stmt = stmt.order_by(Order.created_at.desc(), Order.id)
    return await paginate(session, stmt, params)


async def get_order(
    session: AsyncSession, promotion_id: uuid.UUID, order_id: uuid.UUID
) -> Order | None:
    stmt = _orders_query(with_audit=True).where(
        Order.id == order_id, Order.promotion_id == promotion_id
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def get_visible_order(
    session: AsyncSession, ctx: PromotionContext, order_id: uuid.UUID
) -> Order:
    order = await get_order(session, ctx.promotion.id, order_id)
    if order is None or (not sees_all_orders(ctx) and order.seller_member_id != ctx.member.id):
        raise _order_not_found()
    return order


# --- creation -------------------------------------------------------------------------------


def compute_fingerprint(
    promotion_id: uuid.UUID, seller_member_id: uuid.UUID, data: OrderCreate
) -> str:
    """SHA-256 of the canonical create payload: identifies a *safe* idempotent retry."""
    canonical = {
        "promotion_id": str(promotion_id),
        "seller_member_id": str(seller_member_id),
        "customer_id": str(data.customer_id),
        "items": sorted([str(i.product_id), i.quantity] for i in data.items),
        "mark_paid_now": data.mark_paid_now,
    }
    encoded = json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


async def _find_by_key(session: AsyncSession, idempotency_key: str) -> Order | None:
    stmt = select(Order.id, Order.promotion_id).where(Order.idempotency_key == idempotency_key)
    row = (await session.execute(stmt)).first()
    if row is None:
        return None
    return await get_order(session, row.promotion_id, row.id)


def _check_replay(existing: Order, fingerprint: str) -> Order:
    if existing.idempotency_fingerprint != fingerprint:
        raise AppError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "This Idempotency-Key was already used for a different request.",
        )
    return existing


async def create_order(
    session: AsyncSession, ctx: PromotionContext, data: OrderCreate, idempotency_key: uuid.UUID
) -> tuple[Order, bool]:
    """Return (order, created). `created=False` means an idempotent replay."""
    # Capture plain values up front: a rollback below expires every ORM instance.
    promotion_id, seller_member_id = ctx.promotion.id, ctx.member.id
    promotion_status = ctx.promotion.status
    key = str(idempotency_key)
    fingerprint = compute_fingerprint(promotion_id, seller_member_id, data)

    # 1. Replay check comes first: a retry must succeed even if the promotion closed meanwhile.
    if (existing := await _find_by_key(session, key)) is not None:
        return _check_replay(existing, fingerprint), False

    # 2. Business rules.
    if promotion_status != PromotionStatus.ACTIVE:
        raise AppError(400, "PROMOTION_NOT_ACTIVE", "Orders can only be created while ACTIVE.")

    customer = await session.get(Customer, data.customer_id)
    if customer is None or customer.promotion_id != promotion_id:
        raise AppError(404, "CUSTOMER_NOT_FOUND", "Customer not found in this promotion.")

    product_ids = [item.product_id for item in data.items]
    products = {
        p.id: p
        for p in (
            await session.execute(
                select(Product).where(
                    Product.id.in_(product_ids),
                    Product.promotion_id == promotion_id,
                    Product.is_active.is_(True),
                )
            )
        ).scalars()
    }
    unavailable = [pid for pid in product_ids if pid not in products]
    if unavailable:
        raise AppError(
            400,
            "PRODUCT_UNAVAILABLE",
            "Some products are inactive or do not belong to this promotion.",
            errors=[
                {"loc": ["body", "items", "product_id"], "msg": str(pid), "type": "unavailable"}
                for pid in unavailable
            ],
        )

    # 3. Insert with frozen price snapshot (same transaction as the product read).
    paid_at = (
        (await session.execute(select(func.now()))).scalar_one() if data.mark_paid_now else None
    )
    order = Order(
        promotion_id=promotion_id,
        seller_member_id=seller_member_id,
        customer_id=customer.id,
        idempotency_key=key,
        idempotency_fingerprint=fingerprint,
        paid_at=paid_at,
        items=[
            OrderItem(
                product_id=item.product_id,
                quantity=item.quantity,
                unit_price=products[item.product_id].price,
            )
            for item in data.items
        ],
    )
    session.add(order)
    try:
        await session.flush()
    except IntegrityError as exc:
        # Lost a race against a concurrent request with the same key: replay the winner.
        await session.rollback()
        if not violates_constraint(exc, IDEMPOTENCY_KEY_CONSTRAINT):
            raise
        existing = await _find_by_key(session, key)
        if existing is None:  # pragma: no cover - winner must exist after a unique violation
            raise
        return _check_replay(existing, fingerprint), False

    if data.mark_paid_now:
        session.add(
            OrderAuditEvent(
                order_id=order.id,
                actor_member_id=seller_member_id,
                event_type=AuditEventType.PAYMENT_MARKED,
            )
        )
    order_id = order.id
    await session.commit()

    created = await get_order(session, promotion_id, order_id)
    assert created is not None
    return created, True
