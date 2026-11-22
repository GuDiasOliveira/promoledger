"""RFC 7807 Problem Details contract (docs/api.md §1.5)."""

from httpx import AsyncClient

PROBLEM_KEYS = {"type", "title", "status", "code", "detail", "instance", "errors"}


async def test_unknown_route_returns_problem_details(client: AsyncClient) -> None:
    response = await client.get("/api/v1/does-not-exist")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body.keys() == PROBLEM_KEYS
    assert body["code"] == "NOT_FOUND"
    assert body["status"] == 404
    assert body["instance"] == "/api/v1/does-not-exist"
    assert body["type"] == "https://api.promoledger.org/errors/not-found"


async def test_validation_error_returns_problem_details(client: AsyncClient) -> None:
    response = await client.post("/api/v1/auth/token", json={})

    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body.keys() == PROBLEM_KEYS
    assert body["code"] == "VALIDATION_ERROR"
    assert {err["loc"][-1] for err in body["errors"]} == {"email", "password"}


async def test_unauthorized_returns_problem_details(client: AsyncClient) -> None:
    response = await client.get("/api/v1/auth/me")

    assert response.status_code == 401
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.headers["www-authenticate"] == "Bearer"
    body = response.json()
    assert body.keys() == PROBLEM_KEYS
    assert body["type"] == "https://api.promoledger.org/errors/not-authenticated"
