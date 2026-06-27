# Gymdesk

Gym Management SaaS — backoffice for managing members, classes, bookings, and subscriptions.

## Requirements

- [Node.js](https://nodejs.org/) v20+
- [OrbStack](https://orbstack.dev/) (or Docker Desktop) for the database container

## First-time setup

```bash
# 1. Install dependencies
npm install

# 2. Copy environment files
cp apps/backoffice/backend/.env.example apps/backoffice/backend/.env
cp apps/backoffice/frontend/.env.example apps/backoffice/frontend/.env

# 3. Start the database
npm run db:up

# 4. Run migrations
cd apps/backoffice/backend && npm run db:migrate && cd -
```

## Running locally

Open three terminals:

```bash
# Terminal 1 — database
npm run db:up

# Terminal 2 — backend (http://localhost:3001)
npm run dev:backend

# Terminal 3 — frontend (http://localhost:3000)
npm run dev:frontend
```

## Project structure

```
gymdesk/
  apps/
    backoffice/
      backend/        # Express + TypeScript REST API
        src/
          api/        # Route handlers (members, classes, bookings, subscriptions)
          domain/     # TypeScript types
          infra/      # Database connection and migrations
      frontend/       # Next.js admin dashboard
        src/app/      # Pages and layout
  skills/
    business/         # Business domain guidelines
    technical/        # Technical conventions
    procedures/       # Operational runbooks
  docker-compose.yml
  CLAUDE.md
```

## API endpoints

| Method | Path                  | Description          |
|--------|-----------------------|----------------------|
| GET    | /health               | Health check         |
| GET    | /members              | List members         |
| POST   | /members              | Create member        |
| PUT    | /members/:id          | Update member        |
| DELETE | /members/:id          | Delete member        |
| GET    | /classes              | List classes         |
| POST   | /classes              | Create class         |
| PUT    | /classes/:id          | Update class         |
| DELETE | /classes/:id          | Delete class         |
| GET    | /bookings             | List bookings        |
| POST   | /bookings             | Create booking       |
| PUT    | /bookings/:id         | Update booking       |
| DELETE | /bookings/:id         | Delete booking       |
| GET    | /subscriptions        | List subscriptions   |
| POST   | /subscriptions        | Create subscription  |
| PUT    | /subscriptions/:id    | Update subscription  |
| DELETE | /subscriptions/:id    | Delete subscription  |

## Environment variables

**Backend** (`apps/backoffice/backend/.env`)

| Variable       | Default                                              | Description          |
|----------------|------------------------------------------------------|----------------------|
| `DATABASE_URL` | `postgresql://gymdesk:gymdesk@localhost:5432/gymdesk`| PostgreSQL connection |
| `PORT`         | `3001`                                               | API port             |

**Frontend** (`apps/backoffice/frontend/.env`)

| Variable      | Default                  | Description      |
|---------------|--------------------------|------------------|
| `BACKEND_URL` | `http://localhost:3001`  | Backend base URL |
