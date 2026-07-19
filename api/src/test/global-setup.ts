import { config } from 'dotenv';
import { resolve } from 'node:path';

// Runs in the main thread before any worker starts — env vars propagate to workers.
export function setup() {
  // Load api/.env for local dev. In CI the vars are set directly, so dotenv is a no-op.
  // __dirname = api/src/test, so ../../.env = api/.env
  config({ path: resolve(__dirname, '../../.env') });

  // Fallbacks for CI (MySQL service container credentials)
  process.env.CLERK_SECRET_KEY ??= 'test-secret';
  process.env.CORDEL_FITNESS_DB_HOST ??= '127.0.0.1:3306';
  process.env.CORDEL_FITNESS_DB_USER ??= 'root';
  process.env.CORDEL_FITNESS_DB_PASSWORD ??= 'ci';
  process.env.CORDEL_FITNESS_DB_NAME ??= 'fitness';
}
