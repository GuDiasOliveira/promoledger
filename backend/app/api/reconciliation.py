import uuid
from typing import Annotated

from fastapi import APIRouter, Query

from app.api.deps import DbSession, Pagination, PromotionAdminContext, PromotionViewerContext
from app.models.enums import AuditEventType, StatusClassification
from app.schemas.order import AuditEventResponse, OrderResponse
from app.schemas.pagination import Page
from app.schemas.reconciliation import LeaderboardEntry, ReconciliationSummary
from app.services import orders as order_service
from app.services import reconciliation as reconciliation_service

router = APIRouter(prefix="/promotions/{promotion_id}/reconciliation", tags=["reconciliation"])


@router.get("/summary", response_model=ReconciliationSummary)
async def summary(ctx: PromotionViewerContext, session: DbSession) -> ReconciliationSummary:
    return await reconciliation_service.get_summary(session, ctx.promotion.id)


@router.get("/divergences", response_model=Page[OrderResponse])
async def divergences(
    ctx: PromotionViewerContext, session: DbSession, params: Pagination
) -> Page[OrderResponse]:
    filters = order_service.OrderFilters(status_classification=StatusClassification.DIVERGENCE)
    items, total = await order_service.list_orders(session, ctx, filters, params)
    return Page(
        items=[OrderResponse.model_validate(o) for o in items],
        total=total,
        page=params.page,
        size=params.size,
    )


@router.get("/leaderboard", response_model=list[LeaderboardEntry])
async def leaderboard(ctx: PromotionViewerContext, session: DbSession) -> list[LeaderboardEntry]:
    return await reconciliation_service.get_leaderboard(session, ctx.promotion.id)


@router.get("/audit-events", response_model=Page[AuditEventResponse])
async def audit_events(
    ctx: PromotionAdminContext,
    session: DbSession,
    params: Pagination,
    order_id: Annotated[uuid.UUID | None, Query()] = None,
    event_type: Annotated[AuditEventType | None, Query()] = None,
) -> Page[AuditEventResponse]:
    items, total = await reconciliation_service.list_audit_events(
        session, ctx.promotion.id, params, order_id=order_id, event_type=event_type
    )
    return Page(
        items=[AuditEventResponse.model_validate(e) for e in items],
        total=total,
        page=params.page,
        size=params.size,
    )
