"""SQLAlchemy models registry.

Import every model module here so `Base.metadata` is fully populated for Alembic autogenerate.
"""

from app.core.database import Base

__all__ = ["Base"]
