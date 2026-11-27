import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

async function createMember(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Plan Member', ?)`,
    [gymId, `plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`],
  );
  return insertId;
}

const TODAY = new Date().toISOString().slice(0, 10);

describe('POST /training-plans (gym-level)', () => {
  let gymId: string;
  let memberId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Training Plans Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId);
  });

  it('creates a training plan with no existing actives', async () => {
    const res = await request
      .post('/training-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, name: 'Plan A', start_date: TODAY });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
  });

  it('refuses a second active plan without confirmation and changes nothing (#2573)', async () => {
    const res = await request
      .post('/training-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, name: 'Plan B', start_date: TODAY });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('active_plan_exists');
    expect(res.body.current_plan.name).toBe('Plan A');

    const { rows } = await db.query(
      `SELECT name, status FROM training_plans WHERE member_id = ? AND gym_id = ?`, [memberId, gymId]);
    expect(rows).toEqual([{ name: 'Plan A', status: 'active' }]);
  });

  it('keep is no longer an option: still 409 (#2573)', async () => {
    const res = await request
      .post('/training-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, name: 'Plan B', start_date: TODAY, on_existing_active: 'keep' });
    expect(res.status).toBe(409);
  });

  it('completes the previous plan and keeps one active when confirmed (#2573)', async () => {
    const memberB = await createMember(gymId);
    const post = (body: object) =>
      request.post('/training-plans').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
        .send({ member_id: memberB, start_date: TODAY, ...body });

    expect((await post({ name: 'Old Plan' })).status).toBe(201);
    const res = await post({ name: 'New Plan', confirm: true });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');

    const { rows } = await db.query(
      `SELECT status, end_date FROM training_plans WHERE member_id = ? AND gym_id = ? AND name = 'Old Plan'`,
      [memberB, gymId],
    );
    expect(rows[0].status).toBe('completed');
    expect(rows[0].end_date).not.toBeNull();

    const { rows: activeRows } = await db.query(
      `SELECT id FROM training_plans WHERE member_id = ? AND gym_id = ? AND status = 'active'`,
      [memberB, gymId],
    );
    expect(activeRows.length).toBe(1);
    const { rows: mtp } = await db.query(
      `SELECT status FROM member_training_plans WHERE member_id = ? AND gym_id = ? AND status = 'active'`,
      [memberB, gymId],
    );
    expect(mtp.length).toBe(1);
  });

  it('applies the same rule to the per-member assignment route (#2573)', async () => {
    const memberC = await createMember(gymId);
    const post = (body: object) =>
      request.post(`/members/${memberC}/member-training-plans`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send(body);
    expect((await post({ name: 'First' })).status).toBe(201);
    const refused = await post({ name: 'Second' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('active_plan_exists');
    expect((await post({ name: 'Second', confirm: true })).status).toBe(201);
    const { rows } = await db.query(
      `SELECT id FROM training_plans WHERE member_id = ? AND gym_id = ? AND status = 'active'`, [memberC, gymId]);
    expect(rows.length).toBe(1);
  });
});

describe('Assigned Training Plan Draft lifecycle (#3477)', () => {
  let gymId: string;
  let otherGymId: string;
  let memberId: number;

  async function insertPlan(name: string, status: string, startDate = TODAY): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO training_plans (gym_id, member_id, name, status, start_date, created_by) VALUES (?, ?, ?, ?, ?, 'test')`,
      [gymId, memberId, name, status, startDate],
    );
    return insertId;
  }
  const put = (id: number, body: object) =>
    request
      .put(`/members/${memberId}/training-plans/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send(body);
  const activate = (id: number, gym = gymId) =>
    request
      .post(`/members/${memberId}/training-plans/${id}/activate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gym);
  const preview = (id: number) =>
    request
      .get(`/members/${memberId}/training-plans/${id}/activation`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
  const statusOf = async (id: number) =>
    (await db.query('SELECT status, start_date, end_date FROM training_plans WHERE id = ?', [id])).rows[0];

  beforeAll(async () => {
    gymId = await createTestGym('Draft Lifecycle Gym');
    otherGymId = await createTestGym('Draft Lifecycle Other Gym');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(otherGymId, 'admin');
    memberId = await createMember(gymId);
  });

  it('saving a draft keeps it a draft (Continue editing the Draft)', async () => {
    const id = await insertPlan('Dup draft', 'draft');
    const res = await put(id, { name: 'Dup draft edited' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('draft');
    expect(res.body.name).toBe('Dup draft edited');
  });

  it('refuses a status change through PUT and accepts the stored status repeated', async () => {
    const id = await insertPlan('Draft status', 'draft');
    const refused = await put(id, { status: 'active' });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('status_not_editable');
    expect((await statusOf(id)).status).toBe('draft');
    const active = await insertPlan('Active status', 'active');
    expect((await put(active, { status: 'expired', end_date: TODAY })).status).toBe(400);
    const same = await put(active, { name: 'Active status 2', status: 'active' });
    expect(same.status).toBe(200);
    expect(same.body.status).toBe('active');
  });

  it('activates a draft, completing the member\'s active plan (no overlap)', async () => {
    const memberB = await createMember(gymId);
    const ins = async (name: string, status: string) => (await db.query(
      `INSERT INTO training_plans (gym_id, member_id, name, status, start_date, created_by)
       VALUES (?, ?, ?, ?, DATE_SUB(CURRENT_DATE(), INTERVAL 10 DAY), 'test')`, [gymId, memberB, name, status])).insertId;
    const current = await ins('Current', 'active');
    const draft = await ins('Next', 'draft');

    const p = await request.get(`/members/${memberB}/training-plans/${draft}/activation`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(p.status).toBe(200);
    expect(p.body.current_plan).toEqual({ id: current, name: 'Current' });

    const res = await request.post(`/members/${memberB}/training-plans/${draft}/activate`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.previous_plan_id).toBe(current);
    const { rows } = await db.query(
      "SELECT id FROM training_plans WHERE member_id = ? AND gym_id = ? AND status = 'active'", [memberB, gymId]);
    expect(rows.map((r: any) => r.id)).toEqual([draft]);
    expect((await statusOf(current)).status).toBe('completed');
    const { rows: mtp } = await db.query(
      "SELECT training_plan_id FROM member_training_plans WHERE member_id = ? AND gym_id = ? AND status = 'active'", [memberB, gymId]);
    expect(mtp.map((r: any) => r.training_plan_id)).toEqual([draft]);
  });

  it('activates a draft from today when the member has no active plan', async () => {
    const memberC = await createMember(gymId);
    const { insertId: draft } = await db.query(
      `INSERT INTO training_plans (gym_id, member_id, name, status, start_date, created_by)
       VALUES (?, ?, 'Solo', 'draft', DATE_SUB(CURRENT_DATE(), INTERVAL 5 DAY), 'test')`, [gymId, memberC]);
    const p = await request.get(`/members/${memberC}/training-plans/${draft}/activation`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(p.body.current_plan).toBeNull();
    const res = await request.post(`/members/${memberC}/training-plans/${draft}/activate`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.previous_plan_id).toBeNull();
  });

  it('refuses to activate a plan that is not a draft', async () => {
    const id = await insertPlan('Already active', 'active');
    const res = await activate(id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_draft');
    expect((await preview(id)).status).toBe(409);
  });

  it('is tenant-isolated and needs authentication', async () => {
    const id = await insertPlan('Isolated draft', 'draft');
    expect((await activate(id, otherGymId)).status).toBe(404);
    const anon = await request.post(`/members/${memberId}/training-plans/${id}/activate`).set('x-gym-id', gymId);
    expect(anon.status).toBe(401);
    expect((await statusOf(id)).status).toBe('draft');
  });
});
