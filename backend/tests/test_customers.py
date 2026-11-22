import uuid

import pytest
from httpx import AsyncClient

from app.models import Promotion, PromotionMember, User
from app.models.enums import Role
from tests.conftest import CustomerFactory, MemberFactory, PromotionFactory, UserFactory, bearer


def customers_url(promotion: Promotion) -> str:
    return f"/api/v1/promotions/{promotion.id}/customers"


async def test_seller_creates_customer(
    client: AsyncClient, active_promotion: Promotion, seller: PromotionMember
) -> None:
    response = await client.post(
        customers_url(active_promotion),
        json={"name": " Ana Souza ", "contact": "  "},
        headers=bearer(seller.user),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Ana Souza"
    assert body["contact"] is None  # blank -> NULL
    assert uuid.UUID(body["id"]).version == 4


async def test_offline_client_id_is_idempotent(
    client: AsyncClient, active_promotion: Promotion, seller: PromotionMember
) -> None:
    payload = {"id": str(uuid.uuid4()), "name": "Bruno", "contact": "+55 11 90000-0000"}

    first = await client.post(
        customers_url(active_promotion), json=payload, headers=bearer(seller.user)
    )
    retry = await client.post(
        customers_url(active_promotion), json=payload, headers=bearer(seller.user)
    )

    assert first.status_code == 201
    assert retry.status_code == 200
    assert first.json()["id"] == retry.json()["id"] == payload["id"]


async def test_offline_client_id_with_different_data_conflicts(
    client: AsyncClient, active_promotion: Promotion, seller: PromotionMember
) -> None:
    client_id = str(uuid.uuid4())
    await client.post(
        customers_url(active_promotion),
        json={"id": client_id, "name": "Bruno"},
        headers=bearer(seller.user),
    )

    response = await client.post(
        customers_url(active_promotion),
        json={"id": client_id, "name": "Someone else"},
        headers=bearer(seller.user),
    )

    assert response.status_code == 409
    assert response.json()["code"] == "CUSTOMER_ID_CONFLICT"


async def test_client_id_from_another_promotion_conflicts(
    client: AsyncClient,
    active_promotion: Promotion,
    seller: PromotionMember,
    promotion_factory: PromotionFactory,
    user_factory: UserFactory,
    customer_factory: CustomerFactory,
) -> None:
    other = await promotion_factory(creator=await user_factory(), name="Other")
    foreign = await customer_factory(other, name="Same Name")

    response = await client.post(
        customers_url(active_promotion),
        json={"id": str(foreign.id), "name": "Same Name"},
        headers=bearer(seller.user),
    )

    assert response.status_code == 409


async def test_client_id_must_be_uuid4(
    client: AsyncClient, active_promotion: Promotion, seller: PromotionMember
) -> None:
    response = await client.post(
        customers_url(active_promotion),
        json={"id": str(uuid.uuid1()), "name": "X"},
        headers=bearer(seller.user),
    )

    assert response.status_code == 422


@pytest.mark.parametrize("role", [Role.PROMOTION_VIEWER, Role.PROMOTION_ADMIN])
async def test_only_sellers_create_customers(
    client: AsyncClient, active_promotion: Promotion, member_factory: MemberFactory, role: Role
) -> None:
    member = await member_factory(active_promotion, role)

    response = await client.post(
        customers_url(active_promotion), json={"name": "X"}, headers=bearer(member.user)
    )

    assert response.status_code == 403


async def test_search_customers_by_name_or_contact(
    client: AsyncClient,
    active_promotion: Promotion,
    user: User,
    customer_factory: CustomerFactory,
) -> None:
    await customer_factory(active_promotion, name="Ana Souza", contact="ana@example.com")
    await customer_factory(active_promotion, name="Bruno Lima", contact="+55 11 98888-7777")
    await customer_factory(active_promotion, name="Carla 100%")

    async def search(q: str) -> list[str]:
        response = await client.get(
            customers_url(active_promotion), params={"q": q}, headers=bearer(user)
        )
        assert response.status_code == 200
        return [c["name"] for c in response.json()["items"]]

    assert await search("ana") == ["Ana Souza"]  # case-insensitive name
    assert await search("98888") == ["Bruno Lima"]  # contact
    assert await search("%") == ["Carla 100%"]  # LIKE wildcards are escaped
    assert len(await search("")) == 3


async def test_customers_are_scoped_to_promotion(
    client: AsyncClient,
    active_promotion: Promotion,
    user: User,
    promotion_factory: PromotionFactory,
    user_factory: UserFactory,
    customer_factory: CustomerFactory,
) -> None:
    other = await promotion_factory(creator=await user_factory(), name="Other")
    await customer_factory(other, name="Foreign")
    await customer_factory(active_promotion, name="Local")

    response = await client.get(customers_url(active_promotion), headers=bearer(user))

    assert [c["name"] for c in response.json()["items"]] == ["Local"]
