export const API_PORT = 8001;
export const WEB_PORT = 3001;
export const API_URL = `http://localhost:${API_PORT}/api/v1`;
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql+asyncpg://promoledger:promoledger@localhost:5432/promoledger_e2e";
