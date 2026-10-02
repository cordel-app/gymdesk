/**
 * #964 §18 — the Base Exercises list, filtered server-side over the columns
 * migration 209 added: name **or** slug, the five source metadata values, and
 * multi-select muscle filtering in all three flavours (either role, primary,
 * secondary).
 *
 * Integration, because the filters are SQL: the rows are inserted directly
 * (`db.query`) and the filtering is exercised through the HTTP API, which is the
 * CLAUDE.md rule for a router test. Tenancy matters here too — a gym's own
 * exercise carrying the same metadata must never appear in a platform list, and
 * a Base Exercise must never be reachable without superadmin.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, request } from './helpers';
import { FREE_EXERCISE_DB_SOURCE } from '../domain/freeExerciseDb';

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

const suffix = `${Date.now()}`;
const baseIds: number[] = [];
let gymId: string;
let gymExerciseId: number;
/** A gym row carrying metadata no Base Exercise has — what the facets must not leak. */
let gymOnlyExerciseId: number;
const GYM_ONLY_EQUIPMENT = `gym-only-equipment-${suffix}`;

interface SeedRow {
  name: string;
  slug: string;
  equipment: string | null;
  category: string;
  level: string;
  mechanic: string | null;
  force_type: string | null;
  muscles: { key: string; role: 'principal' | 'secondary' }[];
}

const SEEDS: SeedRow[] = [
  {
    name: `Barbell Bench Press ${suffix}`, slug: `barbell-bench-press-${suffix}`,
    equipment: 'barbell', category: 'strength', level: 'beginner', mechanic: 'compound', force_type: 'push',
    muscles: [{ key: 'chest', role: 'principal' }, { key: 'triceps', role: 'secondary' }],
  },
  {
    name: `Dumbbell Row ${suffix}`, slug: `dumbbell-row-${suffix}`,
    equipment: 'dumbbell', category: 'strength', level: 'intermediate', mechanic: 'compound', force_type: 'pull',
    muscles: [{ key: 'middle_back', role: 'principal' }, { key: 'biceps', role: 'secondary' }],
  },
  {
    name: `Treadmill Interval ${suffix}`, slug: `treadmill-interval-${suffix}`,
    equipment: 'machine', category: 'cardio', level: 'beginner', mechanic: null, force_type: null,
    muscles: [{ key: 'quads', role: 'principal' }],
  },
];

async function insertBaseExercise(row: SeedRow): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO exercises
       (gym_id, name, slug, source, source_id, equipment, category, level, mechanic, force_type)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.name, row.slug, FREE_EXERCISE_DB_SOURCE, `${row.slug}-source`, row.equipment, row.category,
     row.level, row.mechanic, row.force_type],
  );
  for (const muscle of row.muscles) {
    await db.query(
      'INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (NULL, ?, ?, ?)',
      [insertId, muscle.key, muscle.role],
    );
  }
  return Number(insertId);
}

beforeAll(async () => {
  for (const seed of SEEDS) baseIds.push(await insertBaseExercise(seed));
  // A gym's own exercise with the same metadata — it may never reach this list.
  gymId = await createTestGym(`Gym Exercises ${suffix}`);
  const { insertId } = await db.query(
    `INSERT INTO exercises (gym_id, name, slug, equipment, category, level)
     VALUES (?, ?, ?, 'barbell', 'strength', 'beginner')`,
    [gymId, `Gym Barbell Bench Press ${suffix}`, `gym-barbell-bench-press-${suffix}`],
  );
  gymExerciseId = Number(insertId);
  // #969 §9: the facets are the values present among the rows in scope, so a
  // value only a gym's own exercise carries may never be offered by the
  // platform screen's dropdowns.
  const gymOnly = await db.query(
    `INSERT INTO exercises (gym_id, name, slug, equipment, category)
     VALUES (?, ?, ?, ?, 'strength')`,
    [gymId, `Gym Only Equipment ${suffix}`, `gym-only-equipment-${suffix}`, GYM_ONLY_EQUIPMENT],
  );
  gymOnlyExerciseId = Number(gymOnly.insertId);
});

