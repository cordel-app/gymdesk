// #635 stage 3 — billing reads the Assigned Plan snapshot.
//
// Stage 2 wrote the record (`assigned-plan-snapshot.test.ts` proves it is
// complete and frozen); this file proves what reads it. Every case sets an
// assignment up through the real routers, edits the catalogue underneath it,
// and asserts the *charges* do not move — §13's "must NOT change" table, plus
// §16 (Promotions) and §17 (Sellable Item prices), plus the live fallback for
// an assignment that captured no snapshot.
//
// Integration, not unit: the whole point is which row the loader reads, so
// each case drives Express + MySQL end to end. The engine's own arithmetic is
// unit-tested in `billing-simulation.test.ts`.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';

// The nightly run's success branch is what advances `next_billing_date`, and
// no provider is configured in tests — so the provider is stubbed here (this
// file only) to make the branch reachable and deterministic.
vi.mock('../payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../payments')>()),
  getPaymentProvider: () => ({
    executeRecurring: async () => ({ success: true, providerRef: 'apsb-test-ref' }),
  }),
}));
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

function dayOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function createMember(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Snapshot Billing Member', `apsb-${uniq()}@test.com`],
  );
  return insertId;
}

async function createPlan(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans
       (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_months, paid_months, bonus_months)
     VALUES (?, ?, 'active', 'public', '1', 0, 12, 0)`,
    [gymId, `APSB-Plan-${uniq()}`],
  );
  return insertId;
}

async function setPlanPrice(gymId: string, planId: number, price: number): Promise<void> {
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, ?, ?, 'active')`,
    [gymId, planId, price, dayOffset(-365)],
  );
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

async function createSellableItem(gymId: string, opts: {
  type?: string; billingFrequency?: string | null; amount?: number; name?: string;
} = {}): Promise<number> {
  const { type = 'service', billingFrequency = 'month', amount = 20, name = `APSB-Item-${uniq()}` } = opts;
  const { insertId } = await db.query(
    `INSERT INTO gym_charges
       (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, ?, ?, 'EUR', ?, 'active', 'available', 0)`,
    [gymId, name, type, amount, billingFrequency],
  );
  return insertId;
}

async function addPlanBenefit(
  gymId: string, table: string, planId: number, chargeId: number, quantity = 1,
): Promise<void> {
  await db.query(
    `INSERT INTO ${table} (gym_id, membership_plan_id, gym_charge_id, quantity) VALUES (?, ?, ?, ?)`,
    [gymId, planId, chargeId, quantity],
  );
}

const assign = (gymId: string, body: Record<string, unknown>) =>
  request.post('/user-memberships')
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send(body);

