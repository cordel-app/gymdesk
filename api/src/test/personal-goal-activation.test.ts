import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

// #1181 — Personal Goals: Duplicate (any visible goal into a new gym-owned
// row), per-gym Activate / Deactivate (`gym_personal_goals`, never the shared
// System row) and the refusal of an inactive goal on both assignment paths.

const mockGetUser = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    publicMetadata: { platform_role: 'superadmin' },
    fullName: 'Super Admin',
    firstName: 'Super',
    lastName: 'Admin',
  }),
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

const ROOT = '/personal-goals';

let gymA: string;
let gymB: string;
let systemGoalId: number;
let ownGoalId: number;
let memberId: number;

const asGym = (gym: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gym });

async function gymStatus(gym: string, goalId: number): Promise<string | null> {
  const { rows } = await db.query<{ status: string }>(
    'SELECT status FROM gym_personal_goals WHERE gym_id = ? AND personal_goal_id = ?',
    [gym, goalId],
  );
  return rows[0]?.status ?? null;
}

/** `recordAudit` is fire-and-forget, so an audit row is awaited rather than read once. */
async function auditRows(goalId: number, action: string): Promise<any[]> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { rows } = await db.query(
      `SELECT action, entity_type, gym_id FROM audit_logs
       WHERE entity_type = 'personal_goal' AND entity_id = ? AND action = ? ORDER BY id DESC`,
      [String(goalId), action],
    );
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return [];
}

async function listed(gym: string, goalId: number) {
  const res = await request.get(`${ROOT}?limit=200`).set(asGym(gym));
  expect(res.status).toBe(200);
  return res.body.items.find((g: any) => g.id === goalId);
}

beforeAll(async () => {
  gymA = await createTestGym('Goal Activation Gym A');
  await createTestMembership(gymA, 'admin');
  gymB = await createTestGym('Goal Activation Gym B');
  await createTestMembership(gymB, 'admin');

  const { rows } = await db.query<{ id: number }>(
    "SELECT id FROM personal_goals WHERE gym_id IS NULL AND slug = 'weight_loss'",
  );
  systemGoalId = rows[0].id;

  const { insertId } = await db.query(
    `INSERT INTO personal_goals (gym_id, name, description, target_value, target_unit, status, created_by_name, created_by_type)
     VALUES (?, 'Run a 10k', 'Finish a 10 km race', 10, 'km', 'active', 'Coach A', 'staff')`,
    [gymA],
  );
  ownGoalId = insertId;

  const { insertId: m } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Activation Member', ?)`,
    [gymA, `activation-member-${Date.now()}@test.com`],
  );
  memberId = m;
});

afterAll(async () => {
  // The duplicates and the System goal's per-gym rows: the gyms' deletion
  // cascades `gym_personal_goals`, but the System goal itself is never deleted.
  await db.query("DELETE FROM personal_goals WHERE gym_id IN (?, ?) AND name LIKE '% - Copy'", [gymA, gymB]);
  await cleanupTestGyms();
  await db.end();
});

