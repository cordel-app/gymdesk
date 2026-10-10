// Tests for platform-goal-library.ts router

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, request } from './helpers';

// Override the default @clerk/backend mock: make test-user-id a superadmin.
const mockGetUser = vi.hoisted(() =>
  vi.fn().mockImplementation(async () => ({
    publicMetadata: { platform_role: 'superadmin' },
    fullName: 'Super Admin',
    firstName: 'Super',
    lastName: 'Admin',
  })),
);

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: mockGetUser,
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      },
      invitations: {
        createInvitation: vi.fn().mockResolvedValue({ id: 'inv-test-id' }),
        revokeInvitation: vi.fn().mockResolvedValue({}),
      },
      emailAddresses: {
        getEmailAddress: vi.fn().mockResolvedValue({ emailAddress: 'test@example.com' }),
      },
    })),
  };
});

/**
 * #947 — one router factory serves both goal catalogues, so the suite is
 * parameterised over the same two kinds `api/src/domain/goalLibrary.ts` declares.
 */
const KINDS = [
  {
    label: 'platform personal goals',
    path: '/platform/personal-goals',
    table: 'personal_goals',
    systemSlug: 'weight_loss',
    systemName: 'Weight Loss',
    systemSlugs: ['weight_loss', 'weight_gain', 'muscle_gain', 'maintenance', 'performance', 'recovery', 'energy'],
    /** #1034 §1 — only this kind has `target_value` + `target_unit`. */
    measurable: true,
  },
  {
    label: 'platform nutrition goals',
    path: '/platform/nutrition-goals',
    table: 'nutrition_goals',
    systemSlug: 'protein',
    systemName: 'Protein',
    systemSlugs: ['calories', 'protein', 'carbohydrates', 'fats', 'fiber', 'water', 'fasting'],
    measurable: false,
  },
] as const;

/** Unique per run, so a re-run against the same database cannot collide. */
const RUN = `${Date.now()}`;

/**
 * Every System row (`gym_id IS NULL`) this suite creates, by table. Nothing
 * cascades to them — migration 206's own seeds are deliberately left alone, so
 * these are tracked by id and removed in afterAll.
 */
const createdSystemIds: Record<string, number[]> = { personal_goals: [], nutrition_goals: [] };

/** A gym and two gym-owned goals per table, for the "not visible here" cases. */
let gymId: string;
const gymGoalIds: Record<string, number> = {};
/** The name no System row ever takes, so the search case can assert an empty page. */
const GYM_ONLY_NAME = `PGL Gym Only ${RUN}`;
/** The name a System row deliberately reuses, to prove the keys do not collide. */
const GYM_SHARED_NAME = `PGL Gym Shared ${RUN}`;

beforeAll(async () => {
  gymId = await createTestGym('PGL Test Gym');
  for (const kind of KINDS) {
    const { insertId } = await db.query(
      `INSERT INTO ${kind.table} (gym_id, name, status, created_by_name, created_by_type)
       VALUES (?, ?, 'active', 'Gym Staffer', 'staff')`,
      [gymId, GYM_ONLY_NAME],
    );
    gymGoalIds[kind.table] = insertId;
    await db.query(
      `INSERT INTO ${kind.table} (gym_id, name, status) VALUES (?, ?, 'active')`,
      [gymId, GYM_SHARED_NAME],
    );
  }
});

afterAll(async () => {
  // The gym's own rows cascade with the gym; the System rows created here do not.
  await cleanupTestGyms();
  for (const [table, ids] of Object.entries(createdSystemIds)) {
    if (ids.length === 0) continue;
    const marks = ids.map(() => '?').join(',');
    await db.query(`DELETE FROM ${table} WHERE id IN (${marks})`, ids);
  }
  await db.end();
});

async function createGoal(path: string, table: string, body: Record<string, unknown>) {
  const res = await request.post(path).set('Authorization', TEST_AUTH_HEADER).send(body);
  if (res.status === 201) createdSystemIds[table].push(res.body.id);
  return res;
}

