import uuid
from typing import Annotated

from fastapi import APIRouter, Query, Response, status

from app.api.deps import (
    DbSession,
    Pagination,
    PromotionAdminContext,
    PromotionMemberContext,
    PromotionSellerContext,
)
from app.core.config import get_settings
from app.core.errors import AppError
from app.models.enums import Role
from app.schemas.catalog import (
    CustomerCreate,
    CustomerResponse,
    ProductCreate,
    ProductResponse,
    ProductUpdate,
)
from app.schemas.pagination import Page
from app.services import catalog as catalog_service

router = APIRouter(prefix="/promotions/{promotion_id}", tags=["catalog"])


def _base_url(promotion_id: uuid.UUID) -> str:
    return f"{get_settings().API_V1_PREFIX}/promotions/{promotion_id}"


# --- products -------------------------------------------------------------------------------


@router.get("/products", response_model=Page[ProductResponse])
async def list_products(
    ctx: PromotionMemberContext,
    session: DbSession,
    params: Pagination,
    include_inactive: Annotated[bool, Query()] = False,
) -> Page[ProductResponse]:
    if include_inactive and not ctx.has_any_role(Role.PROMOTION_ADMIN):
        raise AppError(403, "INSUFFICIENT_ROLE", "Only promotion_admin can list inactive products.")
    items, total = await catalog_service.list_products(
        session, ctx.promotion.id, params, include_inactive=include_inactive
    )
    return Page(
        items=[ProductResponse.model_validate(p) for p in items],
        total=total,
        page=params.page,
        size=params.size,
    )


@router.post("/products", response_model=ProductResponse, status_code=status.HTTP_201_CREATED)
async def create_product(
    payload: ProductCreate, ctx: PromotionAdminContext, session: DbSession, response: Response
) -> ProductResponse:
    product = await catalog_service.create_product(session, ctx.promotion.id, payload)
    response.headers["Location"] = f"{_base_url(ctx.promotion.id)}/products/{product.id}"
    return ProductResponse.model_validate(product)


@router.patch("/products/{product_id}", response_model=ProductResponse)
async def update_product(
    product_id: uuid.UUID, payload: ProductUpdate, ctx: PromotionAdminContext, session: DbSession
) -> ProductResponse:
    product = await catalog_service.get_product(session, ctx.promotion.id, product_id)
    product = await catalog_service.update_product(session, product, payload)
    return ProductResponse.model_validate(product)


# --- customers ------------------------------------------------------------------------------


@router.get("/customers", response_model=Page[CustomerResponse])
async def list_customers(
    ctx: PromotionMemberContext,
    session: DbSession,
    params: Pagination,
    q: Annotated[str | None, Query(max_length=255)] = None,
) -> Page[CustomerResponse]:
    items, total = await catalog_service.list_customers(
        session, ctx.promotion.id, params, q=q.strip() if q else None
    )
    return Page(
        items=[CustomerResponse.model_validate(c) for c in items],
        total=total,
        page=params.page,
        size=params.size,
    )


@router.post("/customers", response_model=CustomerResponse, status_code=status.HTTP_201_CREATED)
async def create_customer(
    payload: CustomerCreate, ctx: PromotionSellerContext, session: DbSession, response: Response
) -> CustomerResponse:
    promotion_id = ctx.promotion.id
    customer, created = await catalog_service.create_customer(session, promotion_id, payload)
    if not created:
        response.status_code = status.HTTP_200_OK
    response.headers["Location"] = f"{_base_url(promotion_id)}/customers/{customer.id}"
    return CustomerResponse.model_validate(customer)
