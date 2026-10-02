// Tests for goal-library.ts router

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { invalidateFeatureFlagsCache } from '../infra/featureFlags';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

/**
 * #947 — one router factory serves both goal catalogues, so the suite is
 * parameterised over the same two kinds `api/src/domain/goalLibrary.ts` declares.
 * Every case below therefore runs twice, once per table, which is what keeps the
 * two from drifting apart.
 */
const KINDS = [
  {
    label: 'personal goals',
    path: '/personal-goals',
    table: 'personal_goals',
    checkName: 'chk_pgoal_slug_system_only',
    // One of migration 206's seeded System rows, and all seven slugs.
    systemSlug: 'weight_loss',
    systemName: 'Weight Loss',
    systemSlugs: ['weight_loss', 'weight_gain', 'muscle_gain', 'maintenance', 'performance', 'recovery', 'energy'],
  },
  {
    label: 'nutrition goals',
    path: '/nutrition-goals',
    table: 'nutrition_goals',
    checkName: 'chk_ngoal_slug_system_only',
    systemSlug: 'protein',
    systemName: 'Protein',
    systemSlugs: ['calories', 'protein', 'carbohydrates', 'fats', 'fiber', 'water', 'fasting'],
  },
] as const;

let gymId: string;
let otherGymId: string;
let frontDeskGymId: string;

/** Unique per run, so a re-run against the same database cannot collide. */
const RUN = `${Date.now()}`;

beforeAll(async () => {
  gymId = await createTestGym('GL Test Gym');
  await createTestMembership(gymId, 'admin');

  // Same TEST_USER_ID as an admin of a second gym — lets the tenant-isolation
  // cases pass the auth/module-access middleware and reach the router's own
  // gym_id ownership check.
  otherGymId = await createTestGym('GL Other Gym');
  await createTestMembership(otherGymId, 'admin');

  // front_desk has 'R' on NUTRITION: it may list, but every write is a 403.
  frontDeskGymId = await createTestGym('GL Front Desk Gym');
  await createTestMembership(frontDeskGymId, 'front_desk');
});

afterAll(async () => {
  // The gyms' own goal rows cascade with the gym (both FKs are ON DELETE
  // CASCADE, and cleanupTestGyms names the two tables explicitly). This suite
  // creates no `gym_id IS NULL` row, so migration 206's seeds are untouched.
  await cleanupTestGyms();
  await db.end();
});

/** Creates a goal through the API and returns the response body. */
async function createGoal(path: string, body: Record<string, unknown>, gym = gymId) {
  return request
    .post(path)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gym)
    .send(body);
}

async function listGoals(path: string, query = '', gym = gymId) {
  return request
    .get(`${path}${query}`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gym);
}

