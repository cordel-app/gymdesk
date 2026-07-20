import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

let gymId: string;
let themeId: string;
let centerId: string;
let otherGymId: string;

beforeAll(async () => {
  gymId = await createTestGym('ThemeAssignGym');
  await createTestMembership(gymId, 'admin');

  otherGymId = await createTestGym('OtherThemeGym');

  // Create a customer theme for this gym
  const { rows: t } = await db.query(
    `INSERT INTO themes (id, gym_id, name, status, tokens, created_at)
     VALUES (UUID(), ?, 'Test Theme', 'active', '{}', UTC_TIMESTAMP())`,
    [gymId],
  );
  void t;
  const { rows: th } = await db.query<{ id: string }>(
    'SELECT id FROM themes WHERE gym_id = ? AND name = ? ORDER BY created_at DESC LIMIT 1',
    [gymId, 'Test Theme'],
  );
  themeId = th[0].id;

  // Create a center for this gym
  await db.query(
    `INSERT INTO centers (gym_id, name, status, created_at) VALUES (?, 'Center A', 'active', UTC_TIMESTAMP())`,
    [gymId],
  );
  const { rows: cs } = await db.query<{ id: string }>(
    'SELECT id FROM centers WHERE gym_id = ? AND name = ? LIMIT 1',
    [gymId, 'Center A'],
  );
  centerId = cs[0].id;
});

afterAll(async () => {
  // Clean up centers and themes before gyms (FK order)
  await db.query('DELETE FROM centers WHERE gym_id IN (SELECT id FROM gyms WHERE slug LIKE ?)', ['test-%']);
  await db.query('DELETE FROM themes WHERE gym_id IN (SELECT id FROM gyms WHERE slug LIKE ?)', ['test-%']);
  await cleanupTestGyms();
  await db.end();
});

// ─── GET /system/themes/:id/assignments ───────────────────────────────────────

describe('GET /system/themes/:id/assignments', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get(`/system/themes/${themeId}/assignments`);
    expect(res.status).toBe(401);
  });

  it('returns 403 for a different gym', async () => {
    const res = await request
      .get(`/system/themes/${themeId}/assignments`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId);
    expect(res.status).toBe(403);
  });

  it('returns 404 for a theme not in this gym', async () => {
    const res = await request
      .get(`/system/themes/non-existent-id/assignments`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns assignments shape for a valid theme', async () => {
    const res = await request
      .get(`/system/themes/${themeId}/assignments`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(typeof res.body.is_org_default).toBe('boolean');
    expect(Array.isArray(res.body.centers)).toBe(true);
  });
});

// ─── PUT /system/themes/:id/set-default ──────────────────────────────────────

describe('PUT /system/themes/:id/set-default', () => {
  it('sets the theme as org default', async () => {
    const res = await request
      .put(`/system/themes/${themeId}/set-default`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const { rows } = await db.query<{ theme_id: string }>('SELECT theme_id FROM gyms WHERE id = ?', [gymId]);
    expect(rows[0].theme_id).toBe(themeId);
  });

  it('reflects is_org_default in assignments after set-default', async () => {
    const res = await request
      .get(`/system/themes/${themeId}/assignments`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.is_org_default).toBe(true);
  });
});

// ─── GET /system/themes/:id/unassigned-centers ───────────────────────────────

describe('GET /system/themes/:id/unassigned-centers', () => {
  it('excludes centers currently inheriting this theme as org default', async () => {
    // After set-default above, Center A inherits this theme → should NOT appear in unassigned
    const res = await request
      .get(`/system/themes/${themeId}/unassigned-centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((c: any) => c.id);
    expect(ids).not.toContain(centerId);
  });
});

// ─── POST /system/themes/:id/assign-centers ──────────────────────────────────

describe('POST /system/themes/:id/assign-centers', () => {
  beforeAll(async () => {
    // Reset org default so Center A goes back to "unassigned" for assign test
    await db.query('UPDATE gyms SET theme_id = NULL WHERE id = ?', [gymId]);
  });

  it('assigns a center to this theme', async () => {
    const res = await request
      .post(`/system/themes/${themeId}/assign-centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ center_ids: [centerId] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const { rows } = await db.query<{ theme_id: string }>(
      'SELECT theme_id FROM centers WHERE id = ?',
      [centerId],
    );
    expect(rows[0].theme_id).toBe(themeId);
  });

  it('returns 400 for empty center_ids', async () => {
    const res = await request
      .post(`/system/themes/${themeId}/assign-centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ center_ids: [] });
    expect(res.status).toBe(400);
  });

  it('returns 400 for center from another gym', async () => {
    const res = await request
      .post(`/system/themes/${themeId}/assign-centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ center_ids: ['non-existent-center'] });
    expect(res.status).toBe(400);
  });
});

// ─── DELETE /system/themes/:id/centers/:centerId ──────────────────────────────

describe('DELETE /system/themes/:id/centers/:centerId (restore inheritance)', () => {
  it('restores inheritance for an explicitly assigned center', async () => {
    // centerId was assigned in the POST test above
    const res = await request
      .delete(`/system/themes/${themeId}/centers/${centerId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const { rows } = await db.query<{ theme_id: string | null }>(
      'SELECT theme_id FROM centers WHERE id = ?',
      [centerId],
    );
    expect(rows[0].theme_id).toBeNull();
  });

  it('returns 409 when center is not assigned to this theme', async () => {
    const res = await request
      .delete(`/system/themes/${themeId}/centers/${centerId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(409);
  });
});

// ─── DELETE /system/themes/:id — blocked when in use ─────────────────────────

describe('DELETE /system/themes/:id (in-use guard)', () => {
  it('returns 409 when theme is set as org default', async () => {
    await db.query('UPDATE gyms SET theme_id = ? WHERE id = ?', [themeId, gymId]);
    const res = await request
      .delete(`/system/themes/${themeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/in use/i);
    await db.query('UPDATE gyms SET theme_id = NULL WHERE id = ?', [gymId]);
  });

  it('returns 409 when theme is explicitly assigned to a center', async () => {
    await db.query('UPDATE centers SET theme_id = ? WHERE id = ?', [themeId, centerId]);
    const res = await request
      .delete(`/system/themes/${themeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/in use/i);
    await db.query('UPDATE centers SET theme_id = NULL WHERE id = ?', [centerId]);
  });
});
