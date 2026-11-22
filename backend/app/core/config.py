from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    APP_NAME: str = "PromoLedger API"
    ENVIRONMENT: str = "local"
    API_V1_PREFIX: str = "/api/v1"
    DATABASE_URL: str = "postgresql+asyncpg://promoledger:promoledger@localhost:5432/promoledger"
    DATABASE_ECHO: bool = False

    # Local-only default; MUST be overridden via environment outside local/test.
    JWT_SECRET_KEY: str = "local-dev-insecure-secret-key-change-me-0123456789abcdef"
    JWT_ALGORITHM: str = "HS256"
    # 7 days: offline sellers may sync long after login (refresh tokens: post-MVP backlog).
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7


@lru_cache
def get_settings() -> Settings:
    return Settings()