/** The id of one of migration 206's seeded System rows (never mutated here). */
async function systemGoalId(table: string, slug: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM ${table} WHERE gym_id IS NULL AND slug = ?`,
    [slug],
  );
  return rows[0]?.id;
}

for (const kind of KINDS) {
  const { label, path, table } = kind;

  // -------------------------------------------------------------------------
  // Auth guard
  // -------------------------------------------------------------------------

  describe(`${label} — auth guard`, () => {
    it('returns 401 without auth on list', async () => {
      const res = await request.get(path);
      expect(res.status).toBe(401);
    });

    it('returns 401 without auth on create, update and delete', async () => {
      expect((await request.post(path).send({ name: 'X' })).status).toBe(401);
      expect((await request.put(`${path}/1`).send({ name: 'X' })).status).toBe(401);
      expect((await request.delete(`${path}/1`)).status).toBe(401);
    });

    it('returns 401 when authenticated without an x-gym-id header', async () => {
      const res = await request.get(path).set('Authorization', TEST_AUTH_HEADER);
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // Role guard — front_desk reads but never writes
  // -------------------------------------------------------------------------

  describe(`${label} — role guard (front_desk has R on NUTRITION)`, () => {
    it('lets front_desk list the catalogue', async () => {
      const res = await listGoals(path, '?limit=200', frontDeskGymId);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
    });

    it('returns 403 for front_desk on create', async () => {
      const res = await createGoal(path, { name: `FD Create ${RUN}` }, frontDeskGymId);
      expect(res.status).toBe(403);
    });

    it('returns 403 for front_desk on update and delete', async () => {
      const own = await createGoal(path, { name: `FD Target ${RUN}` });
      expect(own.status).toBe(201);

      const put = await request
        .put(`${path}/${own.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', frontDeskGymId)
        .send({ name: `FD Renamed ${RUN}` });
      expect(put.status).toBe(403);

      const del = await request
        .delete(`${path}/${own.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', frontDeskGymId);
      expect(del.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — list, create, update, delete
  // -------------------------------------------------------------------------

  describe(`${label} — happy path`, () => {
    it('lists the seven seeded System rows, with their slugs, in the paginated shape', async () => {
      const res = await listGoals(path, '?limit=200');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(typeof res.body.total).toBe('number');
      expect(res.body.limit).toBe(200);
      expect(res.body.offset).toBe(0);

      const systemRows = res.body.items.filter((g: any) => g.gym_id === null);
      const slugs = systemRows.map((g: any) => g.slug);
      expect(slugs).toEqual(expect.arrayContaining([...kind.systemSlugs]));
      expect(systemRows.length).toBeGreaterThanOrEqual(7);

      const seeded = res.body.items.find((g: any) => g.slug === kind.systemSlug);
      expect(seeded.name).toBe(kind.systemName);
      expect(seeded.status).toBe('active');
    });

    it('honours ?limit= and ?offset=', async () => {
      const res = await listGoals(path, '?limit=2&offset=1');
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeLessThanOrEqual(2);
      expect(res.body.limit).toBe(2);
      expect(res.body.offset).toBe(1);
      expect(res.body.total).toBeGreaterThan(2);
    });

    it('creates a gym-owned goal with 201, a gym_id and no slug', async () => {
      const name = `GL Created ${RUN}`;
      const res = await createGoal(path, { name, description: '  A goal  ' });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe(name);
      expect(res.body.gym_id).toBe(gymId);
      // `slug` is a System row's label handle: a gym row may never carry one.
      expect(res.body.slug).toBeNull();
      expect(res.body.status).toBe('active');
      expect(res.body.description).toBe('A goal');
      expect(res.body.deleted_at).toBeNull();

      const list = await listGoals(path, '?limit=200');
      expect(list.body.items.some((g: any) => g.id === res.body.id)).toBe(true);
    });

    it('renames a gym-owned goal with 200', async () => {
      const created = await createGoal(path, { name: `GL Rename Before ${RUN}` });
      expect(created.status).toBe(201);

      const renamed = await request
        .put(`${path}/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: `GL Rename After ${RUN}` });
      expect(renamed.status).toBe(200);
      expect(renamed.body.name).toBe(`GL Rename After ${RUN}`);
      expect(renamed.body.id).toBe(created.body.id);
      expect(renamed.body.modified_at).not.toBeNull();
    });

    it('soft-deletes a gym-owned goal with 204 and hides it from the list', async () => {
      const created = await createGoal(path, { name: `GL Delete ${RUN}` });
      expect(created.status).toBe(201);

      const del = await request
        .delete(`${path}/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(del.status).toBe(204);

      const list = await listGoals(path, '?limit=200');
      expect(list.body.items.some((g: any) => g.id === created.body.id)).toBe(false);

      // Soft, not hard: the row is still there, flagged and stamped.
      const { rows } = await db.query<{ status: string; deleted_at: string | null; deleted_by_name: string | null }>(
        `SELECT status, deleted_at, deleted_by_name FROM ${table} WHERE id = ?`,
        [created.body.id],
      );
      expect(rows[0].status).toBe('deleted');
      expect(rows[0].deleted_at).not.toBeNull();
      expect(rows[0].deleted_by_name).toBe('Test User');
    });

    it('returns 409 on update or delete of an already-deleted goal, and 404 for an unknown id', async () => {
      const created = await createGoal(path, { name: `GL Gone ${RUN}` });
      const del = await request
        .delete(`${path}/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(del.status).toBe(204);

      const again = await request
        .delete(`${path}/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(again.status).toBe(409);

      const put = await request
        .put(`${path}/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: `GL Ghost ${RUN}` });
      expect(put.status).toBe(409);

      const missing = await request
        .put(`${path}/99999999`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: 'Nope' });
      expect(missing.status).toBe(404);
      expect((await request
        .delete(`${path}/99999999`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)).status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  describe(`${label} — tenant isolation`, () => {
    let ownId: number;

    beforeAll(async () => {
      const res = await createGoal(path, { name: `GL Tenant ${RUN}` });
      expect(res.status).toBe(201);
      ownId = res.body.id;
    });

    it('does not list gym A\'s goal for gym B', async () => {
      const res = await listGoals(path, '?limit=200', otherGymId);
      expect(res.status).toBe(200);
      expect(res.body.items.some((g: any) => g.id === ownId)).toBe(false);
      // Gym B still sees the shared System catalogue.
      expect(res.body.items.some((g: any) => g.slug === kind.systemSlug)).toBe(true);
    });

    it('returns 404 when gym B updates gym A\'s goal', async () => {
      const res = await request
        .put(`${path}/${ownId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', otherGymId)
        .send({ name: `GL Cross Tenant ${RUN}` });
      expect(res.status).toBe(404);
    });

    it('returns 404 when gym B deletes gym A\'s goal', async () => {
      const res = await request
        .delete(`${path}/${ownId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', otherGymId);
      expect(res.status).toBe(404);

      const { rows } = await db.query<{ status: string }>(`SELECT status FROM ${table} WHERE id = ?`, [ownId]);
      expect(rows[0].status).toBe('active');
    });
  });

  // -------------------------------------------------------------------------
  // System rows are read-only here
  // -------------------------------------------------------------------------

  describe(`${label} — System rows are read-only on the gym router`, () => {
    let seededId: number;

    beforeAll(async () => {
      seededId = await systemGoalId(table, kind.systemSlug);
      expect(seededId).toBeGreaterThan(0);
    });

    it('returns 403 on PUT of a System goal', async () => {
      const res = await request
        .put(`${path}/${seededId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: 'Hijacked' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('System goals are read-only');
    });

    it('returns 403 on DELETE of a System goal, leaving it untouched', async () => {
      const res = await request
        .delete(`${path}/${seededId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(403);

      const { rows } = await db.query<{ name: string; status: string; modified_at: string | null }>(
        `SELECT name, status, modified_at FROM ${table} WHERE id = ?`,
        [seededId],
      );
      expect(rows[0].name).toBe(kind.systemName);
      expect(rows[0].status).toBe('active');
      expect(rows[0].modified_at).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Live-name uniqueness (the live_name_key generated column)
  // -------------------------------------------------------------------------

  describe(`${label} — live name uniqueness`, () => {
    it('returns 409 for a duplicate live name in the same gym', async () => {
      const name = `GL Duplicate ${RUN}`;
      expect((await createGoal(path, { name })).status).toBe(201);
      const second = await createGoal(path, { name });
      expect(second.status).toBe(409);
      expect(second.body.error).toBe('A goal with this name already exists');
    });

    it('returns 409 when a rename collides with another live goal of the same gym', async () => {
      const taken = `GL Taken ${RUN}`;
      expect((await createGoal(path, { name: taken })).status).toBe(201);
      const other = await createGoal(path, { name: `GL Renamer ${RUN}` });
      expect(other.status).toBe(201);

      const res = await request
        .put(`${path}/${other.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: taken });
      expect(res.status).toBe(409);
    });

    it('lets a gym create a goal named like a System one', async () => {
      // `live_name_key` is (gym, name), so ':Weight Loss' and
      // '<gym>:Weight Loss' are different keys.
      const res = await createGoal(path, { name: kind.systemName });
      expect(res.status).toBe(201);
      expect(res.body.gym_id).toBe(gymId);
      expect(res.body.slug).toBeNull();
    });

    it('lets two different gyms each hold a goal of the same name', async () => {
      const name = `GL Shared Name ${RUN}`;
      expect((await createGoal(path, { name })).status).toBe(201);
      const other = await createGoal(path, { name }, otherGymId);
      expect(other.status).toBe(201);
      expect(other.body.gym_id).toBe(otherGymId);
    });

    it('frees the name on soft delete so it can be re-created', async () => {
      const name = `GL Reusable ${RUN}`;
      const first = await createGoal(path, { name });
      expect(first.status).toBe(201);

      const del = await request
        .delete(`${path}/${first.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(del.status).toBe(204);

      // This is what the VIRTUAL live_name_key exists for: a deleted row's key
      // is NULL, so the UNIQUE index no longer reserves the name.
      const again = await createGoal(path, { name });
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
      expect((await createGoal(path, {})).status).toBe(400);
      expect((await createGoal(path, { name: '   ' })).status).toBe(400);
      expect((await createGoal(path, { name: 42 })).status).toBe(400);
    });

    it('returns 400 for a name longer than 255 characters, and accepts exactly 255', async () => {
      const tooLong = await createGoal(path, { name: 'x'.repeat(256) });
      expect(tooLong.status).toBe(400);

      const exactly255 = `${'y'.repeat(255 - RUN.length)}${RUN}`;
      expect(exactly255).toHaveLength(255);
      const ok = await createGoal(path, { name: exactly255 });
      expect(ok.status).toBe(201);
      expect(ok.body.name).toBe(exactly255);
    });

    it('returns 400 for a blank name on PUT, and leaves the goal alone', async () => {
      const created = await createGoal(path, { name: `GL Blank Put ${RUN}` });
      expect(created.status).toBe(201);

      const res = await request
        .put(`${path}/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: '  ' });
      expect(res.status).toBe(400);

      const { rows } = await db.query<{ name: string }>(`SELECT name FROM ${table} WHERE id = ?`, [created.body.id]);
      expect(rows[0].name).toBe(`GL Blank Put ${RUN}`);
    });

    it('returns 400 for an over-long or non-string description', async () => {
      expect((await createGoal(path, { name: `GL Long Desc ${RUN}`, description: 'x'.repeat(1001) })).status).toBe(400);
      expect((await createGoal(path, { name: `GL Bad Desc ${RUN}`, description: { nope: true } })).status).toBe(400);
    });

    it('leaves the description alone when a PUT does not mention it, and clears it on an empty string', async () => {
      const created = await createGoal(path, { name: `GL Desc ${RUN}`, description: 'Keep me' });
      expect(created.status).toBe(201);
      expect(created.body.description).toBe('Keep me');

      const renamed = await request
        .put(`${path}/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: `GL Desc Renamed ${RUN}` });
      expect(renamed.status).toBe(200);
      expect(renamed.body.description).toBe('Keep me');

      const cleared = await request
        .put(`${path}/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ description: '' });
      expect(cleared.status).toBe(200);
      expect(cleared.body.description).toBeNull();
      expect(cleared.body.name).toBe(`GL Desc Renamed ${RUN}`);
    });
  });

  // -------------------------------------------------------------------------
  // A gym row can never carry a slug
  // -------------------------------------------------------------------------

  describe(`${label} — a gym row carries no slug`, () => {
    it('ignores a slug submitted on create', async () => {
      const res = await createGoal(path, { name: `GL Slug Attempt ${RUN}`, slug: 'hacked_slug' });
      expect(res.status).toBe(201);
      expect(res.body.slug).toBeNull();

      const { rows } = await db.query<{ slug: string | null }>(`SELECT slug FROM ${table} WHERE id = ?`, [res.body.id]);
      expect(rows[0].slug).toBeNull();
    });

    it('ignores a slug submitted on update', async () => {
      const created = await createGoal(path, { name: `GL Slug Update ${RUN}` });
      const res = await request
        .put(`${path}/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: `GL Slug Update Renamed ${RUN}`, slug: 'hacked_slug' });
      expect(res.status).toBe(200);
      expect(res.body.slug).toBeNull();
    });

    it(`is refused by ${kind.checkName} on a direct INSERT of gym_id + slug`, async () => {
      await expect(
        db.query(
          `INSERT INTO ${table} (gym_id, slug, name) VALUES (?, ?, ?)`,
          [gymId, `gl_check_${RUN}`, `GL Check ${RUN}`],
        ),
      ).rejects.toThrow(/slug_system_only/i);
    });
  });

  // -------------------------------------------------------------------------
  // Actor snapshot + masking of the System rows' Cordel actors
  // -------------------------------------------------------------------------

  describe(`${label} — actor snapshot`, () => {
    it('snapshots the creating actor, then the modifying one', async () => {
      const created = await createGoal(path, { name: `GL Actor ${RUN}` });
      expect(created.status).toBe(201);
      expect(created.body.created_by_name).toBe('Test User');
      expect(created.body.created_by_type).toBe('staff');
      expect(created.body.modified_by_name).toBeNull();
      expect(created.body.deleted_by_name).toBeNull();

      const updated = await request
        .put(`${path}/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ description: 'Edited' });
      expect(updated.status).toBe(200);
      expect(updated.body.created_by_name).toBe('Test User');
      expect(updated.body.modified_by_name).toBe('Test User');
      expect(updated.body.modified_by_type).toBe('staff');
    });

    it('masks a System row\'s actor names while keeping the gym\'s own', async () => {
      const own = await createGoal(path, { name: `GL Own Actor ${RUN}` });
      expect(own.status).toBe(201);

      const list = await listGoals(path, '?limit=200');
      expect(list.status).toBe(200);

      // The seeded System rows are administered from Cordel: the catalogue is
      // shared, the actor names are not.
      const seeded = list.body.items.find((g: any) => g.slug === kind.systemSlug);
      expect(seeded.created_by_name).toBeNull();
      expect(seeded.created_by_type).toBeNull();
      expect(seeded.modified_by_name).toBeNull();
      expect(seeded.deleted_by_name).toBeNull();
      // The dates are not masked — they name nobody.
      expect(seeded.created_at).toBeTruthy();
      // The row really does carry a Cordel actor underneath.
      const { rows } = await db.query<{ created_by_name: string | null }>(
        `SELECT created_by_name FROM ${table} WHERE gym_id IS NULL AND slug = ?`,
        [kind.systemSlug],
      );
      expect(rows[0].created_by_name).toBe('Cordel');

      const mine = list.body.items.find((g: any) => g.id === own.body.id);
      expect(mine.created_by_name).toBe('Test User');
      expect(mine.created_by_type).toBe('staff');
    });

    it('returns every detail column on both a System and a gym row', async () => {
      const own = await createGoal(path, { name: `GL Shape ${RUN}` });
      const list = await listGoals(path, '?limit=200');
      const rows = [
        list.body.items.find((g: any) => g.slug === kind.systemSlug),
        list.body.items.find((g: any) => g.id === own.body.id),
      ];
      for (const row of rows) {
        for (const key of [
          'id', 'gym_id', 'slug', 'name', 'status', 'created_at', 'modified_at', 'description',
          'created_by_name', 'created_by_type', 'modified_by_name', 'modified_by_type',
          'deleted_at', 'deleted_by_name', 'deleted_by_type',
        ]) {
          expect(row, `the list row must carry ${key}`).toHaveProperty(key);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  describe(`${label} — ?search=`, () => {
    it('matches a goal name', async () => {
      const name = `GL Searchable ${RUN}`;
      const created = await createGoal(path, { name });
      expect(created.status).toBe(201);

      const res = await listGoals(path, `?search=${encodeURIComponent('Searchable')}&limit=200`);
      expect(res.status).toBe(200);
      expect(res.body.items.some((g: any) => g.id === created.body.id)).toBe(true);
      expect(res.body.total).toBeGreaterThan(0);
    });

    it('matches a System row\'s slug', async () => {
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

/**
 * #948 §3/§8/§9 — Personal Goals is its own admin section now, not a tab of the
 * Nutrition Library, so it is gated by its own feature flag. The two keys have to
 * be independent in **both** directions: hiding Foods must not 403 a section of a
 * different domain, and hiding Personal Goals must not take the Nutrition Library
 * down with it.
 *
 * The caller is a gym admin rather than a superadmin, since a superadmin acting as
 * themselves bypasses every flag.
 */
describe('#948 — Personal Goals has its own feature flag', () => {
  const LIBRARY_KEY = 'nutrition.nutrition_library';
  const PERSONAL_KEY = 'nutrition.personal_goals';
  let original: Record<string, number> = {};

  beforeAll(async () => {
    const { rows } = await db.query<{ feature_key: string; enabled: number }>(
      'SELECT feature_key, enabled FROM feature_flags WHERE feature_key IN (?, ?)',
      [LIBRARY_KEY, PERSONAL_KEY],
    );
    original = Object.fromEntries(rows.map((r) => [r.feature_key, r.enabled]));
  });

  afterEach(async () => {
    for (const [key, enabled] of Object.entries(original)) {
      await db.query('UPDATE feature_flags SET enabled = ? WHERE feature_key = ?', [enabled, key]);
    }
    invalidateFeatureFlagsCache();
  });

  async function setFlag(key: string, enabled: boolean) {
    await db.query('UPDATE feature_flags SET enabled = ? WHERE feature_key = ?', [enabled ? 1 : 0, key]);
    invalidateFeatureFlagsCache();
  }

  it('seeds the key migration 211 adds, so it is switchable on Cordel → Feature Flags', () => {
    // A missing key already counts as enabled, so the row exists to make the flag
    // visible — and its absence would mean the migration never ran.
    expect(Object.keys(original).sort()).toEqual([LIBRARY_KEY, PERSONAL_KEY].sort());
  });

  it('is enabled by default, so an existing platform sees the new section', async () => {
    expect((await listGoals('/personal-goals')).status).toBe(200);
  });

  it('hiding the Nutrition Library leaves Personal Goals readable', async () => {
    await setFlag(LIBRARY_KEY, false);
    expect((await listGoals('/nutrition-goals')).status).toBe(403);
    expect((await listGoals('/personal-goals')).status).toBe(200);
  });

  it('hiding Personal Goals leaves the Nutrition Library readable', async () => {
    await setFlag(PERSONAL_KEY, false);
    expect((await listGoals('/personal-goals')).status).toBe(403);
    expect((await listGoals('/nutrition-goals')).status).toBe(200);
  });

  it('the Nutrition group flag still blocks both', async () => {
    await db.query("UPDATE feature_flags SET enabled = 0 WHERE feature_key = 'nutrition'");
    invalidateFeatureFlagsCache();
    try {
      expect((await listGoals('/personal-goals')).status).toBe(403);
      expect((await listGoals('/nutrition-goals')).status).toBe(403);
    } finally {
      await db.query("UPDATE feature_flags SET enabled = 1 WHERE feature_key = 'nutrition'");
      invalidateFeatureFlagsCache();
    }
  });
});
