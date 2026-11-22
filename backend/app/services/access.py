from dataclasses import dataclass

from app.models import Promotion, PromotionMember
from app.models.enums import Role


@dataclass(frozen=True)
class PromotionContext:
    """The promotion addressed by the request plus the caller's active membership in it."""

    promotion: Promotion
    member: PromotionMember

    def has_any_role(self, *roles: Role) -> bool:
        return not roles or any(role in self.member.roles for role in roles)
