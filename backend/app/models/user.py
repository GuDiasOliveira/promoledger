from sqlalchemy import CheckConstraint, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin


class User(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """ERM §2.4 `USER`. Physical table is `app_user` (`user` is reserved in PostgreSQL)."""

    __tablename__ = "app_user"
    __table_args__ = (CheckConstraint("char_length(trim(name)) > 0", name="name_not_blank"),)

    name: Mapped[str] = mapped_column(String(255))
    email: Mapped[str] = mapped_column(String(255), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
