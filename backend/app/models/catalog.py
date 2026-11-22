import uuid
from decimal import Decimal

from sqlalchemy import CheckConstraint, ForeignKey, Index, Numeric, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.mixins import CreatedAtMixin, TimestampMixin, UUIDPrimaryKeyMixin

# Money: always NUMERIC(10, 2) <-> Decimal. Never Float.
MONEY = Numeric(10, 2, asdecimal=True)


class Product(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """ERM §2.6 `PRODUCT`. Archived via `is_active = false` (never deleted)."""

    __tablename__ = "product"
    __table_args__ = (
        CheckConstraint("char_length(trim(name)) > 0", name="name_not_blank"),
        CheckConstraint("price > 0.00", name="price_positive"),
    )

    promotion_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("promotion.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text)
    price: Mapped[Decimal] = mapped_column(MONEY)
    is_active: Mapped[bool] = mapped_column(server_default=text("true"))


class Customer(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """ERM §2.7 `CUSTOMER`. `id` may be client-generated (offline capture)."""

    __tablename__ = "customer"
    __table_args__ = (
        CheckConstraint("char_length(trim(name)) > 0", name="name_not_blank"),
        Index("ix_customer_promotion_id_name", "promotion_id", "name"),
    )

    promotion_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("promotion.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(255))
    contact: Mapped[str | None] = mapped_column(String(255))
