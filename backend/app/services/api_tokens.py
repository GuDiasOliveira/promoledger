import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.security import generate_api_token
from app.models import ApiToken, User
from app.schemas.api_token import ApiTokenCreate


async def create_token(
    session: AsyncSession, user: User, data: ApiTokenCreate
) -> tuple[ApiToken, str]:
    token, token_hash, prefix = generate_api_token()
    row = ApiToken(
        user_id=user.id,
        name=data.name,
        token_hash=token_hash,
        prefix=prefix,
        scope="read",
        expires_at=datetime.now(UTC) + timedelta(days=data.expires_in_days),
    )
    session.add(row)
    await session.commit()
    return row, token


async def list_tokens(session: AsyncSession, user: User) -> list[ApiToken]:
    stmt = (
        select(ApiToken)
        .where(ApiToken.user_id == user.id)
        .order_by(ApiToken.created_at.desc(), ApiToken.id)
    )
    return list((await session.execute(stmt)).scalars().all())


async def revoke_token(session: AsyncSession, user: User, token_id: uuid.UUID) -> None:
    row = await session.get(ApiToken, token_id)
    if row is None or row.user_id != user.id:
        raise AppError(404, "TOKEN_NOT_FOUND", "Token not found.")
    if row.revoked_at is None:  # idempotent; the row is kept for the audit of past usage
        row.revoked_at = datetime.now(UTC)
        await session.commit()