afterAll(async () => {
  const ids = [...baseIds, gymExerciseId, gymOnlyExerciseId];
  const marks = ids.map(() => '?').join(',');
  await db.query(`DELETE FROM exercise_muscles WHERE exercise_id IN (${marks})`, ids);
  await db.query(`DELETE FROM exercises WHERE id IN (${marks})`, ids);
  await cleanupTestGyms();
  await db.end();
});

const list = (query: string) =>
  request.get(`/platform/exercises${query}`).set('Authorization', TEST_AUTH_HEADER);

const names = (body: any[]) => body.filter((e) => String(e.name).endsWith(suffix)).map((e) => e.name);

describe('auth', () => {
  it('401 without auth, 403 for a non-superadmin', async () => {
    expect((await request.get('/platform/exercises')).status).toBe(401);
    mockGetUser.mockResolvedValueOnce({ publicMetadata: {}, fullName: 'Regular', firstName: 'R', lastName: 'U' });
    expect((await list('')).status).toBe(403);
  });
});

describe('the list carries the provenance and metadata columns', () => {
  it('reports source, source_id, slug and the five metadata values', async () => {
    const res = await list('');
    expect(res.status).toBe(200);
    const row = res.body.find((e: any) => e.id === baseIds[0]);
    expect(row).toMatchObject({
      source: FREE_EXERCISE_DB_SOURCE,
      slug: `barbell-bench-press-${suffix}`,
      equipment: 'barbell',
      category: 'strength',
      level: 'beginner',
      mechanic: 'compound',
      force_type: 'push',
    });
  });
});

describe('migration 209 — what the unique keys actually enforce', () => {
  it('refuses a second Base Exercise with the same (source, source_id)', async () => {
    await expect(db.query(
      `INSERT INTO exercises (gym_id, name, slug, source, source_id)
       VALUES (NULL, ?, ?, ?, ?)`,
      [`Duplicate provenance ${suffix}`, `duplicate-provenance-${suffix}`,
       FREE_EXERCISE_DB_SOURCE, `barbell-bench-press-${suffix}-source`],
    )).rejects.toThrow();
  });

  it('refuses a second live Base Exercise with the same slug', async () => {
    await expect(db.query(
      'INSERT INTO exercises (gym_id, name, slug) VALUES (NULL, ?, ?)',
      [`Duplicate slug ${suffix}`, `barbell-bench-press-${suffix}`],
    )).rejects.toThrow();
  });

  it('leaves a gym’s own copy outside both keys — it may carry the same pair', async () => {
    const { insertId } = await db.query(
      `INSERT INTO exercises (gym_id, name, slug, source, source_id)
       VALUES (?, ?, ?, ?, ?)`,
      [gymId, `Imported copy ${suffix}`, `barbell-bench-press-${suffix}`,
       FREE_EXERCISE_DB_SOURCE, `barbell-bench-press-${suffix}-source`],
    );
    expect(Number(insertId)).toBeGreaterThan(0);
    await db.query('DELETE FROM exercises WHERE id = ?', [insertId]);
  });
});

