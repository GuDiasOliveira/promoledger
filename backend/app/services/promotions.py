from datetime import date

from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.models import (
    Institution,
    Order,
    Promotion,
    PromotionInstitution,
    PromotionMember,
    User,
)
from app.models.enums import PromotionStatus, Role
from app.schemas.pagination import PageParams
from app.schemas.promotion import PromotionCreate, PromotionUpdate
from app.services.institutions import institution_not_found
from app.services.pagination import paginate

ALLOWED_STATUS_TRANSITIONS: dict[PromotionStatus, frozenset[PromotionStatus]] = {
    PromotionStatus.DRAFT: frozenset({PromotionStatus.ACTIVE}),
    PromotionStatus.ACTIVE: frozenset({PromotionStatus.CLOSED}),
    PromotionStatus.CLOSED: frozenset({PromotionStatus.ACTIVE}),
}


def _validate_dates(sales_start: date, last_sales: date, delivery: date) -> None:
    if not (sales_start <= last_sales <= delivery):
        raise AppError(
            400,
            "INVALID_DATE_RANGE",
            "Dates must satisfy sales_start_date <= last_sales_date <= delivery_date.",
        )


def _validate_status_transition(current: PromotionStatus, target: PromotionStatus) -> None:
    if target != current and target not in ALLOWED_STATUS_TRANSITIONS[current]:
        raise AppError(
            400,
            "INVALID_STATUS_TRANSITION",
            f"Cannot change promotion status from {current} to {target}.",
        )


async def _ensure_currency_unlocked(session: AsyncSession, promotion: Promotion) -> None:
    """All amounts are denominated in the promotion currency: freeze it once orders exist."""
    has_orders = await session.scalar(select(exists().where(Order.promotion_id == promotion.id)))
    if has_orders:
        raise AppError(
            400, "CURRENCY_LOCKED", "Currency cannot change after the promotion has orders."
        )


async def create_promotion(
    session: AsyncSession, data: PromotionCreate, creator: User
) -> Promotion:
    """Atomically create the promotion, its lead institution link, and the creator's admin role."""
    if await session.get(Institution, data.institution_id) is None:
        raise institution_not_found()
    _validate_dates(data.sales_start_date, data.last_sales_date, data.delivery_date)

    promotion = Promotion(
        name=data.name,
        status=PromotionStatus.DRAFT,
        sales_start_date=data.sales_start_date,
        last_sales_date=data.last_sales_date,
        delivery_date=data.delivery_date,
        currency=data.currency,
    )
    session.add(promotion)
    await session.flush()  # assigns promotion.id via RETURNING

    session.add_all(
        [
            PromotionInstitution(
                promotion_id=promotion.id, institution_id=data.institution_id, is_lead=True
            ),
            PromotionMember(
                promotion_id=promotion.id, user_id=creator.id, roles=[Role.PROMOTION_ADMIN]
            ),
        ]
    )
    await session.commit()
    return promotion


async def list_user_promotions(
    session: AsyncSession, user: User, params: PageParams
) -> tuple[list[Promotion], int]:
    stmt = (
        select(Promotion)
        .join(PromotionMember, PromotionMember.promotion_id == Promotion.id)
        .where(PromotionMember.user_id == user.id, PromotionMember.revoked_at.is_(None))
        .order_by(Promotion.created_at.desc(), Promotion.id)
    )
    return await paginate(session, stmt, params)


async def update_promotion(
    session: AsyncSession, promotion: Promotion, data: PromotionUpdate
) -> Promotion:
    changes = data.model_dump(exclude_unset=True)

    _validate_dates(
        changes.get("sales_start_date", promotion.sales_start_date),
        changes.get("last_sales_date", promotion.last_sales_date),
        changes.get("delivery_date", promotion.delivery_date),
    )
    if "status" in changes:
        _validate_status_transition(PromotionStatus(promotion.status), changes["status"])
    if changes.get("currency", promotion.currency) != promotion.currency:
        await _ensure_currency_unlocked(session, promotion)

    for field, value in changes.items():
        setattr(promotion, field, value)
    await session.commit()
    return promotion
