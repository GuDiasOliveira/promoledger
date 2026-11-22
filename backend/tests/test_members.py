import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Promotion, PromotionMember, User
from app.models.enums import Role
from tests.conftest import MemberFactory, PromotionFactory, UserFactory, bearer


def members_url(promotion: Promotion) -> str:
    return f"/api/v1/promotions/{promotion.id}/members"


async def _membership_of(
    db_session: AsyncSession, promotion: Promotion, user: User
) -> PromotionMember:
    stmt = select(PromotionMember).where(
        PromotionMember.promotion_id == promotion.id, PromotionMember.user_id == user.id
    )
    return (await db_session.execute(stmt)).scalar_one()


# --- list -----------------------------------------------------------------------------------


async def test_list_members_includes_user_details(
    client: AsyncClient, promotion: Promotion, user: User, member_factory: MemberFactory
) -> None:
    seller = await member_factory(promotion, Role.SELLER)

    response = await client.get(members_url(promotion), headers=bearer(seller.user))

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 2
    by_email = {m["user"]["email"]: m for m in body["items"]}
    assert by_email[user.email]["roles"] == ["promotion_admin"]
    assert by_email[seller.user.email]["roles"] == ["seller"]
    assert by_email[seller.user.email]["user"]["name"] == seller.user.name


async def test_list_members_hides_revoked_unless_requested(
    client: AsyncClient, promotion: Promotion, user: User, member_factory: MemberFactory
) -> None:
    revoked = await member_factory(promotion, Role.SELLER)
    revoked.revoked_at = revoked.created_at

    default = await client.get(members_url(promotion), headers=bearer(user))
    with_revoked = await client.get(
        members_url(promotion), params={"include_revoked": "true"}, headers=bearer(user)
    )

    assert default.json()["total"] == 1
    assert with_revoked.json()["total"] == 2


async def test_list_members_as_non_member_is_404(
    client: AsyncClient, promotion: Promotion, user_factory: UserFactory
) -> None:
    response = await client.get(members_url(promotion), headers=bearer(await user_factory()))

    assert response.status_code == 404


# --- add ------------------------------------------------------------------------------------