async function listGoals(path: string, query = '') {
  return request.get(`${path}${query}`).set('Authorization', TEST_AUTH_HEADER);
}

for (const kind of KINDS) {
  const { label, path, table } = kind;

  // -------------------------------------------------------------------------
  // Auth + superadmin guards
  // -------------------------------------------------------------------------

  describe(`${label} — auth guard`, () => {
    it('returns 401 without auth on every verb', async () => {
      expect((await request.get(path)).status).toBe(401);
      expect((await request.post(path).send({ name: 'X' })).status).toBe(401);
      expect((await request.put(`${path}/1`).send({ name: 'X' })).status).toBe(401);
      expect((await request.delete(`${path}/1`)).status).toBe(401);
    });
  });

  describe(`${label} — superadmin guard`, () => {
    const regularUser = {
      publicMetadata: {},
      fullName: 'Regular User',
      firstName: 'Regular',
      lastName: 'User',
    };

    it('returns 403 when the user is not a superadmin on list', async () => {
      mockGetUser.mockResolvedValueOnce(regularUser);
      const res = await request.get(path).set('Authorization', TEST_AUTH_HEADER);
      expect(res.status).toBe(403);
    });

    it('returns 403 when the user is not a superadmin on create', async () => {
      mockGetUser.mockResolvedValueOnce(regularUser);
      const res = await request
        .post(path)
        .set('Authorization', TEST_AUTH_HEADER)
        .send({ name: `PGL Forbidden ${RUN}` });
      expect(res.status).toBe(403);
    });

    it('returns 403 when the user is not a superadmin on update and delete', async () => {
      mockGetUser.mockResolvedValueOnce(regularUser);
      expect((await request
        .put(`${path}/1`)
        .set('Authorization', TEST_AUTH_HEADER)
        .send({ name: 'X' })).status).toBe(403);

      mockGetUser.mockResolvedValueOnce(regularUser);
      expect((await request.delete(`${path}/1`).set('Authorization', TEST_AUTH_HEADER)).status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — list, create, update, delete
  // -------------------------------------------------------------------------

  describe(`${label} — happy path`, () => {
    it('lists the seven seeded System rows with their slugs, in the paginated shape', async () => {
      const res = await listGoals(path, '?limit=200');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(typeof res.body.total).toBe('number');
      expect(res.body.limit).toBe(200);
      expect(res.body.offset).toBe(0);

      const slugs = res.body.items.map((g: any) => g.slug);
      expect(slugs).toEqual(expect.arrayContaining([...kind.systemSlugs]));

      const seeded = res.body.items.find((g: any) => g.slug === kind.systemSlug);
      expect(seeded.name).toBe(kind.systemName);
      expect(seeded.gym_id).toBeNull();
      expect(seeded.status).toBe('active');
      // Not masked here: Cordel's own screen shows Cordel's actors.
      expect(seeded.created_by_name).toBe('Cordel');
      expect(seeded.created_by_type).toBe('superadmin');
    });

    it('honours ?limit= and ?offset=', async () => {
      const res = await listGoals(path, '?limit=2&offset=1');
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeLessThanOrEqual(2);
      expect(res.body.limit).toBe(2);
      expect(res.body.offset).toBe(1);
      expect(res.body.total).toBeGreaterThan(2);
    });

    it('creates a System goal with 201, a null gym_id, no slug and the superadmin actor', async () => {
      const name = `PGL Created ${RUN}`;
      const res = await createGoal(path, table, { name, description: '  Platform goal  ' });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe(name);
      expect(res.body.gym_id).toBeNull();
      // The router never writes `slug`: a System goal added later carries the
      // single name entered here, not an invented locale-key handle.
      expect(res.body.slug).toBeNull();
      expect(res.body.status).toBe('active');
      expect(res.body.description).toBe('Platform goal');
      expect(res.body.created_by_name).toBe('Super Admin');
      expect(res.body.created_by_type).toBe('superadmin');
      expect(res.body.modified_by_name).toBeNull();
      expect(res.body.deleted_at).toBeNull();

      const list = await listGoals(path, '?limit=200');
      expect(list.body.items.some((g: any) => g.id === res.body.id)).toBe(true);
    });

    it('renames a System goal with 200 and never writes a slug', async () => {
      const created = await createGoal(path, table, { name: `PGL Rename Before ${RUN}` });
      expect(created.status).toBe(201);

      const renamed = await request
        .put(`${path}/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .send({ name: `PGL Rename After ${RUN}`, slug: 'hacked_slug' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.name).toBe(`PGL Rename After ${RUN}`);
      expect(renamed.body.slug).toBeNull();
      expect(renamed.body.modified_by_name).toBe('Super Admin');
      expect(renamed.body.modified_by_type).toBe('superadmin');
      expect(renamed.body.modified_at).not.toBeNull();

      const { rows } = await db.query<{ slug: string | null }>(`SELECT slug FROM ${table} WHERE id = ?`, [created.body.id]);
      expect(rows[0].slug).toBeNull();
    });

    it('soft-deletes a System goal, hides it, lists it under ?status=deleted, then 409s', async () => {
      const created = await createGoal(path, table, { name: `PGL Deletable ${RUN}` });
      expect(created.status).toBe(201);
      const id = created.body.id;

      const del = await request.delete(`${path}/${id}`).set('Authorization', TEST_AUTH_HEADER);
      expect(del.status).toBe(204);

      const active = await listGoals(path, '?limit=200');
      expect(active.body.items.some((g: any) => g.id === id)).toBe(false);
      for (const item of active.body.items) expect(item.status).not.toBe('deleted');

      const deleted = await listGoals(path, '?status=deleted&limit=200');
      expect(deleted.status).toBe(200);
      const found = deleted.body.items.find((g: any) => g.id === id);
      expect(found).toBeDefined();
      expect(found.status).toBe('deleted');
      expect(found.deleted_at).not.toBeNull();
      expect(found.deleted_by_name).toBe('Super Admin');
      expect(found.deleted_by_type).toBe('superadmin');

      // Deleting or updating an already-deleted goal is a 409, not a second delete.
      expect((await request.delete(`${path}/${id}`).set('Authorization', TEST_AUTH_HEADER)).status).toBe(409);
      const put = await request
        .put(`${path}/${id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .send({ name: `PGL Ghost ${RUN}` });
      expect(put.status).toBe(409);
    });

    it('returns 404 for an unknown id on update and delete', async () => {
      const put = await request
        .put(`${path}/99999999`)
        .set('Authorization', TEST_AUTH_HEADER)
        .send({ name: 'Nope' });
      expect(put.status).toBe(404);
      expect((await request.delete(`${path}/99999999`).set('Authorization', TEST_AUTH_HEADER)).status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // A gym's own goal is never visible or writable here
  // -------------------------------------------------------------------------

  describe(`${label} — a gym's own goal belongs to the gym router`, () => {
    it('does not list a gym-owned goal', async () => {
      const res = await listGoals(path, '?limit=200');
      expect(res.status).toBe(200);
      expect(res.body.items.some((g: any) => g.id === gymGoalIds[table])).toBe(false);
      for (const item of res.body.items) expect(item.gym_id).toBeNull();
    });

    it('does not list a gym-owned goal under ?search= either', async () => {
      const res = await listGoals(path, `?search=${encodeURIComponent(GYM_ONLY_NAME)}&limit=200`);
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.total).toBe(0);
    });

    it('returns 404 when updating a gym-owned goal', async () => {
      const res = await request
        .put(`${path}/${gymGoalIds[table]}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .send({ name: `PGL Platform Reach ${RUN}` });
      expect(res.status).toBe(404);

      const { rows } = await db.query<{ name: string }>(`SELECT name FROM ${table} WHERE id = ?`, [gymGoalIds[table]]);
      expect(rows[0].name).toBe(GYM_ONLY_NAME);
    });

    it('returns 404 when deleting a gym-owned goal', async () => {
      const res = await request
        .delete(`${path}/${gymGoalIds[table]}`)
        .set('Authorization', TEST_AUTH_HEADER);
      expect(res.status).toBe(404);

      const { rows } = await db.query<{ status: string }>(`SELECT status FROM ${table} WHERE id = ?`, [gymGoalIds[table]]);
      expect(rows[0].status).toBe('active');
    });
  });

  // -------------------------------------------------------------------------
  // Live-name uniqueness among the System rows
  // -------------------------------------------------------------------------

  describe(`${label} — live name uniqueness`, () => {
    it('returns 409 for a duplicate System name', async () => {
      const name = `PGL Duplicate ${RUN}`;
      expect((await createGoal(path, table, { name })).status).toBe(201);
      const second = await createGoal(path, table, { name });
      expect(second.status).toBe(409);
      expect(second.body.error).toBe('A goal with this name already exists');
    });

    it('returns 409 for a seeded System name', async () => {
      const res = await createGoal(path, table, { name: kind.systemName });
      expect(res.status).toBe(409);
    });

    it('returns 409 when a rename collides with another live System goal', async () => {
      const taken = `PGL Taken ${RUN}`;
      expect((await createGoal(path, table, { name: taken })).status).toBe(201);
      const other = await createGoal(path, table, { name: `PGL Renamer ${RUN}` });
      expect(other.status).toBe(201);

      const res = await request
        .put(`${path}/${other.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .send({ name: taken });
      expect(res.status).toBe(409);
    });

    it('does not collide with a gym\'s goal of the same name', async () => {
      // `live_name_key` is (gym, name): ':X' and '<gym>:X' are different keys.
      const res = await createGoal(path, table, { name: GYM_SHARED_NAME });
      expect(res.status).toBe(201);
      expect(res.body.gym_id).toBeNull();
    });

    it('frees the name on soft delete so it can be re-created', async () => {
      const name = `PGL Reusable ${RUN}`;
      const first = await createGoal(path, table, { name });
      expect(first.status).toBe(201);

      expect((await request.delete(`${path}/${first.body.id}`).set('Authorization', TEST_AUTH_HEADER)).status).toBe(204);

      // This is what the VIRTUAL live_name_key exists for: a deleted row's key
      // is NULL, so the UNIQUE index no longer reserves the name.
      const again = await createGoal(path, table, { name });
      expect(again.status).toBe(201);
      expect(again.body.id).not.toBe(first.body.id);
      expect(again.body.name).toBe(name);
    });
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  describe(`${label} — validation`, () => {
    it('returns 400 when name is missing, blank or not a string', async () => {
      expect((await createGoal(path, table, {})).status).toBe(400);
      expect((await createGoal(path, table, { name: '   ' })).status).toBe(400);
      expect((await createGoal(path, table, { name: 42 })).status).toBe(400);
    });

    it('returns 400 for a name longer than 255 characters, and accepts exactly 255', async () => {
      expect((await createGoal(path, table, { name: 'x'.repeat(256) })).status).toBe(400);

      const exactly255 = `${'z'.repeat(255 - RUN.length)}${RUN}`;
      expect(exactly255).toHaveLength(255);
      const ok = await createGoal(path, table, { name: exactly255 });
      expect(ok.status).toBe(201);
      expect(ok.body.name).toBe(exactly255);
    });

    it('returns 400 for a blank name on PUT, and leaves the goal alone', async () => {
      const created = await createGoal(path, table, { name: `PGL Blank Put ${RUN}` });
      expect(created.status).toBe(201);

      const res = await request
        .put(`${path}/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .send({ name: '  ' });
      expect(res.status).toBe(400);

      const { rows } = await db.query<{ name: string }>(`SELECT name FROM ${table} WHERE id = ?`, [created.body.id]);
      expect(rows[0].name).toBe(`PGL Blank Put ${RUN}`);
    });

    it('returns 400 for an over-long or non-string description', async () => {
      expect((await createGoal(path, table, { name: `PGL Long Desc ${RUN}`, description: 'x'.repeat(1001) })).status).toBe(400);
      expect((await createGoal(path, table, { name: `PGL Bad Desc ${RUN}`, description: { nope: true } })).status).toBe(400);
    });

    it('leaves the description alone when a PUT does not mention it, and clears it on an empty string', async () => {
      const created = await createGoal(path, table, { name: `PGL Desc ${RUN}`, description: 'Keep me' });
      expect(created.status).toBe(201);
      expect(created.body.description).toBe('Keep me');

      const renamed = await request
        .put(`${path}/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .send({ name: `PGL Desc Renamed ${RUN}` });
      expect(renamed.status).toBe(200);
      expect(renamed.body.description).toBe('Keep me');

      const cleared = await request
        .put(`${path}/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .send({ description: '' });
      expect(cleared.status).toBe(200);
      expect(cleared.body.description).toBeNull();
      expect(cleared.body.name).toBe(`PGL Desc Renamed ${RUN}`);
    });
  });

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // #1034 — Cordel administers the Base library's own targets
  // -------------------------------------------------------------------------

  describe(`${label} — target value and unit (#1034 §1)`, () => {
    it(kind.measurable ? 'is administered here, on a System row' : 'is not a field of this kind', async () => {
      if (!kind.measurable) {
        const listed = await listGoals(path, '?limit=5');
        expect(listed.status).toBe(200);
        expect(listed.body.items[0]).not.toHaveProperty('target_value');
        return;
      }

      // The seeded defaults migration 218 writes (§2), which migration 245
      // (#1229) turns into a *relative* target for the goals whose meaning is a
      // change: losing 3 kg is -3, not "reach 3 kg".
      const listed = await listGoals(path, '?limit=200');
      const seeded = listed.body.items.find((g: any) => g.slug === 'weight_loss');
      expect(seeded).toMatchObject({ target_value: -3, target_unit: 'kg', target_type: 'relative' });

      // A Base goal Cordel adds carries one of its own, reported as a number.
      const created = await createGoal(path, table, {
        name: `PGL Target ${RUN}`, target_value: '70', target_unit: 'kg',
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ target_value: 70, target_unit: 'kg' });

      // The partial-update rule, and the explicit clear beside it.
      const renamed = await request.put(`${path}/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .send({ name: `PGL Target B ${RUN}` });
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({ target_value: 70, target_unit: 'kg' });

      const cleared = await request.put(`${path}/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .send({ target_value: null, target_unit: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.target_value).toBeNull();

      // A unit with nothing to qualify is a 400, not the CHECK's 500 (#966).
      const orphaned = await request.put(`${path}/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .send({ target_unit: 'kg' });
      expect(orphaned.status).toBe(400);
    });
  });

  describe(`${label} — ?search=`, () => {
    it('matches a System goal name', async () => {
      const name = `PGL Searchable ${RUN}`;
      const created = await createGoal(path, table, { name });
      expect(created.status).toBe(201);

      const res = await listGoals(path, `?search=${encodeURIComponent('Searchable')}&limit=200`);
      expect(res.status).toBe(200);
      expect(res.body.items.some((g: any) => g.id === created.body.id)).toBe(true);
    });

    it('matches a seeded row\'s slug', async () => {
      const res = await listGoals(path, `?search=${encodeURIComponent(kind.systemSlug)}&limit=200`);
      expect(res.status).toBe(200);
      const found = res.body.items.find((g: any) => g.slug === kind.systemSlug);
      expect(found).toBeDefined();
      expect(found.name).toBe(kind.systemName);
    });

    it('returns an empty page for a term nothing matches', async () => {
      const res = await listGoals(path, `?search=${encodeURIComponent(`no-such-goal-${RUN}`)}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.total).toBe(0);
    });
  });
}
