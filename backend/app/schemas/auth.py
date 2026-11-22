import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, EmailStr, Field, StringConstraints

NonBlankName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)
]
NormalizedEmail = Annotated[EmailStr, Field(max_length=255), AfterValidator(str.lower)]
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
    """Populated from PROMOTION_MEMBER starting in Slice 1.3."""

    member_id: uuid.UUID
    promotion_id: uuid.UUID
    roles: list[str]


class MeResponse(UserResponse):
    memberships: list[PromotionMembershipSummary] = []
