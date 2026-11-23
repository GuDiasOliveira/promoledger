import uuid

from fastapi import APIRouter, Response, status

from app.api.deps import CurrentUser, DbSession, SessionUser
from app.core.errors import AppError
from app.core.security import create_access_token
from app.schemas.api_token import ApiTokenCreate, ApiTokenCreated, ApiTokenResponse
from app.schemas.auth import MeResponse, TokenRequest, TokenResponse, UserCreate, UserResponse
from app.services import api_tokens as token_service
from app.services import auth as auth_service
from app.services import members as member_service

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def register(payload: UserCreate, session: DbSession) -> UserResponse:
    user = await auth_service.register_user(session, payload)
    return UserResponse.model_validate(user)


@router.post("/token", response_model=TokenResponse)
async def issue_token(payload: TokenRequest, session: DbSession) -> TokenResponse:
    user = await auth_service.authenticate_user(session, payload.email, payload.password)
    if user is None:
        raise AppError(
            401,
            "INVALID_CREDENTIALS",
            "Incorrect email or password.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return TokenResponse(access_token=create_access_token(user.id))


@router.get("/me", response_model=MeResponse)
async def me(current_user: CurrentUser, session: DbSession) -> MeResponse:
    memberships = await member_service.list_user_memberships(session, current_user)
    return MeResponse(
        **UserResponse.model_validate(current_user).model_dump(), memberships=memberships
    )


# --- Personal access tokens (read-only; e.g. for the MCP server) ----------------------------


@router.post("/tokens", response_model=ApiTokenCreated, status_code=status.HTTP_201_CREATED)
async def create_api_token(
    payload: ApiTokenCreate, user: SessionUser, session: DbSession
) -> ApiTokenCreated:
    row, token = await token_service.create_token(session, user, payload)
    return ApiTokenCreated(**ApiTokenResponse.model_validate(row).model_dump(), token=token)


@router.get("/tokens", response_model=list[ApiTokenResponse])
async def list_api_tokens(user: SessionUser, session: DbSession) -> list[ApiTokenResponse]:
    return [
        ApiTokenResponse.model_validate(r) for r in await token_service.list_tokens(session, user)
    ]


@router.delete("/tokens/{token_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_api_token(token_id: uuid.UUID, user: SessionUser, session: DbSession) -> Response:
    await token_service.revoke_token(session, user, token_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