describe('§18 — search and filtering', () => {
  it('q matches the name', async () => {
    const res = await list(`?q=Treadmill Interval ${suffix}`);
    expect(names(res.body)).toEqual([`Treadmill Interval ${suffix}`]);
  });

  it('q matches the slug too', async () => {
    const res = await list(`?q=dumbbell-row-${suffix}`);
    expect(names(res.body)).toEqual([`Dumbbell Row ${suffix}`]);
  });

  it('filters by equipment, and accepts several values', async () => {
    expect(names((await list('?equipment=dumbbell')).body)).toEqual([`Dumbbell Row ${suffix}`]);
    expect(names((await list('?equipment=dumbbell,machine')).body).sort())
      .toEqual([`Dumbbell Row ${suffix}`, `Treadmill Interval ${suffix}`]);
    expect(names((await list('?equipment=dumbbell&equipment=machine')).body).sort())
      .toEqual([`Dumbbell Row ${suffix}`, `Treadmill Interval ${suffix}`]);
  });

  it('filters by category, level, mechanic and source', async () => {
    expect(names((await list('?category=cardio')).body)).toEqual([`Treadmill Interval ${suffix}`]);
    expect(names((await list('?level=intermediate')).body)).toEqual([`Dumbbell Row ${suffix}`]);
    expect(names((await list('?mechanic=compound')).body).sort())
      .toEqual([`Barbell Bench Press ${suffix}`, `Dumbbell Row ${suffix}`]);
    expect(names((await list(`?source=${FREE_EXERCISE_DB_SOURCE}`)).body).length).toBe(3);
  });

  // There is no Exercise Type filter: `exercises` has no such column (migration
  // 074 dropped migration 071's), so the source's measurement-ish axis is read
  // through `?category=` above, which is the value the dataset actually supplies.
  it('offers no Exercise Type filter, and ignores one rather than failing', async () => {
    const res = await list('?exercise_type=time');
    expect(res.status).toBe(200);
    expect(names(res.body).length).toBe(3);
  });

  it('filters by muscle in either role, multi-select', async () => {
    expect(names((await list('?muscle=chest')).body)).toEqual([`Barbell Bench Press ${suffix}`]);
    expect(names((await list('?muscle=triceps')).body)).toEqual([`Barbell Bench Press ${suffix}`]);
    expect(names((await list('?muscle=chest,quads')).body).sort())
      .toEqual([`Barbell Bench Press ${suffix}`, `Treadmill Interval ${suffix}`]);
  });

  it('distinguishes primary from secondary, as the dataset does', async () => {
    expect(names((await list('?primary_muscle=middle_back')).body)).toEqual([`Dumbbell Row ${suffix}`]);
    expect(names((await list('?primary_muscle=biceps')).body)).toEqual([]);
    expect(names((await list('?secondary_muscle=biceps')).body)).toEqual([`Dumbbell Row ${suffix}`]);
  });

  it('combines filters', async () => {
    expect(names((await list('?equipment=barbell&muscle=chest&level=beginner')).body))
      .toEqual([`Barbell Bench Press ${suffix}`]);
    expect(names((await list('?equipment=barbell&level=intermediate')).body)).toEqual([]);
  });

  it('never reaches a gym’s own exercise (§1, §14)', async () => {
    for (const query of ['', '?equipment=barbell', '?level=beginner', `?q=${suffix}`]) {
      const res = await list(query);
      expect(res.body.some((e: any) => e.id === gymExerciseId), query).toBe(false);
    }
  });
});

/**
 * #969 — what the inline filter toolbar adds on top of #964's query: a Slug
 * field of its own (§4), `Any`/`All` within the muscle filter (§6), and the
 * facets the Equipment and Category dropdowns are built from (§8, §9, §14).
 *
 * Deliberately **no pagination**: the thread's `Q3` answer is "do not paginate,
 * display all", so the list response is still the plain array and §14's count
 * is the toolbar's own.
 */
