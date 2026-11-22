"""Shared pytest fixtures.

Tests always run against PostgreSQL (never SQLite). The URL is resolved from
TEST_DATABASE_URL, falling back to DATABASE_URL. The schema is built by running the real
Alembic migrations once per session.
"""

import asyncio
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.database import get_db_session
from app.core.security import create_access_token, hash_password
from app.main import create_app
from app.models.user import User

BACKEND_DIR = Path(__file__).resolve().parent.parent
TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")

if not TEST_DATABASE_URL:
    raise RuntimeError("Set TEST_DATABASE_URL (or DATABASE_URL) to a PostgreSQL test database.")
if not TEST_DATABASE_URL.startswith("postgresql+asyncpg://"):
    raise RuntimeError("Tests must run against PostgreSQL via postgresql+asyncpg://.")

DEFAULT_PASSWORD = "correct-horse-battery"

UserFactory = Callable[..., Awaitable[User]]


@pytest.fixture(scope="session")
async def db_engine() -> AsyncIterator[AsyncEngine]:
    alembic_cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    alembic_cfg.set_main_option("sqlalchemy.url", TEST_DATABASE_URL)
    alembic_cfg.attributes["configure_logger"] = False
    # Alembic's async env.py calls asyncio.run(), so it must run outside this event loop.
    await asyncio.to_thread(command.upgrade, alembic_cfg, "head")

    engine = create_async_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    yield engine
    await engine.dispose()


@pytest.fixture
async def db_session(db_engine: AsyncEngine) -> AsyncIterator[AsyncSession]:
    """Session bound to an outer transaction that is rolled back after each test.

    Service-level commits/rollbacks only touch a SAVEPOINT, so tests stay isolated.
    """
    async with db_engine.connect() as connection:
        transaction = await connection.begin()
        session_factory = async_sessionmaker(
            bind=connection,
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        )
        async with session_factory() as session:
            yield session
        await transaction.rollback()


@pytest.fixture
async def client(db_session: AsyncSession) -> AsyncIterator[AsyncClient]:
    app = create_app()

    async def _override_get_db_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_db_session] = _override_get_db_session
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac


@pytest.fixture
def user_factory(db_session: AsyncSession) -> UserFactory:
    counter = 0

    async def _create(
        *, name: str = "Test User", email: str | None = None, password: str = DEFAULT_PASSWORD
    ) -> User:
        nonlocal counter
        counter += 1
        user = User(
            name=name,
            email=(email or f"user{counter}@example.com").lower(),
            password_hash=hash_password(password),
        )
        db_session.add(user)
        await db_session.flush()
        return user

    return _create


@pytest.fixture
async def user(user_factory: UserFactory) -> User:
    return await user_factory()


@pytest.fixture
def auth_headers(user: User) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}
