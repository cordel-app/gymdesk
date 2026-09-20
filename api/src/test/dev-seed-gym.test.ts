// Regression tests for #600: the one-time `POST /dev/seed-gym` route was removed.
// It must stay gone — it wrote gyms + admin memberships with no authentication.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, request } from './helpers';

const OUTSIDER_USER_ID = 'dev-seed-gym-outsider';
const NEW_SLUG = `dev-seed-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

afterAll(async () => {
  // Only leaves rows behind if the route is ever reintroduced; keep the shared DB clean regardless.
  await db.query('DELETE FROM gym_memberships WHERE user_id = ?', [OUTSIDER_USER_ID]);
  await db.query('DELETE FROM centers WHERE gym_id IN (SELECT id FROM gyms WHERE slug = ?)', [NEW_SLUG]);
  await db.query('DELETE FROM gyms WHERE slug = ?', [NEW_SLUG]);
  await cleanupTestGyms();
  await db.end();
});

describe('POST /dev/seed-gym (removed)', () => {
  let gymId: string;
  let gymSlug: string;

  beforeAll(async () => {
    gymId = await createTestGym('Seed Target Gym');
    const { rows } = await db.query<{ slug: string }>('SELECT slug FROM gyms WHERE id = ?', [gymId]);
    gymSlug = rows[0].slug;
  });

  async function expectGymUntouched() {
    const { rows: memberships } = await db.query(
      'SELECT 1 FROM gym_memberships WHERE user_id = ?',
      [OUTSIDER_USER_ID],
    );
    expect(memberships).toHaveLength(0);

    const { rows: gyms } = await db.query<{ name: string }>('SELECT name FROM gyms WHERE id = ?', [gymId]);
    expect(gyms[0].name).toBe('Seed Target Gym');
  }

  it('rejects an unauthenticated request against an existing gym slug and writes nothing', async () => {
    const res = await request
      .post('/dev/seed-gym')
      .send({ user_id: OUTSIDER_USER_ID, gym_name: 'Renamed', gym_slug: gymSlug });

    expect([401, 404]).toContain(res.status);
    await expectGymUntouched();
  });

  it('does not create a new gym for an unauthenticated request', async () => {
    const res = await request
      .post('/dev/seed-gym')
      .send({ user_id: OUTSIDER_USER_ID, gym_name: 'Should Not Exist', gym_slug: NEW_SLUG });

    expect([401, 404]).toContain(res.status);
    const { rows } = await db.query('SELECT 1 FROM gyms WHERE slug = ?', [NEW_SLUG]);
    expect(rows).toHaveLength(0);
    await expectGymUntouched();
  });

  it('is also gone for an authenticated caller', async () => {
    const res = await request
      .post('/dev/seed-gym')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ user_id: OUTSIDER_USER_ID, gym_name: 'Renamed', gym_slug: gymSlug });

    expect(res.status).toBe(404);
    await expectGymUntouched();
  });
});
