// #635 stage 1 — Membership Plan Billing & Duration + the three
// Sellable-Item-keyed Benefit sections (One-off / Session / Period).
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

async function createSellableItem(
  gymId: string,
  name: string,
  type: 'sessions' | 'service' | 'fee' | 'merchandise' | 'other',
  billingFrequency: string | null,
  status: 'active' | 'inactive' = 'active',
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO gym_charges (gym_id, name, type, billing_frequency, status, is_system, currency)
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
      matchingItemId = await createSellableItem(gymId, 'Group Class', 'sessions', null);
      mismatchedItemId = await createSellableItem(gymId, 'Locker Rental', 'service', 'month');
    } else if (category === 'oneoff') {
      matchingItemId = await createSellableItem(gymId, 'Registration Fee', 'fee', 'once');
      mismatchedItemId = await createSellableItem(gymId, 'Group Class', 'sessions', null);
    } else {
      matchingItemId = await createSellableItem(gymId, 'Locker Rental', 'service', 'month');
      mismatchedItemId = await createSellableItem(gymId, 'Registration Fee', 'fee', 'once');
    }
    inactiveItemId = await createSellableItem(gymId, 'Retired Item', 'other', null, 'inactive');
  });

  it('GET returns empty initially', async () => {
    const res = await request
      .get(`/membership-plans/${planId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('PUT replaces all items for a matching Sellable Item', async () => {
    const res = await request
      .put(`/membership-plans/${planId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: matchingItemId, quantity: 3 }] });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].gym_charge_id).toBe(matchingItemId);
    expect(res.body[0].quantity).toBe(3);
    expect(res.body[0].gym_charge_name).toBeDefined();
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
    expect(res.body[field][0].gym_charge_id).toBe(matchingItemId);
  });

  it('PUT rejects a Sellable Item that classifies into a different category', async () => {
    const res = await request
      .put(`/membership-plans/${planId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: mismatchedItemId, quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it('PUT rejects an inactive Sellable Item', async () => {
    const res = await request
      .put(`/membership-plans/${planId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: inactiveItemId, quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it('PUT rejects a Sellable Item belonging to another gym', async () => {
    const foreignItem = await createSellableItem(
      gymB, `Foreign ${category} Item`,
      category === 'session' ? 'sessions' : category === 'periodical' ? 'service' : 'fee',
      category === 'periodical' ? 'month' : category === 'session' ? null : 'once',
    );
    const res = await request
      .put(`/membership-plans/${planId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: foreignItem, quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  // Same rule as the Promotion sections (#550): only a *new* inactive item is
  // rejected — an already-attached one must survive a resave, or deactivating
  // an item elsewhere would silently drop it from every plan that uses it.
  it('PUT keeps an already-selected Sellable Item that has since gone inactive', async () => {
    const otherPlanId = await createPlan(gymId, `MPB ${category} Deactivation Plan`);
    const itemId = await createSellableItem(
      gymId,
      `${category} Later Inactive Item`,
      category === 'session' ? 'sessions' : category === 'periodical' ? 'service' : 'fee',
      category === 'periodical' ? 'month' : category === 'session' ? null : 'once',
    );

    const firstSave = await request
      .put(`/membership-plans/${otherPlanId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: itemId, quantity: 2 }] });
    expect(firstSave.status).toBe(200);

    await db.query("UPDATE gym_charges SET status = 'inactive' WHERE id = ?", [itemId]);

    const resave = await request
      .put(`/membership-plans/${otherPlanId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: itemId, quantity: 3 }] });
    expect(resave.status).toBe(200);
    expect(resave.body).toHaveLength(1);
    expect(resave.body[0].quantity).toBe(3);
    expect(resave.body[0].gym_charge_status).toBe('inactive');
  });

  it('PUT rejects a non-positive quantity', async () => {
    const res = await request
      .put(`/membership-plans/${planId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: matchingItemId, quantity: 0 }] });
    expect(res.status).toBe(400);
  });

  it('PUT rejects a duplicate gym_charge_id within the same request', async () => {
    const res = await request
      .put(`/membership-plans/${planId}/${path}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        items: [
          { gym_charge_id: matchingItemId, quantity: 1 },
          { gym_charge_id: matchingItemId, quantity: 2 },
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
    sessionItemId = await createSellableItem(gymId, 'Group Class', 'sessions', null);

    await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ free_periods: 1, paid_periods: 2, bonus_periods: 2 });
    await request
      .put(`/membership-plans/${planId}/session-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: sessionItemId, quantity: 4 }] });
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
    expect(dup.body.session_benefits[0].gym_charge_id).toBe(sessionItemId);
    expect(dup.body.session_benefits[0].quantity).toBe(4);

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

// ─── #893: Mandatory Sellable Items are always part of the Plan ───────────────

