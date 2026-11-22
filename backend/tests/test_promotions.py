import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Institution, Promotion, PromotionInstitution, PromotionMember, User
from app.models.enums import Role
from tests.conftest import (
    PROMOTION_DATES,
    MemberFactory,
    PromotionFactory,
    UserFactory,
    bearer,
)

URL = "/api/v1/promotions"


# --- create ---------------------------------------------------------------------------------


async def test_create_promotion_links_lead_institution_and_creator_admin(
    client: AsyncClient, db_session: AsyncSession, institution: Institution, user: User
) -> None:
    payload = {"name": "Easter Drive", "institution_id": str(institution.id), **PROMOTION_DATES}

    response = await client.post(URL, json=payload, headers=bearer(user))

    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "DRAFT"
    assert body["sales_start_date"] == "2026-03-01"
    assert response.headers["location"] == f"{URL}/{body['id']}"

    promotion_id = uuid.UUID(body["id"])
    link = await db_session.get(PromotionInstitution, (promotion_id, institution.id))
    assert link is not None and link.is_lead is True

    member = (
        await db_session.execute(
            select(PromotionMember).where(PromotionMember.promotion_id == promotion_id)
        )
    ).scalar_one()
    assert member.user_id == user.id
    assert member.roles == [Role.PROMOTION_ADMIN]


async def test_create_promotion_unknown_institution(
    client: AsyncClient, auth_headers: dict[str, str]
) -> None:
    payload = {"name": "X", "institution_id": str(uuid.uuid4()), **PROMOTION_DATES}

    response = await client.post(URL, json=payload, headers=auth_headers)

    assert response.status_code == 404
    assert response.json()["code"] == "INSTITUTION_NOT_FOUND"


@pytest.mark.parametrize(
    "dates",
    [
        {"sales_start_date": "2026-03-10", "last_sales_date": "2026-03-01"},
        {"last_sales_date": "2026-03-25", "delivery_date": "2026-03-20"},
    ],
)
async def test_create_promotion_invalid_date_range(
    client: AsyncClient,
    institution: Institution,
    auth_headers: dict[str, str],
    dates: dict[str, str],
) -> None:
    payload = {"name": "X", "institution_id": str(institution.id), **PROMOTION_DATES, **dates}

    response = await client.post(URL, json=payload, headers=auth_headers)

    assert response.status_code == 400
    assert response.json()["code"] == "INVALID_DATE_RANGE"


async def test_only_one_lead_institution_per_promotion(
    db_session: AsyncSession, promotion: Promotion
) -> None:
    other = Institution(name="Co-organizer")
    db_session.add(other)
    await db_session.flush()
    db_session.add(
        PromotionInstitution(promotion_id=promotion.id, institution_id=other.id, is_lead=True)
    )

    with pytest.raises(IntegrityError, match="idx_promotion_lead_institution"):
        await db_session.flush()


async def test_non_lead_co_organizer_is_allowed(
    db_session: AsyncSession, promotion: Promotion
) -> None:
    other = Institution(name="Co-organizer")
    db_session.add(other)
    await db_session.flush()
    db_session.add(
        PromotionInstitution(promotion_id=promotion.id, institution_id=other.id, is_lead=False)
    )

    await db_session.flush()


# --- read / list ----------------------------------------------------------------------------


async def test_list_promotions_only_returns_active_memberships(
    client: AsyncClient,
    promotion_factory: PromotionFactory,
    member_factory: MemberFactory,
    user: User,
    user_factory: UserFactory,
) -> None:
    other_admin = await user_factory()
    mine = await promotion_factory(creator=user, name="Mine")
    joined = await promotion_factory(creator=other_admin, name="Joined")
    revoked = await promotion_factory(creator=other_admin, name="Revoked")
    await promotion_factory(creator=other_admin, name="Foreign")
    await member_factory(joined, Role.SELLER, user=user)
    revoked_member = await member_factory(revoked, Role.SELLER, user=user)
    revoked_member.revoked_at = revoked_member.created_at

    response = await client.get(URL, headers=bearer(user))

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 2
    assert {p["id"] for p in body["items"]} == {str(mine.id), str(joined.id)}


