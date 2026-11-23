import uuid

from sqlalchemy import Row, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.models import Institution, Promotion, PromotionInstitution, PromotionMember
from app.schemas.institution import InstitutionCreate
from app.schemas.pagination import PageParams
from app.services.pagination import paginate
from app.services.search import contains_pattern


def institution_not_found() -> AppError:
    return AppError(404, "INSTITUTION_NOT_FOUND", "Institution not found.")


async def create_institution(session: AsyncSession, data: InstitutionCreate) -> Institution:
    institution = Institution(name=data.name)
    session.add(institution)
    await session.commit()
    return institution


async def list_institutions(
    session: AsyncSession, params: PageParams, *, q: str | None = None
) -> tuple[list[Institution], int]:
    stmt = select(Institution)
    if q:
        stmt = stmt.where(Institution.name.ilike(contains_pattern(q), escape="\\"))
        stmt = stmt.order_by(Institution.name, Institution.id)
    else:
        stmt = stmt.order_by(Institution.created_at.desc(), Institution.id)
    return await paginate(session, stmt, params)


async def get_institution(session: AsyncSession, institution_id: uuid.UUID) -> Institution:
    institution = await session.get(Institution, institution_id)
    if institution is None:
        raise institution_not_found()
    return institution


async def list_visible_promotions(
    session: AsyncSession, institution_id: uuid.UUID, user_id: uuid.UUID
) -> list[Row[tuple[Promotion, bool]]]:
    """Promotions linked to the institution where `user_id` is an active member."""
    stmt = (
        select(Promotion, PromotionInstitution.is_lead)
        .join(PromotionInstitution, PromotionInstitution.promotion_id == Promotion.id)
        .join(
            PromotionMember,
            (PromotionMember.promotion_id == Promotion.id)
            & (PromotionMember.user_id == user_id)
            & PromotionMember.revoked_at.is_(None),
        )
        .where(PromotionInstitution.institution_id == institution_id)
        .order_by(Promotion.created_at.desc(), Promotion.id)
    )
    return list((await session.execute(stmt)).all())
