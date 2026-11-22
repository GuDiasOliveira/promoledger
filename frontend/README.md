# PromoLedger — Frontend

Next.js 16 (App Router) + TypeScript + Tailwind, `next-intl` (en-US, pt-BR, es-ES),
TanStack Query v5. Mobile-first PWA for sellers; desktop dashboard for admins.

```bash
npm install
npm run dev          # http://localhost:3000 — needs the backend on :8000 (proxied /api/v1)
npm run gen:api      # regenerate typed API contract from the FastAPI app
npm run lint && npm run typecheck && npm test && npm run build
```

Conventions and known traps: see the root `CLAUDE.md` (§4 Frontend) and `AGENTS.md`.
