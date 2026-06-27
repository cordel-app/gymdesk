# Gymdesk

Gymdesk is a Gym Management SaaS product. It provides gym operators with tools to manage members, classes, bookings, and subscriptions.

## Monorepo Structure

```
gymdesk/
  apps/
    backoffice/
      backend/    # Express + TypeScript REST API
      frontend/   # Next.js admin dashboard
  skills/
    business/     # Business domain guidelines
    technical/    # Technical conventions and patterns
    procedures/   # Operational runbooks
  docker-compose.yml
  package.json
```

## Key Rules

### Architecture
- Keep it simple. No microservices, no event-driven architecture.
- Backend-first development: define the API contract before building UI.
- One database: PostgreSQL. No additional stores unless there is a concrete need.
- All config comes from environment variables. No hardcoded values.

### Backend
- Express + TypeScript. Folder structure: `api/`, `domain/`, `infra/`.
- No unnecessary abstractions. Direct database queries are fine.
- Validate input at the API boundary.

### Frontend
- Next.js admin dashboard. Keep pages flat and straightforward.
- Call the backend; do not duplicate business logic in the frontend.

### What does NOT belong in this repo
- AI systems, LLM integrations, or ML pipelines.
- Dev automation or orchestration tooling as product logic.
- Over-engineered abstractions that exist to be "clean" rather than useful.

## skills/ Folder

The `skills/` folder is reserved for development guidelines — conventions, procedures, and domain knowledge that help engineers work on this codebase. It does not contain product logic or runtime code.

## Local Development

```bash
# Start the database
npm run db:up

# Start the backend (in a separate terminal)
npm run dev:backend

# Start the frontend (in a separate terminal)
npm run dev:frontend
```

Environment variables are loaded from `.env` in each app directory. Copy `.env.example` to `.env` before starting.
