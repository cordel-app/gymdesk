// Tests for user-membership-services.ts router
//
// #631 — Additional Periodic Services on an Assigned Plan. Mounted in app.ts at
// /user-memberships/:id/services behind requireAuth + tenantContext +
// requireModuleAccess('PAYMENTS') + requireFeatureEnabled('payments.transactions').
//
// Every date in this file is computed relative to today (`dayOffset`), never
// hard-coded: the router stamps removals with the server's current date
// (`todayISO()`), and `active` is derived by comparing `ends_at` to it.

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

// ─── Date helpers ─────────────────────────────────────────────────────────────

/** YYYY-MM-DD, `days` from today in UTC — matches the router's todayISO(). */
function dayOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const today = () => dayOffset(0);

// ─── Fixture helpers (direct inserts — the HTTP API is only used for the
// action under test) ──────────────────────────────────────────────────────────

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

async function createPlan(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `UMS-Plan-${uniq()}`],
  );
  return insertId;
}

async function createMember(gymId: string, name = 'UMS Member'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)`,
    [gymId, name, `ums-${uniq()}@test.com`],
  );
  return insertId;
}

/**
 * An Assigned Plan (`user_memberships`) starting 30 days ago by default, so a
 * service can be attached before, on, or after its start date.
 */
async function createAssignedPlan(
  gymId: string,
  opts: {
    status?: 'draft' | 'awaiting_payment' | 'active' | 'paused' | 'cancelled' | 'expired';
    startsAt?: string;
    endsAt?: string | null;
  } = {},
): Promise<number> {
  const { status = 'active', startsAt = dayOffset(-30), endsAt = null } = opts;
  const memberId = await createMember(gymId);
  const planId = await createPlan(gymId);
  const { insertId } = await db.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, status, starts_at, ends_at, base_price, membership_fee_price)
     VALUES (?, ?, ?, ?, ?, ?, 40, 40)`,
    [gymId, memberId, planId, status, startsAt, endsAt],
  );
  return insertId;
}

/**
 * A Sellable Item (`gym_charges`). Defaults to the recurring service shape that
 * #631 allows: type 'service', billing_frequency 'month', status 'active'.
 * `charge_type_id` stays NULL — these are custom items, not system charges.
 */
async function createSellableItem(
  gymId: string,
  opts: {
    name?: string;
    type?: string;
    billingFrequency?: string | null;
    amount?: number;
    status?: 'active' | 'inactive';
    units?: number | null;
  } = {},
): Promise<number> {
  const {
    name = `UMS-Item-${uniq()}`,
    type = 'service',
    billingFrequency = 'month',
    amount = 25,
    status = 'active',
    units = null,
  } = opts;
  const { insertId } = await db.query(
    `INSERT INTO gym_charges
       (gym_id, name, type, units, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, ?, ?, ?, 'EUR', ?, ?, 'available', 0)`,
    [gymId, name, type, units, amount, billingFrequency, status],
  );
  return insertId;
}

