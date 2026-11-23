import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Institution, Promotion, User
from tests.conftest import PromotionFactory, UserFactory, bearer

URL = "/api/v1/institutions"


async def test_create_institution(client: AsyncClient, auth_headers: dict[str, str]) -> None:
    response = await client.post(URL, json={"name": "  Igreja Central  "}, headers=auth_headers)

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Igreja Central"
    assert response.headers["location"] == f"{URL}/{body['id']}"


async def test_create_institution_requires_auth(client: AsyncClient) -> None:
    response = await client.post(URL, json={"name": "X"})

    assert response.status_code == 401


async def test_create_institution_rejects_blank_name(
    client: AsyncClient, auth_headers: dict[str, str]
) -> None:
    response = await client.post(URL, json={"name": "   "}, headers=auth_headers)

    assert response.status_code == 422


async def test_list_institutions_is_paginated(
    client: AsyncClient, db_session: AsyncSession, auth_headers: dict[str, str]
) -> None:
    db_session.add_all([Institution(name=f"Inst {i}") for i in range(3)])
    await db_session.flush()

    response = await client.get(URL, params={"page": 1, "size": 2}, headers=auth_headers)

    assert response.status_code == 200
    body = response.json()
    assert (body["page"], body["size"], body["total"]) == (1, 2, 3)
    assert len(body["items"]) == 2


@pytest.mark.parametrize("params", [{"page": 0}, {"size": 0}, {"size": 101}])
async def test_list_institutions_rejects_invalid_pagination(
    client: AsyncClient, auth_headers: dict[str, str], params: dict[str, int]
) -> None:
    response = await client.get(URL, params=params, headers=auth_headers)

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


async def test_get_institution_lists_only_promotions_caller_belongs_to(
    client: AsyncClient,
    institution: Institution,
    promotion_factory: PromotionFactory,
    user: User,
    user_factory: UserFactory,
) -> None:
    mine = await promotion_factory(creator=user, name="Mine")
    outsider = await user_factory()
    await promotion_factory(creator=outsider, name="Not mine")

    response = await client.get(f"{URL}/{institution.id}", headers=bearer(user))

    assert response.status_code == 200
    promotions = response.json()["promotions"]
    assert promotions == [{"id": str(mine.id), "name": "Mine", "status": "DRAFT", "is_lead": True}]


async def test_get_unknown_institution(client: AsyncClient, auth_headers: dict[str, str]) -> None:
    response = await client.get(f"{URL}/{uuid.uuid4()}", headers=auth_headers)

    assert response.status_code == 404
    assert response.json()["code"] == "INSTITUTION_NOT_FOUND"


async def test_institution_with_promotions_cannot_be_deleted(
    db_session: AsyncSession, institution: Institution, promotion: Promotion
) -> None:
    await db_session.delete(institution)

    with pytest.raises(IntegrityError, match="fk_promotion_institution_institution_id"):
        await db_session.flush()


async def test_search_institutions_by_name(
    client: AsyncClient, db_session: AsyncSession, auth_headers: dict[str, str]
) -> None:
    db_session.add_all(
        [Institution(name=n) for n in ["Colégio São Paulo", "Igreja Central", "Escola 100%"]]
    )
    await db_session.flush()

    async def search(q: str) -> list[str]:
        response = await client.get(URL, params={"q": q, "size": 100}, headers=auth_headers)
        assert response.status_code == 200
        return [i["name"] for i in response.json()["items"]]

    assert await search("igreja") == ["Igreja Central"]  # case-insensitive
    assert await search("%") == ["Escola 100%"]  # LIKE wildcards are escaped
    assert "Colégio São Paulo" in await search("são")
