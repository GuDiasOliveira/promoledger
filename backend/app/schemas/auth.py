import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import PromotionStatus, Role
from app.schemas.common import NonBlankName, NormalizedEmail

Password = Annotated[str, Field(min_length=8, max_length=128)]


class UserCreate(BaseModel):
    name: NonBlankName
    email: NormalizedEmail
    password: Password


class TokenRequest(BaseModel):
    email: NormalizedEmail
    password: Annotated[str, Field(min_length=1, max_length=128)]


class TokenResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    email: str
    created_at: datetime
    updated_at: datetime


class PromotionMembershipSummary(BaseModel):
    """One active PROMOTION_MEMBER row of the current user."""

    member_id: uuid.UUID
    promotion_id: uuid.UUID
    promotion_name: str
    promotion_status: PromotionStatus
    roles: list[Role]


class MeResponse(UserResponse):
    memberships: list[PromotionMembershipSummary] = []
