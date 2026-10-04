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
    expect(typeof res.body.is_gym_default).toBe('boolean');
    expect(Array.isArray(res.body.centers)).toBe(true);
  });

  // #985: the Assignments section is a checkbox list, so the read reports every
  // Center of the gym — an unassigned one has to be a box you can tick.
  it('reports every center of the gym, assigned or not', async () => {
    await db.query('UPDATE centers SET theme_id = NULL WHERE id = ?', [centerId]);
    await db.query('UPDATE gyms SET theme_id = NULL WHERE id = ?', [gymId]);
    const res = await request
      .get(`/system/themes/${themeId}/assignments`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const row = res.body.centers.find((c: any) => c.id === centerId);
    expect(row).toMatchObject({ is_assigned: false, is_inherited: false });
  });

  it('distinguishes an assigned center from one inheriting the gym default', async () => {
    await db.query('UPDATE centers SET theme_id = ? WHERE id = ?', [themeId, centerId]);
    const assignedRes = await request
      .get(`/system/themes/${themeId}/assignments`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(assignedRes.body.centers.find((c: any) => c.id === centerId)).toMatchObject({
      is_assigned: true,
      is_inherited: false,
    });

    // No assignment of its own + this theme as the Gym Default ⇒ inherited, and
    // deliberately *not* `is_assigned`: the checkbox is the center's own column.
    await db.query('UPDATE centers SET theme_id = NULL WHERE id = ?', [centerId]);
    await db.query('UPDATE gyms SET theme_id = ? WHERE id = ?', [themeId, gymId]);
    const inheritedRes = await request
      .get(`/system/themes/${themeId}/assignments`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(inheritedRes.body.centers.find((c: any) => c.id === centerId)).toMatchObject({
      is_assigned: false,
      is_inherited: true,
    });
    await db.query('UPDATE gyms SET theme_id = NULL WHERE id = ?', [gymId]);
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

  it('reflects is_gym_default in assignments after set-default', async () => {
    const res = await request
      .get(`/system/themes/${themeId}/assignments`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.is_gym_default).toBe(true);
  });

  it('returns 400 when theme is not active', async () => {
    // Set theme to draft first
    await db.query("UPDATE themes SET status = 'draft' WHERE id = ?", [themeId]);
    const res = await request
      .put(`/system/themes/${themeId}/set-default`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
    // Restore active for later tests
    await db.query("UPDATE themes SET status = 'active' WHERE id = ?", [themeId]);
  });
});

// ─── PUT /system/themes/:id/centers (#985 replace-all) ───────────────────────

describe('PUT /system/themes/:id/centers', () => {
  beforeAll(async () => {
    await db.query('UPDATE gyms SET theme_id = NULL WHERE id = ?', [gymId]);
    await db.query('UPDATE centers SET theme_id = NULL WHERE gym_id = ?', [gymId]);
    await db.query("UPDATE themes SET status = 'active' WHERE id = ?", [themeId]);
  });

  async function themeIdOf(id: string) {
    const { rows } = await db.query<{ theme_id: string | null }>(
      'SELECT theme_id FROM centers WHERE id = ?',
      [id],
    );
    return rows[0].theme_id;
  }

  it('returns 401 without auth', async () => {
    const res = await request.put(`/system/themes/${themeId}/centers`).send({ center_ids: [] });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a different gym', async () => {
    const res = await request
      .put(`/system/themes/${themeId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId)
      .send({ center_ids: [] });
    expect(res.status).toBe(403);
  });

  it('returns 404 for a theme not in this gym', async () => {
    const res = await request
      .put(`/system/themes/non-existent-id/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ center_ids: [] });
    expect(res.status).toBe(404);
  });

  it('assigns the submitted centers', async () => {
    const res = await request
      .put(`/system/themes/${themeId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ center_ids: [centerId] });
    expect(res.status).toBe(200);
    expect(res.body.assigned).toEqual([centerId]);
    expect(await themeIdOf(centerId)).toBe(themeId);
  });

  it('restores inheritance for a center the request leaves out', async () => {
    // The replace-all half: an unticked checkbox is what `DELETE
    // /:id/centers/:centerId` ("Restore Inheritance") used to be.
    const res = await request
      .put(`/system/themes/${themeId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ center_ids: [] });
    expect(res.status).toBe(200);
    expect(res.body.assigned).toEqual([]);
    expect(await themeIdOf(centerId)).toBeNull();
  });

  it('is idempotent — submitting the stored set again changes nothing', async () => {
    await request
      .put(`/system/themes/${themeId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ center_ids: [centerId] });
    const res = await request
      .put(`/system/themes/${themeId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ center_ids: [centerId] });
    expect(res.status).toBe(200);
    expect(res.body.assigned).toEqual([centerId]);
    expect(await themeIdOf(centerId)).toBe(themeId);
  });

  it('returns 400 for a payload that is not a list of center ids', async () => {
    // A number *is* a center id here (`centers.id` is an auto-increment integer,
    // migration 043), so the shape error is about values that are not ids at
    // all; an id of the right shape naming no Center is the next test's 400.
    for (const body of [{}, { center_ids: 'a' }, { center_ids: [null] }, { center_ids: [{ id: 1 }] }]) {
      const res = await request
        .put(`/system/themes/${themeId}/centers`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send(body);
      expect(res.status).toBe(400);
    }
    // The refused calls left the stored assignment exactly as it was.
    expect(await themeIdOf(centerId)).toBe(themeId);
  });

  it('returns 400 for a center that is not this gym\'s', async () => {
    for (const ids of [['non-existent-center'], [987654321]]) {
      const res = await request
        .put(`/system/themes/${themeId}/centers`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ center_ids: ids });
      expect(res.status).toBe(400);
    }
    expect(await themeIdOf(centerId)).toBe(themeId);
  });

  it('accepts a center id a client sent as a string', async () => {
    // The browser reads the id out of JSON as a number but may hold it as a
    // string; both resolve against the stored integer, and the response reports
    // the stored form. Cleared first, so this asserts the write and not a no-op.
    await db.query('UPDATE centers SET theme_id = NULL WHERE id = ?', [centerId]);
    const res = await request
      .put(`/system/themes/${themeId}/centers`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ center_ids: [String(centerId)] });
    expect(res.status).toBe(200);
    expect(res.body.assigned).toEqual([centerId]);
    expect(await themeIdOf(centerId)).toBe(themeId);
  });

  it('refuses to assign a theme that is not active', async () => {
    await db.query("UPDATE themes SET status = 'draft' WHERE id = ?", [themeId]);
    try {
      const res = await request
        .put(`/system/themes/${themeId}/centers`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ center_ids: [centerId] });
      expect(res.status).toBe(400);
    } finally {
      await db.query("UPDATE themes SET status = 'active' WHERE id = ?", [themeId]);
    }
  });

  it('still clears the assignments of a theme that is not active', async () => {
    // An empty set is a legitimate save, so a theme taken out of service can be
    // removed from the Centers it was left on.
    await db.query('UPDATE centers SET theme_id = ? WHERE id = ?', [themeId, centerId]);
    await db.query("UPDATE themes SET status = 'inactive' WHERE id = ?", [themeId]);
    try {
      const res = await request
        .put(`/system/themes/${themeId}/centers`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ center_ids: [] });
      expect(res.status).toBe(200);
      expect(await themeIdOf(centerId)).toBeNull();
    } finally {
      await db.query("UPDATE themes SET status = 'active' WHERE id = ?", [themeId]);
    }
  });

  it('has retired the picker routes it replaced', async () => {
    const gone = await Promise.all([
      request
        .get(`/system/themes/${themeId}/unassigned-centers`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId),
      request
        .post(`/system/themes/${themeId}/assign-centers`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ center_ids: [centerId] }),
      request
        .delete(`/system/themes/${themeId}/centers/${centerId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId),
    ]);
    for (const res of gone) expect(res.status).toBe(404);
  });
});

// ─── DELETE /system/themes/:id — blocked when in use ─────────────────────────

describe('DELETE /system/themes/:id (in-use guard)', () => {
  it('returns 409 when theme is set as gym default', async () => {
    await db.query('UPDATE gyms SET theme_id = ? WHERE id = ?', [themeId, gymId]);
    try {
      const res = await request
        .delete(`/system/themes/${themeId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/gym default/i);
    } finally {
      await db.query('UPDATE gyms SET theme_id = NULL WHERE id = ?', [gymId]);
    }
  });

  it('returns 409 when theme is explicitly assigned to a center', async () => {
    await db.query('UPDATE centers SET theme_id = ? WHERE id = ?', [themeId, centerId]);
    try {
      const res = await request
        .delete(`/system/themes/${themeId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/center/i);
    } finally {
      await db.query('UPDATE centers SET theme_id = NULL WHERE id = ?', [centerId]);
    }
  });
});
