// #635 stage 2 — the Assigned Membership Plan's own snapshot of the commercial
// configuration it was assigned with (migration 174).
//
// Integration tests: the point of the stage is what the *database* ends up
// holding after an assignment, so every case here drives the real routers over
// the full Express + MySQL stack and then edits the catalogue underneath to
// prove the assignment does not move (§13, §16, §17).
//
// Billing itself is untouched by this stage — the cutover to these rows is
// stage 3 — so nothing below asserts a changed charge; it asserts that the
// record the cutover will read is complete and frozen.

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

// ─── Fixtures (direct inserts; the HTTP API is only used for the action under
// test, per CLAUDE.md) ────────────────────────────────────────────────────────

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

/** YYYY-MM-DD, `days` from today in UTC. */
function dayOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function createPlan(gymId: string, opts: {
  freeMonths?: number | null; paidMonths?: number | null; bonusMonths?: number | null;
  enrollment?: 'public' | 'staff_only';
} = {}): Promise<number> {
  const { freeMonths = 1, paidMonths = 12, bonusMonths = 2, enrollment = 'public' } = opts;
  const { insertId } = await db.query(
    `INSERT INTO membership_plans
       (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_months, paid_months, bonus_months)
     VALUES (?, ?, 'active', ?, '1', ?, ?, ?)`,
    [gymId, `APS-Plan-${uniq()}`, enrollment, freeMonths, paidMonths, bonusMonths],
  );
  return insertId;
}

async function setPlanPrice(gymId: string, planId: number, price: number, validFrom = dayOffset(-365)): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, ?, ?, 'active')`,
    [gymId, planId, price, validFrom],
  );
  return insertId;
}

async function setBillingPolicy(
  gymId: string, planId: number, interval = 1, unit: 'day' | 'week' | 'month' | 'year' = 'month',
): Promise<void> {
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, ?, ?)`,
    [gymId, planId, interval, unit],
  );
}

async function createMember(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'APS Member', `aps-${uniq()}@test.com`],
  );
  return insertId;
}

async function createSellableItem(gymId: string, opts: {
  type?: string; billingFrequency?: string | null; amount?: number; name?: string;
} = {}): Promise<number> {
  const { type = 'service', billingFrequency = 'month', amount = 20, name = `APS-Item-${uniq()}` } = opts;
  const { insertId } = await db.query(
    `INSERT INTO gym_charges
       (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, ?, ?, 'EUR', ?, 'active', 'available', 0)`,
    [gymId, name, type, amount, billingFrequency],
  );
  return insertId;
}

/** A benefit row on the Plan side (migration 173). */
async function addPlanBenefit(
  gymId: string, table: string, planId: number, chargeId: number, quantity = 1,
): Promise<void> {
  await db.query(
    `INSERT INTO ${table} (gym_id, membership_plan_id, gym_charge_id, quantity) VALUES (?, ?, ?, ?)`,
    [gymId, planId, chargeId, quantity],
  );
}

const getAssignment = (gymId: string, umId: number | string) =>
  request
    .get(`/user-memberships/${umId}`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId);

const assign = (gymId: string, body: Record<string, unknown>) =>
  request
    .post('/user-memberships')
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send(body);

/** A Plan with a price, a cadence and one benefit of each of the three kinds. */
async function createFullyConfiguredPlan(gymId: string) {
  const planId = await createPlan(gymId);
  await setPlanPrice(gymId, planId, 75);
  await setBillingPolicy(gymId, planId, 1, 'month');
  const sessionItem = await createSellableItem(gymId, { type: 'sessions', billingFrequency: 'per_session', amount: 30, name: `APS-Sessions-${uniq()}` });
  const oneoffItem = await createSellableItem(gymId, { type: 'fee', billingFrequency: 'once', amount: 50, name: `APS-Fee-${uniq()}` });
  const periodicalItem = await createSellableItem(gymId, { type: 'service', billingFrequency: 'month', amount: 20, name: `APS-Locker-${uniq()}` });
  await addPlanBenefit(gymId, 'membership_plan_session', planId, sessionItem, 10);
  await addPlanBenefit(gymId, 'membership_plan_oneoff', planId, oneoffItem, 1);
  await addPlanBenefit(gymId, 'membership_plan_periodical', planId, periodicalItem, 2);
  return { planId, sessionItem, oneoffItem, periodicalItem };
}

