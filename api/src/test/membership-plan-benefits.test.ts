// #635 stage 1 — Membership Plan Billing & Duration + the three
// Product-keyed Benefit sections (One-off / Session / Period).
//
// Integration tests: these exercise the full Express + MySQL stack, so every
// rule below (tenant isolation, role gating, the classification and
// already-selected-item rules) is checked against the real router rather than a
// stub. The Promotion equivalents live in `promotions.test.ts`; the contract is
// deliberately identical, so the shapes here mirror those on purpose.

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

async function createPlan(gymId: string, name?: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`,
    [gymId, name ?? `MPB-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`],
  );
  return insertId;
}

async function createProduct(
  gymId: string,
  name: string,
  type: 'sessions' | 'service' | 'fee' | 'merchandise' | 'other',
  billingFrequency: string | null,
  status: 'active' | 'inactive' = 'active',
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, is_system, currency)
     VALUES (?, ?, ?, ?, ?, 0, 'EUR')`,
    [gymId, name, type, billingFrequency, status],
  );
  return insertId;
}

// ─── Billing & Duration (§7) ──────────────────────────────────────────────────

describe('Membership Plan Billing & Duration', () => {
  let gymId: string;
  let gymB: string;
  let planId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Plan Duration Gym');
    gymB = await createTestGym('Plan Duration Gym B');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(gymB, 'admin');
    planId = await createPlan(gymId, 'Duration Plan');
  });

  it('starts unconfigured — null, not 0', async () => {
    const res = await request
      .get(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.free_periods).toBeNull();
    expect(res.body.paid_periods).toBeNull();
    expect(res.body.bonus_periods).toBeNull();
  });

  it('PUT stores free / paid / bonus months', async () => {
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ free_periods: 1, paid_periods: 2, bonus_periods: 2 });
    expect(res.status).toBe(200);
    expect(res.body.free_periods).toBe(1);
    expect(res.body.paid_periods).toBe(2);
    expect(res.body.bonus_periods).toBe(2);
  });

  // The Billing & Duration section saves on its own, so a PUT from any other
  // section must leave the stored months alone rather than blanking them.
  it('leaves the stored months untouched when the body omits them', async () => {
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Duration Plan Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.free_periods).toBe(1);
    expect(res.body.paid_periods).toBe(2);
    expect(res.body.bonus_periods).toBe(2);
  });

  // An emptied field means "not configured", which must round-trip as NULL —
  // COALESCE alone could never express this, hence the IF(present, …) pairs.
  it('clears a field back to null when it is sent as null', async () => {
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ free_periods: null, paid_periods: 3, bonus_periods: null });
    expect(res.status).toBe(200);
    expect(res.body.free_periods).toBeNull();
    expect(res.body.paid_periods).toBe(3);
    expect(res.body.bonus_periods).toBeNull();
  });

  it('accepts an explicit 0, distinct from null', async () => {
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ free_periods: 0 });
    expect(res.status).toBe(200);
    expect(res.body.free_periods).toBe(0);
  });

  it('rejects a negative value', async () => {
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ paid_periods: -1 });
    expect(res.status).toBe(400);
  });

  it('rejects a non-integer value', async () => {
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ bonus_periods: 'soon' });
    expect(res.status).toBe(400);
  });

  it('is tenant-isolated — gym B cannot set gym A\'s durations', async () => {
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ free_periods: 9 });
    expect(res.status).toBe(404);
  });

  it('→ 401 without authentication', async () => {
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('x-gym-id', gymId)
      .send({ free_periods: 1 });
    expect(res.status).toBe(401);
  });

  it('→ 403 for a non-admin role', async () => {
    const frontDeskGym = await createTestGym('Plan Duration Front Desk Gym');
    await createTestMembership(frontDeskGym, 'front_desk');
    const otherPlan = await createPlan(frontDeskGym, 'Front Desk Duration Plan');
    const res = await request
      .put(`/membership-plans/${otherPlan}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', frontDeskGym)
      .send({ free_periods: 1 });
    expect(res.status).toBe(403);
  });
});

// ─── One-off / Session / Period Benefits (§3–§5) ──────────────────────────────

describe.each([
  { path: 'session-benefits', category: 'session' as const },
  { path: 'oneoff-benefits', category: 'oneoff' as const },
  { path: 'periodical-benefits', category: 'periodical' as const },
])('Membership Plan $path', ({ path, category }) => {
  let gymId: string;
  let gymB: string;
  let planId: number;
  let matchingItemId: number;
  let mismatchedItemId: number;
  let inactiveItemId: number;

  beforeAll(async () => {
    gymId = await createTestGym(`MPB ${category} Gym`);
    gymB = await createTestGym(`MPB ${category} Gym B`);
    await createTestMembership(gymId, 'admin');
    await createTestMembership(gymB, 'admin');
    planId = await createPlan(gymId, `MPB ${category} Plan`);

    if (category === 'session') {
      matchingItemId = await createProduct(gymId, 'Group Class', 'sessions', null);
      mismatchedItemId = await createProduct(gymId, 'Locker Rental', 'service', 'month');
    } else if (category === 'oneoff') {
      matchingItemId = await createProduct(gymId, 'Registration Fee', 'fee', 'once');
      mismatchedItemId = await createProduct(gymId, 'Group Class', 'sessions', null);
    } else {
      matchingItemId = await createProduct(gymId, 'Locker Rental', 'service', 'month');
      mismatchedItemId = await createProduct(gymId, 'Registration Fee', 'fee', 'once');
    }
    inactiveItemId = await createProduct(gymId, 'Retired Item', 'other', null, 'inactive');
  });

  it('GET returns empty initially', async () => {
    const res = await request
      .get(`/membership-plans/${planId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('PUT replaces all items for a matching Product', async () => {
    const res = await request
      .put(`/membership-plans/${planId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ product_id: matchingItemId, quantity: 3 }] });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].product_id).toBe(matchingItemId);
    expect(res.body[0].quantity).toBe(3);
    expect(res.body[0].product_name).toBeDefined();
  });

  it('GET returns saved items', async () => {
    const res = await request
      .get(`/membership-plans/${planId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  // The Plans page renders the sections straight off the plan payload, so the
  // saved rows must also come back from GET /membership-plans/:id.
  it('is served with the plan itself', async () => {
    const res = await request
      .get(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const field = category === 'periodical' ? 'periodical_benefits' : `${category}_benefits`;
    expect(res.body[field]).toHaveLength(1);
    expect(res.body[field][0].product_id).toBe(matchingItemId);
  });

  it('PUT rejects a Product that classifies into a different category', async () => {
    const res = await request
      .put(`/membership-plans/${planId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ product_id: mismatchedItemId, quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it('PUT rejects an inactive Product', async () => {
    const res = await request
      .put(`/membership-plans/${planId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ product_id: inactiveItemId, quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it('PUT rejects a Product belonging to another gym', async () => {
    const foreignItem = await createProduct(
      gymB, `Foreign ${category} Item`,
      category === 'session' ? 'sessions' : category === 'periodical' ? 'service' : 'fee',
      category === 'periodical' ? 'month' : category === 'session' ? null : 'once',
    );
    const res = await request
      .put(`/membership-plans/${planId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ product_id: foreignItem, quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  // Same rule as the Promotion sections (#550): only a *new* inactive item is
  // rejected — an already-attached one must survive a resave, or deactivating
  // an item elsewhere would silently drop it from every plan that uses it.
  it('PUT keeps an already-selected Product that has since gone inactive', async () => {
    const otherPlanId = await createPlan(gymId, `MPB ${category} Deactivation Plan`);
    const itemId = await createProduct(
      gymId,
      `${category} Later Inactive Item`,
      category === 'session' ? 'sessions' : category === 'periodical' ? 'service' : 'fee',
      category === 'periodical' ? 'month' : category === 'session' ? null : 'once',
    );

    const firstSave = await request
      .put(`/membership-plans/${otherPlanId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ product_id: itemId, quantity: 2 }] });
    expect(firstSave.status).toBe(200);

    await db.query("UPDATE products SET status = 'inactive' WHERE id = ?", [itemId]);

    const resave = await request
      .put(`/membership-plans/${otherPlanId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ product_id: itemId, quantity: 3 }] });
    expect(resave.status).toBe(200);
    expect(resave.body).toHaveLength(1);
    expect(resave.body[0].quantity).toBe(3);
    expect(resave.body[0].product_status).toBe('inactive');
  });

  it('PUT rejects a non-positive quantity', async () => {
    const res = await request
      .put(`/membership-plans/${planId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ product_id: matchingItemId, quantity: 0 }] });
    expect(res.status).toBe(400);
  });

  it('PUT rejects a duplicate product_id within the same request', async () => {
    const res = await request
      .put(`/membership-plans/${planId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        items: [
          { product_id: matchingItemId, quantity: 1 },
          { product_id: matchingItemId, quantity: 2 },
        ],
      });
    expect(res.status).toBe(400);
  });

  it('PUT rejects a body without an items array', async () => {
    const res = await request
      .put(`/membership-plans/${planId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({});
    expect(res.status).toBe(400);
  });

  it('GET is tenant-isolated — gym B cannot read gym A\'s plan', async () => {
    const res = await request
      .get(`/membership-plans/${planId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });

  it('PUT is tenant-isolated — gym B cannot modify gym A\'s plan', async () => {
    const res = await request
      .put(`/membership-plans/${planId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ items: [] });
    expect(res.status).toBe(404);
  });

  it('→ 401 without authentication', async () => {
    const res = await request
      .get(`/membership-plans/${planId}/${path}`)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('PUT → 403 for a non-admin role', async () => {
    const frontDeskGym = await createTestGym(`MPB ${category} Front Desk Gym`);
    await createTestMembership(frontDeskGym, 'front_desk');
    const otherPlanId = await createPlan(frontDeskGym, `MPB ${category} Front Desk Plan`);
    const res = await request
      .put(`/membership-plans/${otherPlanId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', frontDeskGym)
      .send({ items: [] });
    expect(res.status).toBe(403);
  });

  it('PUT → 404 for a plan that does not exist', async () => {
    const res = await request
      .put(`/membership-plans/99999999/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [] });
    expect(res.status).toBe(404);
  });
});

// ─── Duplicate carries the new configuration ──────────────────────────────────

describe('Membership Plan duplicate — Billing & Duration and Benefits', () => {
  let gymId: string;
  let planId: number;
  let sessionItemId: number;

  beforeAll(async () => {
    gymId = await createTestGym('MPB Duplicate Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId, 'MPB Duplicate Plan');
    sessionItemId = await createProduct(gymId, 'Group Class', 'sessions', null);

    await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ free_periods: 1, paid_periods: 2, bonus_periods: 2 });
    await request
      .put(`/membership-plans/${planId}/session-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        items: [{
          product_id: sessionItemId, quantity: 4,
          action: 'percentage_discount', value: 15,
          // #918: and the renewal Frequency, which Duplicate must carry too.
          frequency: 'week',
        }],
      });
  });

  it('copies the Billing & Duration months and the benefit rows', async () => {
    const dup = await request
      .post(`/membership-plans/${planId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(dup.status).toBe(201);
    expect(dup.body.free_periods).toBe(1);
    expect(dup.body.paid_periods).toBe(2);
    expect(dup.body.bonus_periods).toBe(2);
    expect(dup.body.session_benefits).toHaveLength(1);
    expect(dup.body.session_benefits[0].product_id).toBe(sessionItemId);
    expect(dup.body.session_benefits[0].quantity).toBe(4);
    // #896 stage 2: Duplicate is a copy, so the pricing treatment travels too.
    expect(dup.body.session_benefits[0].action).toBe('percentage_discount');
    expect(dup.body.session_benefits[0].value).toBe(15);
    // #918: and so does the renewal Frequency — a copy of a Plan granting 2
    // sessions a week must not read as a one-time allowance.
    expect(dup.body.session_benefits[0].frequency).toBe('week');

    // Editing the copy must not reach back into the original.
    await request
      .put(`/membership-plans/${dup.body.id}/session-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [] });
    const original = await request
      .get(`/membership-plans/${planId}/session-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(original.body).toHaveLength(1);
  });
});

// ─── Legacy sections are untouched by stage 1 ─────────────────────────────────

describe('Membership Plan legacy sections (stage 1 is additive)', () => {
  let gymId: string;
  let planId: number;

  beforeAll(async () => {
    gymId = await createTestGym('MPB Legacy Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId, 'MPB Legacy Plan');
  });

  // Stage 4 retired both legacy sections — Charge Benefits in part 1
  // (charge-benefits-retired.test.ts) and Included Services in part 2
  // (included-services-retired.test.ts). What a Plan still serves beside its
  // three Benefit sections is its projection, which #818 reshaped from the
  // Billing Events Forecast into the Example timeline.
  it('still serves the example timeline', async () => {
    const res = await request
      .get(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.allowances).toBeUndefined();
    expect(res.body.example_timeline).toBeDefined();
  });
});

// ─── #893: Mandatory Products are always part of the Plan ───────────────

describe('Membership Plan mandatory Products (#893)', () => {
  let gymId: string;
  let gymB: string;
  let planId: number;
  let insuranceId: number;   // periodical, mandatory
  let lockerId: number;      // periodical, not mandatory
  let registrationId: number; // oneoff, mandatory

  async function setMandatory(id: number, mandatory: 0 | 1) {
    await db.query('UPDATE products SET mandatory = ? WHERE id = ?', [mandatory, id]);
  }

  async function periodicalBenefits(plan: number, gym: string) {
    const res = await request
      .get(`/membership-plans/${plan}/periodical-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gym);
    return res;
  }

  beforeAll(async () => {
    gymId = await createTestGym('MPB Mandatory Gym');
    gymB = await createTestGym('MPB Mandatory Gym B');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(gymB, 'admin');
    planId = await createPlan(gymId, 'MPB Mandatory Plan');
    insuranceId = await createProduct(gymId, 'Insurance Fee', 'fee', 'year');
    lockerId = await createProduct(gymId, 'Locker Rental', 'fee', 'month');
    registrationId = await createProduct(gymId, 'Registration Fee', 'fee', 'once');
    await setMandatory(insuranceId, 1);
    await setMandatory(registrationId, 1);
  });

  it('reports a mandatory item the Plan has no row for, flagged implicit', async () => {
    const res = await periodicalBenefits(planId, gymId);
    expect(res.status).toBe(200);
    const insurance = res.body.find((r: any) => r.product_id === insuranceId);
    expect(insurance).toBeDefined();
    expect(insurance.implicit).toBe(true);
    expect(insurance.quantity).toBe(1);
    expect(Number(insurance.product_mandatory)).toBe(1);
    expect(res.body.some((r: any) => r.product_id === lockerId)).toBe(false);
  });

  it('puts the mandatory item in its own section only', async () => {
    const sessions = await request
      .get(`/membership-plans/${planId}/session-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(sessions.body).toHaveLength(0);
    const oneoff = await request
      .get(`/membership-plans/${planId}/oneoff-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(oneoff.body.map((r: any) => r.product_id)).toEqual([registrationId]);
  });

  it('embeds the same merged sections in the Plan itself', async () => {
    const res = await request
      .get(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.periodical_benefits.map((r: any) => r.product_id)).toContain(insuranceId);
    expect(res.body.oneoff_benefits.map((r: any) => r.product_id)).toContain(registrationId);
  });

  it('writes the mandatory item even when the save leaves it out (§7)', async () => {
    const res = await request
      .put(`/membership-plans/${planId}/periodical-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ product_id: lockerId, quantity: 1 }] });
    expect(res.status).toBe(200);
    const ids = res.body.map((r: any) => r.product_id);
    expect(ids).toContain(insuranceId);
    expect(ids).toContain(lockerId);
    // Persisted, not merely reported: the row exists and is no longer implicit.
    const { rows } = await db.query(
      'SELECT product_id, quantity FROM membership_plan_periodical WHERE membership_plan_id = ? AND product_id = ?',
      [planId, insuranceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(1);
    const after = await periodicalBenefits(planId, gymId);
    expect(after.body.find((r: any) => r.product_id === insuranceId).implicit).toBeUndefined();
  });

  it('cannot be emptied out of the section', async () => {
    const res = await request
      .put(`/membership-plans/${planId}/periodical-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [] });
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.product_id)).toEqual([insuranceId]);
  });

  it('keeps the quantity the Plan configured (§4)', async () => {
    const res = await request
      .put(`/membership-plans/${planId}/periodical-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ product_id: insuranceId, quantity: 3 }] });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].quantity).toBe(3);
  });

  it('never duplicates the item (§8)', async () => {
    await request
      .put(`/membership-plans/${planId}/periodical-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ product_id: insuranceId, quantity: 2 }, { product_id: lockerId, quantity: 1 }] });
    const { rows } = await db.query(
      'SELECT product_id FROM membership_plan_periodical WHERE membership_plan_id = ? AND product_id = ?',
      [planId, insuranceId],
    );
    expect(rows).toHaveLength(1);
  });

  it('becomes removable once the item is no longer mandatory (§6)', async () => {
    await setMandatory(insuranceId, 0);
    const res = await request
      .put(`/membership-plans/${planId}/periodical-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ product_id: lockerId, quantity: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.product_id)).toEqual([lockerId]);
    await setMandatory(insuranceId, 1);
  });

  it('does not remove a configured item just because it stopped being mandatory (§6)', async () => {
    await request
      .put(`/membership-plans/${planId}/periodical-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ product_id: insuranceId, quantity: 5 }] });
    await setMandatory(insuranceId, 0);
    const res = await periodicalBenefits(planId, gymId);
    const row = res.body.find((r: any) => r.product_id === insuranceId);
    expect(row).toBeDefined();
    expect(row.quantity).toBe(5);
    await setMandatory(insuranceId, 1);
  });

  it('ignores a mandatory item that is inactive or soft-deleted', async () => {
    const plan = await createPlan(gymId, 'MPB Mandatory Inactive Plan');
    const inactive = await createProduct(gymId, 'Inactive Mandatory', 'fee', 'month', 'inactive');
    await setMandatory(inactive, 1);
    const deleted = await createProduct(gymId, 'Deleted Mandatory', 'fee', 'month');
    await setMandatory(deleted, 1);
    await db.query('UPDATE products SET deleted_at = NOW() WHERE id = ?', [deleted]);

    const res = await periodicalBenefits(plan, gymId);
    const ids = res.body.map((r: any) => r.product_id);
    expect(ids).not.toContain(inactive);
    expect(ids).not.toContain(deleted);
    expect(ids).toContain(insuranceId);
  });

  it("stays within the gym — another gym's mandatory item never appears", async () => {
    const planB = await createPlan(gymB, 'MPB Mandatory Plan B');
    const res = await periodicalBenefits(planB, gymB);
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.product_id)).not.toContain(insuranceId);
  });

  it('404s a plan from another gym rather than reporting its mandatory items', async () => {
    const res = await periodicalBenefits(planId, gymB);
    expect(res.status).toBe(404);
  });
});

// ─── The line's pricing treatment (#896 stage 2) ──────────────────────────────

describe('Membership Plan benefit actions', () => {
  let gymId: string;
  let planId: number;
  let itemId: number;

  const putSession = (items: unknown[]) => request
    .put(`/membership-plans/${planId}/session-benefits`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ items });

  beforeAll(async () => {
    gymId = await createTestGym('MPB Action Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId, 'MPB Action Plan');
    itemId = await createProduct(gymId, 'Action Group Class', 'sessions', null);
  });

  it('defaults a brand new line to the neutral action', async () => {
    const res = await putSession([{ product_id: itemId, quantity: 4 }]);
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ quantity: 4, action: 'no_benefit', value: null });
  });

  it('stores a percentage discount and reports the value as a number', async () => {
    const res = await putSession([
      { product_id: itemId, quantity: 4, action: 'percentage_discount', value: 20 },
    ]);
    expect(res.status).toBe(200);
    // Not the "20.00" string mysql2 hands back for a DECIMAL column.
    expect(res.body[0]).toMatchObject({ action: 'percentage_discount', value: 20 });

    const get = await request
      .get(`/membership-plans/${planId}/session-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(get.body[0]).toMatchObject({ action: 'percentage_discount', value: 20 });
  });

  it('keeps a stored treatment when the save does not mention it', async () => {
    // The replace-all `PUT` is how every other field of the section is edited,
    // so a client that only knows `product_id` + `quantity` must not reset
    // what someone configured. Clearing it stays possible, explicitly.
    const res = await putSession([{ product_id: itemId, quantity: 9 }]);
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ quantity: 9, action: 'percentage_discount', value: 20 });

    const cleared = await putSession([{ product_id: itemId, quantity: 9, action: 'no_benefit' }]);
    expect(cleared.body[0]).toMatchObject({ action: 'no_benefit', value: null });
  });

  it('refuses the two actions §16 keeps out of a Membership Plan', async () => {
    for (const action of ['fixed_discount', 'fixed_price']) {
      const res = await putSession([{ product_id: itemId, quantity: 1, action, value: 10 }]);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('action must be one of');
    }
  });

  it('refuses a missing, out-of-range or superfluous value', async () => {
    expect((await putSession([{ product_id: itemId, quantity: 1, action: 'percentage_discount' }])).status)
      .toBe(400);
    expect((await putSession([{ product_id: itemId, quantity: 1, action: 'percentage_discount', value: 120 }])).status)
      .toBe(400);
    expect((await putSession([{ product_id: itemId, quantity: 1, action: 'waive', value: 5 }])).status)
      .toBe(400);
    const orphanValue = await putSession([{ product_id: itemId, quantity: 1, value: 20 }]);
    expect(orphanValue.status).toBe(400);
    expect(orphanValue.body.error).toBe('value requires an action');
  });

  it('leaves the section untouched when one line is rejected', async () => {
    const before = await request
      .get(`/membership-plans/${planId}/session-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    await putSession([{ product_id: itemId, quantity: 1, action: 'fixed_price', value: 10 }]);
    const after = await request
      .get(`/membership-plans/${planId}/session-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(after.body).toEqual(before.body);
  });

  it('reports a mandatory item the Plan has no row for at the neutral action', async () => {
    // #893: the item is part of the section whether or not it is stored, and
    // Mandatory says nothing about what it costs.
    const mandatoryId = await createProduct(gymId, 'Action Mandatory Class', 'sessions', null);
    await db.query('UPDATE products SET mandatory = 1 WHERE id = ?', [mandatoryId]);

    const get = await request
      .get(`/membership-plans/${planId}/session-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    const implicit = get.body.find((row: any) => row.product_id === mandatoryId);
    expect(implicit).toMatchObject({ implicit: true, action: 'no_benefit', value: null });
  });

  it('preserves a dropped mandatory item without repricing it', async () => {
    const mandatoryId = await createProduct(gymId, 'Action Waived Class', 'sessions', null);
    await db.query('UPDATE products SET mandatory = 1 WHERE id = ?', [mandatoryId]);
    await putSession([{ product_id: mandatoryId, quantity: 2, action: 'waive' }]);

    // The client drops it; #893 puts it back, and #896 must not turn the waive
    // it was configured with into a charge on the way.
    const res = await putSession([]);
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.product_id === mandatoryId);
    expect(row).toMatchObject({ action: 'waive', value: null });
  });
});

// ─── #916: the Original / Final Price a Benefit row reports ───────────────────
//
// The card must show what a Product normally costs and what it costs
// inside this Plan, both VAT-inclusive, and the ticket forbids a second pricing
// implementation for the UI: "the Membership Plan details page cannot show a
// different amount from the amount that would actually be billed". These
// exercise the real router, so the gross-up (`computePriceFields`) and the
// treatment (`applyLineBenefit`) are the ones the Plan actually serves — the
// pure arithmetic is `plan-benefit-prices.unit.test.ts`.

describe('Membership Plan Benefit prices (#916)', () => {
  let gymId: string;
  let planId: number;
  let taxRateId: number;

  async function createPricedItem(opts: {
    name: string;
    type: 'sessions' | 'service' | 'fee' | 'other';
    frequency: string | null;
    amount: string | null;
    taxRateId?: number | null;
    taxBehavior?: 'inclusive' | 'exclusive';
  }): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO products
         (gym_id, name, type, billing_frequency, status, is_system, currency,
          amount, tax_rate_id, tax_behavior)
       VALUES (?, ?, ?, ?, 'active', 0, 'EUR', ?, ?, ?)`,
      [gymId, opts.name, opts.type, opts.frequency, opts.amount,
       opts.taxRateId ?? null, opts.taxBehavior ?? 'inclusive'],
    );
    return insertId;
  }

  async function putSection(section: string, items: unknown[]) {
    return request
      .put(`/membership-plans/${planId}/${section}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items });
  }

  async function getSection(section: string) {
    return request
      .get(`/membership-plans/${planId}/${section}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
  }

  beforeAll(async () => {
    gymId = await createTestGym('MPB Prices Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId, 'MPB Prices Plan');
    // A price and a cadence, so the Billing Event Simulation beside the
    // sections is available and the cross-check at the bottom has something to
    // compare to.
    await db.query(
      `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
       VALUES (?, ?, 100, '2025-01-01', 'active')`,
      [gymId, planId],
    );
    await db.query(
      `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
       VALUES (?, ?, 1, 'month')`,
      [gymId, planId],
    );
    const { insertId } = await db.query(
      `INSERT INTO tax_rates (gym_id, name, rate_percent, is_system, status) VALUES (?, 'VAT 10%', 10, 0, 'active')`,
      [gymId],
    );
    taxRateId = insertId;
  });

  it('quotes a row at the item price when the Plan configures no benefit', async () => {
    const classId = await createPricedItem({
      name: 'Prices Class', type: 'sessions', frequency: null, amount: '25.00',
    });
    const res = await putSection('session-benefits', [{ product_id: classId, quantity: 1 }]);
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.product_id === classId);
    expect(row.original_price_incl_tax).toBe(25);
    expect(row.final_price_incl_tax).toBe(25);
  });

  it('keeps the original price visible for a waived item, whose final price is 0', async () => {
    const insuranceId = await createPricedItem({
      name: 'Prices Insurance', type: 'fee', frequency: 'year', amount: '20.00',
    });
    const res = await putSection('periodical-benefits', [
      { product_id: insuranceId, quantity: 1, action: 'waive' },
    ]);
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.product_id === insuranceId);
    expect(row.original_price_incl_tax).toBe(20);
    expect(row.final_price_incl_tax).toBe(0);
  });

  it('applies a percentage discount to the item price', async () => {
    const packageId = await createPricedItem({
      name: 'Prices Package', type: 'fee', frequency: 'once', amount: '70.00',
    });
    const res = await putSection('oneoff-benefits', [
      { product_id: packageId, quantity: 1, action: 'percentage_discount', value: 20 },
    ]);
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.product_id === packageId);
    expect(row.original_price_incl_tax).toBe(70);
    expect(row.final_price_incl_tax).toBe(56);
  });

  it('reports the line beside the unit, so a quantity cannot hide what is billed', async () => {
    const classId = await createPricedItem({
      name: 'Prices Bulk Class', type: 'sessions', frequency: null, amount: '25.00',
    });
    const res = await putSection('session-benefits', [
      { product_id: classId, quantity: 5, action: 'percentage_discount', value: 10 },
    ]);
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.product_id === classId);
    expect(row.original_price_incl_tax).toBe(25);
    expect(row.final_price_incl_tax).toBe(22.5);
    expect(row.original_line_price_incl_tax).toBe(125);
    expect(row.final_line_price_incl_tax).toBe(112.5);
  });

  it('grosses up a tax-exclusive item — the amounts are VAT-inclusive', async () => {
    const lockerId = await createPricedItem({
      name: 'Prices Locker', type: 'service', frequency: 'month', amount: '15.00',
      taxRateId, taxBehavior: 'exclusive',
    });
    const res = await putSection('periodical-benefits', [{ product_id: lockerId, quantity: 1 }]);
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.product_id === lockerId);
    expect(row.original_price_incl_tax).toBe(16.5);
    expect(row.final_price_incl_tax).toBe(16.5);
  });

  it('reports no price at all for an item that carries none — never €0.00', async () => {
    const unpricedId = await createPricedItem({
      name: 'Prices Unpriced', type: 'other', frequency: null, amount: null,
    });
    const res = await putSection('oneoff-benefits', [{ product_id: unpricedId, quantity: 2 }]);
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.product_id === unpricedId);
    expect(row.original_price_incl_tax).toBeNull();
    expect(row.final_price_incl_tax).toBeNull();
    expect(row.original_line_price_incl_tax).toBeNull();
    expect(row.final_line_price_incl_tax).toBeNull();
  });

  it('embeds the same amounts in the Plan itself, which is what the card renders', async () => {
    const itemId = await createPricedItem({
      name: 'Prices Embedded', type: 'service', frequency: 'month', amount: '30.00',
    });
    await putSection('periodical-benefits', [
      { product_id: itemId, quantity: 2, action: 'percentage_discount', value: 50 },
    ]);
    const res = await request
      .get(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const row = res.body.periodical_benefits.find((r: any) => r.product_id === itemId);
    expect(row.original_price_incl_tax).toBe(30);
    expect(row.final_price_incl_tax).toBe(15);
    expect(row.original_line_price_incl_tax).toBe(60);
    expect(row.final_line_price_incl_tax).toBe(30);
  });

  // #893: a mandatory item the Plan has no row for yet is part of the section,
  // so it must be quoted like any other row rather than reading "—".
  it('prices an implicit mandatory item too', async () => {
    const mandatoryId = await createPricedItem({
      name: 'Prices Mandatory', type: 'fee', frequency: 'year', amount: '40.00',
    });
    await db.query('UPDATE products SET mandatory = 1 WHERE id = ?', [mandatoryId]);
    const res = await getSection('periodical-benefits');
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.product_id === mandatoryId);
    expect(row.implicit).toBe(true);
    expect(row.original_price_incl_tax).toBe(40);
    expect(row.final_price_incl_tax).toBe(40);
    await db.query('UPDATE products SET mandatory = 0 WHERE id = ?', [mandatoryId]);
  });

  // The ticket's central requirement: the section and the Billing Event
  // Simulation on the same card are two projections of one calculation, so the
  // line they both describe must carry the same amount.
  it('agrees with the Billing Event Simulation about what the line bills', async () => {
    const itemId = await createPricedItem({
      name: 'Prices Agreement', type: 'service', frequency: 'month', amount: '12.50',
    });
    await putSection('periodical-benefits', [
      { product_id: itemId, quantity: 4, action: 'percentage_discount', value: 25 },
    ]);
    const res = await request
      .get(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    const row = res.body.periodical_benefits.find((r: any) => r.product_id === itemId);
    const line = res.body.billing_event_simulation.dates
      .flatMap((g: any) => g.lines)
      .find((l: any) => l.product_id === itemId);
    expect(line).toBeDefined();
    expect(line.regular_price).toBe(row.original_line_price_incl_tax);
    expect(line.actual_charge).toBe(row.final_line_price_incl_tax);
    expect(line.unit_price).toBe(row.original_price_incl_tax);
  });
});

// ─── #918: a Session Benefit's renewal Frequency ──────────────────────────────
//
// The field is the Session section's alone (migration 205 puts the column on
// `membership_plan_session` and the assignment's `user_membership_session`, and
// on nothing else), so these cases are not part of the `describe.each` above:
// the other two sections' behaviour is that they ignore it.
describe('Membership Plan Session Benefit Frequency (#918)', () => {
  let gymId: string;
  let planId: number;
  let sessionItemId: number;
  let secondSessionItemId: number;
  let periodicalItemId: number;

  beforeAll(async () => {
    gymId = await createTestGym('MPB Session Frequency Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId, 'MPB Session Frequency Plan');
    sessionItemId = await createProduct(gymId, 'Personal Training Class', 'sessions', null);
    secondSessionItemId = await createProduct(gymId, 'Group Class', 'sessions', null);
    periodicalItemId = await createProduct(gymId, 'Locker Rental', 'service', 'month');
  });

  const putSession = (items: unknown[]) => request
    .put(`/membership-plans/${planId}/session-benefits`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ items });

  const getSession = () => request
    .get(`/membership-plans/${planId}/session-benefits`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId);

  it('stores and reports a Frequency beside the quantity', async () => {
    const res = await putSession([{ product_id: sessionItemId, quantity: 2, frequency: 'week' }]);
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ product_id: sessionItemId, quantity: 2, frequency: 'week' });

    const read = await getSession();
    expect(read.body[0]).toMatchObject({ quantity: 2, frequency: 'week' });
  });

  it('configures it per benefit, not per section', async () => {
    const res = await putSession([
      { product_id: sessionItemId, quantity: 2, frequency: 'week' },
      { product_id: secondSessionItemId, quantity: 5, frequency: 'month' },
    ]);
    expect(res.status).toBe(200);
    const byItem = Object.fromEntries(res.body.map((r: any) => [r.product_id, r.frequency]));
    expect(byItem[sessionItemId]).toBe('week');
    expect(byItem[secondSessionItemId]).toBe('month');
  });

  it('keeps a stored Frequency when the request does not mention it', async () => {
    // The section `PUT` is replace-all, so a quantity-only save — which is what
    // every client written before #918 sends — must not clear the Frequency.
    const res = await putSession([
      { product_id: sessionItemId, quantity: 4 },
      { product_id: secondSessionItemId, quantity: 5 },
    ]);
    expect(res.status).toBe(200);
    const byItem = Object.fromEntries(res.body.map((r: any) => [r.product_id, r.frequency]));
    expect(byItem[sessionItemId]).toBe('week');
    expect(byItem[secondSessionItemId]).toBe('month');
    expect(res.body.find((r: any) => r.product_id === sessionItemId).quantity).toBe(4);
  });

  it('clears it for an explicit null — the dropdown\'s `—`', async () => {
    const res = await putSession([{ product_id: sessionItemId, quantity: 4, frequency: null }]);
    expect(res.status).toBe(200);
    expect(res.body[0].frequency).toBeNull();
  });

  it('accepts the empty string as the same `—`', async () => {
    await putSession([{ product_id: sessionItemId, quantity: 4, frequency: 'month' }]);
    const res = await putSession([{ product_id: sessionItemId, quantity: 4, frequency: '' }]);
    expect(res.status).toBe(200);
    expect(res.body[0].frequency).toBeNull();
  });

  it('reads back as null for a benefit that never configured one', async () => {
    await putSession([{ product_id: secondSessionItemId, quantity: 1 }]);
    const res = await getSession();
    expect(res.body.find((r: any) => r.product_id === secondSessionItemId).frequency).toBeNull();
  });

  it('accepts every offered period', async () => {
    for (const frequency of ['once', 'week', 'four_weeks', 'month', 'year']) {
      const res = await putSession([{ product_id: sessionItemId, quantity: 1, frequency }]);
      expect(res.status, `frequency ${frequency}`).toBe(200);
      expect(res.body[0].frequency).toBe(frequency);
    }
  });

  it('→ 400 for a value outside the set, rather than coercing it', async () => {
    for (const frequency of ['per_session', 'weekly', 'day']) {
      const res = await putSession([{ product_id: sessionItemId, quantity: 1, frequency }]);
      expect(res.status, `frequency ${frequency}`).toBe(400);
      expect(res.body.error).toMatch(/frequency must be one of/);
    }
  });

  it('leaves the other sections unaffected — they have no such column', async () => {
    const res = await request
      .put(`/membership-plans/${planId}/periodical-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ product_id: periodicalItemId, quantity: 1, frequency: 'week' }] });
    expect(res.status).toBe(200);
    expect(res.body[0].frequency).toBeUndefined();
  });

  it('embeds the Frequency in the Plan the card reads', async () => {
    await putSession([{ product_id: sessionItemId, quantity: 2, frequency: 'week' }]);
    const res = await request
      .get(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.session_benefits.find((b: any) => b.product_id === sessionItemId))
      .toMatchObject({ quantity: 2, frequency: 'week' });
  });
});
