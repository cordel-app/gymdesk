// #2093 stage 4 — saving the Assigned Plan editors on a Draft persists on the
// Draft only: the values survive a reload, the catalogue Plan and a sibling
// Draft are untouched, and nothing activates or bills.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment,
  createTestGym, createTestMembership, getAssignmentConfig, request,
} from './helpers';

let gymId: string;
let planId: number;
let umId: number;
let siblingUmId: number;
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const headers = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

beforeAll(async () => {
  gymId = await createTestGym('Draft Save Gym');
  await createTestMembership(gymId, 'admin');
  ({ insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods)
     VALUES (?, ?, 'active', 'public', '1', 1, 12, 2)`, [gymId, `DSP-${uniq()}`]));
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, planId]);
  const mk = async () => (await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'DSP Member', `dsp-${uniq()}@test.com`])).insertId as number;
  umId = await createTestDraftAssignment(gymId, await mk(), planId);
  siblingUmId = await createTestDraftAssignment(gymId, await mk(), planId);
});
afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('saving an Assigned Plan Draft (#2093)', () => {
  it('persists Billing & Duration and the fee benefit across a reload, without activating or billing', async () => {
    const bd = await headers(request.put(`/user-memberships/${umId}/billing-duration`))
      .send({ free_periods: 0, paid_periods: 6, bonus_periods: 3 });
    expect(bd.status).toBe(200);
    const fb = await headers(request.put(`/user-memberships/${umId}/fee-benefit`))
      .send({ action: 'percentage_discount', value: 15 });
    expect(fb.status).toBe(200);

    const cfg = await getAssignmentConfig(umId);
    expect([cfg.free_periods, cfg.paid_periods, cfg.bonus_periods]).toEqual([0, 6, 3]);
    expect(cfg.personal_fee_benefit_action).toBe('percentage_discount');
    expect(Number(cfg.personal_fee_benefit_value)).toBe(15);

    const reload = await headers(request.get(`/user-memberships/${umId}`));
    expect(reload.status).toBe(200);
    expect(reload.body.status).toBe('draft');

    const { rows: events } = await db.query<any>(
      `SELECT be.id FROM billing_events be
         JOIN product_sets ps ON ps.id = be.product_set_id
        WHERE ps.user_membership_id = ?`, [umId]);
    expect(events).toHaveLength(0);
  });

  it('leaves the catalogue Plan and a sibling Draft as they were', async () => {
    const { rows: plan } = await db.query<any>(
      'SELECT free_periods, paid_periods, bonus_periods FROM membership_plans WHERE id = ?', [planId]);
    expect([plan[0].free_periods, plan[0].paid_periods, plan[0].bonus_periods]).toEqual([1, 12, 2]);
    const sibling = await getAssignmentConfig(siblingUmId);
    expect([sibling.free_periods, sibling.paid_periods, sibling.bonus_periods]).toEqual([1, 12, 2]);
  });
});
