"""SQLAlchemy models registry.

Import every model module here so `Base.metadata` is fully populated for Alembic autogenerate.
"""

from app.core.database import Base
from app.models.api_token import ApiToken
from app.models.catalog import Customer, Product
from app.models.institution import Institution
from app.models.order import Order, OrderAuditEvent, OrderItem
from app.models.promotion import Promotion, PromotionInstitution, PromotionMember
from app.models.user import User

__all__ = [
    "ApiToken",
    "Base",
    "Customer",
    "Institution",
    "Order",
    "OrderAuditEvent",
    "OrderItem",
    "Product",
    "Promotion",
    "PromotionInstitution",
    "PromotionMember",
    "User",
]
