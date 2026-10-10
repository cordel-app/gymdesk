/**
 * #969 stage 2 — the other two exercise screens filtered server-side: a gym's
 * own Exercises list (`GET /exercises`) and the Import modal's view of the
 * library (`GET /exercises/base`), plus the facets each of them offers.
 *
 * The point of the stage is §19: one filter vocabulary and one `WHERE` builder
 * (`domain/exerciseListFilters.ts`) behind all three screens, rather than three
 * readings of `?muscle=`. So what is asserted here is that these two routes
 * answer the *same* parameters the platform list does — and the two places they
 * deliberately differ:
 *
 *  * a gym's own exercises carry **no slug**, so `withSlug: false` keeps `?q=`
 *    from matching one and `?slug=` from narrowing anything;
 *  * the facets are scoped per screen, so one gym's values never reach another
 *    gym's dropdowns and a gym's own value never reaches the library's.
 *
 * Integration, because every one of those rules is SQL: the rows go in with
 * `db.query` and the filtering is exercised over HTTP (the CLAUDE.md rule).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const suffix = `${Date.now()}`;

let gymId: string;
let otherGymId: string;
/** The gym's own exercises: chest+triceps, back only, and an inactive one. */
let benchId: number;
let rowId: number;
let inactiveId: number;
let deletedId: number;
/** A gym row carrying a slug and metadata, to pin what this screen does *not* offer. */
let metadataId: number;
/** Another gym's exercise, for the facets' tenant isolation. */
let foreignId: number;
/** The library: two active Base Exercises and one inactive one. */
const baseIds: number[] = [];

const GYM_EQUIPMENT = `gym-equipment-${suffix}`;
const BASE_EQUIPMENT = `base-equipment-${suffix}`;
const INACTIVE_BASE_EQUIPMENT = `inactive-base-equipment-${suffix}`;

async function insertGymExercise(
  gym: string,
  name: string,
  opts: { status?: string; slug?: string | null; equipment?: string | null } = {},
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO exercises (gym_id, name, status, slug, equipment) VALUES (?, ?, ?, ?, ?)`,
    [gym, name, opts.status ?? 'active', opts.slug ?? null, opts.equipment ?? null],
  );
  return Number(insertId);
}

async function insertBaseExercise(
  name: string,
  opts: { status?: string; slug?: string | null; equipment?: string | null; category?: string | null } = {},
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO exercises (gym_id, name, status, slug, equipment, category)
     VALUES (NULL, ?, ?, ?, ?, ?)`,
    [name, opts.status ?? 'active', opts.slug ?? null, opts.equipment ?? null, opts.category ?? null],
  );
  baseIds.push(Number(insertId));
  return Number(insertId);
}

async function link(gym: string | null, exerciseId: number, muscle: string, role: 'principal' | 'secondary') {
  await db.query(
    'INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (?, ?, ?, ?)',
    [gym, exerciseId, muscle, role],
  );
}

beforeAll(async () => {
  gymId = await createTestGym(`Exercise Filters Gym ${suffix}`);
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym(`Exercise Filters Other Gym ${suffix}`);
  await createTestMembership(otherGymId, 'admin');

  benchId = await insertGymExercise(gymId, `Zz969 Bench Press ${suffix}`);
  await link(gymId, benchId, 'chest', 'principal');
  await link(gymId, benchId, 'triceps', 'secondary');

  rowId = await insertGymExercise(gymId, `Zz969 Barbell Row ${suffix}`);
  await link(gymId, rowId, 'back', 'principal');

  inactiveId = await insertGymExercise(gymId, `Zz969 Retired Lunge ${suffix}`, { status: 'inactive' });
  deletedId = await insertGymExercise(gymId, `Zz969 Deleted Press ${suffix}`, { status: 'deleted' });

  // A gym row that *does* carry a slug and an equipment value. Neither is
  // written by any editor (#969's own note) — it is here to pin that the gym
  // screen neither searches the one nor is blind to the other in its facets.
  metadataId = await insertGymExercise(gymId, `Zz969 Metadata Carrier ${suffix}`, {
    slug: `zz969-metadata-carrier-${suffix}`,
    equipment: GYM_EQUIPMENT,
  });

  foreignId = await insertGymExercise(otherGymId, `Zz969 Foreign ${suffix}`, {
    equipment: `foreign-equipment-${suffix}`,
  });

  const baseBench = await insertBaseExercise(`Zz969 Base Bench Press ${suffix}`, {
    slug: `zz969-base-bench-press-${suffix}`,
    equipment: BASE_EQUIPMENT,
    category: 'strength',
  });
  await link(null, baseBench, 'chest', 'principal');
  await link(null, baseBench, 'triceps', 'secondary');

  const baseRow = await insertBaseExercise(`Zz969 Base Dumbbell Row ${suffix}`, {
    slug: `zz969-base-dumbbell-row-${suffix}`,
    equipment: BASE_EQUIPMENT,
    category: 'strength',
  });
  await link(null, baseRow, 'back', 'principal');

  // An inactive Base Exercise: outside the library the modal reads, so outside
  // its facets too.
  await insertBaseExercise(`Zz969 Base Retired ${suffix}`, {
    status: 'inactive',
    slug: `zz969-base-retired-${suffix}`,
    equipment: INACTIVE_BASE_EQUIPMENT,
  });
});

