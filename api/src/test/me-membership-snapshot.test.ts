// #635 stage 10 — the Member's own Membership view reads the Assigned Plan
// snapshot.
//
// `GET /me/membership` is the member app's My Membership page. Until this stage
// it listed `membership_plan_benefits` (P1.4's plan-keyed benefit vocabulary,
// which nothing has written since and migration 184 drops) and took its billing
// cadence from the Plan's live `billing_policies` row — so a Plan re-cadenced
// after the member signed up moved the dates they were shown, which is exactly
// what §13/§14 forbid.
//
// Integration rather than unit: what is under test is *which rows* the endpoint
// reads — the assignment's own snapshot, or the Plan's live sections for an
// assignment that captured nothing. The fallback rule itself is stage 3's and
// the arithmetic behind `upcoming_payments` is unit-tested in
// `me-upcoming-payments.test.ts`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  TEST_USER_ID,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

/** Far enough ahead that `computeUpcomingPayments` never has to roll forward. */
const NEXT_BILLING = '2099-03-10';

const getMembership = (gymId: string) =>
  request.get('/me/membership').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function createItem(
  gymId: string, name: string, type: string, amount: number, billingFrequency: string,
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO gym_charges
       (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, ?, ?, 'EUR', ?, 'active', 'available', 0)`,
    [gymId, name, type, amount, billingFrequency],
  );
  return insertId;
}

async function createPlan(gymId: string, cadence: { interval: number; unit: string }): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`,
    [gymId, `MMS-Plan-${uniq()}`],
  );
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, ?, ?)`,
    [gymId, insertId, cadence.interval, cadence.unit],
  );
  return insertId;
}

/** A `user_memberships` row with (or, with `snapshot: false`, without) a snapshot. */
async function createAssignment(gymId: string, memberId: number, planId: number, opts: {
  snapshot?: { interval: number; unit: string; fee: number };
} = {}): Promise<number> {
  const { snapshot } = opts;
  const { insertId } = await db.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, status, starts_at, base_price,
        next_billing_date, recurring_billing_interval, recurring_billing_unit, membership_fee_price)
     VALUES (?, ?, ?, 'active', '2026-01-10', 60, ?, ?, ?, ?)`,
    [gymId, memberId, planId, NEXT_BILLING,
     snapshot?.interval ?? null, snapshot?.unit ?? null, snapshot?.fee ?? null],
  );
  return insertId;
}

const CATEGORY_TABLE: Record<string, string> = {
  oneoff: 'user_membership_oneoff',
  session: 'user_membership_session',
  periodical: 'user_membership_periodical',
};

async function snapshotBenefit(gymId: string, umId: number, category: string, row: {
  itemId: number; name: string; type: string; quantity: number; price: number; frequency: string | null;
}) {
  await db.query(
    `INSERT INTO ${CATEGORY_TABLE[category]}
       (gym_id, user_membership_id, gym_charge_id, quantity, item_name, item_type,
        unit_price, item_billing_frequency, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'EUR')`,
    [gymId, umId, row.itemId, row.quantity, row.name, row.type, row.price, row.frequency],
  );
}

const PLAN_TABLE: Record<string, string> = {
  oneoff: 'membership_plan_oneoff',
  session: 'membership_plan_session',
  periodical: 'membership_plan_periodical',
};

async function planBenefit(gymId: string, planId: number, category: string, itemId: number, quantity: number) {
  await db.query(
    `INSERT INTO ${PLAN_TABLE[category]} (gym_id, membership_plan_id, gym_charge_id, quantity)
     VALUES (?, ?, ?, ?)`,
    [gymId, planId, itemId, quantity],
  );
}

