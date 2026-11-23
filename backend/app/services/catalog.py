import uuid

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import violates_constraint
from app.core.errors import AppError
from app.models import Customer, Product
from app.schemas.catalog import CustomerCreate, ProductCreate, ProductUpdate
from app.schemas.pagination import PageParams
from app.services.pagination import paginate
from app.services.search import contains_pattern

# --- products -------------------------------------------------------------------------------


async def list_products(
    session: AsyncSession, promotion_id: uuid.UUID, params: PageParams, *, include_inactive: bool
) -> tuple[list[Product], int]:
    stmt = select(Product).where(Product.promotion_id == promotion_id)
    if not include_inactive:
        stmt = stmt.where(Product.is_active.is_(True))
    stmt = stmt.order_by(Product.name, Product.id)
    return await paginate(session, stmt, params)


async def create_product(
    session: AsyncSession, promotion_id: uuid.UUID, data: ProductCreate
) -> Product:
    product = Product(promotion_id=promotion_id, **data.model_dump())
    session.add(product)
    await session.commit()
    return product


async def get_product(
    session: AsyncSession, promotion_id: uuid.UUID, product_id: uuid.UUID
) -> Product:
    product = await session.get(Product, product_id)
    if product is None or product.promotion_id != promotion_id:
        raise AppError(404, "PRODUCT_NOT_FOUND", "Product not found in this promotion.")
    return product


async def update_product(session: AsyncSession, product: Product, data: ProductUpdate) -> Product:
    # Price changes never touch existing orders: ORDER_ITEM.unit_price is a frozen snapshot.
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(product, field, value)
    await session.commit()
    return product


# --- customers ------------------------------------------------------------------------------


async def list_customers(
    session: AsyncSession, promotion_id: uuid.UUID, params: PageParams, *, q: str | None
) -> tuple[list[Customer], int]:
    stmt = select(Customer).where(Customer.promotion_id == promotion_id)
    if q:
        pattern = contains_pattern(q)
        stmt = stmt.where(
            or_(
                Customer.name.ilike(pattern, escape="\\"),
                Customer.contact.ilike(pattern, escape="\\"),
            )
        )
    stmt = stmt.order_by(Customer.name, Customer.id)
    return await paginate(session, stmt, params)


def _customer_conflict() -> AppError:
    return AppError(
        409, "CUSTOMER_ID_CONFLICT", "A customer with this id already exists with different data."
    )


def _same_customer(existing: Customer, promotion_id: uuid.UUID, data: CustomerCreate) -> bool:
    return (existing.promotion_id, existing.name, existing.contact) == (
        promotion_id,
        data.name,
        data.contact,
    )


async def create_customer(
    session: AsyncSession, promotion_id: uuid.UUID, data: CustomerCreate
) -> tuple[Customer, bool]:
    """Return (customer, created). A client-supplied `id` makes the call idempotent."""
    if data.id is not None:
        existing = await session.get(Customer, data.id)
        if existing is not None:
            if not _same_customer(existing, promotion_id, data):
                raise _customer_conflict()
            return existing, False

    customer = Customer(promotion_id=promotion_id, name=data.name, contact=data.contact)
    if data.id is not None:
        customer.id = data.id
    session.add(customer)
    try:
        await session.commit()
    except IntegrityError as exc:  # concurrent offline sync of the same client id
        await session.rollback()
        if data.id is None or not violates_constraint(exc, "pk_customer"):
            raise
        existing = await session.get(Customer, data.id)
        if existing is None or not _same_customer(existing, promotion_id, data):
            raise _customer_conflict() from exc
        return existing, False
    return customer, True
