// #635 stage 6 — the Assigned Membership Plan's snapshot, edited section by
// section (§9/§10/§15).
//
// The point of the stage is that an edit lands on *this* assignment and
// nowhere else, so every case drives the real routers over the full Express +
// MySQL stack and then re-reads the Plan, the sibling assignment and the
// Sellable Item to prove none of them moved. Fixtures are inserted directly;
// the HTTP API is only used for the action under test (CLAUDE.md).

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

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

function dayOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function createPlan(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans
       (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_months, paid_months, bonus_months)
     VALUES (?, ?, 'active', 'public', '1', 1, 12, 2)`,
    [gymId, `APSE-Plan-${uniq()}`],
  );
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, 80, ?, 'active')`,
    [gymId, insertId, dayOffset(-365)],
  );
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`,
    [gymId, insertId],
  );
  return insertId;
}

async function createMember(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'APSE Member', `apse-${uniq()}@test.com`],
  );
  return insertId;
}

async function createSellableItem(gymId: string, opts: {
  type?: string; billingFrequency?: string | null; amount?: number; status?: string;
} = {}): Promise<number> {
  const { type = 'service', billingFrequency = 'month', amount = 20, status = 'active' } = opts;
  const { insertId } = await db.query(
    `INSERT INTO gym_charges
       (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, ?, ?, 'EUR', ?, ?, 'available', 0)`,
    [gymId, `APSE-Item-${uniq()}`, type, amount, billingFrequency, status],
  );
  return insertId;
}

async function addPlanBenefit(gymId: string, table: string, planId: number, chargeId: number, quantity = 1) {
  await db.query(
    `INSERT INTO ${table} (gym_id, membership_plan_id, gym_charge_id, quantity) VALUES (?, ?, ?, ?)`,
    [gymId, planId, chargeId, quantity],
  );
}

const assign = (gymId: string, planId: number, memberId: number) =>
  request
    .post('/user-memberships')
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ member_id: memberId, membership_plan_id: planId, starts_at: dayOffset(0) });

const getAssignment = (gymId: string, umId: number) =>
  request.get(`/user-memberships/${umId}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

const putBillingDuration = (gymId: string, umId: number, body: Record<string, unknown>) =>
  request
    .put(`/user-memberships/${umId}/billing-duration`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send(body);

const putBenefits = (gymId: string, umId: number, path: string, items: unknown[]) =>
  request
    .put(`/user-memberships/${umId}/${path}`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ items });

