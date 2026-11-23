import hashlib
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ApiToken, Promotion, User
from tests.conftest import UserFactory, bearer

URL = "/api/v1/auth/tokens"


async def create_token(client: AsyncClient, user: User, **body: object) -> dict:
    response = await client.post(URL, json={"name": "Claude Desktop", **body}, headers=bearer(user))
    assert response.status_code == 201, response.text
    return response.json()


def pat(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def test_token_is_shown_once_and_only_its_hash_is_stored(
    client: AsyncClient, db_session: AsyncSession, user: User
) -> None:
    created = await create_token(client, user, expires_in_days=30)

    token = created["token"]
    assert token.startswith("pl_") and len(token) > 40
    assert created["prefix"] == token[:10]
    assert created["scope"] == "read"
    row = (
        await db_session.execute(select(ApiToken).where(ApiToken.id == uuid.UUID(created["id"])))
    ).scalar_one()
    assert row.token_hash == hashlib.sha256(token.encode()).hexdigest()
    assert token not in (row.token_hash, row.prefix)

    listed = (await client.get(URL, headers=bearer(user))).json()
    assert [t["id"] for t in listed] == [created["id"]]
    assert "token" not in listed[0]  # never shown again


async def test_token_reads_like_its_user(
    client: AsyncClient, db_session: AsyncSession, user: User, promotion: Promotion
) -> None:
    token = (await create_token(client, user))["token"]

    me = await client.get("/api/v1/auth/me", headers=pat(token))
    detail = await client.get(f"/api/v1/promotions/{promotion.id}", headers=pat(token))

    assert me.status_code == 200 and me.json()["id"] == str(user.id)
    assert detail.status_code == 200
    row = (await db_session.execute(select(ApiToken))).scalar_one()
    assert row.last_used_at is not None


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("POST", "/api/v1/institutions", {"name": "X"}),
        ("PATCH", "/api/v1/promotions/{pid}", {"name": "Hacked"}),
        ("POST", "/api/v1/promotions/{pid}/products", {"name": "X", "price": "1.00"}),
    ],
)
async def test_token_can_never_write(
    client: AsyncClient,
    user: User,
    promotion: Promotion,
    method: str,
    path: str,
    body: dict,
) -> None:
    token = (await create_token(client, user))["token"]  # `user` is the promotion's admin

    response = await client.request(
        method, path.format(pid=promotion.id), json=body, headers=pat(token)
    )

    assert response.status_code == 403
    assert response.json()["code"] == "TOKEN_READ_ONLY"


async def test_token_cannot_manage_tokens(client: AsyncClient, user: User) -> None:
    token = (await create_token(client, user))["token"]

    listed = await client.get(URL, headers=pat(token))
    created = await client.post(URL, json={"name": "escalate"}, headers=pat(token))

    assert listed.status_code == 403 and listed.json()["code"] == "TOKEN_NOT_ALLOWED"
    assert created.status_code == 403  # read-only check fires first: TOKEN_READ_ONLY


async def test_revoked_and_expired_tokens_are_rejected(
    client: AsyncClient, db_session: AsyncSession, user: User
) -> None:
    revoked = await create_token(client, user, name="old")
    expired = await create_token(client, user, name="expired")
    assert (await client.delete(f"{URL}/{revoked['id']}", headers=bearer(user))).status_code == 204
    row = await db_session.get(ApiToken, uuid.UUID(expired["id"]))
    assert row is not None
    row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await db_session.flush()

    r1 = await client.get("/api/v1/auth/me", headers=pat(revoked["token"]))
    r2 = await client.get("/api/v1/auth/me", headers=pat(expired["token"]))
    r3 = await client.get("/api/v1/auth/me", headers=pat("pl_" + "x" * 43))

    assert (r1.status_code, r1.json()["code"]) == (401, "INVALID_TOKEN")
    assert (r2.status_code, r2.json()["code"]) == (401, "TOKEN_EXPIRED")
    assert (r3.status_code, r3.json()["code"]) == (401, "INVALID_TOKEN")


async def test_users_cannot_revoke_each_others_tokens(
    client: AsyncClient, user: User, user_factory: UserFactory
) -> None:
    mine = await create_token(client, user)
    other = await user_factory()

    response = await client.delete(f"{URL}/{mine['id']}", headers=bearer(other))

    assert response.status_code == 404
    assert response.json()["code"] == "TOKEN_NOT_FOUND"


@pytest.mark.parametrize("days", [0, 366, "30"])
async def test_expiry_must_be_1_to_365_days(client: AsyncClient, user: User, days: object) -> None:
    response = await client.post(
        URL, json={"name": "x", "expires_in_days": days}, headers=bearer(user)
    )

    assert response.status_code == 422