describe('per-gym availability (#1181 §2)', () => {
  it('lists every visible goal as active with no configuration row written by hand', async () => {
    // Gym A was created through the test helper, not `POST /gyms`, so it has
    // no seeded rows: the absence of a row is what reads as active.
    expect(await gymStatus(gymA, systemGoalId)).toBeNull();
    const row = await listed(gymA, systemGoalId);
    expect(row.gym_status).toBe('active');
    expect(row.status).toBe('active');
  });

  it('deactivates a System goal for one gym, never touching the shared row or another gym', async () => {
    const before = await db.query('SELECT * FROM personal_goals WHERE id = ?', [systemGoalId]);
    const res = await request.post(`${ROOT}/${systemGoalId}/deactivate`).set(asGym(gymA));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(systemGoalId);
    expect(res.body.gym_status).toBe('inactive');
    expect(res.body.gym_id).toBeNull();
    // The definition is untouched, column for column.
    const after = await db.query('SELECT * FROM personal_goals WHERE id = ?', [systemGoalId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    // Gym B still sees its own, independent state.
    expect((await listed(gymB, systemGoalId)).gym_status).toBe('active');
    expect(await gymStatus(gymB, systemGoalId)).toBeNull();
    expect(await gymStatus(gymA, systemGoalId)).toBe('inactive');
    // The catalogue still shows it, as inactive.
    expect((await listed(gymA, systemGoalId)).gym_status).toBe('inactive');
  });

  it('is idempotent, and reactivating restores the goal', async () => {
    expect((await request.post(`${ROOT}/${systemGoalId}/deactivate`).set(asGym(gymA))).body.gym_status).toBe('inactive');
    expect((await request.post(`${ROOT}/${systemGoalId}/activate`).set(asGym(gymA))).body.gym_status).toBe('active');
    expect((await request.post(`${ROOT}/${systemGoalId}/activate`).set(asGym(gymA))).body.gym_status).toBe('active');
    expect(await gymStatus(gymA, systemGoalId)).toBe('active');
  });

  it('records the gym-level change in the audit log, against the goal', async () => {
    await request.post(`${ROOT}/${ownGoalId}/deactivate`).set(asGym(gymA));
    const rows = await auditRows(ownGoalId, 'deactivate');
    await request.post(`${ROOT}/${ownGoalId}/activate`).set(asGym(gymA));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].gym_id).toBe(gymA);
  });

  it("is 404 for another gym's goal and for a Nutrition Goal", async () => {
    // The write guard is the factory's own `requireWrite`, the one every other
    // write of this router sits behind — goal-library.test.ts proves it for a
    // front-desk membership, which this file's superadmin mock cannot (a
    // superadmin is what lets it impersonate the member below).
    expect((await request.post(`${ROOT}/${ownGoalId}/deactivate`).set(asGym(gymB))).status).toBe(404);
    const { rows } = await db.query<{ id: number }>("SELECT id FROM nutrition_goals WHERE gym_id IS NULL AND slug = 'protein'");
    expect((await request.post(`/nutrition-goals/${rows[0].id}/deactivate`).set(asGym(gymA))).status).toBe(404);
    expect((await request.post(`/nutrition-goals/${rows[0].id}/duplicate`).set(asGym(gymA))).status).toBe(404);
  });
});

