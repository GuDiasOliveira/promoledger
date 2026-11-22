from sqlalchemy import CheckConstraint, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin


class Institution(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """ERM §2.1 `INSTITUTION`."""

    __tablename__ = "institution"
    __table_args__ = (CheckConstraint("char_length(trim(name)) > 0", name="name_not_blank"),)

    name: Mapped[str] = mapped_column(String(255))
