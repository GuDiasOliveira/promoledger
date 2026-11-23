import { execFileSync } from "node:child_process";
import path from "node:path";

import { E2E_DATABASE_URL } from "./config";

/**
 * Fresh database for every run: E2E tests commit real data, so they get their own DB
 * (never `promoledger_test`, whose pytest suite counts rows), dropped and re-migrated here.
 */
export default function globalSetup() {
  const backend = path.resolve(__dirname, "../../backend");
  const url = new URL(E2E_DATABASE_URL.replace("+asyncpg", ""));
  const dbName = url.pathname.slice(1);
  const adminUrl = `${url.protocol}//${url.username}:${url.password}@${url.host}/postgres`;
  const recreate = [
    "import asyncio, asyncpg, sys",
    "async def main(admin, name):",
    "    conn = await asyncpg.connect(admin)",
    "    await conn.execute(f'DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)')",
    "    await conn.execute(f'CREATE DATABASE \"{name}\"')",
    "    await conn.close()",
    "asyncio.run(main(sys.argv[1], sys.argv[2]))",
  ].join("\n");
  execFileSync("uv", ["run", "python", "-c", recreate, adminUrl, dbName], {
    cwd: backend,
    stdio: "inherit",
  });
  execFileSync("uv", ["run", "alembic", "upgrade", "head"], {
    cwd: backend,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
  });
}
