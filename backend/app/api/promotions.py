import uuid
from typing import Annotated

from fastapi import APIRouter, Query, Response, status

from app.api.deps import (
    CurrentUser,
    DbSession,
    Pagination,
    PromotionAdminContext,
    PromotionMemberContext,
)
from app.core.config import get_settings
from app.schemas.pagination import Page
from app.schemas.promotion import (
    MemberCreate,
    MemberResponse,
    MemberUpdate,
    PromotionCreate,
    PromotionResponse,
    PromotionUpdate,
)
from app.services import members as member_service
from app.services import promotions as promotion_service

router = APIRouter(prefix="/promotions", tags=["promotions"])


def _promotion_url(promotion_id: uuid.UUID) -> str:
    return f"{get_settings().API_V1_PREFIX}/promotions/{promotion_id}"


# --- promotions -----------------------------------------------------------------------------


@router.get("", response_model=Page[PromotionResponse])
async def list_promotions(
    user: CurrentUser, session: DbSession, params: Pagination
) -> Page[PromotionResponse]:
    items, total = await promotion_service.list_user_promotions(session, user, params)
    return Page(
        items=[PromotionResponse.model_validate(p) for p in items],
        total=total,
        page=params.page,
        size=params.size,
    )


@router.post("", response_model=PromotionResponse, status_code=status.HTTP_201_CREATED)
async def create_promotion(
    payload: PromotionCreate, user: CurrentUser, session: DbSession, response: Response
) -> PromotionResponse:
    promotion = await promotion_service.create_promotion(session, payload, user)
    response.headers["Location"] = _promotion_url(promotion.id)
    return PromotionResponse.model_validate(promotion)


@router.get("/{promotion_id}", response_model=PromotionResponse)
async def get_promotion(ctx: PromotionMemberContext) -> PromotionResponse:
    return PromotionResponse.model_validate(ctx.promotion)


@router.patch("/{promotion_id}", response_model=PromotionResponse)
async def update_promotion(
    payload: PromotionUpdate, ctx: PromotionAdminContext, session: DbSession
) -> PromotionResponse:
    promotion = await promotion_service.update_promotion(session, ctx.promotion, payload)
    return PromotionResponse.model_validate(promotion)


# --- members --------------------------------------------------------------------------------


@router.get("/{promotion_id}/members", response_model=Page[MemberResponse])
async def list_members(
    ctx: PromotionMemberContext,
    session: DbSession,
    params: Pagination,
    include_revoked: Annotated[bool, Query()] = False,
) -> Page[MemberResponse]:
    items, total = await member_service.list_members(
        session, ctx.promotion.id, params, include_revoked=include_revoked
    )
    return Page(
        items=[MemberResponse.model_validate(m) for m in items],
        total=total,
        page=params.page,
        size=params.size,
    )


@router.post(
    "/{promotion_id}/members", response_model=MemberResponse, status_code=status.HTTP_201_CREATED
)
async def add_member(
    payload: MemberCreate, ctx: PromotionAdminContext, session: DbSession, response: Response
) -> MemberResponse:
    member = await member_service.add_member(session, ctx.promotion.id, payload)
    response.headers["Location"] = f"{_promotion_url(ctx.promotion.id)}/members/{member.id}"
    return MemberResponse.model_validate(member)


@router.patch("/{promotion_id}/members/{member_id}", response_model=MemberResponse)
async def update_member(
    member_id: uuid.UUID, payload: MemberUpdate, ctx: PromotionAdminContext, session: DbSession
) -> MemberResponse:
    member = await member_service.update_member(session, ctx.promotion.id, member_id, payload)
    return MemberResponse.model_validate(member)
