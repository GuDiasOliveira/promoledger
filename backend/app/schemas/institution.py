import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.models.enums import PromotionStatus
from app.schemas.common import NonBlankName


class InstitutionCreate(BaseModel):
    name: NonBlankName


class InstitutionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    created_at: datetime
    updated_at: datetime


class InstitutionPromotionSummary(BaseModel):
    id: uuid.UUID
    name: str
    status: PromotionStatus
    is_lead: bool


class InstitutionDetailResponse(InstitutionResponse):
    # Only promotions the caller is an active member of (no cross-tenant disclosure).
    promotions: list[InstitutionPromotionSummary] = []