async function softDeleteItem(itemId: number): Promise<void> {
  await db.query('UPDATE gym_charges SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [itemId]);
}

// ─── Route helpers ────────────────────────────────────────────────────────────

const listServices = (gymId: string, umId: number | string) =>
  request
    .get(`/user-memberships/${umId}/services`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId);

const addService = (gymId: string, umId: number | string, body: Record<string, unknown>) =>
  request
    .post(`/user-memberships/${umId}/services`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send(body);

const removeService = (gymId: string, umId: number | string, serviceId: number | string) =>
  request
    .delete(`/user-memberships/${umId}/services/${serviceId}`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId);

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe('/user-memberships/:id/services — auth', () => {
  let gymId: string;
  let umId: number;
  let itemId: number;

  beforeAll(async () => {
    gymId = await createTestGym('UMS Auth Gym');
    await createTestMembership(gymId, 'admin');
    umId = await createAssignedPlan(gymId);
    itemId = await createSellableItem(gymId);
  });

  it('returns 401 on GET without an Authorization header', async () => {
    const res = await request.get(`/user-memberships/${umId}/services`).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 401 on POST without an Authorization header', async () => {
    const res = await request
      .post(`/user-memberships/${umId}/services`)
      .set('x-gym-id', gymId)
      .send({ gym_charge_id: itemId });
    expect(res.status).toBe(401);
  });

  it('returns 401 on DELETE without an Authorization header', async () => {
    const res = await request
      .delete(`/user-memberships/${umId}/services/1`)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });
});

// ─── Module permissions (PAYMENTS: admin RW, accountant R, trainer NONE) ──────

describe('/user-memberships/:id/services — PAYMENTS module permissions', () => {
  // A role is granted per gym, and a user has at most one membership per gym,
  // so each role under test gets its own gym with its own Assigned Plan.
  let accountantGymId: string;
  let accountantUmId: number;
  let accountantItemId: number;
  let accountantServiceId: number;

  let noAccessGymId: string;
  let noAccessUmId: number;
  let noAccessItemId: number;

  beforeAll(async () => {
    accountantGymId = await createTestGym('UMS Accountant Gym');
    await createTestMembership(accountantGymId, 'accountant');
    accountantUmId = await createAssignedPlan(accountantGymId);
    accountantItemId = await createSellableItem(accountantGymId);
    // Seeded directly: an accountant cannot create one through the API.
    const { insertId } = await db.query(
      `INSERT INTO user_membership_services (gym_id, user_membership_id, gym_charge_id, quantity, starts_at)
       VALUES (?, ?, ?, 1, ?)`,
      [accountantGymId, accountantUmId, accountantItemId, dayOffset(-5)],
    );
    accountantServiceId = insertId;

    noAccessGymId = await createTestGym('UMS No Access Gym');
    await createTestMembership(noAccessGymId, 'trainer_performance');
    noAccessUmId = await createAssignedPlan(noAccessGymId);
    noAccessItemId = await createSellableItem(noAccessGymId);
  });

  it('lets a read-only role (accountant) list the services', async () => {
    const res = await listServices(accountantGymId, accountantUmId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.map((r: any) => r.id)).toContain(accountantServiceId);
  });

  it('returns 403 when a read-only role (accountant) attaches a service', async () => {
    const res = await addService(accountantGymId, accountantUmId, { gym_charge_id: accountantItemId });
    expect(res.status).toBe(403);
  });

  it('returns 403 when a read-only role (accountant) removes a service', async () => {
    const res = await removeService(accountantGymId, accountantUmId, accountantServiceId);
    expect(res.status).toBe(403);
    // Nothing was written.
    const { rows } = await db.query(
      'SELECT ends_at FROM user_membership_services WHERE id = ?',
      [accountantServiceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ends_at).toBeNull();
  });

  it('returns 403 on GET for a role with NONE access to PAYMENTS', async () => {
    const res = await listServices(noAccessGymId, noAccessUmId);
    expect(res.status).toBe(403);
  });

  it('returns 403 on POST for a role with NONE access to PAYMENTS', async () => {
    const res = await addService(noAccessGymId, noAccessUmId, { gym_charge_id: noAccessItemId });
    expect(res.status).toBe(403);
  });
});

// ─── Tenant isolation ─────────────────────────────────────────────────────────

describe('/user-memberships/:id/services — tenant isolation', () => {
  let gymA: string;
  let gymB: string;
  let umA: number;
  let itemA: number;
  let serviceA: number;
  let otherUmA: number;

  beforeAll(async () => {
    gymA = await createTestGym('UMS Tenant Gym A');
    await createTestMembership(gymA, 'admin');
    gymB = await createTestGym('UMS Tenant Gym B');
    await createTestMembership(gymB, 'admin');

    umA = await createAssignedPlan(gymA);
    otherUmA = await createAssignedPlan(gymA);
    itemA = await createSellableItem(gymA);

    const created = await addService(gymA, umA, { gym_charge_id: itemA, starts_at: dayOffset(-5) });
    expect(created.status).toBe(201);
    serviceA = created.body.id;
  });

  it('returns 404 listing gym A\'s Assigned Plan with gym B\'s x-gym-id', async () => {
    const res = await listServices(gymB, umA);
    expect(res.status).toBe(404);
  });

  it('returns 404 attaching to gym A\'s Assigned Plan with gym B\'s x-gym-id', async () => {
    const res = await addService(gymB, umA, { gym_charge_id: itemA });
    expect(res.status).toBe(404);
    // And gym A still sees exactly the one service it had.
    const list = await listServices(gymA, umA);
    expect(list.body).toHaveLength(1);
  });

  it('returns 404 removing gym A\'s service with gym B\'s x-gym-id', async () => {
    const res = await removeService(gymB, umA, serviceA);
    expect(res.status).toBe(404);
    const { rows } = await db.query('SELECT ends_at FROM user_membership_services WHERE id = ?', [serviceA]);
    expect(rows[0].ends_at).toBeNull();
  });

  it('returns 404 removing a service that belongs to a different Assigned Plan in the same gym', async () => {
    const res = await removeService(gymA, otherUmA, serviceA);
    expect(res.status).toBe(404);
    const { rows } = await db.query('SELECT ends_at FROM user_membership_services WHERE id = ?', [serviceA]);
    expect(rows[0].ends_at).toBeNull();
  });

  it('returns 404 for a Sellable Item belonging to another gym', async () => {
    const itemB = await createSellableItem(gymB);
    const res = await addService(gymA, umA, { gym_charge_id: itemB });
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown Assigned Plan id', async () => {
    const res = await listServices(gymA, 99999999);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-numeric Assigned Plan id', async () => {
    const res = await listServices(gymA, 'not-a-number');
    expect(res.status).toBe(404);
  });
});

// ─── Happy path: attach + list ────────────────────────────────────────────────

describe('POST/GET /user-memberships/:id/services — happy path', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('UMS Happy Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('attaches a recurring Sellable Item and lists it with the item\'s live name, price and frequency', async () => {
    const umId = await createAssignedPlan(gymId);
    const itemId = await createSellableItem(gymId, { name: 'Locker Rental', amount: 12.5 });

    const created = await addService(gymId, umId, { gym_charge_id: itemId, quantity: 2, starts_at: today() });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      user_membership_id: umId,
      gym_charge_id: itemId,
      quantity: 2,
      starts_at: today(),
      ends_at: null,
      sellable_item_name: 'Locker Rental',
      billing_frequency: 'month',
      currency: 'EUR',
      active: true,
    });
    expect(Number(created.body.unit_price)).toBe(12.5);
    expect(typeof created.body.id).toBe('number');

    const list = await listServices(gymId, umId);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({
      id: created.body.id,
      gym_charge_id: itemId,
      quantity: 2,
      sellable_item_name: 'Locker Rental',
      billing_frequency: 'month',
      active: true,
    });
  });

  it('reads the name and price live from the Sellable Item after it is edited', async () => {
    const umId = await createAssignedPlan(gymId);
    const itemId = await createSellableItem(gymId, { name: 'Towel Service', amount: 10 });
    const created = await addService(gymId, umId, { gym_charge_id: itemId });
    expect(created.status).toBe(201);

    await db.query('UPDATE gym_charges SET name = ?, amount = ? WHERE id = ?', ['Towel Service Plus', 18, itemId]);

    const list = await listServices(gymId, umId);
    expect(list.body[0].sellable_item_name).toBe('Towel Service Plus');
    expect(Number(list.body[0].unit_price)).toBe(18);
  });

  it('defaults quantity to 1 and starts_at to today for a plan that already started', async () => {
    const umId = await createAssignedPlan(gymId, { startsAt: dayOffset(-30) });
    const itemId = await createSellableItem(gymId);
    const res = await addService(gymId, umId, { gym_charge_id: itemId });
    expect(res.status).toBe(201);
    expect(res.body.quantity).toBe(1);
    expect(res.body.starts_at).toBe(today());
  });

  it('defaults starts_at to the Assigned Plan\'s start date when the plan has not started yet', async () => {
    const futureStart = dayOffset(10);
    const umId = await createAssignedPlan(gymId, { status: 'draft', startsAt: futureStart });
    const itemId = await createSellableItem(gymId);
    const res = await addService(gymId, umId, { gym_charge_id: itemId });
    expect(res.status).toBe(201);
    expect(res.body.starts_at).toBe(futureStart);
    expect(res.body.active).toBe(true);
  });

  it('returns an empty array for an Assigned Plan with no services', async () => {
    const umId = await createAssignedPlan(gymId);
    const res = await listServices(gymId, umId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('lists several services oldest window first', async () => {
    const umId = await createAssignedPlan(gymId);
    const first = await createSellableItem(gymId, { name: 'Older Service' });
    const second = await createSellableItem(gymId, { name: 'Newer Service' });
    // Posted newest-first on purpose — ordering must come from starts_at, not insert order.
    expect((await addService(gymId, umId, { gym_charge_id: second, starts_at: dayOffset(5) })).status).toBe(201);
    expect((await addService(gymId, umId, { gym_charge_id: first, starts_at: dayOffset(-10) })).status).toBe(201);

    const list = await listServices(gymId, umId);
    expect(list.body.map((r: any) => r.sellable_item_name)).toEqual(['Older Service', 'Newer Service']);
  });
});

// ─── Invariants on attaching (#631 §2) ────────────────────────────────────────

describe('POST /user-memberships/:id/services — attach invariants', () => {
  let gymId: string;
  let umId: number;

  beforeAll(async () => {
    gymId = await createTestGym('UMS Invariants Gym');
    await createTestMembership(gymId, 'admin');
    umId = await createAssignedPlan(gymId, { startsAt: dayOffset(-30) });
  });

  it('rejects a non-recurring Sellable Item (billing_frequency \'once\') with 400', async () => {
    const itemId = await createSellableItem(gymId, { billingFrequency: 'once' });
    const res = await addService(gymId, umId, { gym_charge_id: itemId });
    expect(res.status).toBe(400);
  });

  it('rejects a Sellable Item with no billing frequency with 400', async () => {
    const itemId = await createSellableItem(gymId, { billingFrequency: null });
    const res = await addService(gymId, umId, { gym_charge_id: itemId });
    expect(res.status).toBe(400);
  });

  it('rejects a sessions-type Sellable Item with 400 even when its frequency is recurring', async () => {
    const itemId = await createSellableItem(gymId, { type: 'sessions', billingFrequency: 'month', units: 10 });
    const res = await addService(gymId, umId, { gym_charge_id: itemId });
    expect(res.status).toBe(400);
  });

  it('accepts every other recurring frequency (week, four_weeks, year)', async () => {
    // 'four_weeks' is a valid gym_charges.billing_frequency since migration 123.
    for (const frequency of ['week', 'four_weeks', 'year']) {
      const target = await createAssignedPlan(gymId);
      const itemId = await createSellableItem(gymId, { billingFrequency: frequency });
      const res = await addService(gymId, target, { gym_charge_id: itemId });
      expect(res.status).toBe(201);
      expect(res.body.billing_frequency).toBe(frequency);
    }
  });

  it('rejects an inactive Sellable Item with 400', async () => {
    const itemId = await createSellableItem(gymId, { status: 'inactive' });
    const res = await addService(gymId, umId, { gym_charge_id: itemId });
    expect(res.status).toBe(400);
  });

  it('rejects a soft-deleted Sellable Item with 404', async () => {
    const itemId = await createSellableItem(gymId);
    await softDeleteItem(itemId);
    const res = await addService(gymId, umId, { gym_charge_id: itemId });
    expect(res.status).toBe(404);
  });

  it('rejects a missing or non-numeric gym_charge_id with 400', async () => {
    for (const gym_charge_id of [undefined, null, 'abc', 0, -3]) {
      const res = await addService(gymId, umId, { gym_charge_id });
      expect(res.status).toBe(400);
    }
  });

  it('rejects a non-positive or fractional quantity with 400', async () => {
    const itemId = await createSellableItem(gymId);
    for (const quantity of [0, -1, 1.5, 'two']) {
      const res = await addService(gymId, umId, { gym_charge_id: itemId, quantity });
      expect(res.status).toBe(400);
    }
  });

  it('rejects starts_at earlier than the Assigned Plan start date with 400', async () => {
    const planStart = dayOffset(-10);
    const target = await createAssignedPlan(gymId, { startsAt: planStart });
    const itemId = await createSellableItem(gymId);
    const res = await addService(gymId, target, { gym_charge_id: itemId, starts_at: dayOffset(-11) });
    expect(res.status).toBe(400);

    // The plan's own start date is accepted.
    const ok = await addService(gymId, target, { gym_charge_id: itemId, starts_at: planStart });
    expect(ok.status).toBe(201);
    expect(ok.body.starts_at).toBe(planStart);
  });

  it('rejects starts_at later than the Assigned Plan end date with 400', async () => {
    const target = await createAssignedPlan(gymId, { startsAt: dayOffset(-10), endsAt: dayOffset(10) });
    const itemId = await createSellableItem(gymId);
    const res = await addService(gymId, target, { gym_charge_id: itemId, starts_at: dayOffset(11) });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed starts_at with 400', async () => {
    const itemId = await createSellableItem(gymId);
    const res = await addService(gymId, umId, { gym_charge_id: itemId, starts_at: '15-02-2026' });
    expect(res.status).toBe(400);
  });

  it('returns 409 attaching the same Sellable Item while the first attachment is still open', async () => {
    const target = await createAssignedPlan(gymId);
    const itemId = await createSellableItem(gymId);
    const first = await addService(gymId, target, { gym_charge_id: itemId, starts_at: today() });
    expect(first.status).toBe(201);

    const duplicate = await addService(gymId, target, { gym_charge_id: itemId, starts_at: today() });
    expect(duplicate.status).toBe(409);

    // Also for a later start date, while the open attachment has no end.
    const later = await addService(gymId, target, { gym_charge_id: itemId, starts_at: dayOffset(30) });
    expect(later.status).toBe(409);

    const list = await listServices(gymId, target);
    expect(list.body).toHaveLength(1);
  });

  it('allows a different Sellable Item on the same Assigned Plan', async () => {
    const target = await createAssignedPlan(gymId);
    const itemA = await createSellableItem(gymId);
    const itemB = await createSellableItem(gymId);
    expect((await addService(gymId, target, { gym_charge_id: itemA })).status).toBe(201);
    expect((await addService(gymId, target, { gym_charge_id: itemB })).status).toBe(201);
    const list = await listServices(gymId, target);
    expect(list.body).toHaveLength(2);
  });

  it('allows the same Sellable Item on a different Assigned Plan', async () => {
    const itemId = await createSellableItem(gymId);
    const planOne = await createAssignedPlan(gymId);
    const planTwo = await createAssignedPlan(gymId);
    expect((await addService(gymId, planOne, { gym_charge_id: itemId })).status).toBe(201);
    expect((await addService(gymId, planTwo, { gym_charge_id: itemId })).status).toBe(201);
  });

  it('returns 409 for a cancelled or expired Assigned Plan', async () => {
    for (const status of ['cancelled', 'expired'] as const) {
      const target = await createAssignedPlan(gymId, { status });
      const itemId = await createSellableItem(gymId);
      const res = await addService(gymId, target, { gym_charge_id: itemId });
      expect(res.status).toBe(409);
    }
  });

  it('allows attaching to a draft, awaiting_payment or paused Assigned Plan', async () => {
    for (const status of ['draft', 'awaiting_payment', 'paused'] as const) {
      const target = await createAssignedPlan(gymId, { status });
      const itemId = await createSellableItem(gymId);
      const res = await addService(gymId, target, { gym_charge_id: itemId });
      expect(res.status).toBe(201);
    }
  });
});

// ─── Future-only removal (#631 §3) ────────────────────────────────────────────

describe('DELETE /user-memberships/:id/services/:serviceId — future-only removal', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('UMS Removal Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('deletes a service outright when its billing has not started yet', async () => {
    const umId = await createAssignedPlan(gymId);
    const itemId = await createSellableItem(gymId);
    const created = await addService(gymId, umId, { gym_charge_id: itemId, starts_at: dayOffset(7) });
    expect(created.status).toBe(201);

    const res = await removeService(gymId, umId, created.body.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: created.body.id, deleted: true, ends_at: null });

    const list = await listServices(gymId, umId);
    expect(list.body).toEqual([]);
    const { rows } = await db.query('SELECT id FROM user_membership_services WHERE id = ?', [created.body.id]);
    expect(rows).toHaveLength(0);
  });

  it('stamps ends_at = today for a service that is already being billed, keeping the row', async () => {
    const umId = await createAssignedPlan(gymId);
    const itemId = await createSellableItem(gymId);
    const created = await addService(gymId, umId, { gym_charge_id: itemId, starts_at: dayOffset(-5) });
    expect(created.status).toBe(201);

    const res = await removeService(gymId, umId, created.body.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: created.body.id, deleted: false, ends_at: today() });

    // The row survives for the billing history it already produced.
    const list = await listServices(gymId, umId);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(created.body.id);
    expect(list.body[0].ends_at).toBe(today());
    // Still billable through today, so it is active on the removal date itself.
    expect(list.body[0].active).toBe(true);
  });

  it('lists a service whose window has already closed as active: false', async () => {
    const umId = await createAssignedPlan(gymId);
    const itemId = await createSellableItem(gymId);
    const created = await addService(gymId, umId, { gym_charge_id: itemId, starts_at: dayOffset(-10) });
    expect(created.status).toBe(201);
    expect((await removeService(gymId, umId, created.body.id)).status).toBe(200);

    // Move the stamped removal date into the past, as it would be the day after.
    await db.query('UPDATE user_membership_services SET ends_at = ? WHERE id = ?', [dayOffset(-1), created.body.id]);

    const list = await listServices(gymId, umId);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].ends_at).toBe(dayOffset(-1));
    expect(list.body[0].active).toBe(false);
  });

  it('allows re-attaching the same Sellable Item once the earlier window has closed', async () => {
    const umId = await createAssignedPlan(gymId);
    const itemId = await createSellableItem(gymId);
    const first = await addService(gymId, umId, { gym_charge_id: itemId, starts_at: dayOffset(-20) });
    expect(first.status).toBe(201);
    expect((await removeService(gymId, umId, first.body.id)).body.ends_at).toBe(today());

    // Still overlapping today (ends_at = today) → 409.
    expect((await addService(gymId, umId, { gym_charge_id: itemId, starts_at: today() })).status).toBe(409);

    // After that end date → allowed, and both windows are listed.
    const second = await addService(gymId, umId, { gym_charge_id: itemId, starts_at: dayOffset(1) });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);

    const list = await listServices(gymId, umId);
    expect(list.body).toHaveLength(2);
    expect(list.body.map((r: any) => r.id)).toEqual([first.body.id, second.body.id]);
    expect(list.body[0].ends_at).toBe(today());
    expect(list.body[1].ends_at).toBeNull();
  });

  it('returns 409 removing the same service twice', async () => {
    const umId = await createAssignedPlan(gymId);
    const itemId = await createSellableItem(gymId);
    const created = await addService(gymId, umId, { gym_charge_id: itemId, starts_at: dayOffset(-3) });
    expect(created.status).toBe(201);

    expect((await removeService(gymId, umId, created.body.id)).status).toBe(200);
    const second = await removeService(gymId, umId, created.body.id);
    expect(second.status).toBe(409);

    // The original end date was not moved by the second attempt.
    const { rows } = await db.query('SELECT ends_at FROM user_membership_services WHERE id = ?', [created.body.id]);
    expect(rows).toHaveLength(1);
  });

  it('returns 404 removing a service that was already deleted outright', async () => {
    const umId = await createAssignedPlan(gymId);
    const itemId = await createSellableItem(gymId);
    const created = await addService(gymId, umId, { gym_charge_id: itemId, starts_at: dayOffset(7) });
    expect((await removeService(gymId, umId, created.body.id)).body.deleted).toBe(true);

    const second = await removeService(gymId, umId, created.body.id);
    expect(second.status).toBe(404);
  });

  it('returns 404 for an unknown service id and 400 for a non-numeric one', async () => {
    const umId = await createAssignedPlan(gymId);
    expect((await removeService(gymId, umId, 99999999)).status).toBe(404);
    expect((await removeService(gymId, umId, 'abc')).status).toBe(400);
  });

  it('removes a service whose Sellable Item was soft-deleted after it was attached', async () => {
    const umId = await createAssignedPlan(gymId);
    const itemId = await createSellableItem(gymId);
    const created = await addService(gymId, umId, { gym_charge_id: itemId, starts_at: dayOffset(-2) });
    expect(created.status).toBe(201);
    await softDeleteItem(itemId);

    // The attachment must survive its item being retired (no cascade by design).
    const list = await listServices(gymId, umId);
    expect(list.body).toHaveLength(1);

    const res = await removeService(gymId, umId, created.body.id);
    expect(res.status).toBe(200);
    expect(res.body.ends_at).toBe(today());
  });
});
