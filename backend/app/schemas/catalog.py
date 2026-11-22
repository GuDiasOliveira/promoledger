import uuid
from datetime import datetime
from typing import Self

from pydantic import UUID4, BaseModel, ConfigDict, model_validator

from app.schemas.common import NonBlankName, OptionalShortText, OptionalText, reject_explicit_nulls
from app.schemas.money import MoneyOut, PositiveMoneyIn

# --- products -------------------------------------------------------------------------------


class ProductCreate(BaseModel):
    name: NonBlankName
    description: OptionalText = None
    price: PositiveMoneyIn


class ProductUpdate(BaseModel):
    name: NonBlankName | None = None
    description: OptionalText = None  # explicit null clears it
    price: PositiveMoneyIn | None = None
    is_active: bool | None = None

    @model_validator(mode="after")
    def _no_nulls(self) -> Self:
        reject_explicit_nulls(self, nullable=frozenset({"description"}))
        return self


class ProductResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    promotion_id: uuid.UUID
    name: str
    description: str | None
    price: MoneyOut
    is_active: bool
    created_at: datetime
    updated_at: datetime


# --- customers ------------------------------------------------------------------------------


class CustomerCreate(BaseModel):
    # Optional client-generated id so offline-captured orders can reference the customer.
    id: UUID4 | None = None
    name: NonBlankName
    contact: OptionalShortText = None


class CustomerResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    promotion_id: uuid.UUID
    name: str
    contact: str | None
    created_at: datetime
