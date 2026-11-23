import uuid
from typing import Annotated

from fastapi import APIRouter, Query, Response, status

from app.api.deps import CurrentUser, DbSession, Pagination
from app.core.config import get_settings
from app.schemas.institution import (
    InstitutionCreate,
    InstitutionDetailResponse,
    InstitutionPromotionSummary,
    InstitutionResponse,
)
from app.schemas.pagination import Page
from app.services import institutions as institution_service

router = APIRouter(prefix="/institutions", tags=["institutions"])


@router.get("", response_model=Page[InstitutionResponse])
async def list_institutions(
    _: CurrentUser,
    session: DbSession,
    params: Pagination,
    q: Annotated[str | None, Query(max_length=255)] = None,
) -> Page[InstitutionResponse]:
    items, total = await institution_service.list_institutions(
        session, params, q=q.strip() if q else None
    )
    return Page(
        items=[InstitutionResponse.model_validate(i) for i in items],
        total=total,
        page=params.page,
        size=params.size,
    )


@router.post("", response_model=InstitutionResponse, status_code=status.HTTP_201_CREATED)
async def create_institution(
    payload: InstitutionCreate, _: CurrentUser, session: DbSession, response: Response
) -> InstitutionResponse:
    institution = await institution_service.create_institution(session, payload)
    response.headers["Location"] = f"{get_settings().API_V1_PREFIX}/institutions/{institution.id}"
    return InstitutionResponse.model_validate(institution)


@router.get("/{institution_id}", response_model=InstitutionDetailResponse)
async def get_institution(
    institution_id: uuid.UUID, user: CurrentUser, session: DbSession
) -> InstitutionDetailResponse:
    institution = await institution_service.get_institution(session, institution_id)
    rows = await institution_service.list_visible_promotions(session, institution_id, user.id)
    return InstitutionDetailResponse(
        **InstitutionResponse.model_validate(institution).model_dump(),
        promotions=[
            InstitutionPromotionSummary(
                id=promotion.id, name=promotion.name, status=promotion.status, is_lead=is_lead
            )
            for promotion, is_lead in rows
        ],
    )