async def test_admin_adds_member_by_email(
    client: AsyncClient, promotion: Promotion, user: User, user_factory: UserFactory
) -> None:
    newcomer = await user_factory(email="newcomer@example.com")

    response = await client.post(
        members_url(promotion),
        json={"email": "NEWCOMER@example.com", "roles": ["seller", "seller", "promotion_viewer"]},
        headers=bearer(user),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["user"]["id"] == str(newcomer.id)
    assert body["roles"] == ["seller", "promotion_viewer"]  # deduplicated
    assert body["revoked_at"] is None
    assert response.headers["location"] == f"{members_url(promotion)}/{body['id']}"


async def test_add_member_unknown_email(
    client: AsyncClient, promotion: Promotion, user: User
) -> None:
    response = await client.post(
        members_url(promotion),
        json={"email": "ghost@example.com", "roles": ["seller"]},
        headers=bearer(user),
    )

    assert response.status_code == 404
    assert response.json()["code"] == "USER_NOT_FOUND"


async def test_add_existing_active_member_conflicts(
    client: AsyncClient, promotion: Promotion, user: User, member_factory: MemberFactory
) -> None:
    seller = await member_factory(promotion, Role.SELLER)

    response = await client.post(
        members_url(promotion),
        json={"email": seller.user.email, "roles": ["promotion_viewer"]},
        headers=bearer(user),
    )

    assert response.status_code == 409
    assert response.json()["code"] == "ALREADY_MEMBER"


async def test_re_adding_revoked_member_reactivates_same_row(
    client: AsyncClient, promotion: Promotion, user: User, member_factory: MemberFactory
) -> None:
    former = await member_factory(promotion, Role.SELLER)
    former.revoked_at = former.created_at

    response = await client.post(
        members_url(promotion),
        json={"email": former.user.email, "roles": ["promotion_viewer"]},
        headers=bearer(user),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["id"] == str(former.id)
    assert body["roles"] == ["promotion_viewer"]
    assert body["revoked_at"] is None


@pytest.mark.parametrize("roles", [[], ["superuser"]])
async def test_add_member_invalid_roles(
    client: AsyncClient,
    promotion: Promotion,
    user: User,
    user_factory: UserFactory,
    roles: list[str],
) -> None:
    target = await user_factory()

    response = await client.post(
        members_url(promotion), json={"email": target.email, "roles": roles}, headers=bearer(user)
    )

    assert response.status_code == 422


async def test_non_admin_cannot_add_member(
    client: AsyncClient,
    promotion: Promotion,
    member_factory: MemberFactory,
    user_factory: UserFactory,
) -> None:
    seller = await member_factory(promotion, Role.SELLER)
    target = await user_factory()

    response = await client.post(
        members_url(promotion),
        json={"email": target.email, "roles": ["seller"]},
        headers=bearer(seller.user),
    )

    assert response.status_code == 403
    assert response.json()["code"] == "INSUFFICIENT_ROLE"


# --- update / revoke ------------------------------------------------------------------------


async def test_admin_updates_member_roles(
    client: AsyncClient, promotion: Promotion, user: User, member_factory: MemberFactory
) -> None:
    seller = await member_factory(promotion, Role.SELLER)

    response = await client.patch(
        f"{members_url(promotion)}/{seller.id}",
        json={"roles": ["seller", "promotion_admin"]},
        headers=bearer(user),
    )

    assert response.status_code == 200
    assert response.json()["roles"] == ["seller", "promotion_admin"]


async def test_revoked_member_loses_access_and_can_be_reinstated(
    client: AsyncClient, promotion: Promotion, user: User, member_factory: MemberFactory
) -> None:
    seller = await member_factory(promotion, Role.SELLER)
    promotion_url = f"/api/v1/promotions/{promotion.id}"
    member_url = f"{members_url(promotion)}/{seller.id}"

    revoke = await client.patch(member_url, json={"revoked": True}, headers=bearer(user))
    assert revoke.status_code == 200
    assert revoke.json()["revoked_at"] is not None
    assert (await client.get(promotion_url, headers=bearer(seller.user))).status_code == 404

    reinstate = await client.patch(member_url, json={"revoked": False}, headers=bearer(user))
    assert reinstate.status_code == 200
    assert reinstate.json()["revoked_at"] is None
    assert (await client.get(promotion_url, headers=bearer(seller.user))).status_code == 200


async def test_cannot_demote_last_admin(
    client: AsyncClient, db_session: AsyncSession, promotion: Promotion, user: User
) -> None:
    admin = await _membership_of(db_session, promotion, user)

    response = await client.patch(
        f"{members_url(promotion)}/{admin.id}", json={"roles": ["seller"]}, headers=bearer(user)
    )

    assert response.status_code == 409
    assert response.json()["code"] == "LAST_ADMIN"


async def test_cannot_revoke_last_admin(
    client: AsyncClient, db_session: AsyncSession, promotion: Promotion, user: User
) -> None:
    admin = await _membership_of(db_session, promotion, user)

    response = await client.patch(
        f"{members_url(promotion)}/{admin.id}", json={"revoked": True}, headers=bearer(user)
    )

    assert response.status_code == 409
    assert response.json()["code"] == "LAST_ADMIN"


async def test_admin_can_step_down_when_another_admin_exists(
    client: AsyncClient,
    db_session: AsyncSession,
    promotion: Promotion,
    user: User,
    member_factory: MemberFactory,
) -> None:
    await member_factory(promotion, Role.PROMOTION_ADMIN)
    admin = await _membership_of(db_session, promotion, user)

    response = await client.patch(
        f"{members_url(promotion)}/{admin.id}", json={"roles": ["seller"]}, headers=bearer(user)
    )

    assert response.status_code == 200
    assert response.json()["roles"] == ["seller"]


async def test_update_member_from_another_promotion_is_404(
    client: AsyncClient,
    promotion: Promotion,
    promotion_factory: PromotionFactory,
    user: User,
    user_factory: UserFactory,
    member_factory: MemberFactory,
) -> None:
    other = await promotion_factory(creator=await user_factory(), name="Other")
    foreign_member = await member_factory(other, Role.SELLER)

    response = await client.patch(
        f"{members_url(promotion)}/{foreign_member.id}",
        json={"roles": ["promotion_viewer"]},
        headers=bearer(user),
    )

    assert response.status_code == 404
    assert response.json()["code"] == "MEMBER_NOT_FOUND"


async def test_update_member_requires_a_field(
    client: AsyncClient, promotion: Promotion, user: User
) -> None:
    response = await client.patch(
        f"{members_url(promotion)}/{uuid.uuid4()}", json={}, headers=bearer(user)
    )

    assert response.status_code == 422


# --- /auth/me memberships -------------------------------------------------------------------


async def test_me_lists_active_memberships(
    client: AsyncClient,
    promotion: Promotion,
    promotion_factory: PromotionFactory,
    user: User,
    user_factory: UserFactory,
    member_factory: MemberFactory,
) -> None:
    other = await promotion_factory(creator=await user_factory(), name="Revoked one")
    revoked = await member_factory(other, Role.SELLER, user=user)
    revoked.revoked_at = revoked.created_at

    response = await client.get("/api/v1/auth/me", headers=bearer(user))

    assert response.status_code == 200
    memberships = response.json()["memberships"]
    assert len(memberships) == 1
    assert memberships[0]["promotion_id"] == str(promotion.id)
    assert memberships[0]["promotion_name"] == promotion.name
    assert memberships[0]["promotion_status"] == "DRAFT"
    assert memberships[0]["roles"] == ["promotion_admin"]


# --- DB-level invariants --------------------------------------------------------------------


@pytest.mark.parametrize(
    ("roles_sql", "constraint"),
    [
        ("'{}'::text[]", "ck_promotion_member_roles_not_empty"),
        ("ARRAY['superuser']", "ck_promotion_member_roles_valid"),
    ],
)
async def test_roles_check_constraints(
    db_session: AsyncSession,
    promotion: Promotion,
    user_factory: UserFactory,
    roles_sql: str,
    constraint: str,
) -> None:
    target = await user_factory()

    with pytest.raises(IntegrityError, match=constraint):
        await db_session.execute(
            text(
                "INSERT INTO promotion_member (user_id, promotion_id, roles) "
                f"VALUES (:user_id, :promotion_id, {roles_sql})"
            ),
            {"user_id": target.id, "promotion_id": promotion.id},
        )


async def test_duplicate_membership_is_rejected_by_db(
    db_session: AsyncSession, promotion: Promotion, user: User
) -> None:
    db_session.add(PromotionMember(promotion_id=promotion.id, user_id=user.id, roles=["seller"]))

    with pytest.raises(IntegrityError, match="uq_promotion_member_user_id"):
        await db_session.flush()