afterAll(async () => {
  const ids = [benchId, rowId, inactiveId, deletedId, metadataId, foreignId, ...baseIds];
  const marks = ids.map(() => '?').join(',');
  await db.query(`DELETE FROM exercise_muscles WHERE exercise_id IN (${marks})`, ids);
  await db.query(`DELETE FROM exercises WHERE id IN (${marks})`, ids);
  await cleanupTestGyms();
  await db.end();
});

const gymList = (query = '', gym = () => gymId) =>
  request.get(`/exercises${query}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym());

const baseList = (query = '') =>
  request.get(`/exercises/base${query}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

const mine = (body: any[]) => body.filter((e) => String(e.name).endsWith(suffix)).map((e) => e.name);

// ─── GET /exercises — a gym's own list ──────────────────────────────────────

describe('GET /exercises: the shared filter vocabulary', () => {
  it('filters by a single muscle, either role', async () => {
    const res = await gymList('?muscle=triceps');
    expect(res.status).toBe(200);
    expect(mine(res.body)).toEqual([`Zz969 Bench Press ${suffix}`]);
  });

  it('treats several muscles as OR by default (§6)', async () => {
    const res = await gymList('?muscle=triceps,back');
    expect(mine(res.body).sort()).toEqual([
      `Zz969 Barbell Row ${suffix}`, `Zz969 Bench Press ${suffix}`,
    ].sort());
  });

  it('narrows them to AND with muscle_match=all (§6)', async () => {
    expect(mine((await gymList('?muscle=chest,triceps&muscle_match=all')).body))
      .toEqual([`Zz969 Bench Press ${suffix}`]);
    expect(mine((await gymList('?muscle=chest,back&muscle_match=all')).body)).toEqual([]);
  });

  it('distinguishes the primary and secondary roles (§7)', async () => {
    expect(mine((await gymList('?primary_muscle=chest')).body)).toEqual([`Zz969 Bench Press ${suffix}`]);
    expect(mine((await gymList('?primary_muscle=triceps')).body)).toEqual([]);
    expect(mine((await gymList('?secondary_muscle=triceps')).body)).toEqual([`Zz969 Bench Press ${suffix}`]);
  });

  it('combines filter groups with AND (§11)', async () => {
    const res = await gymList(`?q=Bench&muscle=chest&status=active`);
    expect(mine(res.body)).toEqual([`Zz969 Bench Press ${suffix}`]);
    expect(mine((await gymList('?q=Bench&muscle=back')).body)).toEqual([]);
  });

  it('refuses an unknown value only for the two closed sets', async () => {
    expect((await gymList('?status=deleted')).status).toBe(400);
    expect((await gymList('?muscle_match=either')).status).toBe(400);
    // A muscle key outside MUSCLE_KEYS is storable (#964 §8), so the filter
    // takes it and simply matches nothing rather than answering 400.
    const unknown = await gymList('?muscle=not-a-real-muscle');
    expect(unknown.status).toBe(200);
    expect(mine(unknown.body)).toEqual([]);
  });

  it('never searches or filters a slug here (§4)', async () => {
    // #1356: the slug is internal, so neither `?q=` nor `?slug=` uses it.
    const byQ = await gymList(`?q=zz969-metadata-carrier-${suffix}`);
    expect(byQ.status).toBe(200);
    expect(mine(byQ.body)).toEqual([]);
    const bySlug = await gymList(`?slug=zz969-metadata-carrier-${suffix}`);
    expect(bySlug.status).toBe(200);
    // The parameter narrows nothing rather than erroring — every row is still there.
    expect(mine(bySlug.body)).toContain(`Zz969 Bench Press ${suffix}`);
  });

  it('still hides the soft-deleted and respects the status filter', async () => {
    const all = await gymList();
    expect(all.body.map((e: any) => e.id)).not.toContain(deletedId);
    expect(mine((await gymList('?status=inactive')).body)).toEqual([`Zz969 Retired Lunge ${suffix}`]);
  });

  it('never reaches another gym’s exercises', async () => {
    const res = await gymList('?muscle=chest');
    expect(res.body.map((e: any) => e.id)).not.toContain(foreignId);
    const foreign = await gymList('', () => otherGymId);
    expect(foreign.body.map((e: any) => e.id)).not.toContain(benchId);
  });
});

// ─── GET /exercises/facets ──────────────────────────────────────────────────

describe('GET /exercises/facets', () => {
  it('401 without auth', async () => {
    expect((await request.get('/exercises/facets').set('x-gym-id', gymId)).status).toBe(401);
  });

  it('reports the gym’s own values and its unfiltered total', async () => {
    const res = await request.get('/exercises/facets')
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.equipment).toEqual([GYM_EQUIPMENT]);
    // The count §14 compares against: this gym's four live rows (the
    // soft-deleted one is excluded), and nothing from any other gym.
    expect(res.body.total).toBe(4);
  });

  it('offers no value another gym carries', async () => {
    const res = await request.get('/exercises/facets')
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', otherGymId);
    expect(res.status).toBe(200);
    expect(res.body.equipment).not.toContain(GYM_EQUIPMENT);
  });

  it('reports every declared facet key, empty when the gym has no such value', async () => {
    const res = await request.get('/exercises/facets')
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    for (const key of ['equipment', 'category', 'level', 'mechanic', 'source']) {
      expect(Array.isArray(res.body[key]), key).toBe(true);
    }
    // §9: a control with no values is one the page does not render at all.
    expect(res.body.mechanic).toEqual([]);
  });
});

