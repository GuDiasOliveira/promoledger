"""Shared pytest fixtures.

Tests always run against PostgreSQL (never SQLite). The URL is resolved from
TEST_DATABASE_URL, falling back to DATABASE_URL. The schema is built by running the real
Alembic migrations once per session.
"""

import asyncio
import os
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.database import get_db_session
from app.core.security import create_access_token, hash_password
from app.main import create_app
from app.models import Customer, Institution, Product, Promotion, PromotionMember, User
from app.models.enums import PromotionStatus, Role
from app.schemas.promotion import PromotionCreate
from app.services.promotions import create_promotion

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
    return bearer(user)


def bearer(user: User) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


PROMOTION_DATES = {
    "sales_start_date": "2026-03-01",
    "last_sales_date": "2026-03-25",
    "delivery_date": "2026-03-30",
}
# Base fields for creating a promotion (dates + currency).
PROMOTION_BASE = {**PROMOTION_DATES, "currency": "BRL"}


@pytest.fixture
async def institution(db_session: AsyncSession) -> Institution:
    institution = Institution(name="Colégio Exemplo")
    db_session.add(institution)
    await db_session.flush()
    return institution


PromotionFactory = Callable[..., Awaitable[Promotion]]


@pytest.fixture
def promotion_factory(db_session: AsyncSession, institution: Institution) -> PromotionFactory:
    """Creates a promotion through the real service (lead link + creator as admin)."""

    async def _create(*, creator: User, name: str = "Easter Drive 2026") -> Promotion:
        data = PromotionCreate(name=name, institution_id=institution.id, **PROMOTION_BASE)
        return await create_promotion(db_session, data, creator)

    return _create


@pytest.fixture
async def promotion(promotion_factory: PromotionFactory, user: User) -> Promotion:
    """A promotion whose admin is the default `user` fixture."""
    return await promotion_factory(creator=user)


MemberFactory = Callable[..., Awaitable[PromotionMember]]


@pytest.fixture
def member_factory(db_session: AsyncSession, user_factory: UserFactory) -> MemberFactory:
    async def _create(
        promotion: Promotion, *roles: Role, user: User | None = None
    ) -> PromotionMember:
        member_user = user or await user_factory()
        member = PromotionMember(
            promotion_id=promotion.id,
            user_id=member_user.id,
            roles=list(roles or (Role.SELLER,)),
        )
        member.user = member_user
        db_session.add(member)
        await db_session.flush()
        return member

    return _create


# --- catalog & orders -----------------------------------------------------------------------


@pytest.fixture
async def active_promotion(db_session: AsyncSession, promotion: Promotion) -> Promotion:
    """`promotion` (admin = `user`) switched to ACTIVE so orders can be created."""
    promotion.status = PromotionStatus.ACTIVE
    await db_session.flush()
    return promotion


@pytest.fixture
async def seller(active_promotion: Promotion, member_factory: MemberFactory) -> PromotionMember:
    return await member_factory(active_promotion, Role.SELLER)


ProductFactory = Callable[..., Awaitable[Product]]


@pytest.fixture
def product_factory(db_session: AsyncSession) -> ProductFactory:
    async def _create(
        promotion: Promotion,
        *,
        name: str = "Chocolate Egg",
        price: str = "10.00",
        is_active: bool = True,
    ) -> Product:
        product = Product(
            promotion_id=promotion.id, name=name, price=Decimal(price), is_active=is_active
        )
        db_session.add(product)
        await db_session.flush()
        return product

    return _create


CustomerFactory = Callable[..., Awaitable[Customer]]


@pytest.fixture
def customer_factory(db_session: AsyncSession) -> CustomerFactory:
    async def _create(
        promotion: Promotion, *, name: str = "Ana Souza", contact: str | None = None
    ) -> Customer:
        customer = Customer(promotion_id=promotion.id, name=name, contact=contact)
        db_session.add(customer)
        await db_session.flush()
        return customer

    return _create


def orders_url(promotion: Promotion) -> str:
    return f"/api/v1/promotions/{promotion.id}/orders"


def new_key() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


@pytest.fixture
async def product(active_promotion: Promotion, product_factory: ProductFactory) -> Product:
    return await product_factory(active_promotion, name="Ovo 400g", price="19.90")


@pytest.fixture
async def customer(active_promotion: Promotion, customer_factory: CustomerFactory) -> Customer:
    return await customer_factory(active_promotion)


def order_payload(customer: Customer, *lines: tuple[Product, int], **extra: Any) -> dict[str, Any]:
    return {
        "customer_id": str(customer.id),
        "items": [{"product_id": str(p.id), "quantity": q} for p, q in lines],
        **extra,
    }


async def place_order(
    client: AsyncClient,
    promotion: Promotion,
    member: PromotionMember,
    payload: dict[str, Any],
    headers: dict[str, str] | None = None,
) -> Response:
    return await client.post(
        orders_url(promotion),
        json=payload,
        headers={**bearer(member.user), **(headers or new_key())},
    )
