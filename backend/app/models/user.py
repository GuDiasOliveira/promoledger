import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, String, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class User(Base):
    """ERM §2.4 `USER`. Physical table is `app_user` (`user` is reserved in PostgreSQL)."""

    __tablename__ = "app_user"
    __table_args__ = (CheckConstraint("char_length(trim(name)) > 0", name="name_not_blank"),)
    # Fetch server-generated values (id, created_at, updated_at) via RETURNING so they are
    # never lazily refreshed afterwards (avoids MissingGreenlet in async).
    __mapper_args__ = {"eager_defaults": True}

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()")
    )
    name: Mapped[str] = mapped_column(String(255))
    email: Mapped[str] = mapped_column(String(255), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
