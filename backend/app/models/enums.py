from collections.abc import Iterable
from enum import StrEnum


class PromotionStatus(StrEnum):
    DRAFT = "DRAFT"
    ACTIVE = "ACTIVE"
    CLOSED = "CLOSED"


class Role(StrEnum):
    SELLER = "seller"
    PROMOTION_ADMIN = "promotion_admin"
    PROMOTION_VIEWER = "promotion_viewer"


class AuditEventType(StrEnum):
    PAYMENT_MARKED = "PAYMENT_MARKED"
    PAYMENT_REVOKED = "PAYMENT_REVOKED"
    DELIVERY_MARKED = "DELIVERY_MARKED"
    DELIVERY_REVOKED = "DELIVERY_REVOKED"
    ORDER_CANCELLED = "ORDER_CANCELLED"


# Events that must carry a non-blank `reason` (enforced in schema validation and a DB CHECK).
REASON_REQUIRED_EVENTS = (
    AuditEventType.PAYMENT_REVOKED,
    AuditEventType.DELIVERY_REVOKED,
    AuditEventType.ORDER_CANCELLED,
)


class StatusClassification(StrEnum):
    """Derived order state (ERM §3 reconciliation matrix)."""

    UNPAID_PENDING = "UNPAID_PENDING"
    PAID_PENDING = "PAID_PENDING"
    DIVERGENCE = "DIVERGENCE"
    SETTLED = "SETTLED"
    CANCELLED = "CANCELLED"


def sql_in_list(values: Iterable[StrEnum]) -> str:
    """Render enum values as a SQL literal list, e.g. `'A', 'B'` (for CHECK constraints)."""
    return ", ".join(f"'{member.value}'" for member in values)
