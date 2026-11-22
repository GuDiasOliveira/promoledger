from enum import StrEnum


class PromotionStatus(StrEnum):
    DRAFT = "DRAFT"
    ACTIVE = "ACTIVE"
    CLOSED = "CLOSED"


class Role(StrEnum):
    SELLER = "seller"
    PROMOTION_ADMIN = "promotion_admin"
    PROMOTION_VIEWER = "promotion_viewer"


def sql_in_list(values: type[StrEnum]) -> str:
    """Render enum values as a SQL literal list, e.g. `'A', 'B'` (for CHECK constraints)."""
    return ", ".join(f"'{member.value}'" for member in values)
