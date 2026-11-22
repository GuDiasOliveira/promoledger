import uuid
from datetime import date, datetime
from typing import Annotated, Self

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

from app.models.enums import PromotionStatus, Role
from app.schemas.common import NonBlankName, NormalizedEmail


def _reject_explicit_nulls(model: BaseModel) -> None:
    """PATCH semantics: omitted = unchanged; explicit `null` is not a valid value."""
    nulls = [name for name in model.model_fields_set if getattr(model, name) is None]
    if nulls:
        raise ValueError(f"Fields cannot be null: {', '.join(sorted(nulls))}")


# --- promotions -----------------------------------------------------------------------------


class PromotionCreate(BaseModel):
    name: NonBlankName
    institution_id: uuid.UUID
    sales_start_date: date
    last_sales_date: date
    delivery_date: date


class PromotionUpdate(BaseModel):
    name: NonBlankName | None = None
    sales_start_date: date | None = None
    last_sales_date: date | None = None
    delivery_date: date | None = None
    status: PromotionStatus | None = None

    @model_validator(mode="after")
    def _no_nulls(self) -> Self:
        _reject_explicit_nulls(self)
        return self


class PromotionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    status: PromotionStatus
    sales_start_date: date
    last_sales_date: date
    delivery_date: date
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
        _reject_explicit_nulls(self)
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
