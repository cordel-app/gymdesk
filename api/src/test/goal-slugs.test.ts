// #2951 stage 3: Base goals and gym goals get a persistent slug on creation, unique per scope (each
// Base table; each gym), never changed by an edit; an imported copy keeps its Base goal's slug.
// A gym goal's slug lives in `entity_slug`, so the label handle `slug` stays NULL on a gym row.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

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
const basePersonal: number[] = [];
const baseNutrition: number[] = [];
let gymA: string;
let gymB: string;

const auth = (gym?: string) => (gym ? { Authorization: TEST_AUTH_HEADER, 'x-gym-id': gym } : { Authorization: TEST_AUTH_HEADER });
const row = async (table: string, id: number) =>
  (await db.query<{ slug: string | null; entity_slug?: string | null }>(`SELECT * FROM ${table} WHERE id = ?`, [id])).rows[0];

beforeAll(async () => {
  gymA = await createTestGym(`Goal Slug A ${RUN}`);
  await createTestMembership(gymA, 'admin');
  gymB = await createTestGym(`Goal Slug B ${RUN}`);
  await createTestMembership(gymB, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  if (basePersonal.length) {
    await db.query(`DELETE FROM base_personal_goal_translations WHERE base_personal_goal_id IN (${basePersonal.map(() => '?').join(',')})`, basePersonal);
    await db.query(`DELETE FROM base_personal_goals WHERE id IN (${basePersonal.map(() => '?').join(',')})`, basePersonal);
  }
  if (baseNutrition.length) {
    await db.query(`DELETE FROM base_nutrition_goal_translations WHERE base_nutrition_goal_id IN (${baseNutrition.map(() => '?').join(',')})`, baseNutrition);
    await db.query(`DELETE FROM base_nutrition_goals WHERE id IN (${baseNutrition.map(() => '?').join(',')})`, baseNutrition);
  }
  await db.end();
});

describe('Base goals', () => {
  it.each([
    ['personal', 'base_personal_goals', basePersonal],
    ['nutrition', 'base_nutrition_goals', baseNutrition],
  ] as const)('a Base %s goal is slugged from its name, suffixed when taken, and kept on rename', async (kind, table, ids) => {
    const first = await request.post(`/platform/${kind}-goals`).set(auth()).send({ name: `Équilibre Goal ${RUN}` });
    expect(first.status).toBe(201);
    ids.push(Number(first.body.id));
    expect(first.body.entity_slug).toBe(`equilibre-goal-${RUN}`);

    // Same slug, different name: the second gets a suffix.
    const second = await request.post(`/platform/${kind}-goals`).set(auth()).send({ name: `Equilibre-Goal (${RUN})` });
    expect(second.status).toBe(201);
    ids.push(Number(second.body.id));
    expect(second.body.entity_slug).toBe(`equilibre-goal-${RUN}-2`);

    const renamed = await request.put(`/platform/${kind}-goals/${first.body.id}`).set(auth())
      .send({ name: `Renamed ${kind} ${RUN}`, slug: 'something-else', entity_slug: 'something-else' });
    expect(renamed.status).toBe(200);
    expect((await row(table, first.body.id)).slug).toBe(`equilibre-goal-${RUN}`);
  });
});

describe('gym goals', () => {
  it.each(['personal', 'nutrition'] as const)('a gym %s goal is slugged per gym, kept on rename, and not a label handle', async (kind) => {
    const table = `${kind}_goals`;
    const name = `Hydration Target ${kind} ${RUN}`;
    const a = await request.post(`/${kind}-goals`).set(auth(gymA)).send({ name });
    const b = await request.post(`/${kind}-goals`).set(auth(gymB)).send({ name });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    // Two gyms may hold the same slug.
    expect(a.body.entity_slug).toBe(`hydration-target-${kind}-${RUN}`);
    expect(b.body.entity_slug).toBe(`hydration-target-${kind}-${RUN}`);
    // The System label handle is untouched, so the goal keeps its own name as its label.
    expect(a.body.slug).toBeNull();

    if (kind === 'personal') {
      // Duplicate exists for Personal Goals only; a copy is a new goal, slugged from its own name.
      const dup = await request.post(`/${kind}-goals/${a.body.id}/duplicate`).set(auth(gymA));
      expect(dup.status).toBe(201);
      expect(dup.body.entity_slug).toBe(`hydration-target-${kind}-${RUN}-copy`);
    }

    const put = await request.put(`/${kind}-goals/${a.body.id}`).set(auth(gymA)).send({ name: `Other ${kind} ${RUN}`, entity_slug: 'x' });
    expect(put.status).toBe(200);
    expect((await row(table, a.body.id)).entity_slug).toBe(`hydration-target-${kind}-${RUN}`);

    // The database refuses a second row with that slug in the same gym.
    await expect(db.query(
      `INSERT INTO ${table} (gym_id, entity_slug, name, status, created_by) VALUES (?, ?, ?, 'active', 'System')`,
      [gymA, a.body.entity_slug, `Another ${kind} ${RUN}`],
    )).rejects.toThrow();
  });

  it('an imported Personal Goal carries its Base goal slug into every gym and keeps it on rename', async () => {
    const base = await request.post('/platform/personal-goals').set(auth()).send({ name: `Core Strength ${RUN}` });
    expect(base.status).toBe(201);
    const baseId = Number(base.body.id);
    basePersonal.push(baseId);
    // The Base goal's slug is what travels, not one generated from the copy's name.
    await db.query('UPDATE base_personal_goals SET slug = ? WHERE id = ?', [`core_strength_${RUN}`, baseId]);

    for (const gym of [gymA, gymB]) {
      const imp = await request.post('/personal-goals/import').set(auth(gym)).send({ base_personal_goal_ids: [baseId] });
      expect(imp.status).toBeLessThan(300);
    }
    const { rows } = await db.query<{ id: number; gym_id: string; entity_slug: string; slug: string | null }>(
      'SELECT id, gym_id, entity_slug, slug FROM personal_goals WHERE base_personal_goal_id = ? AND gym_id IN (?, ?)',
      [baseId, gymA, gymB],
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.entity_slug).toBe(`core_strength_${RUN}`);
      expect(r.slug).toBeNull();
    }

    const copyA = rows.find((r) => r.gym_id === gymA)!;
    await request.put(`/personal-goals/${copyA.id}`).set(auth(gymA)).send({ name: `My Core ${RUN}` });
    expect((await row('personal_goals', copyA.id)).entity_slug).toBe(`core_strength_${RUN}`);

    // Details reads it through the list row.
    const list = await request.get(`/personal-goals?q=${encodeURIComponent(`My Core ${RUN}`)}`).set(auth(gymA));
    expect(list.status).toBe(200);
    const listed = list.body.items.find((g: any) => g.id === copyA.id);
    expect(listed?.entity_slug).toBe(`core_strength_${RUN}`);
  });
});