/**
 * A system Sellable Item: `gym_charges` rows created from a `charge_types` row
 * carry neither their own `name` nor `type` (both columns are nullable and the
 * display name comes from the charge type), which is the shape that would
 * otherwise write a NULL into the snapshot's NOT NULL columns.
 */
async function createSystemSellableItem(gymId: string): Promise<{ id: number; chargeTypeName: string }> {
  const { rows } = await db.query(
    `SELECT ct.id, ct.name FROM charge_types ct
     WHERE ct.is_gym_charge = 1
       AND NOT EXISTS (SELECT 1 FROM gym_charges gc WHERE gc.gym_id = ? AND gc.charge_type_id = ct.id)
     LIMIT 1`,
    [gymId],
  );
  const { insertId } = await db.query(
    `INSERT INTO gym_charges (gym_id, charge_type_id, availability, amount, currency, billing_frequency, status, is_system)
     VALUES (?, ?, 'available', 35, 'EUR', 'once', 'active', 1)`,
    [gymId, rows[0].id],
  );
  return { id: insertId, chargeTypeName: rows[0].name };
}

// ─── The snapshot taken at assignment time ────────────────────────────────────

describe('POST /user-memberships — captures the Plan configuration', () => {
  let gymId: string;
  let planId: number;
  let periodicalItem: number;
  let umId: number;

  beforeAll(async () => {
    gymId = await createTestGym('APS Assign Gym');
    await createTestMembership(gymId, 'admin');
    ({ planId, periodicalItem } = await createFullyConfiguredPlan(gymId));
    const res = await assign(gymId, {
      member_id: await createMember(gymId),
      membership_plan_id: planId,
      starts_at: dayOffset(0),
    });
    expect(res.status).toBe(201);
    umId = res.body.id;
  });

  it('freezes Billing & Duration, the cadence and the regular fee', async () => {
    const res = await getAssignment(gymId, umId);
    expect(res.status).toBe(200);
    expect(res.body.snapshot).toMatchObject({
      free_months: 1,
      paid_months: 12,
      bonus_months: 2,
      recurring_billing_interval: 1,
      recurring_billing_unit: 'month',
      membership_fee_price: 75,
      snapshot_captured: true,
    });
  });

  it('copies each benefit section with the item price as it was', async () => {
    const { body } = await getAssignment(gymId, umId);
    expect(body.snapshot.session_benefits).toHaveLength(1);
    expect(body.snapshot.session_benefits[0]).toMatchObject({ quantity: 10, unit_price: 30, item_type: 'sessions', currency: 'EUR' });
    expect(body.snapshot.oneoff_benefits[0]).toMatchObject({ quantity: 1, unit_price: 50, item_type: 'fee' });
    expect(body.snapshot.periodical_benefits[0]).toMatchObject({
      quantity: 2, unit_price: 20, item_billing_frequency: 'month', gym_charge_id: periodicalItem,
    });
  });

  // §13 — every row of the ticket's "must NOT change" table, in one pass.
  it('does not move when the Plan, its price or a Sellable Item is edited afterwards', async () => {
    await db.query(
      'UPDATE membership_plans SET free_months = 6, paid_months = 24, bonus_months = 0 WHERE id = ?',
      [planId],
    );
    await db.query('UPDATE billing_policies SET recurring_billing_interval = 4, recurring_billing_unit = ? WHERE membership_plan_id = ?', ['week', planId]);
    await db.query('UPDATE membership_plan_prices SET price = 200 WHERE membership_plan_id = ?', [planId]);
    await db.query('UPDATE gym_charges SET amount = 999, name = ? WHERE id = ?', ['Renamed Locker', periodicalItem]);
    await db.query('DELETE FROM membership_plan_periodical WHERE membership_plan_id = ?', [planId]);

    const { body } = await getAssignment(gymId, umId);
    expect(body.snapshot).toMatchObject({
      free_months: 1, paid_months: 12, bonus_months: 2,
      recurring_billing_interval: 1, recurring_billing_unit: 'month',
      membership_fee_price: 75,
    });
    expect(body.snapshot.periodical_benefits).toHaveLength(1);
    expect(body.snapshot.periodical_benefits[0].unit_price).toBe(20);
    expect(body.snapshot.periodical_benefits[0].item_name).not.toBe('Renamed Locker');
  });

  it('survives the Sellable Item being retired', async () => {
    await db.query('UPDATE gym_charges SET deleted_at = UTC_TIMESTAMP(), status = ? WHERE id = ?', ['inactive', periodicalItem]);
    const { body } = await getAssignment(gymId, umId);
    expect(body.snapshot.periodical_benefits).toHaveLength(1);
    expect(body.snapshot.periodical_benefits[0].unit_price).toBe(20);
  });
});

