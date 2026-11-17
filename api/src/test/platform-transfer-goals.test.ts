// #2952 stage 4: Cordel → Export / Import of Base Goals (Personal and Nutrition).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const platformRole = vi.hoisted(() => ({ value: 'superadmin' as string | undefined }));

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: vi.fn().mockImplementation(async () => ({
          publicMetadata: platformRole.value ? { platform_role: platformRole.value } : {},
          fullName: 'Super Admin', firstName: 'Super', lastName: 'Admin',
        })),
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      },
      invitations: { createInvitation: vi.fn().mockResolvedValue({ id: 'inv' }), revokeInvitation: vi.fn().mockResolvedValue({}) },
      emailAddresses: { getEmailAddress: vi.fn().mockResolvedValue({ emailAddress: 't@example.com' }) },
    })),
  };
});

const H = { Authorization: TEST_AUTH_HEADER };
const STAMP = Date.now();
const PERSONAL_SLUG = `transfer-personal-${STAMP}`;
const NUTRITION_SLUG = `transfer_nutrition_${STAMP}`;
let gymId: string;

beforeAll(async () => {
  gymId = await createTestGym('Transfer Goals Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  for (const [table, translations, fk] of [
    ['base_personal_goals', 'base_personal_goal_translations', 'base_personal_goal_id'],
    ['base_nutrition_goals', 'base_nutrition_goal_translations', 'base_nutrition_goal_id'],
  ] as const) {
    const { rows } = await db.query<{ id: number }>(`SELECT id FROM ${table} WHERE slug LIKE 'transfer%'`);
    for (const { id } of rows) {
      await db.query(`DELETE FROM ${translations} WHERE ${fk} = ?`, [id]).catch(() => undefined);
      await db.query(`DELETE FROM ${table} WHERE id = ?`, [id]);
    }
  }
  await cleanupTestGyms();
  await db.end();
});

