from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    APP_NAME: str = "PromoLedger API"
    ENVIRONMENT: str = "local"
    API_V1_PREFIX: str = "/api/v1"
    DATABASE_URL: str = "postgresql+asyncpg://promoledger:promoledger@localhost:5432/promoledger"
    DATABASE_ECHO: bool = False


@lru_cache
def get_settings() -> Settings:
    return Settings()
