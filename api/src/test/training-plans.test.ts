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

  it('returns 409 with active_count when a second active plan is created without a decision', async () => {
    const res = await request
      .post('/training-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, name: 'Plan B', start_date: TODAY });

    expect(res.status).toBe(409);
    expect(typeof res.body.active_count).toBe('number');
    expect(res.body.active_count).toBeGreaterThan(0);
  });

  it('keeps existing actives when on_existing_active=keep', async () => {
    const res = await request
      .post('/training-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, name: 'Plan B', start_date: TODAY, on_existing_active: 'keep' });

    expect(res.status).toBe(201);

    // Both plans should still be active
    const { rows } = await db.query(
      `SELECT status FROM training_plans WHERE member_id = ? AND gym_id = ? AND status = 'active'`,
      [memberId, gymId],
    );
    expect(rows.length).toBe(2);
  });

  it('expires all prior actives atomically when on_existing_active=expire', async () => {
    const memberB = await createMember(gymId);

    // Create an active plan
    await request
      .post('/training-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberB, name: 'Old Plan', start_date: TODAY });

    // Create a new one with expire
    const res = await request
      .post('/training-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberB, name: 'New Plan', start_date: TODAY, on_existing_active: 'expire' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');

    // Old plan should now be expired
    const { rows } = await db.query(
      `SELECT status FROM training_plans WHERE member_id = ? AND gym_id = ? AND name = 'Old Plan'`,
      [memberB, gymId],
    );
    expect(rows[0].status).toBe('expired');

    // Only one active plan remains
    const { rows: activeRows } = await db.query(
      `SELECT id FROM training_plans WHERE member_id = ? AND gym_id = ? AND status = 'active'`,
      [memberB, gymId],
    );
    expect(activeRows.length).toBe(1);
  });
});

describe('PUT /members/:memberId/training-plans/:planId — saving a Draft (#1958)', () => {
  let gymId: string;
  let memberId: number;

  async function insertPlan(name: string, status: string): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO training_plans (gym_id, member_id, name, status, start_date, created_by) VALUES (?, ?, ?, ?, CURRENT_DATE(), 'test')`,
      [gymId, memberId, name, status],
    );
    return insertId;
  }
  const put = (id: number, body: object) =>
    request
      .put(`/members/${memberId}/training-plans/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send(body);

  beforeAll(async () => {
    gymId = await createTestGym('Draft Save Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId);
  });

  it('activates a draft when it is saved', async () => {
    const id = await insertPlan('Dup draft', 'draft');
    const res = await put(id, { name: 'Dup draft edited' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
  });

  it('activates a draft even when the client sends status draft', async () => {
    const id = await insertPlan('Dup draft 2', 'draft');
    const res = await put(id, { name: 'Dup draft 2', status: 'draft' });
    expect(res.body.status).toBe('active');
  });

  it('leaves the original plan untouched and keeps an expired status explicit', async () => {
    const original = await insertPlan('Original', 'expired');
    const draft = await insertPlan('Copy', 'draft');
    await put(draft, { name: 'Copy edited' });
    const { rows } = await db.query('SELECT status FROM training_plans WHERE id = ?', [original]);
    expect(rows[0].status).toBe('expired');
    const res = await put(await insertPlan('Draft to expire', 'draft'), { status: 'expired' });
    expect(res.status).toBe(400); // end date required, rule unchanged
  });

  it('does not change an active plan\'s status on save', async () => {
    const id = await insertPlan('Already active', 'active');
    const res = await put(id, { name: 'Already active 2' });
    expect(res.body.status).toBe('active');
  });
});