/** The caller: a member of this gym whose Clerk id is the one the tests sign as. */
async function createCallingMember(gymId: string): Promise<number> {
  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id)
     VALUES (?, 'Snapshot Member', ?, ?)
     ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), email = VALUES(email)`,
    [gymId, `me-membership-${uniq()}@test.com`, TEST_USER_ID],
  );
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM members WHERE clerk_user_id = ?', [TEST_USER_ID],
  );
  return rows[0].id;
}

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ─── The assignment's own benefit rows ───────────────────────────────────────

describe('GET /me/membership — benefits come from the assignment snapshot', () => {
  let gymId: string;
  let memberId: number;
  let planId: number;
  let umId: number;
  let lockerId: number;
  let ptId: number;
  let joiningFeeId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Me Membership Snapshot Gym');
    // Every /me/* route is requireRole('member') — an exact role check.
    await createTestMembership(gymId, 'member');
    memberId = await createCallingMember(gymId);

    planId = await createPlan(gymId, { interval: 1, unit: 'month' });
    lockerId = await createItem(gymId, 'Locker Rental', 'service', 10, 'month');
    ptId = await createItem(gymId, 'Personal Training Pack', 'sessions', 200, 'per_session');
    joiningFeeId = await createItem(gymId, 'Joining Fee', 'fee', 50, 'once');

    umId = await createAssignment(gymId, memberId, planId, {
      snapshot: { interval: 1, unit: 'month', fee: 60 },
    });
    // Frozen at assignment time — deliberately at prices the catalogue no
    // longer carries by the time the last test in this block runs.
    await snapshotBenefit(gymId, umId, 'periodical', {
      itemId: lockerId, name: 'Locker Rental', type: 'service', quantity: 1, price: 10, frequency: 'month',
    });
    await snapshotBenefit(gymId, umId, 'session', {
      itemId: ptId, name: 'Personal Training Pack', type: 'sessions', quantity: 10, price: 200, frequency: 'per_session',
    });
    await snapshotBenefit(gymId, umId, 'oneoff', {
      itemId: joiningFeeId, name: 'Joining Fee', type: 'fee', quantity: 1, price: 50, frequency: 'once',
    });
  });

  it('returns 401 without auth', async () => {
    const res = await request.get('/me/membership').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('lists the frozen lines, one-off → session → period', async () => {
    const res = await getMembership(gymId);
    expect(res.status).toBe(200);
    expect(res.body.membership.benefits).toEqual([
      {
        category: 'oneoff', gym_charge_id: joiningFeeId, name: 'Joining Fee',
        quantity: 1, billing_frequency: 'once', unit_price: 50,
      },
      {
        category: 'session', gym_charge_id: ptId, name: 'Personal Training Pack',
        quantity: 10, billing_frequency: 'per_session', unit_price: 200,
      },
      {
        category: 'periodical', gym_charge_id: lockerId, name: 'Locker Rental',
        quantity: 1, billing_frequency: 'month', unit_price: 10,
      },
    ]);
  });

  it('does not leak the internal has_billing_snapshot flag', async () => {
    const { body } = await getMembership(gymId);
    expect(body.membership).not.toHaveProperty('has_billing_snapshot');
  });

  it('projects the upcoming payments on the assignment\'s frozen cadence, not the Plan\'s', async () => {
    // The Plan is re-cadenced to yearly *after* the assignment was made (§13).
    await db.query(
      `UPDATE billing_policies SET recurring_billing_interval = 1, recurring_billing_unit = 'year'
       WHERE gym_id = ? AND membership_plan_id = ?`,
      [gymId, planId],
    );
    const { body } = await getMembership(gymId);
    expect(body.membership.billing_interval).toBe(1);
    expect(body.membership.billing_unit).toBe('month');
    expect(body.membership.upcoming_payments.map((p: any) => p.date))
      .toEqual([NEXT_BILLING, '2099-04-10']);
  });

  it('keeps the frozen price when the Sellable Item is repriced (§17)', async () => {
    await db.query('UPDATE gym_charges SET amount = 99 WHERE id = ?', [lockerId]);
    const { body } = await getMembership(gymId);
    const locker = body.membership.benefits.find((b: any) => b.gym_charge_id === lockerId);
    expect(locker.unit_price).toBe(10);
  });

  it('ignores a benefit added to the Membership Plan after the assignment (§13)', async () => {
    const newItem = await createItem(gymId, 'Towel Service', 'service', 5, 'month');
    await planBenefit(gymId, planId, 'periodical', newItem, 1);
    const { body } = await getMembership(gymId);
    expect(body.membership.benefits.map((b: any) => b.gym_charge_id)).not.toContain(newItem);
    expect(body.membership.benefits).toHaveLength(3);
  });
});

// ─── The snapshot is all-or-nothing ──────────────────────────────────────────

describe('GET /me/membership — an assignment that captured no snapshot', () => {
  let gymId: string;
  let planId: number;
  let itemId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Me Membership Legacy Gym');
    await createTestMembership(gymId, 'member');
    const memberId = await createCallingMember(gymId);

    planId = await createPlan(gymId, { interval: 3, unit: 'month' });
    itemId = await createItem(gymId, 'Insurance Fee', 'fee', 25, 'year');
    await planBenefit(gymId, planId, 'periodical', itemId, 1);
    // No snapshot columns and no benefit rows: a row from before migration 174.
    await createAssignment(gymId, memberId, planId);
  });

  it('falls back to the Plan\'s live sections and its live cadence', async () => {
    const res = await getMembership(gymId);
    expect(res.status).toBe(200);
    expect(res.body.membership.billing_interval).toBe(3);
    expect(res.body.membership.billing_unit).toBe('month');
    expect(res.body.membership.benefits).toEqual([{
      category: 'periodical', gym_charge_id: itemId, name: 'Insurance Fee',
      quantity: 1, billing_frequency: 'year', unit_price: 25,
    }]);
  });
});

describe('GET /me/membership — a captured assignment whose Plan had no benefits', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Me Membership Captured Empty Gym');
    await createTestMembership(gymId, 'member');
    const memberId = await createCallingMember(gymId);

    const planId = await createPlan(gymId, { interval: 1, unit: 'month' });
    // The Plan gains a section only *after* the assignment captured its
    // (empty) snapshot — the assignment must not fall through to it.
    const umId = await createAssignment(gymId, memberId, planId, {
      snapshot: { interval: 1, unit: 'month', fee: 40 },
    });
    expect(umId).toBeGreaterThan(0);
    const lateItem = await createItem(gymId, 'Late Locker', 'service', 12, 'month');
    await planBenefit(gymId, planId, 'periodical', lateItem, 1);
  });

  it('reports no benefits rather than the Plan\'s current ones', async () => {
    const res = await getMembership(gymId);
    expect(res.status).toBe(200);
    expect(res.body.membership.benefits).toEqual([]);
  });
});

// ─── Only the caller's own assignment ────────────────────────────────────────

describe('GET /me/membership — scoping', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Me Membership Scoping Gym');
    await createTestMembership(gymId, 'member');
    const memberId = await createCallingMember(gymId);

    const planId = await createPlan(gymId, { interval: 1, unit: 'month' });
    const mineId = await createItem(gymId, 'My Locker', 'service', 10, 'month');
    const mine = await createAssignment(gymId, memberId, planId, {
      snapshot: { interval: 1, unit: 'month', fee: 60 },
    });
    await snapshotBenefit(gymId, mine, 'periodical', {
      itemId: mineId, name: 'My Locker', type: 'service', quantity: 1, price: 10, frequency: 'month',
    });

    // Another member of the same gym, on the same Plan, with their own snapshot.
    const { insertId: otherMemberId } = await db.query(
      'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
      [gymId, 'Other Member', `me-membership-other-${uniq()}@test.com`],
    );
    const theirsId = await createItem(gymId, 'Their Locker', 'service', 20, 'month');
    const theirs = await createAssignment(gymId, otherMemberId, planId, {
      snapshot: { interval: 1, unit: 'month', fee: 80 },
    });
    await snapshotBenefit(gymId, theirs, 'periodical', {
      itemId: theirsId, name: 'Their Locker', type: 'service', quantity: 1, price: 20, frequency: 'month',
    });
  });

  it('returns the caller\'s own snapshot only', async () => {
    const { body } = await getMembership(gymId);
    expect(body.membership.benefits.map((b: any) => b.name)).toEqual(['My Locker']);
  });
});

// ─── #635 stage 12: each upcoming charge is priced on its own date ───────────

describe('GET /me/membership — upcoming payments are priced per cycle (#635 stage 12)', () => {
  let gymId: string;
  let memberId: number;
  let planId: number;
  let umId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Me Membership Stage 12 Gym');
    await createTestMembership(gymId, 'member');
    memberId = await createCallingMember(gymId);
    planId = await createPlan(gymId, { interval: 1, unit: 'month' });

    // €60 regular, discounted 20% by a Promotion whose Paid Duration covers
    // January to March 2099 — so the March cycle is discounted and the April one is
    // not. Since #635 stage 15 the €48 exists nowhere in the database: it is what
    // the March cycle resolves to.
    const { insertId } = await db.query(
      `INSERT INTO user_memberships
         (gym_id, member_id, membership_plan_id, status, starts_at, base_price,
          next_billing_date, recurring_billing_interval, recurring_billing_unit, membership_fee_price)
       VALUES (?, ?, ?, 'active', '2099-01-10', 0, ?, 1, 'month', 60)`,
      [gymId, memberId, planId, NEXT_BILLING],
    );
    umId = insertId;

    const { insertId: promotionId } = await db.query(
      `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status,
                               free_months, paid_months, bonus_months)
       VALUES (?, ?, '2099-01-01', '2100-01-01', 'active', 0, 3, 0)`,
      [gymId, `MMS-Promo-${uniq()}`],
    );
    await db.query(
      `INSERT INTO user_membership_promotions
         (gym_id, user_membership_id, promotion_id, applied_by, status, applied_at, snapshot)
       VALUES (?, ?, ?, 'test-actor', 'applied', '2099-01-10', ?)`,
      [gymId, umId, promotionId, JSON.stringify({
        name: 'Three Months 20% Off',
        description: null,
        stackable: false,
        starts_at: '2099-01-01',
        ends_at: '2100-01-01',
        free_months: 0,
        paid_months: 3,
        bonus_months: 0,
        membership_fee_benefits: [{
          quantity: 1, frequency_interval: 1, frequency_unit: 'month', enabled: true,
          action: 'percentage_discount', value: 20, duration_months: null,
        }],
      })],
    );
  });

  it('shows the discounted cycle and the regular one that follows it', async () => {
    const { body } = await getMembership(gymId);
    // Until stage 12 this repeated one stored number (48.00) for every future date
    // — a promise the nightly run would not keep once the Promotion's own months
    // were over.
    expect(body.membership.upcoming_payments).toEqual([
      { date: NEXT_BILLING, amount: '48.00', status: 'scheduled' },
      { date: '2099-04-10', amount: '60.00', status: 'scheduled' },
    ]);
  });

  it('resolves the same amounts the nightly run would charge for those dates', async () => {
    const { priceDueMembershipFee } = await import('../api/billing-run-pricing');
    const { rows } = await db.query(
      `SELECT um.id, um.gym_id, um.membership_plan_id, um.starts_at,
              um.membership_fee_price, um.base_price,
              um.free_months, um.paid_months, um.bonus_months, um.pay_beforehand_months,
              p.free_months AS plan_free_months, p.paid_months AS plan_paid_months,
              p.bonus_months AS plan_bonus_months,
              p.pay_beforehand_months AS plan_pay_beforehand_months, 1 AS has_billing_snapshot
       FROM user_memberships um
       LEFT JOIN membership_plans p ON p.id = um.membership_plan_id
       WHERE um.id = ?`,
      [umId],
    );
    const march = await priceDueMembershipFee(rows[0] as any, NEXT_BILLING, gymId);
    const april = await priceDueMembershipFee(rows[0] as any, '2099-04-10', gymId);
    expect([march.amount, april.amount]).toEqual([48, 60]);
  });

  it('does not leak the months it resolved from', async () => {
    const { body } = await getMembership(gymId);
    for (const field of ['free_months', 'paid_months', 'bonus_months', 'plan_free_months', 'membership_fee_price']) {
      expect(body.membership).not.toHaveProperty(field);
    }
  });
});