describe('an inactive goal is not assignable (#1181 §2 — enforced server-side)', () => {
  beforeAll(async () => {
    await request.post(`${ROOT}/${systemGoalId}/deactivate`).set(asGym(gymA));
  });

  afterAll(async () => {
    await request.post(`${ROOT}/${systemGoalId}/activate`).set(asGym(gymA));
  });

  it('POST /member-personal-goals refuses it with 409 goal_inactive', async () => {
    const res = await request.post('/member-personal-goals').set(asGym(gymA))
      .send({ member_id: memberId, personal_goal_id: systemGoalId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('goal_inactive');
  });

  it('GET /me/personal-goals/available excludes it and POST /me/personal-goals refuses it', async () => {
    const member = { ...asGym(gymA), 'x-impersonate-as': `member:${memberId}` };
    const available = await request.get('/me/personal-goals/available').set(member);
    expect(available.status).toBe(200);
    expect(available.body.goals.map((g: any) => g.id)).not.toContain(systemGoalId);
    expect(available.body.goals.map((g: any) => g.id)).toContain(ownGoalId);
    const res = await request.post('/me/personal-goals').set(member).send({ personal_goal_id: systemGoalId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('goal_inactive');
  });

  it('leaves an existing assignment exactly as it is', async () => {
    const { insertId } = await db.query(
      `INSERT INTO member_personal_goals (gym_id, member_id, personal_goal_id, goal_name) VALUES (?, ?, ?, 'Weight Loss')`,
      [gymA, memberId, ownGoalId],
    );
    await request.post(`${ROOT}/${ownGoalId}/deactivate`).set(asGym(gymA));
    const { rows } = await db.query('SELECT status, deleted_at FROM member_personal_goals WHERE id = ?', [insertId]);
    expect(rows[0].status).toBe('in_progress');
    expect(rows[0].deleted_at).toBeNull();
    await request.post(`${ROOT}/${ownGoalId}/activate`).set(asGym(gymA));
    await db.query('DELETE FROM member_personal_goals WHERE id = ?', [insertId]);
  });
});

describe('Duplicate (#1181 §1)', () => {
  it('copies a System goal into a new, active, gym-owned goal and leaves the source untouched', async () => {
    const before = await db.query('SELECT * FROM personal_goals WHERE id = ?', [systemGoalId]);
    const res = await request.post(`${ROOT}/${systemGoalId}/duplicate`).set(asGym(gymA));
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Weight Loss - Copy');
    expect(res.body.gym_id).toBe(gymA);
    expect(res.body.slug).toBeNull();
    expect(res.body.status).toBe('active');
    expect(res.body.gym_status).toBe('active');
    expect(res.body.target_value).toBe(Number(before.rows[0].target_value));
    expect(res.body.target_unit).toBe(before.rows[0].target_unit);
    expect(res.body.description).toBe(before.rows[0].description);
    expect(res.body.created_by_name).toBe('Super Admin');
    const after = await db.query('SELECT * FROM personal_goals WHERE id = ?', [systemGoalId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(await gymStatus(gymA, res.body.id)).toBe('active');
    // Editable now, because it is the gym's own.
    const edit = await request.put(`${ROOT}/${res.body.id}`).set(asGym(gymA)).send({ name: 'Weight Loss - Copy' });
    expect(edit.status).toBe(200);
    expect((await auditRows(res.body.id, 'duplicate')).length).toBe(1);
  });

  it('copies a gym-owned goal too, without inheriting a deactivation, and refuses a second copy of the same name', async () => {
    await request.post(`${ROOT}/${ownGoalId}/deactivate`).set(asGym(gymA));
    const res = await request.post(`${ROOT}/${ownGoalId}/duplicate`).set(asGym(gymA));
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Run a 10k - Copy');
    expect(res.body.gym_status).toBe('active');
    expect(res.body.target_value).toBe(10);
    expect(res.body.target_unit).toBe('km');
    expect((await request.post(`${ROOT}/${ownGoalId}/duplicate`).set(asGym(gymA))).status).toBe(409);
    await request.post(`${ROOT}/${ownGoalId}/activate`).set(asGym(gymA));
  });

  it("is 404 for another gym's goal and for a deleted one", async () => {
    expect((await request.post(`${ROOT}/${ownGoalId}/duplicate`).set(asGym(gymB))).status).toBe(404);
    const { insertId } = await db.query(
      `INSERT INTO personal_goals (gym_id, name, status) VALUES (?, 'Gone', 'deleted')`, [gymA],
    );
    expect((await request.post(`${ROOT}/${insertId}/duplicate`).set(asGym(gymA))).status).toBe(409);
  });
});

describe('gym creation seeds the System goals (#1181 §2)', () => {
  it('writes an active row per System goal for a new gym', async () => {
    const res = await request.post('/platform/gyms').set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `Seeded Goals Gym ${Date.now()}` });
    expect(res.status).toBe(201);
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM gym_personal_goals gpg
       JOIN personal_goals pg ON pg.id = gpg.personal_goal_id AND pg.gym_id IS NULL
       WHERE gpg.gym_id = ? AND gpg.status = 'active'`,
      [res.body.id],
    );
    const { rows: system } = await db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM personal_goals WHERE gym_id IS NULL AND status <> 'deleted'",
    );
    expect(Number(rows[0].n)).toBe(Number(system[0].n));
    await db.query('DELETE FROM gyms WHERE id = ?', [res.body.id]);
  });
});
