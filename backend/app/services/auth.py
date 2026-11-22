from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.security import hash_password, verify_password
from app.models.user import User
from app.schemas.auth import UserCreate


def _email_taken_error() -> AppError:
    return AppError(409, "EMAIL_ALREADY_REGISTERED", "An account with this email already exists.")


async def get_user_by_email(session: AsyncSession, email: str) -> User | None:
    result = await session.execute(select(User).where(User.email == email.lower()))
    return result.scalar_one_or_none()


async def register_user(session: AsyncSession, data: UserCreate) -> User:
    if await get_user_by_email(session, data.email) is not None:
        raise _email_taken_error()

    user = User(name=data.name, email=data.email, password_hash=hash_password(data.password))
    session.add(user)
    try:
        await session.commit()
    except IntegrityError as exc:  # concurrent registration with the same email
        await session.rollback()
        raise _email_taken_error() from exc
    return user


async def authenticate_user(session: AsyncSession, email: str, password: str) -> User | None:
    user = await get_user_by_email(session, email)
    if not verify_password(password, user.password_hash if user else None):
        return None
    return user