const getBenefits = (gymId: string, umId: number, path: string) =>
  request.get(`/user-memberships/${umId}/${path}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

/** A Plan with a price, a cadence and one Period Benefit, assigned to a new Member. */
async function assignConfiguredPlan(gymId: string) {
  const planId = await createPlan(gymId);
  const periodicalItem = await createSellableItem(gymId, { amount: 20 });
  await addPlanBenefit(gymId, 'membership_plan_periodical', planId, periodicalItem, 1);
  const res = await assign(gymId, planId, await createMember(gymId));
  expect(res.status).toBe(201);
  return { planId, periodicalItem, umId: res.body.id as number };
}

// ─── Billing & Duration (§7/§9) ───────────────────────────────────────────────

describe('PUT /user-memberships/:id/billing-duration', () => {
  let gymId: string;
  let planId: number;
  let umId: number;
  let siblingUmId: number;

  beforeAll(async () => {
    gymId = await createTestGym('APSE Billing Gym');
    await createTestMembership(gymId, 'admin');
    ({ planId, umId } = await assignConfiguredPlan(gymId));
    const sibling = await assign(gymId, planId, await createMember(gymId));
    expect(sibling.status).toBe(201);
    siblingUmId = sibling.body.id;
  });

  it('edits this assignment only — not the Plan, not another assignment (§15)', async () => {
    const res = await putBillingDuration(gymId, umId, {
      free_months: 0, paid_months: 6, bonus_months: 3,
      recurring_billing_interval: 3, recurring_billing_unit: 'month',
      membership_fee_price: 90,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      free_months: 0, paid_months: 6, bonus_months: 3,
      recurring_billing_interval: 3, recurring_billing_unit: 'month',
      membership_fee_price: 90,
      snapshot_captured: true,
    });

    const { rows: planRows } = await db.query(
      'SELECT free_months, paid_months, bonus_months FROM membership_plans WHERE id = ?', [planId],
    );
    expect(planRows[0]).toMatchObject({ free_months: 1, paid_months: 12, bonus_months: 2 });

    const sibling = await getAssignment(gymId, siblingUmId);
    expect(sibling.body.snapshot).toMatchObject({
      free_months: 1, paid_months: 12, bonus_months: 2, membership_fee_price: 80,
    });
  });

  it('writes only the fields it was sent, and reads a cleared one back as null', async () => {
    const res = await putBillingDuration(gymId, umId, { bonus_months: null });
    expect(res.status).toBe(200);
    expect(res.body.bonus_months).toBeNull();
    // Untouched by this request.
    expect(res.body).toMatchObject({ paid_months: 6, membership_fee_price: 90 });
  });

  it('rejects a half-configured cadence, which would mix in the Plan’s unit', async () => {
    const res = await putBillingDuration(gymId, umId, { recurring_billing_unit: null });
    expect(res.status).toBe(400);
    const after = await getAssignment(gymId, umId);
    expect(after.body.snapshot.recurring_billing_unit).toBe('month');
  });

  it('rejects a negative duration, an unknown unit and an empty payload', async () => {
    expect((await putBillingDuration(gymId, umId, { paid_months: -1 })).status).toBe(400);
    expect((await putBillingDuration(gymId, umId, { recurring_billing_unit: 'fortnight' })).status).toBe(400);
    expect((await putBillingDuration(gymId, umId, {})).status).toBe(400);
  });

  it('is what the Billing Simulation then reads (stage 3 reads the snapshot)', async () => {
    const { rows } = await db.query(
      'SELECT member_id FROM user_memberships WHERE id = ?', [umId],
    );
    const res = await request
      .get(`/user-memberships/member/${rows[0].member_id}/billing-simulation`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('90');
  });
});

// ─── One-off / Session / Period Benefits (§3–§5/§9) ───────────────────────────

describe('PUT /user-memberships/:id/{session,oneoff,periodical}-benefits', () => {
  let gymId: string;
  let planId: number;
  let umId: number;
  let periodicalItem: number;

  beforeAll(async () => {
    gymId = await createTestGym('APSE Benefits Gym');
    await createTestMembership(gymId, 'admin');
    ({ planId, umId, periodicalItem } = await assignConfiguredPlan(gymId));
  });

  it('replaces a section on the assignment, freezing a newly added line’s price', async () => {
    const added = await createSellableItem(gymId, { amount: 35, billingFrequency: 'year' });
    const res = await putBenefits(gymId, umId, 'periodical-benefits', [
      { gym_charge_id: periodicalItem, quantity: 3 },
      { gym_charge_id: added, quantity: 1 },
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const byItem = Object.fromEntries(res.body.map((r: any) => [r.gym_charge_id, r]));
    expect(byItem[periodicalItem]).toMatchObject({ quantity: 3, unit_price: 20 });
    expect(byItem[added]).toMatchObject({ quantity: 1, unit_price: 35, item_billing_frequency: 'year', currency: 'EUR' });

    // The Plan's own section is untouched (§15).
    const { rows } = await db.query(
      'SELECT gym_charge_id, quantity FROM membership_plan_periodical WHERE membership_plan_id = ?', [planId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gym_charge_id: periodicalItem, quantity: 1 });
  });

  it('keeps a kept line at the price it was agreed at when the catalogue moves (§17)', async () => {
    await db.query('UPDATE gym_charges SET amount = 999 WHERE id = ?', [periodicalItem]);
    const res = await putBenefits(gymId, umId, 'periodical-benefits', [
      { gym_charge_id: periodicalItem, quantity: 5 },
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ quantity: 5, unit_price: 20 });
  });

  it('keeps a line whose Sellable Item was since retired saveable', async () => {
    await db.query('UPDATE gym_charges SET status = ? WHERE id = ?', ['inactive', periodicalItem]);
    const res = await putBenefits(gymId, umId, 'periodical-benefits', [
      { gym_charge_id: periodicalItem, quantity: 2 },
    ]);
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ quantity: 2, unit_price: 20 });
    await db.query('UPDATE gym_charges SET status = ?, amount = 20 WHERE id = ?', ['active', periodicalItem]);
  });

  it('serves the same section on its own GET', async () => {
    const res = await getBenefits(gymId, umId, 'periodical-benefits');
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.gym_charge_id)).toEqual([periodicalItem]);
  });

  it('empties a section when sent no items', async () => {
    const res = await putBenefits(gymId, umId, 'session-benefits', []);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('rejects a new item of the wrong category, an inactive one and a bad payload', async () => {
    const sessionItem = await createSellableItem(gymId, { type: 'sessions', billingFrequency: 'per_session' });
    const inactive = await createSellableItem(gymId, { status: 'inactive' });

    expect((await putBenefits(gymId, umId, 'periodical-benefits', [
      { gym_charge_id: sessionItem, quantity: 1 },
    ])).status).toBe(400);
    expect((await putBenefits(gymId, umId, 'periodical-benefits', [
      { gym_charge_id: inactive, quantity: 1 },
    ])).status).toBe(400);
    expect((await putBenefits(gymId, umId, 'session-benefits', [
      { gym_charge_id: sessionItem, quantity: 0 },
    ])).status).toBe(400);
    expect((await putBenefits(gymId, umId, 'session-benefits', [
      { gym_charge_id: sessionItem, quantity: 1 }, { gym_charge_id: sessionItem, quantity: 2 },
    ])).status).toBe(400);
    expect((await request
      .put(`/user-memberships/${umId}/session-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: 'nope' })).status).toBe(400);
  });

  it('refuses to rewrite the configuration of a cancelled assignment', async () => {
    const other = await assignConfiguredPlan(gymId);
    await db.query("UPDATE user_memberships SET status = 'cancelled' WHERE id = ?", [other.umId]);
    expect((await putBenefits(gymId, other.umId, 'periodical-benefits', [])).status).toBe(400);
    expect((await putBillingDuration(gymId, other.umId, { paid_months: 1 })).status).toBe(400);
  });
});