describe('Export / Import of Base Goals (#2952 stage 4)', () => {
  it('refuses a caller who is not a superadmin', async () => {
    platformRole.value = undefined;
    try {
      expect((await request.get('/platform/transfer/base_personal_goals').set(H).set('x-gym-id', gymId)).status).toBe(403);
      expect((await request.post('/platform/transfer/base_nutrition_goals').set(H).set('x-gym-id', gymId)
        .send({ slug: NUTRITION_SLUG, name: 'X' })).status).toBe(403);
    } finally {
      platformRole.value = 'superadmin';
    }
  });

  it('creates a Base Personal Goal under the archive slug, ignoring what is not its own content', async () => {
    const created = await request.post('/platform/transfer/base_personal_goals').set(H)
      .send({
        slug: PERSONAL_SLUG, name: `Transfer Personal ${STAMP}`, description: 'One',
        target_value: -4, target_unit: 'kg', target_type: 'relative',
        translations: { es: { name: `Objetivo ${STAMP}`, description: 'Uno' } },
        id: 999999999, gym_id: gymId, status: 'deleted',
      });
    expect(created.status).toBe(201);
    expect(created.body.action).toBe('created');
    const e = created.body.entity;
    expect(e.slug).toBe(PERSONAL_SLUG);
    expect(e.id).not.toBe(999999999);
    expect(e.gym_id).toBeNull();
    expect(e.status).toBe('active');
    expect(e.target_value).toBe(-4);
    expect(e.target_type).toBe('relative');
    expect(e.translations.es.name).toBe(`Objetivo ${STAMP}`);
  });

  it('accepts a seeded goal\'s snake_case slug and creates a Base Nutrition Goal', async () => {
    const created = await request.post('/platform/transfer/base_nutrition_goals').set(H)
      .send({ slug: NUTRITION_SLUG, name: `Transfer Nutrition ${STAMP}`, description: null, translations: {} });
    expect(created.status).toBe(201);
    expect(created.body.entity.slug).toBe(NUTRITION_SLUG);
    expect(created.body.entity.target_value).toBeUndefined();
  });

  it('exports each kind as its slug, its own fields and its image slot', async () => {
    const personal = await request.get('/platform/transfer/base_personal_goals').set(H);
    expect(personal.status).toBe(200);
    const p = personal.body.entities.find((x: any) => x.slug === PERSONAL_SLUG);
    expect(Object.keys(p.data).sort())
      .toEqual(['description', 'name', 'target_type', 'target_unit', 'target_value', 'translations']);
    expect(p.data.translations).toEqual({ es: { name: `Objetivo ${STAMP}`, description: 'Uno' } });
    expect(p.images).toEqual({ image: null });

    const nutrition = await request.get('/platform/transfer/base_nutrition_goals').set(H);
    const n = nutrition.body.entities.find((x: any) => x.slug === NUTRITION_SLUG);
    expect(Object.keys(n.data).sort()).toEqual(['description', 'name', 'translations']);
  });

  it('updates the goal in place, and a gym\'s imported copy of it is left as it was', async () => {
    const { rows } = await db.query<{ id: number }>('SELECT id FROM base_personal_goals WHERE slug = ?', [PERSONAL_SLUG]);
    const id = rows[0].id;
    const imported = await request.post('/personal-goals/import').set(H).set('x-gym-id', gymId)
      .send({ base_personal_goal_ids: [id] });
    expect([200, 201]).toContain(imported.status);
    const copyBefore = await db.query<{ id: number; name: string }>(
      'SELECT id, name FROM personal_goals WHERE gym_id = ? AND base_personal_goal_id = ?', [gymId, id],
    );

    const updated = await request.post('/platform/transfer/base_personal_goals').set(H)
      .send({
        slug: PERSONAL_SLUG, name: `Transfer Personal ${STAMP} Renamed`, description: 'Two',
        target_value: 5, target_unit: 'kg', target_type: 'absolute',
        translations: { ca: { name: `Objectiu ${STAMP}`, description: null } },
      });
    expect(updated.status).toBe(200);
    expect(updated.body.action).toBe('updated');
    expect(updated.body.entity.id).toBe(id);
    expect(updated.body.entity.slug).toBe(PERSONAL_SLUG);
    expect(updated.body.entity.name).toBe(`Transfer Personal ${STAMP} Renamed`);
    expect(updated.body.entity.target_value).toBe(5);
    expect(updated.body.entity.translations).toEqual({ ca: { name: `Objectiu ${STAMP}`, description: null } });

    const copyAfter = await db.query<{ id: number; name: string }>(
      'SELECT id, name FROM personal_goals WHERE gym_id = ? AND base_personal_goal_id = ?', [gymId, id],
    );
    expect(copyAfter.rows).toEqual(copyBefore.rows);
    const count = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM base_personal_goals WHERE slug = ?', [PERSONAL_SLUG]);
    expect(Number(count.rows[0].n)).toBe(1);
  });

  it('keeps the editor\'s rules: a unit with no target value is refused', async () => {
    const res = await request.post('/platform/transfer/base_personal_goals').set(H)
      .send({ slug: PERSONAL_SLUG, target_value: null, target_unit: 'kg' });
    expect(res.status).toBe(400);
  });

  it('refuses a malformed slug, an image for an unknown slug or slot, and a soft-deleted slug', async () => {
    expect((await request.post('/platform/transfer/base_personal_goals').set(H)
      .send({ slug: 'Bad Slug', name: 'X' })).status).toBe(400);
    const unknown = await request.post('/platform/transfer/base_personal_goals/transfer-missing/image/image').set(H)
      .set('Content-Type', 'image/png').send(Buffer.from([1, 2, 3]));
    expect(unknown.status).toBe(404);
    const slot = await request.post(`/platform/transfer/base_nutrition_goals/${NUTRITION_SLUG}/image/other`).set(H)
      .set('Content-Type', 'image/png').send(Buffer.from([1, 2, 3]));
    expect(slot.status).toBe(400);

    await db.query('UPDATE base_nutrition_goals SET deleted_at = UTC_TIMESTAMP() WHERE slug = ?', [NUTRITION_SLUG]);
    const res = await request.post('/platform/transfer/base_nutrition_goals').set(H)
      .send({ slug: NUTRITION_SLUG, name: 'Resurrected' });
    expect(res.status).toBe(409);
  });
});
