"""SQLAlchemy models registry.

Import every model module here so `Base.metadata` is fully populated for Alembic autogenerate.
"""

from app.core.database import Base
from app.models.institution import Institution
from app.models.promotion import Promotion, PromotionInstitution, PromotionMember
from app.models.user import User

__all__ = ["Base", "Institution", "Promotion", "PromotionInstitution", "PromotionMember", "User"]
