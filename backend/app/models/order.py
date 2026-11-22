import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    CHAR,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.catalog import MONEY, Customer, Product
from app.models.enums import AuditEventType, StatusClassification, sql_in_list
from app.models.mixins import CreatedAtMixin, TimestampMixin, UUIDPrimaryKeyMixin

ZERO = Decimal("0.00")


class Order(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """ERM §2.8 `ORDER`. Physical table is `customer_order` (`order` is reserved)."""

    __tablename__ = "customer_order"
    __table_args__ = (
        CheckConstraint("version >= 1", name="version_positive"),
        Index("ix_customer_order_promotion_id_created_at", "promotion_id", "created_at"),
    )

    promotion_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("promotion.id", ondelete="RESTRICT"))
    seller_member_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("promotion_member.id", ondelete="RESTRICT"), index=True
    )
    customer_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("customer.id", ondelete="RESTRICT"), index=True
    )
    idempotency_key: Mapped[str] = mapped_column(String(64), unique=True)
    idempotency_fingerprint: Mapped[str] = mapped_column(CHAR(64))
    version: Mapped[int] = mapped_column(Integer, server_default=text("1"))
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    customer: Mapped[Customer] = relationship(lazy="raise")
    items: Mapped[list["OrderItem"]] = relationship(
        lazy="raise", cascade="all, delete-orphan", order_by="OrderItem.id"
    )
    audit_events: Mapped[list["OrderAuditEvent"]] = relationship(
        lazy="raise", order_by="OrderAuditEvent.created_at"
    )

    @property
    def status_classification(self) -> StatusClassification:
        if self.cancelled_at is not None:
            return StatusClassification.CANCELLED
        if self.paid_at is not None and self.delivered_at is not None:
            return StatusClassification.SETTLED
        if self.paid_at is not None:
            return StatusClassification.PAID_PENDING
        if self.delivered_at is not None:
            return StatusClassification.DIVERGENCE
        return StatusClassification.UNPAID_PENDING

    @property
    def total_amount(self) -> Decimal:
        """Exact Decimal sum. Requires `items` to be eager-loaded."""
        return sum((item.line_total for item in self.items), ZERO)


class OrderItem(UUIDPrimaryKeyMixin, Base):
    """ERM §2.9 `ORDER_ITEM`. `unit_price` is a frozen snapshot of `PRODUCT.price`."""

    __tablename__ = "order_item"
    __table_args__ = (
        UniqueConstraint("order_id", "product_id"),
        CheckConstraint("quantity > 0", name="quantity_positive"),
        CheckConstraint("unit_price > 0.00", name="unit_price_positive"),
    )

    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("customer_order.id", ondelete="CASCADE"))
    product_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("product.id", ondelete="RESTRICT"), index=True
    )
    quantity: Mapped[int] = mapped_column(Integer)
    unit_price: Mapped[Decimal] = mapped_column(MONEY)

    product: Mapped[Product] = relationship(lazy="raise")

    @property
    def line_total(self) -> Decimal:
        return self.unit_price * self.quantity


class OrderAuditEvent(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """ERM §2.10 `ORDER_AUDIT_EVENT`. Append-only (enforced by a DB trigger)."""

    __tablename__ = "order_audit_event"
    __table_args__ = (
        CheckConstraint(f"event_type IN ({sql_in_list(AuditEventType)})", name="event_type_valid"),
    )

    order_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("customer_order.id", ondelete="CASCADE"), index=True
    )
    actor_member_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("promotion_member.id", ondelete="RESTRICT"), index=True
    )
    event_type: Mapped[str] = mapped_column(String(32))
    reason: Mapped[str | None] = mapped_column(Text)
