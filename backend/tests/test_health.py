from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


async def test_healthcheck_reports_database_ok(client: AsyncClient) -> None:
    response = await client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}


async def test_session_is_connected_to_postgres(db_session: AsyncSession) -> None:
    result = await db_session.execute(text("SELECT current_database(), version()"))
    database, version = result.one()

    assert database == "promoledger_test"
    assert version.startswith("PostgreSQL 16")
