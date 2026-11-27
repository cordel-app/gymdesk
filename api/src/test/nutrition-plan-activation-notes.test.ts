import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

// #3474: Draft activation of assigned Nutrition Plans and Member Notes on every plan type.

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

let gymId: string;
let otherGymId: string;
const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

async function createMember(name: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, name, `np3474-${Date.now()}-${Math.random()}@test.com`],
  );
  return insertId;
}

async function insertPlan(memberId: number, name: string, status: string, startSql = 'CURRENT_DATE - INTERVAL 7 DAY'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO member_nutrition_plans (gym_id, member_id, name, status, start_date) VALUES (?, ?, ?, ?, ${startSql})`,
    [gymId, memberId, name, status],
  );
  return insertId;
}

async function statusOf(id: number) {
  const { rows } = await db.query<any>('SELECT status, start_date, end_date, name FROM member_nutrition_plans WHERE id = ?', [id]);
  return rows[0];
}

beforeAll(async () => {
  gymId = await createTestGym('NP Activation Gym');
  otherGymId = await createTestGym('NP Activation Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
});

describe('activating a Draft assigned Nutrition Plan', () => {
  it('names the current active plan, then completes it and activates the Draft in one step', async () => {
    const memberId = await createMember('Act Member');
    const activeId = await insertPlan(memberId, 'Cut', 'active');
    const draftId = await insertPlan(memberId, 'Bulk', 'draft', 'CURRENT_DATE');

    const preview = await auth(request.get(`/member-nutrition-plans/${draftId}/activation`));
    expect(preview.status).toBe(200);
    expect(preview.body.current_plan).toMatchObject({ id: activeId, name: 'Cut' });

    const res = await auth(request.post(`/member-nutrition-plans/${draftId}/activate`));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.previous_plan_id).toBe(activeId);

    const previous = await statusOf(activeId);
    expect(previous.status).toBe('completed');
    expect(previous.end_date).not.toBeNull();
    const activated = await statusOf(draftId);
    expect(new Date(activated.start_date).getTime()).toBeGreaterThan(new Date(previous.end_date).getTime());

    const { rows } = await db.query<any>(
      "SELECT COUNT(*) AS n FROM member_nutrition_plans WHERE member_id = ? AND status = 'active'", [memberId]);
    expect(Number(rows[0].n)).toBe(1);
    // A second activation is refused: the plan is no longer a Draft.
    expect((await auth(request.post(`/member-nutrition-plans/${draftId}/activate`))).status).toBe(409);
  });

  it('activates a Draft when the member has no active plan, completing nothing', async () => {
    const memberId = await createMember('Solo Member');
    const draftId = await insertPlan(memberId, 'First', 'draft', 'CURRENT_DATE');
    const preview = await auth(request.get(`/member-nutrition-plans/${draftId}/activation`));
    expect(preview.body.current_plan).toBeNull();
    const res = await auth(request.post(`/member-nutrition-plans/${draftId}/activate`));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.previous_plan_id).toBeNull();
  });

  it('keeps a Draft a Draft when it is only saved', async () => {
    const memberId = await createMember('Keep Member');
    const draftId = await insertPlan(memberId, 'Kept', 'draft', 'CURRENT_DATE');
    const put = await auth(request.put(`/member-nutrition-plans/${draftId}`)).send({ name: 'Kept 2', member_notes: 'Eat slowly' });
    expect(put.status).toBe(200);
    expect(put.body.status).toBe('draft');
    expect(put.body.member_notes).toBe('Eat slowly');
  });

  it('refuses an active plan, another gym, an unauthenticated caller', async () => {
    const memberId = await createMember('Guard Member');
    const activeId = await insertPlan(memberId, 'Live', 'active');
    const draftId = await insertPlan(memberId, 'Next', 'draft', 'CURRENT_DATE');
    expect((await auth(request.post(`/member-nutrition-plans/${activeId}/activate`))).status).toBe(409);
    expect((await auth(request.post(`/member-nutrition-plans/${draftId}/activate`), otherGymId)).status).toBe(404);
    expect((await auth(request.get(`/member-nutrition-plans/${draftId}/activation`), otherGymId)).status).toBe(404);
    expect((await request.post(`/member-nutrition-plans/${draftId}/activate`)).status).toBe(401);
    expect((await statusOf(draftId)).status).toBe('draft');
    expect((await statusOf(activeId)).status).toBe('active');
  });
});

describe('Member Notes', () => {
  it('are stored on a template apart from the description, and refused when not text', async () => {
    const created = await auth(request.post('/nutrition-plan-templates'))
      .send({ name: `Notes Tpl ${Date.now()}`, description: 'Desc', member_notes: 'Drink water' });
    expect(created.status).toBe(201);
    expect(created.body.member_notes).toBe('Drink water');
    expect(created.body.description).toBe('Desc');

    // A write that does not mention the field keeps it; blank clears it.
    const kept = await auth(request.put(`/nutrition-plan-templates/${created.body.id}`)).send({ description: 'New desc' });
    expect(kept.body.member_notes).toBe('Drink water');
    expect((await auth(request.put(`/nutrition-plan-templates/${created.body.id}`)).send({ member_notes: 42 })).status).toBe(400);
  });

  it('are copied onto a plan assigned from the template, and a later template edit does not reach it', async () => {
    const memberId = await createMember('Assign Member');
    const tpl = await auth(request.post('/nutrition-plan-templates'))
      .send({ name: `Assign Tpl ${Date.now()}`, member_notes: 'Original note' });
    const assigned = await auth(request.post(`/nutrition-plan-templates/${tpl.body.id}/assign`)).send({ member_id: memberId });
    expect(assigned.status).toBe(201);
    expect(assigned.body.member_notes).toBe('Original note');

    await auth(request.put(`/nutrition-plan-templates/${tpl.body.id}`)).send({ member_notes: 'Changed note' });
    const plan = await auth(request.get(`/member-nutrition-plans/${assigned.body.id}`));
    expect(plan.body.member_notes).toBe('Original note');
  });

  it('start empty on a plan assigned from a template that has none', async () => {
    const memberId = await createMember('Empty Notes Member');
    const tpl = await auth(request.post('/nutrition-plan-templates')).send({ name: `Empty Tpl ${Date.now()}` });
    const assigned = await auth(request.post(`/nutrition-plan-templates/${tpl.body.id}/assign`)).send({ member_id: memberId });
    expect(assigned.body.member_notes).toBeNull();
  });

  it('travel with a version Draft', async () => {
    const memberId = await createMember('Version Member');
    const activeId = await insertPlan(memberId, 'Versioned', 'active');
    await db.query('UPDATE member_nutrition_plans SET member_notes = ? WHERE id = ?', ['Keep hydrated', activeId]);
    const draft = await auth(request.post(`/member-nutrition-plans/${activeId}/edit-draft`));
    expect(draft.status).toBe(201);
    expect(draft.body.member_notes).toBe('Keep hydrated');
  });
});
