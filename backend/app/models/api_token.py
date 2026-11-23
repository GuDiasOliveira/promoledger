import uuid
from datetime import datetime

from sqlalchemy import CHAR, CheckConstraint, DateTime, ForeignKey, String, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.mixins import CreatedAtMixin, UUIDPrimaryKeyMixin


class ApiToken(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """Personal access token for integrations (e.g. the MCP server). READ-ONLY by design:
    the API rejects any non-GET request authenticated with it. Only a SHA-256 hash is stored.
    """

    __tablename__ = "api_token"
    __table_args__ = (
        CheckConstraint("char_length(trim(name)) > 0", name="name_not_blank"),
        CheckConstraint("scope IN ('read')", name="scope_valid"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("app_user.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(100))
    token_hash: Mapped[str] = mapped_column(CHAR(64), unique=True)
    prefix: Mapped[str] = mapped_column(String(16))  # shown in lists, e.g. "pl_Ab3dE9x"
    scope: Mapped[str] = mapped_column(String(16), server_default=text("'read'"))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
