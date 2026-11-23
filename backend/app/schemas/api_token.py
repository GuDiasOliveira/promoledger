import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

TokenName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]


class ApiTokenCreate(BaseModel):
    name: TokenName
    expires_in_days: Annotated[int, Field(ge=1, le=365, strict=True)] = 90


class ApiTokenResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    prefix: str
    scope: Literal["read"]
    created_at: datetime
    expires_at: datetime
    last_used_at: datetime | None
    revoked_at: datetime | None


class ApiTokenCreated(ApiTokenResponse):
    """Returned ONCE, at creation: the plain token is never stored nor shown again."""

    token: str
