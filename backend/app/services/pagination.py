from typing import Any

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.pagination import PageParams


async def paginate(
    session: AsyncSession, stmt: Select[Any], params: PageParams, *, scalars: bool = True
) -> tuple[list[Any], int]:
    """Run an already-ordered `stmt` for one page and return (items, total_count).

    `scalars=True` returns the first entity of each row; `False` returns full rows
    (for multi-column selects).
    """
    count_stmt = select(func.count()).select_from(stmt.order_by(None).subquery())
    total = (await session.execute(count_stmt)).scalar_one()
    result = await session.execute(stmt.limit(params.size).offset(params.offset))
    items = result.scalars().all() if scalars else result.all()
    return list(items), total
