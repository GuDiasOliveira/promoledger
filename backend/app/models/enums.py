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


class StatusClassification(StrEnum):
    """Derived order state (ERM §3 reconciliation matrix)."""

    UNPAID_PENDING = "UNPAID_PENDING"
    PAID_PENDING = "PAID_PENDING"
    DIVERGENCE = "DIVERGENCE"
    SETTLED = "SETTLED"
    CANCELLED = "CANCELLED"


def sql_in_list(values: type[StrEnum]) -> str:
    """Render enum values as a SQL literal list, e.g. `'A', 'B'` (for CHECK constraints)."""
    return ", ".join(f"'{member.value}'" for member in values)
