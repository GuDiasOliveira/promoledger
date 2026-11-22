from collections.abc import Iterable
from enum import StrEnum


class PromotionStatus(StrEnum):
    DRAFT = "DRAFT"
    ACTIVE = "ACTIVE"
    CLOSED = "CLOSED"


class Currency(StrEnum):
    """MVP allowlist: ISO 4217 codes with exactly 2 minor units (fits NUMERIC(10, 2)).

    Covers Brazil, the US and Europe. Other currencies (incl. 0/3-decimal ones such as
    JPY/KWD) are in the post-MVP backlog (docs/prd.md).
    """

    BRL = "BRL"
    USD = "USD"
    EUR = "EUR"
    GBP = "GBP"
    CHF = "CHF"
    SEK = "SEK"
    NOK = "NOK"
    DKK = "DKK"
    PLN = "PLN"
    CZK = "CZK"


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
