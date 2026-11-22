"""Reconciliation analytics (docs/api.md §9). All sums are NUMERIC in SQL -> Decimal."""

import uuid
from decimal import Decimal
from typing import Any

from sqlalchemy import ColumnElement, Subquery, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Order, OrderAuditEvent, OrderItem, PromotionMember, User
from app.models.enums import AuditEventType, StatusClassification
from app.schemas.pagination import PageParams
from app.schemas.reconciliation import ClassificationBucket, LeaderboardEntry, ReconciliationSummary
from app.services.orders import classification_conditions
from app.services.pagination import paginate

ZERO = Decimal("0.00")
HUNDRED = Decimal("100")
CENT = Decimal("0.01")


def _order_totals(promotion_id: uuid.UUID) -> Subquery:
    """One row per order: its state columns plus exact amount and units."""
    return (
        select(
            Order.id,
            Order.seller_member_id,
            Order.paid_at,
            Order.delivered_at,
            Order.cancelled_at,
            func.sum(OrderItem.quantity * OrderItem.unit_price).label("amount"),
            func.sum(OrderItem.quantity).label("units"),
        )
        .join(OrderItem, OrderItem.order_id == Order.id)
        .where(Order.promotion_id == promotion_id)
        .group_by(Order.id)
        .subquery()
    )


def _sum_where(column: ColumnElement[Any], condition: ColumnElement[bool]) -> ColumnElement[Any]:
    return func.coalesce(func.sum(column).filter(condition), 0)


async def get_summary(session: AsyncSession, promotion_id: uuid.UUID) -> ReconciliationSummary:
    t = _order_totals(promotion_id)
    conditions = classification_conditions(t.c.paid_at, t.c.delivered_at, t.c.cancelled_at)
    live = t.c.cancelled_at.is_(None)

    columns: list[ColumnElement[Any]] = [
        _sum_where(t.c.amount, live).label("total_revenue"),
        _sum_where(t.c.amount, live & t.c.paid_at.is_not(None)).label("collected"),
        _sum_where(t.c.units, live).label("units_ordered"),
        _sum_where(t.c.units, live & t.c.delivered_at.is_not(None)).label("units_delivered"),
    ]
    for classification, condition in conditions.items():
        columns.append(func.count().filter(condition).label(f"{classification}_count"))
        columns.append(_sum_where(t.c.amount, condition).label(f"{classification}_amount"))

    row = (await session.execute(select(*columns).select_from(t))).one()._mapping
    total_revenue = Decimal(row["total_revenue"])
    collected = Decimal(row["collected"])
    return ReconciliationSummary(
        total_revenue=total_revenue,
        collected_amount=collected,
        outstanding_amount=total_revenue - collected,
        units_ordered=row["units_ordered"],
        units_delivered=row["units_delivered"],
        by_classification={
            c: ClassificationBucket(count=row[f"{c}_count"], amount=Decimal(row[f"{c}_amount"]))
            for c in StatusClassification
        },
    )


async def get_leaderboard(session: AsyncSession, promotion_id: uuid.UUID) -> list[LeaderboardEntry]:
    t = _order_totals(promotion_id)
    live = t.c.cancelled_at.is_(None)
    settled = classification_conditions(t.c.paid_at, t.c.delivered_at, t.c.cancelled_at)[
        StatusClassification.SETTLED
    ]
    gross = func.sum(t.c.amount)
    stmt = (
        select(
            PromotionMember.id.label("member_id"),
            User.id.label("user_id"),
            User.name,
            func.count().label("order_count"),
            func.sum(t.c.units).label("units_sold"),
            gross.label("gross_revenue"),
            _sum_where(t.c.amount, settled).label("settled_amount"),
        )
        .select_from(t)
        .join(PromotionMember, PromotionMember.id == t.c.seller_member_id)
        .join(User, User.id == PromotionMember.user_id)
        .where(live)
        .group_by(PromotionMember.id, User.id, User.name)
        .order_by(gross.desc(), User.name, PromotionMember.id)
    )
    entries = []
    for row in (await session.execute(stmt)).all():
        gross_revenue, settled_amount = Decimal(row.gross_revenue), Decimal(row.settled_amount)
        percentage = (
            (settled_amount / gross_revenue * HUNDRED).quantize(CENT) if gross_revenue else ZERO
        )
        entries.append(
            LeaderboardEntry(
                member_id=row.member_id,
                user_id=row.user_id,
                name=row.name,
                order_count=row.order_count,
                units_sold=row.units_sold,
                gross_revenue=gross_revenue,
                settled_amount=settled_amount,
                settlement_percentage=percentage,
            )
        )
    return entries


async def list_audit_events(
    session: AsyncSession,
    promotion_id: uuid.UUID,
    params: PageParams,
    *,
    order_id: uuid.UUID | None,
    event_type: AuditEventType | None,
) -> tuple[list[OrderAuditEvent], int]:
    stmt = (
        select(OrderAuditEvent)
        .join(Order, Order.id == OrderAuditEvent.order_id)
        .where(Order.promotion_id == promotion_id)
    )
    if order_id is not None:
        stmt = stmt.where(OrderAuditEvent.order_id == order_id)
    if event_type is not None:
        stmt = stmt.where(OrderAuditEvent.event_type == event_type)
    stmt = stmt.order_by(OrderAuditEvent.seq)
    return await paginate(session, stmt, params)