// ─── GET /exercises/base — the Import modal's library ───────────────────────

describe('GET /exercises/base: the same vocabulary, on the library', () => {
  it('no longer searches a Base Exercise by its slug (#1356)', async () => {
    expect(mine((await baseList(`?q=zz969-base-dumbbell-row-${suffix}`)).body)).toEqual([]);
    const bySlug = await baseList(`?slug=zz969-base-bench-press-${suffix}`);
    expect(bySlug.status).toBe(200);
    expect(mine(bySlug.body).length).toBeGreaterThan(1);
    expect(mine((await baseList(`?q=Zz969 Base Dumbbell Row ${suffix}`)).body))
      .toEqual([`Zz969 Base Dumbbell Row ${suffix}`]);
  });

  it('supports the muscle filter in all three roles and both match modes', async () => {
    expect(mine((await baseList('?muscle=triceps')).body)).toEqual([`Zz969 Base Bench Press ${suffix}`]);
    expect(mine((await baseList('?secondary_muscle=triceps')).body)).toEqual([`Zz969 Base Bench Press ${suffix}`]);
    expect(mine((await baseList('?muscle=chest,back&muscle_match=all')).body)).toEqual([]);
    expect(mine((await baseList('?muscle=chest,back')).body).sort()).toEqual([
      `Zz969 Base Bench Press ${suffix}`, `Zz969 Base Dumbbell Row ${suffix}`,
    ].sort());
  });

  it('filters by the source metadata the Base Exercises list offers (§8)', async () => {
    expect(mine((await baseList(`?equipment=${BASE_EQUIPMENT}`)).body).sort()).toEqual([
      `Zz969 Base Bench Press ${suffix}`, `Zz969 Base Dumbbell Row ${suffix}`,
    ].sort());
    expect(mine((await baseList(`?equipment=${BASE_EQUIPMENT}&category=cardio`)).body)).toEqual([]);
  });

  it('takes an unknown muscle key as a filter that matches nothing, not a 400', async () => {
    // It answered 400 until stage 2 — one filter vocabulary now, in which only
    // `status` and `muscle_match` are closed sets.
    const res = await baseList('?muscle=not a muscle');
    expect(res.status).toBe(200);
    expect(mine(res.body)).toEqual([]);
    expect((await baseList('?muscle_match=either')).status).toBe(400);
  });

  it('still lists the library alone, and only its active rows', async () => {
    const res = await baseList();
    const names = mine(res.body);
    expect(names).toContain(`Zz969 Base Bench Press ${suffix}`);
    expect(names).not.toContain(`Zz969 Base Retired ${suffix}`);
    expect(names).not.toContain(`Zz969 Bench Press ${suffix}`);
  });

  it('still carries the slug internally', async () => {
    const row = (await baseList()).body.find((e: any) => e.name === `Zz969 Base Bench Press ${suffix}`);
    expect(row.slug).toBe(`zz969-base-bench-press-${suffix}`);
  });
});

// ─── GET /exercises/base/facets ─────────────────────────────────────────────

describe('GET /exercises/base/facets', () => {
  it('401 without auth', async () => {
    expect((await request.get('/exercises/base/facets').set('x-gym-id', gymId)).status).toBe(401);
  });

  it('is gym-facing: a gym admin reads the library’s own facets', async () => {
    const res = await request.get('/exercises/base/facets')
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.equipment).toContain(BASE_EQUIPMENT);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
  });

  it('scopes them to the importable library — no gym value, no inactive row', async () => {
    const res = await request.get('/exercises/base/facets')
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.body.equipment).not.toContain(GYM_EQUIPMENT);
    expect(res.body.equipment).not.toContain(INACTIVE_BASE_EQUIPMENT);
  });
});
