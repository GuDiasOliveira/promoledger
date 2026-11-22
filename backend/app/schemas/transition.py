from enum import StrEnum
from typing import Annotated, Self

from pydantic import BaseModel, Field, StringConstraints, model_validator

Reason = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]
ExpectedVersion = Annotated[int, Field(ge=1, strict=True)]


class PaymentAction(StrEnum):
    MARK_PAID = "MARK_PAID"
    REVOKE_PAYMENT = "REVOKE_PAYMENT"


class DeliveryAction(StrEnum):
    MARK_DELIVERED = "MARK_DELIVERED"
    REVOKE_DELIVERY = "REVOKE_DELIVERY"


def _require_reason(is_revoke: bool, reason: str | None) -> None:
    if is_revoke and reason is None:
        raise ValueError("reason is required when revoking")


class PaymentTransition(BaseModel):
    action: PaymentAction
    expected_version: ExpectedVersion
    reason: Reason | None = None

    @model_validator(mode="after")
    def _reason_on_revoke(self) -> Self:
        _require_reason(self.action is PaymentAction.REVOKE_PAYMENT, self.reason)
        return self


class DeliveryTransition(BaseModel):
    action: DeliveryAction
    expected_version: ExpectedVersion
    reason: Reason | None = None

    @model_validator(mode="after")
    def _reason_on_revoke(self) -> Self:
        _require_reason(self.action is DeliveryAction.REVOKE_DELIVERY, self.reason)
        return self


class CancelTransition(BaseModel):
    expected_version: ExpectedVersion
    reason: Reason
