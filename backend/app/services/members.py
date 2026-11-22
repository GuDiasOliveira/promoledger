import uuid
from datetime import UTC, datetime

from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.errors import AppError
from app.models import Promotion, PromotionMember, User
from app.models.enums import Role
from app.schemas.auth import PromotionMembershipSummary
from app.schemas.pagination import PageParams
from app.schemas.promotion import MemberCreate, MemberUpdate
from app.services.auth import get_user_by_email
from app.services.pagination import paginate


def _members_query(promotion_id: uuid.UUID) -> Select[tuple[PromotionMember]]:
    return (
        select(PromotionMember)
        .options(selectinload(PromotionMember.user))
        .where(PromotionMember.promotion_id == promotion_id)
    )


async def list_members(
    session: AsyncSession, promotion_id: uuid.UUID, params: PageParams, *, include_revoked: bool
) -> tuple[list[PromotionMember], int]:
    stmt = _members_query(promotion_id)
    if not include_revoked:
        stmt = stmt.where(PromotionMember.revoked_at.is_(None))
    stmt = stmt.order_by(PromotionMember.created_at.desc(), PromotionMember.id)
    return await paginate(session, stmt, params)


async def add_member(
    session: AsyncSession, promotion_id: uuid.UUID, data: MemberCreate
) -> PromotionMember:
    """Add a user by email. A previously revoked membership is reactivated with the new roles."""
    user = await get_user_by_email(session, data.email)
    if user is None:
        raise AppError(404, "USER_NOT_FOUND", "No account exists with this email.")

    stmt = _members_query(promotion_id).where(PromotionMember.user_id == user.id)
    member = (await session.execute(stmt)).scalar_one_or_none()

    if member is None:
        member = PromotionMember(promotion_id=promotion_id, user_id=user.id, roles=list(data.roles))
        member.user = user
        session.add(member)
    elif member.is_active:
        raise AppError(409, "ALREADY_MEMBER", "User is already an active member of this promotion.")
    else:
        member.roles = list(data.roles)
        member.revoked_at = None

    await session.commit()
    return member


def _is_active_admin(roles: list[str], revoked_at: datetime | None) -> bool:
    return revoked_at is None and Role.PROMOTION_ADMIN in roles


async def _ensure_other_active_admin(
    session: AsyncSession, promotion_id: uuid.UUID, member_id: uuid.UUID
) -> None:
    # FOR UPDATE serializes concurrent demotions so two admins can't remove each other.
    stmt = (
        select(PromotionMember.id)
        .where(
            PromotionMember.promotion_id == promotion_id,
            PromotionMember.revoked_at.is_(None),
            PromotionMember.roles.contains([Role.PROMOTION_ADMIN.value]),
        )
        .with_for_update()
    )
    admin_ids = set((await session.execute(stmt)).scalars().all())
    if not admin_ids - {member_id}:
        raise AppError(
            409, "LAST_ADMIN", "A promotion must keep at least one active promotion_admin."
        )


async def update_member(
    session: AsyncSession, promotion_id: uuid.UUID, member_id: uuid.UUID, data: MemberUpdate
) -> PromotionMember:
    stmt = _members_query(promotion_id).where(PromotionMember.id == member_id)
    member = (await session.execute(stmt)).scalar_one_or_none()
    if member is None:
        raise AppError(404, "MEMBER_NOT_FOUND", "Member not found in this promotion.")

    new_roles = list(data.roles) if data.roles is not None else list(member.roles)
    new_revoked_at = member.revoked_at
    if data.revoked is True and member.revoked_at is None:
        new_revoked_at = datetime.now(UTC)
    elif data.revoked is False:
        new_revoked_at = None

    if _is_active_admin(member.roles, member.revoked_at) and not _is_active_admin(
        new_roles, new_revoked_at
    ):
        await _ensure_other_active_admin(session, promotion_id, member.id)

    member.roles = new_roles
    member.revoked_at = new_revoked_at
    await session.commit()
    return member


async def list_user_memberships(
    session: AsyncSession, user: User
) -> list[PromotionMembershipSummary]:
    stmt = (
        select(PromotionMember, Promotion.name, Promotion.status)
        .join(Promotion, Promotion.id == PromotionMember.promotion_id)
        .where(PromotionMember.user_id == user.id, PromotionMember.revoked_at.is_(None))
        .order_by(Promotion.created_at.desc(), Promotion.id)
    )
    return [
        PromotionMembershipSummary(
            member_id=member.id,
            promotion_id=member.promotion_id,
            promotion_name=name,
            promotion_status=status,
            roles=member.roles,
        )
        for member, name, status in (await session.execute(stmt)).all()
    ]