describe('the other assignment entry points snapshot too', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('APS Entry Points Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('POST /:id/assign-new-plan snapshots the new plan and leaves the superseded one alone', async () => {
    const first = await createFullyConfiguredPlan(gymId);
    const memberId = await createMember(gymId);
    const created = await assign(gymId, { member_id: memberId, membership_plan_id: first.planId, starts_at: dayOffset(0) });
    expect(created.status).toBe(201);

    const second = await createPlan(gymId, { freeMonths: 0, paidMonths: 6, bonusMonths: null });
    await setPlanPrice(gymId, second, 120);
    await setBillingPolicy(gymId, second, 1, 'year');

    const res = await request
      .post(`/user-memberships/${created.body.id}/assign-new-plan`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ membership_plan_id: second, starts_at: dayOffset(0) });
    expect(res.status).toBe(201);

    const fresh = await getAssignment(gymId, res.body.id);
    expect(fresh.body.snapshot).toMatchObject({
      free_months: 0, paid_months: 6, bonus_months: null,
      recurring_billing_interval: 1, recurring_billing_unit: 'year',
      membership_fee_price: 120,
    });

    const superseded = await getAssignment(gymId, created.body.id);
    expect(superseded.body.snapshot).toMatchObject({ paid_months: 12, membership_fee_price: 75 });
  });

  it('POST /membership-plans/:id/assign snapshots as well', async () => {
    const { planId } = await createFullyConfiguredPlan(gymId);
    const memberId = await createMember(gymId);
    const res = await request
      .post(`/membership-plans/${planId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_ids: [memberId], owner_member_id: memberId, starts_at: dayOffset(0) });
    expect(res.status).toBe(201);

    const { body } = await getAssignment(gymId, res.body.id);
    expect(body.snapshot.membership_fee_price).toBe(75);
    expect(body.snapshot.session_benefits).toHaveLength(1);
    expect(body.snapshot.oneoff_benefits).toHaveLength(1);
    expect(body.snapshot.periodical_benefits).toHaveLength(1);
  });

  // A Plan with no price window has no regular fee to freeze, and there is no
  // other stored price to borrow one from (#635 stage 15).
  it('leaves the regular fee null when the Plan has no price window', async () => {
    const planId = await createPlan(gymId);
    const res = await assign(gymId, {
      member_id: await createMember(gymId), membership_plan_id: planId, starts_at: dayOffset(0),
    });
    expect(res.status).toBe(201);
    const { body } = await getAssignment(gymId, res.body.id);
    expect(body.snapshot.membership_fee_price).toBeNull();
    // Durations still came from the Plan, so the snapshot exists.
    expect(body.snapshot.snapshot_captured).toBe(true);
  });
});

// A system Sellable Item has no `name` and no `type` of its own, and the
// snapshot columns are NOT NULL — copying them raw would 500 the assignment.
describe('a Plan carrying a system Sellable Item still assigns', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('APS System Item Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('resolves the charge type name and falls back to type "other"', async () => {
    const planId = await createPlan(gymId);
    await setPlanPrice(gymId, planId, 60);
    const system = await createSystemSellableItem(gymId);
    await addPlanBenefit(gymId, 'membership_plan_oneoff', planId, system.id, 1);

    const res = await assign(gymId, {
      member_id: await createMember(gymId), membership_plan_id: planId, starts_at: dayOffset(0),
    });
    expect(res.status).toBe(201);

    const { body } = await getAssignment(gymId, res.body.id);
    expect(body.snapshot.oneoff_benefits).toHaveLength(1);
    expect(body.snapshot.oneoff_benefits[0]).toMatchObject({
      item_name: system.chargeTypeName, item_type: 'other', unit_price: 35,
    });
  });
});

// ─── Tenant isolation & auth ──────────────────────────────────────────────────

describe('tenant isolation and auth', () => {
  let gymA: string;
  let gymB: string;
  let umId: number;
  let planA: number;

  beforeAll(async () => {
    gymA = await createTestGym('APS Gym A');
    gymB = await createTestGym('APS Gym B');
    await createTestMembership(gymA, 'admin');
    await createTestMembership(gymB, 'admin');
    ({ planId: planA } = await createFullyConfiguredPlan(gymA));
    const res = await assign(gymA, {
      member_id: await createMember(gymA), membership_plan_id: planA, starts_at: dayOffset(0),
    });
    umId = res.body.id;
  });

  it("gym B cannot read gym A's assignment or its snapshot", async () => {
    const res = await getAssignment(gymB, umId);
    expect(res.status).toBe(404);
  });

  it('every snapshot row carries the owning gym', async () => {
    const { rows } = await db.query(
      `SELECT gym_id FROM user_membership_periodical WHERE user_membership_id = ?
       UNION ALL SELECT gym_id FROM user_membership_session WHERE user_membership_id = ?
       UNION ALL SELECT gym_id FROM user_membership_oneoff WHERE user_membership_id = ?`,
      [umId, umId, umId],
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r: any) => r.gym_id === gymA)).toBe(true);
  });

  it('unauthenticated reads are rejected', async () => {
    const res = await request.get(`/user-memberships/${umId}`).set('x-gym-id', gymA);
    expect(res.status).toBe(401);
  });

  it('a role without PAYMENTS write cannot assign (and so cannot write a snapshot)', async () => {
    const gymC = await createTestGym('APS Gym C');
    await createTestMembership(gymC, 'trainer_performance');
    const planC = await createPlan(gymC);
    const res = await assign(gymC, {
      member_id: await createMember(gymC), membership_plan_id: planC, starts_at: dayOffset(0),
    });
    expect(res.status).toBe(403);
  });
});

// ─── Assignments made before the snapshot existed ─────────────────────────────

describe('an assignment with no snapshot still reads back', () => {
  let gymId: string;
  let umId: number;

  beforeAll(async () => {
    gymId = await createTestGym('APS Legacy Gym');
    await createTestMembership(gymId, 'admin');
    // Inserted the way a pre-migration-174 row looks: none of the snapshot
    // columns set, no benefit rows. The reader must not treat that as "this
    // assignment bills nothing" — stage 3 falls back to the live catalogue.
    const { insertId } = await db.query(
      `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
       VALUES (?, ?, NULL, 'active', ?, 40)`,
      [gymId, await createMember(gymId), dayOffset(-10)],
    );
    umId = insertId;
  });

  it('reports an empty, explicitly uncaptured snapshot', async () => {
    const res = await getAssignment(gymId, umId);
    expect(res.status).toBe(200);
    expect(res.body.snapshot).toMatchObject({
      free_months: null, paid_months: null, bonus_months: null,
      recurring_billing_interval: null, recurring_billing_unit: null,
      membership_fee_price: null,
      session_benefits: [], oneoff_benefits: [], periodical_benefits: [],
      snapshot_captured: false,
    });
  });
});

// ─── Promotion grants (§16) ───────────────────────────────────────────────────

describe('applying a Promotion snapshots what it grants', () => {
  let gymId: string;
  let umId: number;
  let promotionId: number;
  let grantedItem: number;

  beforeAll(async () => {
    gymId = await createTestGym('APS Promotion Gym');
    await createTestMembership(gymId, 'admin');
    const { planId } = await createFullyConfiguredPlan(gymId);
    const created = await assign(gymId, {
      member_id: await createMember(gymId), membership_plan_id: planId, starts_at: dayOffset(0),
    });
    expect(created.status).toBe(201);
    umId = created.body.id;

    const { insertId } = await db.query(
      `INSERT INTO promotions (gym_id, name, starts_at, ends_at, stackable, only_applicable_for_new_members,
                               lifecycle_status, free_months, paid_months, bonus_months)
       VALUES (?, ?, ?, ?, 1, 0, 'active', 1, 3, 0)`,
      [gymId, `APS-Promo-${uniq()}`, `${dayOffset(-5)} 00:00:00`, `${dayOffset(30)} 00:00:00`],
    );
    promotionId = insertId;
    await db.query(
      'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
      [gymId, promotionId, planId],
    );
    grantedItem = await createSellableItem(gymId, { type: 'service', billingFrequency: 'month', amount: 15, name: `APS-Granted-${uniq()}` });
    await db.query(
      'INSERT INTO promotion_periodical (gym_id, promotion_id, gym_charge_id, quantity) VALUES (?, ?, ?, ?)',
      [gymId, promotionId, grantedItem, 3],
    );

    const applied = await request
      .post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ promotion_id: promotionId });
    expect(applied.status).toBe(201);
  });

  it('writes a snapshot row with the granted item price', async () => {
    const { rows } = await db.query(
      `SELECT s.* FROM user_membership_promotion_periodical_snapshot s
       JOIN user_membership_promotions ump ON ump.id = s.user_membership_promotion_id
       WHERE ump.user_membership_id = ?`,
      [umId],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].unit_price)).toBe(15);
    expect(rows[0].quantity).toBe(3);
    expect(rows[0].item_billing_frequency).toBe('month');
    expect(rows[0].gym_id).toBe(gymId);
  });

  it('keeps the agreed price after the Promotion and the item are edited', async () => {
    await db.query('UPDATE gym_charges SET amount = 60 WHERE id = ?', [grantedItem]);
    await db.query('UPDATE promotion_periodical SET quantity = 12 WHERE promotion_id = ?', [promotionId]);
    await db.query('DELETE FROM promotion_periodical WHERE promotion_id = ?', [promotionId]);

    const { rows } = await db.query(
      `SELECT s.unit_price, s.quantity FROM user_membership_promotion_periodical_snapshot s
       JOIN user_membership_promotions ump ON ump.id = s.user_membership_promotion_id
       WHERE ump.user_membership_id = ?`,
      [umId],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].unit_price)).toBe(15);
    expect(rows[0].quantity).toBe(3);
  });
});

// ─── Additional Periodic Services (§11) ───────────────────────────────────────

describe('attaching an Additional Periodic Service snapshots its price', () => {
  let gymId: string;
  let umId: number;
  let itemId: number;
  let serviceId: number;

  beforeAll(async () => {
    gymId = await createTestGym('APS Services Gym');
    await createTestMembership(gymId, 'admin');
    const { planId } = await createFullyConfiguredPlan(gymId);
    const created = await assign(gymId, {
      member_id: await createMember(gymId), membership_plan_id: planId, starts_at: dayOffset(-5),
    });
    umId = created.body.id;
    itemId = await createSellableItem(gymId, { type: 'service', billingFrequency: 'month', amount: 40, name: `APS-PT-${uniq()}` });
    const res = await request
      .post(`/user-memberships/${umId}/services`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ gym_charge_id: itemId, quantity: 1 });
    expect(res.status).toBe(201);
    serviceId = res.body.id;
    expect(res.body.snapshot).toMatchObject({ unit_price: 40, billing_frequency: 'month', currency: 'EUR' });
  });

  it('keeps the attached price after the item is repriced', async () => {
    await db.query('UPDATE gym_charges SET amount = 90 WHERE id = ?', [itemId]);
    const res = await request
      .get(`/user-memberships/${umId}/services`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const row = res.body.find((s: any) => s.id === serviceId);
    expect(row.snapshot.unit_price).toBe(40);
    // Stage 2 does not change what billing reads: the live price is still served.
    expect(row.unit_price).toBe(90);
  });

  it('reports no snapshot for an attachment made before migration 174', async () => {
    const { insertId } = await db.query(
      `INSERT INTO user_membership_services (gym_id, user_membership_id, gym_charge_id, quantity, starts_at)
       VALUES (?, ?, ?, 1, ?)`,
      [gymId, umId, await createSellableItem(gymId), dayOffset(-1)],
    );
    const res = await request
      .get(`/user-memberships/${umId}/services`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    const row = res.body.find((s: any) => s.id === insertId);
    expect(row.snapshot).toBeNull();
    expect(row.unit_price).toBe(20);
  });
});
