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
  `);

  console.log('Migration complete');
  await db.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
