import uuid
from datetime import date, datetime

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.enums import PromotionStatus, Role, sql_in_list
from app.models.institution import Institution
from app.models.mixins import CreatedAtMixin, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.user import User

# Relationships use lazy="raise": any access that was not explicitly eager-loaded
# (selectinload/joinedload) fails loudly instead of lazy-loading (MissingGreenlet).


class Promotion(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """ERM §2.2 `PROMOTION`."""

    __tablename__ = "promotion"
    __table_args__ = (
        CheckConstraint("char_length(trim(name)) > 0", name="name_not_blank"),
        CheckConstraint(f"status IN ({sql_in_list(PromotionStatus)})", name="status_valid"),
        CheckConstraint("last_sales_date >= sales_start_date", name="sales_window_valid"),
        CheckConstraint("delivery_date >= last_sales_date", name="delivery_after_sales"),
    )

    name: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(
        String(32), server_default=text(f"'{PromotionStatus.DRAFT.value}'")
    )
    sales_start_date: Mapped[date] = mapped_column(Date)
    last_sales_date: Mapped[date] = mapped_column(Date)
    delivery_date: Mapped[date] = mapped_column(Date)


class PromotionInstitution(CreatedAtMixin, Base):
    """ERM §2.3 `PROMOTION_INSTITUTION` (N:N, exactly one lead per promotion)."""

    __tablename__ = "promotion_institution"
    __table_args__ = (
        Index(
            "idx_promotion_lead_institution",
            "promotion_id",
            unique=True,
            postgresql_where=text("is_lead = true"),
        ),
    )

    promotion_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("promotion.id", ondelete="CASCADE"), primary_key=True
    )
    institution_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("institution.id", ondelete="RESTRICT"), primary_key=True, index=True
    )
    is_lead: Mapped[bool] = mapped_column(server_default=text("false"))

    promotion: Mapped[Promotion] = relationship(lazy="raise")
    institution: Mapped[Institution] = relationship(lazy="raise")


class PromotionMember(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """ERM §2.5 `PROMOTION_MEMBER` — contextual RBAC. Revocation is soft (`revoked_at`)."""

    __tablename__ = "promotion_member"
    __table_args__ = (
        UniqueConstraint("user_id", "promotion_id"),
        # cardinality(), not array_length(): array_length('{}', 1) is NULL and would pass.
        CheckConstraint("cardinality(roles) > 0", name="roles_not_empty"),
        CheckConstraint(f"roles <@ ARRAY[{sql_in_list(Role)}]::text[]", name="roles_valid"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("app_user.id", ondelete="CASCADE"))
    promotion_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("promotion.id", ondelete="CASCADE"), index=True
    )
    # Not mutation-tracked: always assign a new list, never mutate in place.
    roles: Mapped[list[str]] = mapped_column(ARRAY(Text))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship(lazy="raise")
    promotion: Mapped[Promotion] = relationship(lazy="raise")

    @property
    def is_active(self) -> bool:
        return self.revoked_at is None
