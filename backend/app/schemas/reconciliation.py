import uuid

from pydantic import BaseModel

from app.models.enums import StatusClassification
from app.schemas.money import MoneyOut

# Percentages share the exact-decimal-string serialization of money ("75.00").
PercentOut = MoneyOut


class ClassificationBucket(BaseModel):
    count: int
    amount: MoneyOut


class ReconciliationSummary(BaseModel):
    total_revenue: MoneyOut
    collected_amount: MoneyOut
    outstanding_amount: MoneyOut
    units_ordered: int
    units_delivered: int
    by_classification: dict[StatusClassification, ClassificationBucket]


class LeaderboardEntry(BaseModel):
    member_id: uuid.UUID
    user_id: uuid.UUID
    name: str
    order_count: int
    units_sold: int
    gross_revenue: MoneyOut
    settled_amount: MoneyOut
    settlement_percentage: PercentOut
