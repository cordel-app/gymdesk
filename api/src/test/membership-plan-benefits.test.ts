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
    expect(res.body.free_months).toBeNull();
    expect(res.body.paid_months).toBeNull();
    expect(res.body.bonus_months).toBeNull();
  });

  it('PUT stores free / paid / bonus months', async () => {
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ free_months: 1, paid_months: 2, bonus_months: 2 });
    expect(res.status).toBe(200);
    expect(res.body.free_months).toBe(1);
    expect(res.body.paid_months).toBe(2);
    expect(res.body.bonus_months).toBe(2);
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
    expect(res.body.free_months).toBe(1);
    expect(res.body.paid_months).toBe(2);
    expect(res.body.bonus_months).toBe(2);
  });

  // An emptied field means "not configured", which must round-trip as NULL —
  // COALESCE alone could never express this, hence the IF(present, …) pairs.
  it('clears a field back to null when it is sent as null', async () => {
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ free_months: null, paid_months: 3, bonus_months: null });
    expect(res.status).toBe(200);
    expect(res.body.free_months).toBeNull();
    expect(res.body.paid_months).toBe(3);
    expect(res.body.bonus_months).toBeNull();
  });

  it('accepts an explicit 0, distinct from null', async () => {
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ free_months: 0 });
    expect(res.status).toBe(200);
    expect(res.body.free_months).toBe(0);
  });

  it('rejects a negative value', async () => {
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ paid_months: -1 });
    expect(res.status).toBe(400);
  });

  it('rejects a non-integer value', async () => {
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ bonus_months: 'soon' });
    expect(res.status).toBe(400);
  });

  it('is tenant-isolated — gym B cannot set gym A\'s durations', async () => {
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ free_months: 9 });
    expect(res.status).toBe(404);
  });

  it('→ 401 without authentication', async () => {
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('x-gym-id', gymId)
      .send({ free_months: 1 });
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
      .send({ free_months: 1 });
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
      .send({ free_months: 1, paid_months: 2, bonus_months: 2 });
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
    expect(dup.body.free_months).toBe(1);
    expect(dup.body.paid_months).toBe(2);
    expect(dup.body.bonus_months).toBe(2);
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
  // three Benefit sections is the billing forecast.
  it('still serves the billing forecast', async () => {
    const res = await request
      .get(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.allowances).toBeUndefined();
    expect(res.body.billing_forecast).toBeDefined();
  });
});
