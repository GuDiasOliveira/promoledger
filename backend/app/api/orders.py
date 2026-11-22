import uuid
from typing import Annotated

from fastapi import APIRouter, Query, Response, status

from app.api.deps import (
    DbSession,
    IdempotencyKey,
    Pagination,
    PromotionMemberContext,
    PromotionOperatorContext,
    PromotionSellerContext,
)
from app.core.config import get_settings
from app.models.enums import StatusClassification
from app.schemas.order import OrderCreate, OrderDetailResponse, OrderResponse
from app.schemas.pagination import Page
from app.schemas.transition import CancelTransition, DeliveryTransition, PaymentTransition
from app.services import orders as order_service
from app.services import transitions as transition_service
from app.services.access import PromotionContext

router = APIRouter(prefix="/promotions/{promotion_id}/orders", tags=["orders"])


@router.post("", response_model=OrderDetailResponse, status_code=status.HTTP_201_CREATED)
async def create_order(
    payload: OrderCreate,
    ctx: PromotionSellerContext,
    session: DbSession,
    idempotency_key: IdempotencyKey,
    response: Response,
) -> OrderDetailResponse:
    promotion_id = ctx.promotion.id
    order, created = await order_service.create_order(session, ctx, payload, idempotency_key)
    if not created:
        response.status_code = status.HTTP_200_OK
        response.headers["Idempotent-Replayed"] = "true"
    response.headers["Location"] = (
        f"{get_settings().API_V1_PREFIX}/promotions/{promotion_id}/orders/{order.id}"
    )
    return OrderDetailResponse.model_validate(order)


@router.get("", response_model=Page[OrderResponse])
async def list_orders(
    ctx: PromotionMemberContext,
    session: DbSession,
    params: Pagination,
    status_classification: Annotated[StatusClassification | None, Query()] = None,
    seller_member_id: Annotated[uuid.UUID | None, Query()] = None,
    customer_id: Annotated[uuid.UUID | None, Query()] = None,
) -> Page[OrderResponse]:
    filters = order_service.OrderFilters(
        status_classification=status_classification,
        seller_member_id=seller_member_id,
        customer_id=customer_id,
    )
    items, total = await order_service.list_orders(session, ctx, filters, params)
    return Page(
        items=[OrderResponse.model_validate(o) for o in items],
        total=total,
        page=params.page,
        size=params.size,
    )


@router.get("/{order_id}", response_model=OrderDetailResponse)
async def get_order(
    order_id: uuid.UUID, ctx: PromotionMemberContext, session: DbSession
) -> OrderDetailResponse:
    order = await order_service.get_visible_order(session, ctx, order_id)
    return OrderDetailResponse.model_validate(order)


# --- lifecycle transitions (docs/api.md §8) -------------------------------------------------


async def _transition(
    ctx: PromotionContext,
    session: DbSession,
    response: Response,
    order_id: uuid.UUID,
    transition: transition_service.Transition,
    expected_version: int,
    reason: str | None,
    idempotency_key: uuid.UUID,
) -> OrderDetailResponse:
    order, applied = await transition_service.apply_transition(
        session,
        ctx,
        order_id,
        transition,
        expected_version=expected_version,
        reason=reason,
        idempotency_key=idempotency_key,
    )
    if not applied:
        response.headers["Idempotent-Replayed"] = "true"
    return OrderDetailResponse.model_validate(order)


@router.post("/{order_id}/payment", response_model=OrderDetailResponse)
async def payment_transition(
    order_id: uuid.UUID,
    payload: PaymentTransition,
    ctx: PromotionOperatorContext,
    session: DbSession,
    idempotency_key: IdempotencyKey,
    response: Response,
) -> OrderDetailResponse:
    return await _transition(
        ctx,
        session,
        response,
        order_id,
        transition_service.ACTION_TRANSITIONS[payload.action],
        payload.expected_version,
        payload.reason,
        idempotency_key,
    )


@router.post("/{order_id}/delivery", response_model=OrderDetailResponse)
async def delivery_transition(
    order_id: uuid.UUID,
    payload: DeliveryTransition,
    ctx: PromotionOperatorContext,
    session: DbSession,
    idempotency_key: IdempotencyKey,
    response: Response,
) -> OrderDetailResponse:
    return await _transition(
        ctx,
        session,
        response,
        order_id,
        transition_service.ACTION_TRANSITIONS[payload.action],
        payload.expected_version,
        payload.reason,
        idempotency_key,
    )


@router.post("/{order_id}/cancel", response_model=OrderDetailResponse)
async def cancel_order(
    order_id: uuid.UUID,
    payload: CancelTransition,
    ctx: PromotionOperatorContext,
    session: DbSession,
    idempotency_key: IdempotencyKey,
    response: Response,
) -> OrderDetailResponse:
    return await _transition(
        ctx,
        session,
        response,
        order_id,
        transition_service.CANCEL_TRANSITION,
        payload.expected_version,
        payload.reason,
        idempotency_key,
    )
