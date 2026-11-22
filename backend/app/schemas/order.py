import uuid
from datetime import datetime
from typing import Annotated, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.enums import AuditEventType, StatusClassification
from app.schemas.money import MoneyOut

MAX_ORDER_LINES = 50
MAX_LINE_QUANTITY = 1000


class OrderItemCreate(BaseModel):
    product_id: uuid.UUID
    quantity: Annotated[int, Field(ge=1, le=MAX_LINE_QUANTITY, strict=True)]


class OrderCreate(BaseModel):
    customer_id: uuid.UUID
    items: Annotated[list[OrderItemCreate], Field(min_length=1, max_length=MAX_ORDER_LINES)]
    mark_paid_now: bool = False

    @model_validator(mode="after")
    def _unique_products(self) -> Self:
        product_ids = [item.product_id for item in self.items]
        if len(product_ids) != len(set(product_ids)):
            raise ValueError("Each product may appear only once; consolidate quantities")
        return self


class OrderCustomerSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    contact: str | None


class OrderItemResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    product_id: uuid.UUID
    quantity: int
    unit_price: MoneyOut
    line_total: MoneyOut


class AuditEventResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    order_id: uuid.UUID
    event_type: AuditEventType
    actor_member_id: uuid.UUID
    reason: str | None
    created_at: datetime


class OrderResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    promotion_id: uuid.UUID
    seller_member_id: uuid.UUID
    customer: OrderCustomerSummary
    items: list[OrderItemResponse]
    total_amount: MoneyOut
    status_classification: StatusClassification
    version: int
    paid_at: datetime | None
    delivered_at: datetime | None
    cancelled_at: datetime | None
    created_at: datetime
    updated_at: datetime


class OrderDetailResponse(OrderResponse):
    audit_events: list[AuditEventResponse]