describe('Membership Plan mandatory Sellable Items (#893)', () => {
  let gymId: string;
  let gymB: string;
  let planId: number;
  let insuranceId: number;   // periodical, mandatory
  let lockerId: number;      // periodical, not mandatory
  let registrationId: number; // oneoff, mandatory

  async function setMandatory(id: number, mandatory: 0 | 1) {
    await db.query('UPDATE gym_charges SET mandatory = ? WHERE id = ?', [mandatory, id]);
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
    insuranceId = await createSellableItem(gymId, 'Insurance Fee', 'fee', 'year');
    lockerId = await createSellableItem(gymId, 'Locker Rental', 'fee', 'month');
    registrationId = await createSellableItem(gymId, 'Registration Fee', 'fee', 'once');
    await setMandatory(insuranceId, 1);
    await setMandatory(registrationId, 1);
  });

  it('reports a mandatory item the Plan has no row for, flagged implicit', async () => {
    const res = await periodicalBenefits(planId, gymId);
    expect(res.status).toBe(200);
    const insurance = res.body.find((r: any) => r.gym_charge_id === insuranceId);
    expect(insurance).toBeDefined();
    expect(insurance.implicit).toBe(true);
    expect(insurance.quantity).toBe(1);
    expect(Number(insurance.gym_charge_mandatory)).toBe(1);
    expect(res.body.some((r: any) => r.gym_charge_id === lockerId)).toBe(false);
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
    expect(oneoff.body.map((r: any) => r.gym_charge_id)).toEqual([registrationId]);
  });

  it('embeds the same merged sections in the Plan itself', async () => {
    const res = await request
      .get(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.periodical_benefits.map((r: any) => r.gym_charge_id)).toContain(insuranceId);
    expect(res.body.oneoff_benefits.map((r: any) => r.gym_charge_id)).toContain(registrationId);
  });

  it('writes the mandatory item even when the save leaves it out (§7)', async () => {
    const res = await request
      .put(`/membership-plans/${planId}/periodical-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: lockerId, quantity: 1 }] });
    expect(res.status).toBe(200);
    const ids = res.body.map((r: any) => r.gym_charge_id);
    expect(ids).toContain(insuranceId);
    expect(ids).toContain(lockerId);
    // Persisted, not merely reported: the row exists and is no longer implicit.
    const { rows } = await db.query(
      'SELECT gym_charge_id, quantity FROM membership_plan_periodical WHERE membership_plan_id = ? AND gym_charge_id = ?',
      [planId, insuranceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(1);
    const after = await periodicalBenefits(planId, gymId);
    expect(after.body.find((r: any) => r.gym_charge_id === insuranceId).implicit).toBeUndefined();
  });

  it('cannot be emptied out of the section', async () => {
    const res = await request
      .put(`/membership-plans/${planId}/periodical-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [] });
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.gym_charge_id)).toEqual([insuranceId]);
  });

  it('keeps the quantity the Plan configured (§4)', async () => {
    const res = await request
      .put(`/membership-plans/${planId}/periodical-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: insuranceId, quantity: 3 }] });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].quantity).toBe(3);
  });

  it('never duplicates the item (§8)', async () => {
    await request
      .put(`/membership-plans/${planId}/periodical-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: insuranceId, quantity: 2 }, { gym_charge_id: lockerId, quantity: 1 }] });
    const { rows } = await db.query(
      'SELECT gym_charge_id FROM membership_plan_periodical WHERE membership_plan_id = ? AND gym_charge_id = ?',
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
      .send({ items: [{ gym_charge_id: lockerId, quantity: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.gym_charge_id)).toEqual([lockerId]);
    await setMandatory(insuranceId, 1);
  });

  it('does not remove a configured item just because it stopped being mandatory (§6)', async () => {
    await request
      .put(`/membership-plans/${planId}/periodical-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: insuranceId, quantity: 5 }] });
    await setMandatory(insuranceId, 0);
    const res = await periodicalBenefits(planId, gymId);
    const row = res.body.find((r: any) => r.gym_charge_id === insuranceId);
    expect(row).toBeDefined();
    expect(row.quantity).toBe(5);
    await setMandatory(insuranceId, 1);
  });

  it('ignores a mandatory item that is inactive or soft-deleted', async () => {
    const plan = await createPlan(gymId, 'MPB Mandatory Inactive Plan');
    const inactive = await createSellableItem(gymId, 'Inactive Mandatory', 'fee', 'month', 'inactive');
    await setMandatory(inactive, 1);
    const deleted = await createSellableItem(gymId, 'Deleted Mandatory', 'fee', 'month');
    await setMandatory(deleted, 1);
    await db.query('UPDATE gym_charges SET deleted_at = NOW() WHERE id = ?', [deleted]);

    const res = await periodicalBenefits(plan, gymId);
    const ids = res.body.map((r: any) => r.gym_charge_id);
    expect(ids).not.toContain(inactive);
    expect(ids).not.toContain(deleted);
    expect(ids).toContain(insuranceId);
  });

  it("stays within the gym — another gym's mandatory item never appears", async () => {
    const planB = await createPlan(gymB, 'MPB Mandatory Plan B');
    const res = await periodicalBenefits(planB, gymB);
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.gym_charge_id)).not.toContain(insuranceId);
  });

  it('404s a plan from another gym rather than reporting its mandatory items', async () => {
    const res = await periodicalBenefits(planId, gymB);
    expect(res.status).toBe(404);
  });
});
