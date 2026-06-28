# Gymdesk

Multi-tenant Gym Management SaaS. Express backend + Next.js frontend + PostgreSQL + Clerk auth.

## Before implementing any feature

Read these two files first — they contain the full architecture map and step-by-step patterns:

- `docs/architecture.md` — codebase structure, auth, roles, DB conventions
- `docs/feature-patterns.md` — checklist and code templates for new features

Use **Members** as the reference implementation for staff-level CRUD with soft-delete.
Use **Fares** as the reference implementation for admin-only CRUD.

## Hard constraints

- No microservices, no event sourcing, no AI/LLM integrations.
- One database: PostgreSQL. No additional stores without a concrete reason.
- Every domain table must have `gym_id`. Every query must filter by it.
- All config via environment variables. No hardcoded values.
- Backend-first: define the API contract before building UI.
- Do not duplicate business logic in the frontend.

## Local development

```bash
npm run db:up          # start PostgreSQL
npm run db:migrate     # run pending migrations
npm run dev:backend    # Express on :3001
npm run dev:frontend   # Next.js on :3000
```

Copy `.env.example` to `.env` in each app directory before starting.
