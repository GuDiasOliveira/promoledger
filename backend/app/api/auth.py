from fastapi import APIRouter, status

from app.api.deps import CurrentUser, DbSession
from app.core.errors import AppError
from app.core.security import create_access_token
from app.schemas.auth import MeResponse, TokenRequest, TokenResponse, UserCreate, UserResponse
from app.services import auth as auth_service

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
async def me(current_user: CurrentUser) -> MeResponse:
    # Memberships are populated from PROMOTION_MEMBER in Slice 1.3.
    return MeResponse.model_validate(current_user)
