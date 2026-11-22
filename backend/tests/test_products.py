import pytest
from httpx import AsyncClient

from app.models import Promotion, User
from app.models.enums import Role
from tests.conftest import MemberFactory, ProductFactory, PromotionFactory, UserFactory, bearer


def products_url(promotion: Promotion) -> str:
    return f"/api/v1/promotions/{promotion.id}/products"


# --- create & money -------------------------------------------------------------------------


async def test_admin_creates_product_with_exact_money(
    client: AsyncClient, promotion: Promotion, user: User
) -> None:
    response = await client.post(
        products_url(promotion),
        json={"name": "Ovo de Páscoa", "description": "  400g  ", "price": "19.9"},
        headers=bearer(user),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["price"] == "19.90"  # string, always 2 decimals
    assert body["description"] == "400g"
    assert body["is_active"] is True
    assert response.headers["location"] == f"{products_url(promotion)}/{body['id']}"


@pytest.mark.parametrize(
    "price",
    [
        19.9,  # JSON number: floats are prohibited
        20,  # JSON integer: also a number, not a string
        "19.999",  # more than 2 decimals
        "0.00",  # must be > 0
        "-1.00",
        "100000000.00",  # exceeds NUMERIC(10, 2)
        "1e3",
        "abc",
    ],
)
async def test_create_product_rejects_invalid_money(
    client: AsyncClient, promotion: Promotion, user: User, price: object
) -> None:
    response = await client.post(
        products_url(promotion), json={"name": "X", "price": price}, headers=bearer(user)
    )

    assert response.status_code == 422
    assert response.json()["errors"][0]["loc"][-1] == "price"


async def test_max_money_value_is_accepted(
    client: AsyncClient, promotion: Promotion, user: User
) -> None:
    response = await client.post(
        products_url(promotion), json={"name": "Max", "price": "99999999.99"}, headers=bearer(user)
    )

    assert response.status_code == 201
    assert response.json()["price"] == "99999999.99"


@pytest.mark.parametrize("role", [Role.SELLER, Role.PROMOTION_VIEWER])
async def test_non_admin_cannot_create_product(
    client: AsyncClient, promotion: Promotion, member_factory: MemberFactory, role: Role
) -> None:
    member = await member_factory(promotion, role)

    response = await client.post(
        products_url(promotion), json={"name": "X", "price": "1.00"}, headers=bearer(member.user)
    )

    assert response.status_code == 403


# --- list -----------------------------------------------------------------------------------


async def test_list_products_hides_inactive_by_default(
    client: AsyncClient,
    promotion: Promotion,
    product_factory: ProductFactory,
    member_factory: MemberFactory,
) -> None:
    await product_factory(promotion, name="Active")
    await product_factory(promotion, name="Archived", is_active=False)
    seller = await member_factory(promotion, Role.SELLER)

    response = await client.get(products_url(promotion), headers=bearer(seller.user))

    assert response.status_code == 200
    assert [p["name"] for p in response.json()["items"]] == ["Active"]


async def test_admin_can_include_inactive_products(
    client: AsyncClient, promotion: Promotion, user: User, product_factory: ProductFactory
) -> None:
    await product_factory(promotion, name="Active")
    await product_factory(promotion, name="Archived", is_active=False)

    response = await client.get(
        products_url(promotion), params={"include_inactive": "true"}, headers=bearer(user)
    )

    assert response.json()["total"] == 2


async def test_non_admin_cannot_include_inactive_products(
    client: AsyncClient, promotion: Promotion, member_factory: MemberFactory
) -> None:
    seller = await member_factory(promotion, Role.SELLER)

    response = await client.get(
        products_url(promotion), params={"include_inactive": "true"}, headers=bearer(seller.user)
    )

    assert response.status_code == 403
    assert response.json()["code"] == "INSUFFICIENT_ROLE"


# --- update ---------------------------------------------------------------------------------


async def test_admin_updates_price_and_archives_product(
    client: AsyncClient, promotion: Promotion, user: User, product_factory: ProductFactory
) -> None:
    product = await product_factory(promotion, price="10.00")

    response = await client.patch(
        f"{products_url(promotion)}/{product.id}",
        json={"price": "12.5", "is_active": False},
        headers=bearer(user),
    )

    assert response.status_code == 200
    assert response.json()["price"] == "12.50"
    assert response.json()["is_active"] is False


async def test_update_description_null_clears_but_name_null_is_rejected(
    client: AsyncClient, promotion: Promotion, user: User, product_factory: ProductFactory
) -> None:
    product = await product_factory(promotion)
    url = f"{products_url(promotion)}/{product.id}"
    await client.patch(url, json={"description": "something"}, headers=bearer(user))

    cleared = await client.patch(url, json={"description": None}, headers=bearer(user))
    rejected = await client.patch(url, json={"name": None}, headers=bearer(user))

    assert cleared.status_code == 200
    assert cleared.json()["description"] is None
    assert rejected.status_code == 422


async def test_update_product_from_another_promotion_is_404(
    client: AsyncClient,
    promotion: Promotion,
    promotion_factory: PromotionFactory,
    user: User,
    user_factory: UserFactory,
    product_factory: ProductFactory,
) -> None:
    other = await promotion_factory(creator=await user_factory(), name="Other")
    foreign = await product_factory(other)

    response = await client.patch(
        f"{products_url(promotion)}/{foreign.id}", json={"price": "1.00"}, headers=bearer(user)
    )

    assert response.status_code == 404
    assert response.json()["code"] == "PRODUCT_NOT_FOUND"