// ─── An assignment that never captured a snapshot (§13 + stage 3's fallback) ──

describe('editing an assignment that predates the snapshot', () => {
  let gymId: string;
  let planId: number;
  let umId: number;
  let periodicalItem: number;
  let sessionItem: number;

  beforeAll(async () => {
    gymId = await createTestGym('APSE Legacy Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId);
    periodicalItem = await createSellableItem(gymId, { amount: 20 });
    sessionItem = await createSellableItem(gymId, { type: 'sessions', billingFrequency: 'per_session', amount: 30 });
    await addPlanBenefit(gymId, 'membership_plan_periodical', planId, periodicalItem, 1);
    await addPlanBenefit(gymId, 'membership_plan_session', planId, sessionItem, 10);

    const res = await assign(gymId, planId, await createMember(gymId));
    expect(res.status).toBe(201);
    umId = res.body.id;
    // Strip the snapshot stage 2 captured, reproducing a row the migration-174
    // backfill could not reach: it resolves the live catalogue today.
    await db.query(
      `UPDATE user_memberships SET free_months = NULL, paid_months = NULL, bonus_months = NULL,
          recurring_billing_interval = NULL, recurring_billing_unit = NULL, membership_fee_price = NULL
       WHERE id = ?`,
      [umId],
    );
    for (const table of ['user_membership_session', 'user_membership_oneoff', 'user_membership_periodical']) {
      await db.query(`DELETE FROM ${table} WHERE user_membership_id = ?`, [umId]);
    }
  });

  it('starts out uncaptured', async () => {
    const res = await getAssignment(gymId, umId);
    expect(res.body.snapshot.snapshot_captured).toBe(false);
  });

  it('captures what it resolves live before applying the first edit', async () => {
    const res = await putBenefits(gymId, umId, 'periodical-benefits', [
      { gym_charge_id: periodicalItem, quantity: 4 },
    ]);
    expect(res.status).toBe(200);

    const after = await getAssignment(gymId, umId);
    // The edited section is what was asked for…
    expect(after.body.snapshot.periodical_benefits).toHaveLength(1);
    expect(after.body.snapshot.periodical_benefits[0]).toMatchObject({ quantity: 4, unit_price: 20 });
    // …and the sections the edit never mentioned were written down rather than
    // silently lost with the live fallback.
    expect(after.body.snapshot.session_benefits).toHaveLength(1);
    expect(after.body.snapshot.session_benefits[0]).toMatchObject({ gym_charge_id: sessionItem, quantity: 10, unit_price: 30 });
    expect(after.body.snapshot).toMatchObject({
      free_months: 1, paid_months: 12, bonus_months: 2,
      recurring_billing_interval: 1, recurring_billing_unit: 'month',
      membership_fee_price: 80,
      snapshot_captured: true,
    });
  });

  it('then stops following the Plan (§13)', async () => {
    await db.query('UPDATE membership_plans SET paid_months = 36 WHERE id = ?', [planId]);
    await db.query('DELETE FROM membership_plan_session WHERE membership_plan_id = ?', [planId]);
    const after = await getAssignment(gymId, umId);
    expect(after.body.snapshot.paid_months).toBe(12);
    expect(after.body.snapshot.session_benefits).toHaveLength(1);
  });
});

describe('materialising, on an assignment that captured nothing', () => {
  let gymId: string;

  /** An assignment stripped back to the pre-migration-174 shape. */
  async function uncapturedAssignment() {
    const planId = await createPlan(gymId);
    const res = await assign(gymId, planId, await createMember(gymId));
    expect(res.status).toBe(201);
    const umId = res.body.id as number;
    await db.query(
      `UPDATE user_memberships SET free_months = NULL, paid_months = NULL, bonus_months = NULL,
          recurring_billing_interval = NULL, recurring_billing_unit = NULL, membership_fee_price = NULL
       WHERE id = ?`,
      [umId],
    );
    return umId;
  }

  beforeAll(async () => {
    gymId = await createTestGym('APSE Materialise Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('accepts half the cadence, because the other half is captured with it', async () => {
    const umId = await uncapturedAssignment();
    const res = await putBillingDuration(gymId, umId, { recurring_billing_interval: 2 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ recurring_billing_interval: 2, recurring_billing_unit: 'month' });
  });

  it('rolls the capture back with a rejected edit', async () => {
    const umId = await uncapturedAssignment();
    // The Plan has a cadence, so clearing only the unit would leave half of one.
    const res = await putBillingDuration(gymId, umId, { recurring_billing_unit: null });
    expect(res.status).toBe(400);
    const after = await getAssignment(gymId, umId);
    expect(after.body.snapshot.snapshot_captured).toBe(false);
  });
});

// ─── Tenant isolation and auth ────────────────────────────────────────────────

describe('/user-memberships/:id snapshot sections — tenant isolation and auth', () => {
  let gymA: string;
  let gymB: string;
  let umId: number;

  beforeAll(async () => {
    gymA = await createTestGym('APSE Tenant A');
    await createTestMembership(gymA, 'admin');
    ({ umId } = await assignConfiguredPlan(gymA));

    gymB = await createTestGym('APSE Tenant B');
    await createTestMembership(gymB, 'admin');
  });

  it("returns 404 for another gym's assignment", async () => {
    expect((await getBenefits(gymB, umId, 'periodical-benefits')).status).toBe(404);
    expect((await putBenefits(gymB, umId, 'periodical-benefits', [])).status).toBe(404);
    expect((await putBillingDuration(gymB, umId, { paid_months: 1 })).status).toBe(404);
  });

  it("refuses an item that belongs to another gym", async () => {
    const otherGymItem = await createSellableItem(gymB);
    const res = await putBenefits(gymA, umId, 'periodical-benefits', [
      { gym_charge_id: otherGymItem, quantity: 1 },
    ]);
    expect(res.status).toBe(400);
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request
      .put(`/user-memberships/${umId}/billing-duration`)
      .set('x-gym-id', gymA)
      .send({ paid_months: 1 });
    expect(res.status).toBe(401);
    const benefits = await request
      .put(`/user-memberships/${umId}/periodical-benefits`)
      .set('x-gym-id', gymA)
      .send({ items: [] });
    expect(benefits.status).toBe(401);
  });

  it('returns 403 for a read-only role, and writes nothing', async () => {
    const readOnlyGym = await createTestGym('APSE Accountant Gym');
    await createTestMembership(readOnlyGym, 'accountant');
    const { umId: readOnlyUmId } = await assignConfiguredPlanAsAdmin(readOnlyGym);

    expect((await putBillingDuration(readOnlyGym, readOnlyUmId, { paid_months: 1 })).status).toBe(403);
    expect((await putBenefits(readOnlyGym, readOnlyUmId, 'periodical-benefits', [])).status).toBe(403);
    const { rows } = await db.query('SELECT paid_months FROM user_memberships WHERE id = ?', [readOnlyUmId]);
    expect(rows[0].paid_months).toBe(12);
    // Reading the section is allowed for a role with read access.
    expect((await getBenefits(readOnlyGym, readOnlyUmId, 'periodical-benefits')).status).toBe(200);
  });

  it('returns 403 for a role with no access to PAYMENTS at all', async () => {
    const noAccessGym = await createTestGym('APSE Trainer Gym');
    await createTestMembership(noAccessGym, 'trainer_performance');
    const { umId: noAccessUmId } = await assignConfiguredPlanAsAdmin(noAccessGym);
    expect((await getBenefits(noAccessGym, noAccessUmId, 'periodical-benefits')).status).toBe(403);
    expect((await putBenefits(noAccessGym, noAccessUmId, 'periodical-benefits', [])).status).toBe(403);
  });

  /**
   * The caller's role in these gyms cannot create an assignment through the
   * API, so the fixture is inserted directly — with the snapshot the POST
   * route would have captured, since that is what is under test.
   */
  async function assignConfiguredPlanAsAdmin(gym: string) {
    const planId = await createPlan(gym);
    const item = await createSellableItem(gym, { amount: 20 });
    const memberId = await createMember(gym);
    const { insertId } = await db.query(
      `INSERT INTO user_memberships
         (member_id, gym_id, membership_plan_id, base_price, final_price, starts_at, status,
          free_months, paid_months, bonus_months, recurring_billing_interval, recurring_billing_unit,
          membership_fee_price)
       VALUES (?, ?, ?, 0, 80, ?, 'active', 1, 12, 2, 1, 'month', 80)`,
      [memberId, gym, planId, dayOffset(0)],
    );
    await db.query(
      'INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, 1)',
      [gym, insertId, memberId],
    );
    await db.query(
      `INSERT INTO user_membership_periodical
         (gym_id, user_membership_id, gym_charge_id, quantity, item_name, item_type,
          item_billing_frequency, unit_price, currency)
       VALUES (?, ?, ?, 1, 'APSE Item', 'service', 'month', 20, 'EUR')`,
      [gym, insertId, item],
    );
    return { umId: insertId as number, itemId: item };
  }
});