describe('#969 — the filter toolbar’s own parameters', () => {
  it('§4 — ?slug= matches partially, and an exact slug matches itself', async () => {
    expect(names((await list(`?slug=barbell-bench-press-${suffix}`)).body))
      .toEqual([`Barbell Bench Press ${suffix}`]);
    expect(names((await list(`?slug=treadmill-interval-${suffix}`)).body))
      .toEqual([`Treadmill Interval ${suffix}`]);
    // Partial: the three seeds' slugs all end in the suffix.
    expect(names((await list(`?slug=${suffix}`)).body).length).toBe(3);
  });

  it('§4 — the slug filter is separate from ?q=, and combines with it', async () => {
    expect(names((await list(`?q=Treadmill&slug=barbell-bench-press-${suffix}`)).body)).toEqual([]);
    expect(names((await list(`?q=Barbell&slug=barbell-bench-press-${suffix}`)).body))
      .toEqual([`Barbell Bench Press ${suffix}`]);
  });

  it('§6 — muscle_match=any is the default, and ORs the checked muscles', async () => {
    const any = names((await list('?muscle=chest,quads')).body).sort();
    expect(any).toEqual([`Barbell Bench Press ${suffix}`, `Treadmill Interval ${suffix}`]);
    expect(names((await list('?muscle=chest,quads&muscle_match=any')).body).sort()).toEqual(any);
  });

  it('§6 — muscle_match=all ANDs them, in either role and in one role', async () => {
    // Bench Press is the only seed carrying both, and `chest` is primary while
    // `triceps` is secondary — so `all` finds it, and asking for both as
    // primary finds nothing.
    expect(names((await list('?muscle=chest,triceps&muscle_match=all')).body))
      .toEqual([`Barbell Bench Press ${suffix}`]);
    expect(names((await list('?muscle=chest,quads&muscle_match=all')).body)).toEqual([]);
    expect(names((await list('?primary_muscle=chest,triceps&muscle_match=all')).body)).toEqual([]);
    expect(names((await list('?primary_muscle=chest&secondary_muscle=triceps')).body))
      .toEqual([`Barbell Bench Press ${suffix}`]);
  });

  it('refuses an unknown muscle_match rather than guessing one', async () => {
    const res = await list('?muscle=chest&muscle_match=either');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('muscle_match');
  });

  it('still refuses an unknown status', async () => {
    expect((await list('?status=deleted')).status).toBe(400);
  });

  describe('GET /platform/exercises/facets', () => {
    const facets = () =>
      request.get('/platform/exercises/facets').set('Authorization', TEST_AUTH_HEADER);

    it('401 without auth, 403 for a non-superadmin', async () => {
      expect((await request.get('/platform/exercises/facets')).status).toBe(401);
      mockGetUser.mockResolvedValueOnce({ publicMetadata: {}, fullName: 'Regular', firstName: 'R', lastName: 'U' });
      expect((await facets()).status).toBe(403);
    });

    it('offers the values present, and a total the count can be shown against', async () => {
      const res = await facets();
      expect(res.status).toBe(200);
      expect(res.body.equipment).toContain('barbell');
      expect(res.body.equipment).toContain('dumbbell');
      expect(res.body.equipment).toContain('machine');
      expect(res.body.category).toContain('strength');
      expect(res.body.category).toContain('cardio');
      expect(res.body.level).toContain('beginner');
      expect(res.body.mechanic).toContain('compound');
      expect(res.body.source).toContain(FREE_EXERCISE_DB_SOURCE);
      expect(res.body.total).toBeGreaterThanOrEqual(3);
      // Every list is de-duplicated and sorted, so the dropdown needs no work.
      for (const key of ['equipment', 'category', 'level', 'mechanic', 'source']) {
        const values: string[] = res.body[key];
        expect(new Set(values).size).toBe(values.length);
        expect([...values].sort((a, b) => a.localeCompare(b))).toEqual(values);
      }
    });

    it('never offers a value only a gym’s own exercise carries', async () => {
      const res = await facets();
      expect(res.body.equipment).not.toContain(GYM_ONLY_EQUIPMENT);
      // …and the total counts the platform's rows alone.
      const { rows } = await db.query(
        "SELECT COUNT(*) AS n FROM exercises WHERE gym_id IS NULL AND status != 'deleted'",
      );
      expect(res.body.total).toBe(Number(rows[0].n));
    });

    it('leaves a soft-deleted Base Exercise out of both halves', async () => {
      const { insertId } = await db.query(
        `INSERT INTO exercises (gym_id, name, slug, equipment, status)
         VALUES (NULL, ?, ?, ?, 'deleted')`,
        [`Deleted facet ${suffix}`, `deleted-facet-${suffix}`, `deleted-equipment-${suffix}`],
      );
      try {
        const res = await facets();
        expect(res.body.equipment).not.toContain(`deleted-equipment-${suffix}`);
        expect(names((await list('')).body)).not.toContain(`Deleted facet ${suffix}`);
      } finally {
        await db.query('DELETE FROM exercises WHERE id = ?', [insertId]);
      }
    });
  });
});
