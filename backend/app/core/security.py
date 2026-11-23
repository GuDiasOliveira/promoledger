import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

import jwt
from pwdlib import PasswordHash
from pwdlib.hashers.argon2 import Argon2Hasher

from app.core.config import get_settings

_password_hash = PasswordHash((Argon2Hasher(),))

# Used to equalize timing when the user does not exist (prevents account enumeration).
_DUMMY_HASH = _password_hash.hash("promoledger-dummy-password")


def hash_password(password: str) -> str:
    return _password_hash.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    if password_hash is None:
        _password_hash.verify(password, _DUMMY_HASH)
        return False
    return _password_hash.verify(password, password_hash)


def create_access_token(subject: uuid.UUID, expires_delta: timedelta | None = None) -> str:
    settings = get_settings()
    delta = expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"sub": str(subject), "exp": datetime.now(UTC) + delta}
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def decode_access_token(token: str) -> uuid.UUID:
    """Return the user id (`sub`). Raises `jwt.InvalidTokenError` (or subclass) on failure."""
    settings = get_settings()
    payload = jwt.decode(
        token,
        settings.JWT_SECRET_KEY,
        algorithms=[settings.JWT_ALGORITHM],
        options={"require": ["sub", "exp"]},
    )
    try:
        return uuid.UUID(payload["sub"])
    except (ValueError, TypeError) as exc:
        raise jwt.InvalidTokenError("Invalid subject claim") from exc


# --- Personal access tokens (read-only integrations) ---------------------------------------

API_TOKEN_PREFIX = "pl_"


def generate_api_token() -> tuple[str, str, str]:
    """Return (token, sha256_hex, display_prefix). The plain token is shown to the user ONCE."""
    token = API_TOKEN_PREFIX + secrets.token_urlsafe(32)  # 256 bits of entropy
    return token, hash_api_token(token), token[:10]


def hash_api_token(token: str) -> str:
    # A random 256-bit secret needs no slow KDF (unlike passwords): SHA-256 is sufficient.
    return hashlib.sha256(token.encode()).hexdigest()


def is_api_token(credential: str) -> bool:
    return credential.startswith(API_TOKEN_PREFIX)
