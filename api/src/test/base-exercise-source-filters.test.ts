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

interface SeedRow {
  name: string;
  slug: string;
  equipment: string | null;
  category: string;
  level: string;
  mechanic: string | null;
  force_type: string | null;
  exercise_type: string;
  muscles: { key: string; role: 'principal' | 'secondary' }[];
}

const SEEDS: SeedRow[] = [
  {
    name: `Barbell Bench Press ${suffix}`, slug: `barbell-bench-press-${suffix}`,
    equipment: 'barbell', category: 'strength', level: 'beginner', mechanic: 'compound', force_type: 'push',
    exercise_type: 'reps',
    muscles: [{ key: 'chest', role: 'principal' }, { key: 'triceps', role: 'secondary' }],
  },
  {
    name: `Dumbbell Row ${suffix}`, slug: `dumbbell-row-${suffix}`,
    equipment: 'dumbbell', category: 'strength', level: 'intermediate', mechanic: 'compound', force_type: 'pull',
    exercise_type: 'reps',
    muscles: [{ key: 'middle_back', role: 'principal' }, { key: 'biceps', role: 'secondary' }],
  },
  {
    name: `Treadmill Interval ${suffix}`, slug: `treadmill-interval-${suffix}`,
    equipment: 'machine', category: 'cardio', level: 'beginner', mechanic: null, force_type: null,
    exercise_type: 'time',
    muscles: [{ key: 'quads', role: 'principal' }],
  },
];

async function insertBaseExercise(row: SeedRow): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO exercises
       (gym_id, name, slug, source, source_id, equipment, category, level, mechanic, force_type, exercise_type)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.name, row.slug, FREE_EXERCISE_DB_SOURCE, `${row.slug}-source`, row.equipment, row.category,
     row.level, row.mechanic, row.force_type, row.exercise_type],
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
    `INSERT INTO exercises (gym_id, name, slug, equipment, category, level, exercise_type)
     VALUES (?, ?, ?, 'barbell', 'strength', 'beginner', 'reps')`,
    [gymId, `Gym Barbell Bench Press ${suffix}`, `gym-barbell-bench-press-${suffix}`],
  );
  gymExerciseId = Number(insertId);
});

afterAll(async () => {
  const ids = [...baseIds, gymExerciseId];
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

  it('filters by Exercise Type, and refuses a value outside the taxonomy', async () => {
    expect(names((await list('?exercise_type=time')).body)).toEqual([`Treadmill Interval ${suffix}`]);
    expect((await list('?exercise_type=bodyweight')).status).toBe(400);
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
