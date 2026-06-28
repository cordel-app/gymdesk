import 'dotenv/config';
import { db } from './db';

async function migrate() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS members (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      email       TEXT NOT NULL UNIQUE,
      phone       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS classes (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      capacity    INTEGER NOT NULL DEFAULT 10,
      starts_at   TIMESTAMPTZ NOT NULL,
      ends_at     TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id          SERIAL PRIMARY KEY,
      member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      class_id    INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      status      TEXT NOT NULL DEFAULT 'confirmed',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (member_id, class_id)
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id          SERIAL PRIMARY KEY,
      member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      plan        TEXT NOT NULL,
      starts_at   DATE NOT NULL,
      ends_at     DATE,
      status      TEXT NOT NULL DEFAULT 'active',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Fix pre-existing schema gap
    ALTER TABLE members ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

    -- Multi-tenant tables
    CREATE TABLE IF NOT EXISTS gyms (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name       TEXT NOT NULL,
      slug       TEXT NOT NULL UNIQUE,
      plan       TEXT NOT NULL DEFAULT 'free',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS gym_memberships (
      id         SERIAL PRIMARY KEY,
      user_id    TEXT NOT NULL,
      gym_id     UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN ('admin','coach','staff')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, gym_id)
    );

    -- Scope all domain tables to a gym
    ALTER TABLE members       ADD COLUMN IF NOT EXISTS gym_id UUID REFERENCES gyms(id);
    ALTER TABLE classes        ADD COLUMN IF NOT EXISTS gym_id UUID REFERENCES gyms(id);
    ALTER TABLE bookings       ADD COLUMN IF NOT EXISTS gym_id UUID REFERENCES gyms(id);
    ALTER TABLE subscriptions  ADD COLUMN IF NOT EXISTS gym_id UUID REFERENCES gyms(id);
  `);

  console.log('Migration complete');
  await db.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
