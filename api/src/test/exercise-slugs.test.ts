// #2951 stage 2: Base Exercises and gym exercises get a persistent slug on creation, unique per
// scope (the Base catalogue; each gym), never changed by an edit; an imported or cloned copy keeps
// its Base Exercise's slug.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, deleteBaseExercises, request } from './helpers';

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: vi.fn().mockResolvedValue({
          publicMetadata: { platform_role: 'superadmin' },
          fullName: 'Super Admin', firstName: 'Super', lastName: 'Admin',
          emailAddresses: [], primaryEmailAddressId: null,
        }),
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      },
    })),
  };
});

const RUN = Math.random().toString(36).slice(2, 8);
const baseIds: number[] = [];
let gymA: string;
let gymB: string;

const auth = (gym?: string) => (gym ? { Authorization: TEST_AUTH_HEADER, 'x-gym-id': gym } : { Authorization: TEST_AUTH_HEADER });
const slugOf = async (table: 'exercises' | 'base_exercises', id: number) =>
  (await db.query<{ slug: string | null }>(`SELECT slug FROM ${table} WHERE id = ?`, [id])).rows[0]?.slug;

beforeAll(async () => {
  gymA = await createTestGym(`Slug A ${RUN}`);
  gymB = await createTestGym(`Slug B ${RUN}`);
});

afterAll(async () => {
  await cleanupTestGyms();
  await deleteBaseExercises(baseIds);
  await db.end();
});

describe('Base Exercises', () => {
  it('generates the slug from the name, suffixes a taken one and keeps it on rename', async () => {
    const first = await request.post('/platform/exercises').set(auth()).send({ name: `Équilibre Squat ${RUN}` });
    expect(first.status).toBe(201);
    baseIds.push(Number(first.body.id));
    expect(first.body.slug).toBe(`equilibre-squat-${RUN}`);

    const second = await request.post('/platform/exercises').set(auth()).send({ name: `Equilibre-Squat (${RUN})` });
    expect(second.status).toBe(201);
    baseIds.push(Number(second.body.id));
    expect(second.body.slug).toBe(`equilibre-squat-${RUN}-2`);

    const renamed = await request.put(`/platform/exercises/${first.body.id}`).set(auth())
      .send({ name: `Renamed Base ${RUN}`, slug: 'something-else' });
    expect(renamed.status).toBe(200);
    expect(await slugOf('base_exercises', first.body.id)).toBe(`equilibre-squat-${RUN}`);
  });
});

describe('gym exercises', () => {
  it('slugs a new exercise per gym and keeps it on rename', async () => {
    const name = `Romanian Deadlift ${RUN}`;
    const a = await request.post('/exercises').set(auth(gymA)).send({ name });
    const b = await request.post('/exercises').set(auth(gymB)).send({ name });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    // Two gyms may hold the same slug.
    expect(a.body.slug).toBe(`romanian-deadlift-${RUN}`);
    expect(b.body.slug).toBe(`romanian-deadlift-${RUN}`);

    const dup = await request.post(`/exercises/${a.body.id}/duplicate`).set(auth(gymA));
    expect(dup.status).toBe(201);
    expect(dup.body.slug).toBe(`romanian-deadlift-${RUN}-copy`);

    const put = await request.put(`/exercises/${a.body.id}`).set(auth(gymA)).send({ name: `Other ${RUN}`, slug: 'x' });
    expect(put.status).toBe(200);
    expect(await slugOf('exercises', a.body.id)).toBe(`romanian-deadlift-${RUN}`);
  });

  it('carries the Base Exercise slug into imported and cloned copies, in every gym', async () => {
    const base = await request.post('/platform/exercises').set(auth()).send({ name: `Hip Thrust ${RUN}` });
    expect(base.status).toBe(201);
    const baseId = Number(base.body.id);
    baseIds.push(baseId);
    // The Base Exercise's slug is what travels, not one generated from the copy's name.
    await db.query('UPDATE base_exercises SET slug = ? WHERE id = ?', [`hip-thrust-legacy-${RUN}`, baseId]);

    const impA = await request.post('/exercises/import').set(auth(gymA)).send({ baseExerciseIds: [baseId] });
    const impB = await request.post('/exercises/import').set(auth(gymB)).send({ baseExerciseIds: [baseId] });
    expect(impA.status).toBe(201);
    expect(impB.status).toBe(201);
    const copyA = Number(impA.body.imported[0].id);
    expect(await slugOf('exercises', copyA)).toBe(`hip-thrust-legacy-${RUN}`);
    expect(await slugOf('exercises', Number(impB.body.imported[0].id))).toBe(`hip-thrust-legacy-${RUN}`);

    // A clone into a gym already holding that slug is suffixed, never regenerated from "(Copy)".
    const clone = await request.post(`/exercises/${baseId}/clone`).set(auth(gymA));
    expect(clone.status).toBe(201);
    expect(clone.body.slug).toBe(`hip-thrust-legacy-${RUN}-2`);

    // Renaming the imported copy keeps the carried slug.
    await request.put(`/exercises/${copyA}`).set(auth(gymA)).send({ name: `My Thrust ${RUN}` });
    expect(await slugOf('exercises', copyA)).toBe(`hip-thrust-legacy-${RUN}`);
  });

  it('refuses a second row with the same slug in one gym at the database', async () => {
    const own = await request.post('/exercises').set(auth(gymA)).send({ name: `Unique ${RUN}` });
    await expect(db.query(
      "INSERT INTO exercises (gym_id, name, slug, status, created_by) VALUES (?, ?, ?, 'active', 'System')",
      [gymA, `Another ${RUN}`, own.body.slug],
    )).rejects.toThrow();
  });
});