async def test_get_promotion_as_member(
    client: AsyncClient, promotion: Promotion, member_factory: MemberFactory
) -> None:
    viewer = await member_factory(promotion, Role.PROMOTION_VIEWER)

    response = await client.get(f"{URL}/{promotion.id}", headers=bearer(viewer.user))

    assert response.status_code == 200
    assert response.json()["id"] == str(promotion.id)


async def test_get_promotion_as_non_member_is_404(
    client: AsyncClient, promotion: Promotion, user_factory: UserFactory
) -> None:
    outsider = await user_factory()

    response = await client.get(f"{URL}/{promotion.id}", headers=bearer(outsider))

    assert response.status_code == 404
    assert response.json()["code"] == "PROMOTION_NOT_FOUND"


async def test_get_unknown_promotion_is_404(
    client: AsyncClient, auth_headers: dict[str, str]
) -> None:
    response = await client.get(f"{URL}/{uuid.uuid4()}", headers=auth_headers)

    assert response.status_code == 404
    assert response.json()["code"] == "PROMOTION_NOT_FOUND"


async def test_get_promotion_requires_auth(client: AsyncClient, promotion: Promotion) -> None:
    response = await client.get(f"{URL}/{promotion.id}")

    assert response.status_code == 401


# --- update ---------------------------------------------------------------------------------


async def test_admin_updates_promotion(
    client: AsyncClient, promotion: Promotion, user: User
) -> None:
    original_updated_at = promotion.updated_at

    response = await client.patch(
        f"{URL}/{promotion.id}",
        json={"name": "Renamed", "delivery_date": "2026-04-05"},
        headers=bearer(user),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "Renamed"
    assert body["delivery_date"] == "2026-04-05"
    assert body["sales_start_date"] == "2026-03-01"
    assert body["updated_at"] >= original_updated_at.isoformat().replace("+00:00", "Z")


@pytest.mark.parametrize("role", [Role.SELLER, Role.PROMOTION_VIEWER])
async def test_non_admin_cannot_update_promotion(
    client: AsyncClient, promotion: Promotion, member_factory: MemberFactory, role: Role
) -> None:
    member = await member_factory(promotion, role)

    response = await client.patch(
        f"{URL}/{promotion.id}", json={"name": "Hacked"}, headers=bearer(member.user)
    )

    assert response.status_code == 403
    assert response.json()["code"] == "INSUFFICIENT_ROLE"


async def test_update_validates_merged_dates(
    client: AsyncClient, promotion: Promotion, user: User
) -> None:
    # Only delivery_date changes, but it now precedes the stored last_sales_date (03-25).
    response = await client.patch(
        f"{URL}/{promotion.id}", json={"delivery_date": "2026-03-20"}, headers=bearer(user)
    )

    assert response.status_code == 400
    assert response.json()["code"] == "INVALID_DATE_RANGE"


async def test_update_rejects_explicit_null(
    client: AsyncClient, promotion: Promotion, user: User
) -> None:
    response = await client.patch(
        f"{URL}/{promotion.id}", json={"name": None}, headers=bearer(user)
    )

    assert response.status_code == 422


@pytest.mark.parametrize(
    ("path", "allowed"),
    [
        (["ACTIVE"], True),
        (["ACTIVE", "CLOSED"], True),
        (["ACTIVE", "CLOSED", "ACTIVE"], True),  # reopen
        (["DRAFT"], True),  # same status: no-op
        (["CLOSED"], False),  # DRAFT -> CLOSED
        (["ACTIVE", "DRAFT"], False),
        (["ACTIVE", "CLOSED", "DRAFT"], False),
    ],
)
async def test_status_transitions(
    client: AsyncClient, promotion: Promotion, user: User, path: list[str], allowed: bool
) -> None:
    responses = [
        await client.patch(f"{URL}/{promotion.id}", json={"status": s}, headers=bearer(user))
        for s in path
    ]

    *setup, last = responses
    assert all(r.status_code == 200 for r in setup)
    if allowed:
        assert last.status_code == 200
        assert last.json()["status"] == path[-1]
    else:
        assert last.status_code == 400
        assert last.json()["code"] == "INVALID_STATUS_TRANSITION"


async def test_update_rejects_unknown_status(
    client: AsyncClient, promotion: Promotion, user: User
) -> None:
    response = await client.patch(
        f"{URL}/{promotion.id}", json={"status": "ARCHIVED"}, headers=bearer(user)
    )

    assert response.status_code == 422