const getSimulation = (gymId: string, memberId: number) =>
  request.get(`/user-memberships/member/${memberId}/billing-simulation`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

const sectionOf = (body: any, name: string) => body.sections.find((s: any) => s.section === name);

/** Every line of the first event of a section, keyed by label. */
function firstEventLines(body: any, section: string): Record<string, any> {
  const sec = sectionOf(body, section);
  const lines: Record<string, any> = {};
  for (const line of sec?.events[0]?.lines ?? []) lines[line.label] = line;
  return lines;
}

// ─── The Plan's own benefit sections are billed from the snapshot ────────────

describe('Billing Simulation — the Assigned Plan bills its frozen configuration', () => {
  let gymId: string;
  let memberId: number;
  let planId: number;
  let lockerId: number;
  let feeId: number;
  let sessionsId: number;
  let lockerName: string;

  beforeAll(async () => {
    gymId = await createTestGym('APSB Simulation Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId);
    planId = await createPlan(gymId);
    await setPlanPrice(gymId, planId, 75);
    await setBillingPolicy(gymId, planId, 1, 'month');

    lockerName = `APSB-Locker-${uniq()}`;
    lockerId = await createSellableItem(gymId, { amount: 20, billingFrequency: 'month', name: lockerName });
    feeId = await createSellableItem(gymId, { type: 'fee', amount: 50, billingFrequency: 'once', name: `APSB-Fee-${uniq()}` });
    sessionsId = await createSellableItem(gymId, { type: 'sessions', amount: 30, billingFrequency: 'per_session', name: `APSB-PT-${uniq()}` });
    await addPlanBenefit(gymId, 'membership_plan_periodical', planId, lockerId, 1);
    await addPlanBenefit(gymId, 'membership_plan_oneoff', planId, feeId, 1);
    await addPlanBenefit(gymId, 'membership_plan_session', planId, sessionsId, 10);

    const res = await assign(gymId, {
      member_id: memberId, membership_plan_id: planId, starts_at: dayOffset(0),
    });
    expect(res.status).toBe(201);
  });

  it('bills the Membership Fee and the Plan Period Benefit on the same date', async () => {
    const res = await getSimulation(gymId, memberId);
    expect(res.status).toBe(200);
    const monthly = sectionOf(res.body, 'month');
    expect(monthly.events[0].date).toBe(dayOffset(0));
    const lines = firstEventLines(res.body, 'month');
    expect(Object.keys(lines)).toHaveLength(2);
    expect(lines[lockerName]).toMatchObject({ quantity: 1, unit_price: 20, regular_price: 20, actual_charge: 20 });
    expect(monthly.events[0].total).toBe(95);
  });

  it('charges a Plan One-off Benefit and a Plan Session Benefit in full — they are not free', async () => {
    const { body } = await getSimulation(gymId, memberId);
    const oneOff = sectionOf(body, 'one_off');
    expect(oneOff.events[0].lines[0]).toMatchObject({ quantity: 1, regular_price: 50, actual_charge: 50, benefits: [] });
    const session = sectionOf(body, 'session');
    expect(session.events[0].lines[0]).toMatchObject({ quantity: 10, unit_price: 30, regular_price: 300, actual_charge: 300 });
  });

  // §13, in one pass: every kind of catalogue edit, against a simulation that
  // must come back byte-identical.
  it('does not move when the Plan, its price, its cadence or a Sellable Item is edited', async () => {
    const before = (await getSimulation(gymId, memberId)).body;

    await db.query('UPDATE membership_plan_prices SET price = 500 WHERE membership_plan_id = ?', [planId]);
    await db.query(
      'UPDATE billing_policies SET recurring_billing_interval = 1, recurring_billing_unit = ? WHERE membership_plan_id = ?',
      ['year', planId],
    );
    await db.query('UPDATE membership_plans SET free_months = 6, paid_months = 24 WHERE id = ?', [planId]);
    await db.query('UPDATE gym_charges SET amount = 999, name = ? WHERE id = ?', ['Renamed Locker', lockerId]);
    await db.query('UPDATE membership_plan_session SET quantity = 99 WHERE membership_plan_id = ?', [planId]);
    await db.query('DELETE FROM membership_plan_periodical WHERE membership_plan_id = ?', [planId]);

    const after = (await getSimulation(gymId, memberId)).body;
    expect(after).toEqual(before);
  });

  it('keeps billing a Sellable Item that is retired afterwards', async () => {
    await db.query(
      "UPDATE gym_charges SET deleted_at = UTC_TIMESTAMP(), status = 'inactive' WHERE id = ?",
      [lockerId],
    );
    const lines = firstEventLines((await getSimulation(gymId, memberId)).body, 'month');
    expect(lines[lockerName]).toMatchObject({ actual_charge: 20 });
  });
});

// ─── §16 — an applied Promotion keeps the configuration it was applied with ──

describe('Billing Simulation — an applied Promotion is frozen onto the assignment', () => {
  let gymId: string;
  let memberId: number;
  let planId: number;
  let lockerId: number;
  let lockerName: string;
  let promotionId: number;
  let umId: number;

  beforeAll(async () => {
    gymId = await createTestGym('APSB Promotion Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId);
    planId = await createPlan(gymId);
    await setPlanPrice(gymId, planId, 100);
    await setBillingPolicy(gymId, planId, 1, 'month');
    lockerName = `APSB-PromoLocker-${uniq()}`;
    lockerId = await createSellableItem(gymId, { amount: 20, billingFrequency: 'month', name: lockerName });
    await addPlanBenefit(gymId, 'membership_plan_periodical', planId, lockerId, 1);

    const res = await assign(gymId, {
      member_id: memberId, membership_plan_id: planId, starts_at: dayOffset(0),
    });
    expect(res.status).toBe(201);
    umId = res.body.id;

    const { insertId } = await db.query(
      `INSERT INTO promotions
         (gym_id, name, lifecycle_status, stackable, only_applicable_for_new_members,
          starts_at, ends_at, free_months, paid_months, bonus_months, pay_beforehand_months)
       VALUES (?, ?, 'active', 1, 0, ?, ?, 0, 0, 0, 0)`,
      [gymId, `APSB-Promo-${uniq()}`, dayOffset(-30), dayOffset(365)],
    );
    promotionId = insertId;
    await db.query(
      'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
      [gymId, promotionId, planId],
    );
    // Two free months of the locker the Plan already carries.
    await db.query(
      'INSERT INTO promotion_periodical (gym_id, promotion_id, gym_charge_id, quantity) VALUES (?, ?, ?, 2)',
      [gymId, promotionId, lockerId],
    );

    const applied = await request.post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
      .send({ promotion_id: promotionId });
    expect(applied.status).toBe(201);
  });

  it('merges the grant into the Plan item rather than billing it twice', async () => {
    const { body } = await getSimulation(gymId, memberId);
    const lines = firstEventLines(body, 'month');
    // Membership Fee + one locker line, not two locker lines.
    expect(Object.keys(lines)).toHaveLength(2);
    expect(lines[lockerName]).toMatchObject({ actual_charge: 0, regular_price: 20 });
    expect(lines[lockerName].benefits[0]).toMatchObject({ source: 'promotion', action: 'included' });
  });

  it('charges the item again once the granted periods run out', async () => {
    const { body } = await getSimulation(gymId, memberId);
    const events = sectionOf(body, 'month').events;
    expect(events.length).toBeGreaterThanOrEqual(3);
    const third = events[2].lines.find((l: any) => l.label === lockerName);
    expect(third).toMatchObject({ actual_charge: 20 });
  });

  it('does not move when the Promotion or its benefit is edited or deleted afterwards', async () => {
    const before = (await getSimulation(gymId, memberId)).body;

    await db.query('UPDATE promotion_periodical SET quantity = 12 WHERE promotion_id = ?', [promotionId]);
    await db.query('UPDATE gym_charges SET amount = 777 WHERE id = ?', [lockerId]);
    await db.query('DELETE FROM promotion_periodical WHERE promotion_id = ?', [promotionId]);
    await db.query("UPDATE promotions SET lifecycle_status = 'deleted' WHERE id = ?", [promotionId]);

    const after = (await getSimulation(gymId, memberId)).body;
    expect(after).toEqual(before);
  });
});

// ─── §17 — an Additional Periodic Service keeps its attached price ───────────

describe('Billing Simulation — an attached service keeps the price it was attached at', () => {
  let gymId: string;
  let memberId: number;
  let serviceItemId: number;
  let serviceName: string;

  beforeAll(async () => {
    gymId = await createTestGym('APSB Service Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    await setPlanPrice(gymId, planId, 60);
    await setBillingPolicy(gymId, planId, 1, 'month');

    const res = await assign(gymId, {
      member_id: memberId, membership_plan_id: planId, starts_at: dayOffset(0),
    });
    expect(res.status).toBe(201);

    serviceName = `APSB-Service-${uniq()}`;
    serviceItemId = await createSellableItem(gymId, { amount: 40, billingFrequency: 'month', name: serviceName });
    const attached = await request.post(`/user-memberships/${res.body.id}/services`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
      .send({ gym_charge_id: serviceItemId, quantity: 2, starts_at: dayOffset(0) });
    expect(attached.status).toBe(201);
  });

  it('bills quantity × the attached unit price', async () => {
    const lines = firstEventLines((await getSimulation(gymId, memberId)).body, 'month');
    expect(lines[serviceName]).toMatchObject({ quantity: 2, unit_price: 40, actual_charge: 80 });
  });

  it('ignores a later reprice or rename of the Sellable Item', async () => {
    await db.query('UPDATE gym_charges SET amount = 400, name = ? WHERE id = ?', ['Renamed Service', serviceItemId]);
    const lines = firstEventLines((await getSimulation(gymId, memberId)).body, 'month');
    expect(lines[serviceName]).toMatchObject({ unit_price: 40, actual_charge: 80 });
    expect(lines['Renamed Service']).toBeUndefined();
  });
});

// ─── The live fallback, for an assignment that captured no snapshot ──────────

describe('Billing Simulation — an assignment with no snapshot still resolves live', () => {
  let gymId: string;
  let memberId: number;
  let planId: number;
  let lockerName: string;

  beforeAll(async () => {
    gymId = await createTestGym('APSB Legacy Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId);
    planId = await createPlan(gymId);
    await setPlanPrice(gymId, planId, 45);
    await setBillingPolicy(gymId, planId, 1, 'month');
    lockerName = `APSB-LegacyLocker-${uniq()}`;
    const lockerId = await createSellableItem(gymId, { amount: 15, billingFrequency: 'month', name: lockerName });
    await addPlanBenefit(gymId, 'membership_plan_periodical', planId, lockerId, 1);

    // The shape a row created before migration 174 has: no cadence, no regular
    // fee, no benefit rows of its own.
    await db.query(
      `INSERT INTO user_memberships
         (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
       VALUES (?, ?, ?, 'active', ?, 0)`,
      [gymId, memberId, planId, dayOffset(0)],
    );
  });

  it('prices the fee, the cadence and the Plan benefits from the live catalogue', async () => {
    const { body } = await getSimulation(gymId, memberId);
    expect(body.available).toBe(true);
    const lines = firstEventLines(body, 'month');
    expect(lines[lockerName]).toMatchObject({ actual_charge: 15 });
    expect(sectionOf(body, 'month').events[0].total).toBe(60);
  });

  it('follows a later Plan price change, because it has no snapshot to hold it', async () => {
    await db.query('UPDATE membership_plan_prices SET price = 80 WHERE membership_plan_id = ?', [planId]);
    const { body } = await getSimulation(gymId, memberId);
    expect(sectionOf(body, 'month').events[0].total).toBe(95);
  });
});

// ─── The nightly run and the schedule follow the frozen cadence ──────────────

describe('POST /billing/run — charges on the assignment\'s own cadence', () => {
  let gymId: string;
  let memberId: number;
  let planId: number;
  let umId: number;

  beforeAll(async () => {
    process.env.BILLING_INTERNAL_SECRET = 'test-billing-secret';
    gymId = await createTestGym('APSB Billing Run Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId);
    planId = await createPlan(gymId);
    await setPlanPrice(gymId, planId, 30);
    await setBillingPolicy(gymId, planId, 1, 'month');

    const res = await assign(gymId, {
      member_id: memberId, membership_plan_id: planId, starts_at: dayOffset(0),
    });
    expect(res.status).toBe(201);
    umId = res.body.id;
    await db.query(
      `UPDATE user_memberships SET status = 'active', next_billing_date = '2000-01-01', membership_fee_price = 30 WHERE id = ?`,
      [umId],
    );
    // A payment method with no stored token: the run selects the assignment
    // and emits a `failed_billing` event instead of calling a provider, which
    // is all this case needs — the assertion is on which assignments the query
    // selects, not on the charge itself.
    await db.query(
      `INSERT INTO payment_methods (gym_id, member_id, provider, payment_token, sequence_id)
       VALUES (?, ?, 'monei', NULL, NULL)`,
      [gymId, memberId],
    );
    await db.query('UPDATE billing_run_log SET last_run_at = NULL WHERE id = 1');
  });

  it('still bills an assignment whose Plan lost its billing policy', async () => {
    await db.query('DELETE FROM billing_policies WHERE membership_plan_id = ?', [planId]);
    const res = await request.post('/billing/run').set('X-Internal-Secret', 'test-billing-secret');
    expect(res.status).toBe(200);
    const { rows } = await db.query(
      "SELECT event_type, notes FROM billing_events WHERE user_membership_id = ? AND event_type = 'failed_billing'",
      [umId],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].notes).toBe('no_payment_method');
  });

  it('advances the schedule by the frozen cadence, not the Plan\'s current one', async () => {
    // A monthly assignment whose Plan has since been switched to yearly.
    await db.query('UPDATE billing_run_log SET last_run_at = NULL WHERE id = 1');
    await setBillingPolicy(gymId, planId, 1, 'year');
    await db.query(
      'UPDATE payment_methods SET payment_token = ?, sequence_id = ? WHERE gym_id = ? AND member_id = ?',
      [`tok-${uniq()}`, `seq-${uniq()}`, gymId, memberId],
    );
    await db.query("UPDATE user_memberships SET next_billing_date = '2000-01-01' WHERE id = ?", [umId]);

    const res = await request.post('/billing/run').set('X-Internal-Secret', 'test-billing-secret');
    expect(res.status).toBe(200);
    expect(res.body.succeeded).toBeGreaterThan(0);

    const { rows } = await db.query(
      'SELECT next_billing_date FROM user_memberships WHERE id = ?', [umId],
    );
    const next = rows[0].next_billing_date instanceof Date
      ? rows[0].next_billing_date.toISOString().slice(0, 10)
      : String(rows[0].next_billing_date).slice(0, 10);
    expect(next).toBe('2000-02-01');
  });
});

// ─── The Assigned Plan's own Billing Events projection ───────────────────────

describe('GET /user-memberships/:id/billing-events — projects on the frozen cadence', () => {
  let gymId: string;
  let planId: number;
  let umId: number;

  beforeAll(async () => {
    gymId = await createTestGym('APSB Billing Events Gym');
    await createTestMembership(gymId, 'admin');
    const memberId = await createMember(gymId);
    planId = await createPlan(gymId);
    await setPlanPrice(gymId, planId, 90);
    await setBillingPolicy(gymId, planId, 1, 'month');
    const res = await assign(gymId, {
      member_id: memberId, membership_plan_id: planId, starts_at: '2026-01-01',
    });
    expect(res.status).toBe(201);
    umId = res.body.id;
    // The draft path is the one that projects (a submitted plan reads the
    // persisted ledger instead), so pin the status rather than depend on what
    // POST defaults to.
    await db.query("UPDATE user_memberships SET status = 'draft' WHERE id = ?", [umId]);
  });

  it('keeps the monthly projection after the Plan is switched to yearly', async () => {
    const before = await request.get(`/user-memberships/${umId}/billing-events`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(before.status).toBe(200);
    expect(before.body.events[0].date).toBe('2026-02-01');

    await db.query(
      "UPDATE billing_policies SET recurring_billing_interval = 1, recurring_billing_unit = 'year' WHERE membership_plan_id = ?",
      [planId],
    );
    const after = await request.get(`/user-memberships/${umId}/billing-events`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(after.body.events[0].date).toBe('2026-02-01');
    expect(after.body).toEqual(before.body);
  });
});

// ─── Tenant isolation ────────────────────────────────────────────────────────

describe('tenant isolation', () => {
  it('never reads another gym\'s snapshot rows into a simulation', async () => {
    const gymA = await createTestGym('APSB Isolation A');
    await createTestMembership(gymA, 'admin');
    const gymB = await createTestGym('APSB Isolation B');
    await createTestMembership(gymB, 'admin');

    const memberId = await createMember(gymA);
    const planId = await createPlan(gymA);
    await setPlanPrice(gymA, planId, 70);
    await setBillingPolicy(gymA, planId, 1, 'month');
    const itemId = await createSellableItem(gymA, { amount: 25, billingFrequency: 'month' });
    await addPlanBenefit(gymA, 'membership_plan_periodical', planId, itemId, 1);
    const res = await assign(gymA, {
      member_id: memberId, membership_plan_id: planId, starts_at: dayOffset(0),
    });
    expect(res.status).toBe(201);

    // Gym B's benefit row, pointed at gym A's assignment id: the loaders filter
    // on gym_id, so it must not reach the simulation.
    const otherItemId = await createSellableItem(gymB, { amount: 999, billingFrequency: 'month' });
    await db.query(
      `INSERT INTO user_membership_periodical
         (gym_id, user_membership_id, gym_charge_id, quantity, item_name, item_type,
          item_billing_frequency, unit_price, currency)
       VALUES (?, ?, ?, 1, 'Cross-tenant Item', 'service', 'month', 999, 'EUR')`,
      [gymB, res.body.id, otherItemId],
    );

    const sim = await getSimulation(gymA, memberId);
    const labels = sectionOf(sim.body, 'month').events[0].lines.map((l: any) => l.label);
    expect(labels).not.toContain('Cross-tenant Item');

    const other = await getSimulation(gymB, memberId);
    expect(other.status).toBe(404);
  });
});
