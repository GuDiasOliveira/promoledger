import uuid
from datetime import date, datetime
from typing import Annotated, Self

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

from app.models.enums import Currency, PromotionStatus, Role
from app.schemas.common import NonBlankName, NormalizedEmail, reject_explicit_nulls

# --- promotions -----------------------------------------------------------------------------


class PromotionCreate(BaseModel):
    name: NonBlankName
    institution_id: uuid.UUID
    sales_start_date: date
    last_sales_date: date
    delivery_date: date
    currency: Currency


class PromotionUpdate(BaseModel):
    name: NonBlankName | None = None
    sales_start_date: date | None = None
    last_sales_date: date | None = None
    delivery_date: date | None = None
    status: PromotionStatus | None = None
    currency: Currency | None = None

    @model_validator(mode="after")
    def _no_nulls(self) -> Self:
        reject_explicit_nulls(self)
        return self


class PromotionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    status: PromotionStatus
    sales_start_date: date
    last_sales_date: date
    delivery_date: date
    currency: Currency
    created_at: datetime
    updated_at: datetime


# --- members --------------------------------------------------------------------------------


def _dedupe(roles: list[Role]) -> list[Role]:
    return list(dict.fromkeys(roles))


RoleList = Annotated[list[Role], Field(min_length=1), AfterValidator(_dedupe)]


class MemberCreate(BaseModel):
    email: NormalizedEmail
    roles: RoleList


class MemberUpdate(BaseModel):
    roles: RoleList | None = None
    revoked: bool | None = None

    @model_validator(mode="after")
    def _validate(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("Provide at least one of: roles, revoked")
        reject_explicit_nulls(self)
        return self


class MemberUserSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    email: str


class MemberResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    promotion_id: uuid.UUID
    user: MemberUserSummary
    roles: list[Role]
    revoked_at: datetime | None
    created_at: datetime
