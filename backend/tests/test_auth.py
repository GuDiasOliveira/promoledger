import uuid
from datetime import UTC, datetime, timedelta

import jwt
from httpx import AsyncClient
from sqlalchemy import inspect, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.security import create_access_token
from app.models.user import User
from tests.conftest import DEFAULT_PASSWORD, UserFactory

REGISTER_URL = "/api/v1/auth/register"
TOKEN_URL = "/api/v1/auth/token"
ME_URL = "/api/v1/auth/me"


# --- register -------------------------------------------------------------------------------


async def test_register_creates_user_with_argon2_hash(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    response = await client.post(
        REGISTER_URL,
        json={"name": "  Maria Silva  ", "email": "Maria@Example.com", "password": "s3cret-pass"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Maria Silva"
    assert body["email"] == "maria@example.com"
    assert uuid.UUID(body["id"])
    assert {"created_at", "updated_at"} <= body.keys()
    assert "password" not in body and "password_hash" not in body

    stored = (
        await db_session.execute(select(User).where(User.id == uuid.UUID(body["id"])))
    ).scalar_one()
    assert stored.password_hash.startswith("$argon2id$")
    assert "s3cret-pass" not in stored.password_hash


async def test_register_rejects_duplicate_email_case_insensitive(
    client: AsyncClient, user_factory: UserFactory
) -> None:
    await user_factory(email="dup@example.com")

    response = await client.post(
        REGISTER_URL, json={"name": "Other", "email": "DUP@example.com", "password": "another-pass"}
    )

    assert response.status_code == 409
    assert response.json()["code"] == "EMAIL_ALREADY_REGISTERED"


async def test_register_validation_errors(client: AsyncClient) -> None:
    response = await client.post(
        REGISTER_URL, json={"name": "   ", "email": "not-an-email", "password": "short"}
    )

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "VALIDATION_ERROR"
    failed_fields = {tuple(err["loc"])[-1] for err in body["errors"]}
    assert failed_fields == {"name", "email", "password"}


# --- token ----------------------------------------------------------------------------------


async def test_token_issues_jwt_with_sub_and_exp(client: AsyncClient, user: User) -> None:
    response = await client.post(
        TOKEN_URL, json={"email": user.email, "password": DEFAULT_PASSWORD}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["token_type"] == "bearer"

    settings = get_settings()
    claims = jwt.decode(
        body["access_token"], settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM]
    )
    assert claims["sub"] == str(user.id)
    assert claims["exp"] > datetime.now(UTC).timestamp()


async def test_token_accepts_email_in_any_case(client: AsyncClient, user: User) -> None:
    response = await client.post(
        TOKEN_URL, json={"email": user.email.upper(), "password": DEFAULT_PASSWORD}
    )

    assert response.status_code == 200


async def test_token_wrong_password_and_unknown_email_are_indistinguishable(
    client: AsyncClient, user: User
) -> None:
    wrong_password = await client.post(
        TOKEN_URL, json={"email": user.email, "password": "nope-nope"}
    )
    unknown_email = await client.post(
        TOKEN_URL, json={"email": "ghost@example.com", "password": DEFAULT_PASSWORD}
    )

    for response in (wrong_password, unknown_email):
        assert response.status_code == 401
        assert response.json()["code"] == "INVALID_CREDENTIALS"
        assert response.headers["www-authenticate"] == "Bearer"
    assert wrong_password.json()["detail"] == unknown_email.json()["detail"]


# --- me -------------------------------------------------------------------------------------


async def test_me_returns_current_user_profile(
    client: AsyncClient, user: User, auth_headers: dict[str, str]
) -> None:
    response = await client.get(ME_URL, headers=auth_headers)

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == str(user.id)
    assert body["email"] == user.email
    assert body["memberships"] == []


async def test_me_end_to_end_register_login_me(client: AsyncClient) -> None:
    creds = {"email": "flow@example.com", "password": "flow-password"}
    assert (await client.post(REGISTER_URL, json={"name": "Flow", **creds})).status_code == 201
    token = (await client.post(TOKEN_URL, json=creds)).json()["access_token"]

    response = await client.get(ME_URL, headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 200
    assert response.json()["email"] == "flow@example.com"


async def test_me_without_token(client: AsyncClient) -> None:
    response = await client.get(ME_URL)

    assert response.status_code == 401
    assert response.json()["code"] == "NOT_AUTHENTICATED"


async def test_me_with_expired_token(client: AsyncClient, user: User) -> None:
    token = create_access_token(user.id, expires_delta=timedelta(seconds=-1))

    response = await client.get(ME_URL, headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 401
    assert response.json()["code"] == "TOKEN_EXPIRED"


async def test_me_with_token_signed_by_another_key(client: AsyncClient, user: User) -> None:
    forged = jwt.encode(
        {"sub": str(user.id), "exp": datetime.now(UTC) + timedelta(minutes=5)},
        "attacker-controlled-secret-key-0123456789abcdef",
        algorithm="HS256",
    )

    response = await client.get(ME_URL, headers={"Authorization": f"Bearer {forged}"})

    assert response.status_code == 401
    assert response.json()["code"] == "INVALID_TOKEN"


async def test_me_with_token_for_nonexistent_user(client: AsyncClient) -> None:
    token = create_access_token(uuid.uuid4())

    response = await client.get(ME_URL, headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 401
    assert response.json()["code"] == "INVALID_TOKEN"


# --- model timestamps -----------------------------------------------------------------------


SERVER_GENERATED = {"id", "created_at", "updated_at"}


async def test_server_defaults_are_loaded_via_returning_on_insert(user: User) -> None:
    # eager_defaults: values come back in INSERT ... RETURNING, so none are left expired
    # (an expired attribute would trigger an implicit refresh -> MissingGreenlet in async).
    assert SERVER_GENERATED.isdisjoint(inspect(user).expired_attributes)
    assert user.created_at.tzinfo is not None


async def test_updated_at_onupdate_is_loaded_via_returning_on_update(
    db_session: AsyncSession, user: User
) -> None:
    user.name = "Renamed"
    await db_session.flush()

    assert "updated_at" not in inspect(user).expired_attributes
    assert user.updated_at is not None
