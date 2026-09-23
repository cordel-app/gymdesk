// Tests for member-professional-services.ts router
//
// #647 stage 1 — GET /members/:memberId/professional-services. Mounted in
// app.ts behind requireAuth + tenantContext + requireModuleAccess('MEMBERS') +
// requireFeatureEnabled('organization.professional_services').
//
// The endpoint answers "which Professional Services does this Member hold
// sessions for, and how many?", folding together the three grant sources in
// api/src/domain/memberProfessionalServices.ts:
//
//   1. user_class_packages  — a purchased package (sessions_remaining)
//   2. promotion_session    — Session benefits of a Promotion applied to an
//                             ACTIVE assignment (user_membership_promotions)
//   3. user_membership_services — Additional Services attached to an ACTIVE
//                             assignment (quantity * gym_charges.units)
//
// aggregateProfessionalServiceGrants() — the pure folding step — is covered
// separately by member-professional-services-aggregation.test.ts. This file
// exercises the SQL and the HTTP guards against real MySQL.
//
// Every date is computed relative to today (`dayOffset`), never hard-coded:
// the loader compares expires_at / starts_at / ends_at against UTC_DATE().

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

/** YYYY-MM-DD, `days` from today in UTC — matches the loader's UTC_DATE(). */
function dayOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── Fixture helpers (direct inserts — the HTTP API is only used for the
// action under test) ──────────────────────────────────────────────────────────

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

async function createMember(gymId: string, name = 'MPS Member'): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, name, `mps-${uniq()}@test.com`],
  );
  return insertId;
}

/**
 * A gym-owned Professional Service plus its per-gym enable row.
 *
 * Custom (gym_id = gymId) rather than one of the five migration-seeded system
 * services: createTestGym() inserts straight into `gyms` and so never gets the
 * gym_professional_services rows POST /gyms seeds, and a gym-owned row is
 * cleaned up by cleanupTestGyms() with its gym.
 */
async function createProfessionalService(
  gymId: string,
  opts: { name?: string; status?: 'active' | 'inactive'; deleted?: boolean } = {},
): Promise<{ id: number; name: string }> {
  const { name = `MPS-Service-${uniq()}`, status = 'active', deleted = false } = opts;
  const { insertId } = await db.query(
    `INSERT INTO professional_services (gym_id, name, is_system, system_key)
     VALUES (?, ?, 0, NULL)`,
    [gymId, name],
  );
  if (deleted) {
    await db.query(
      'UPDATE professional_services SET deleted_at = UTC_TIMESTAMP() WHERE id = ?',
      [insertId],
    );
  }
  await db.query(
    'INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, ?)',
    [gymId, insertId, status],
  );
  return { id: insertId, name };
}

/**
 * A Session-type Sellable Item (`gym_charges`, type='sessions'). `units` is the
 * number of sessions the item bundles — migration 103 copies
 * class_packages.number_of_sessions into it. charge_type_id stays NULL: these
 * are custom catalogue items, not system charges.
 */
async function createSessionItem(
  gymId: string,
  opts: { name?: string; units?: number | null; type?: string; classPackageId?: number | null } = {},
): Promise<number> {
  const {
    name = `MPS-Item-${uniq()}`,
    units = 1,
    type = 'sessions',
    classPackageId = null,
  } = opts;
  const { insertId } = await db.query(
    `INSERT INTO gym_charges
       (gym_id, name, type, units, amount, currency, billing_frequency,
        status, availability, is_system, class_package_id)
     VALUES (?, ?, ?, ?, 100.00, 'EUR', NULL, 'active', 'available', 0, ?)`,
    [gymId, name, type, units, classPackageId],
  );
  return insertId;
}

/** Links a Sellable Item to a Professional Service (#546, migration 153). */
async function linkItemToService(gymId: string, itemId: number, serviceId: number): Promise<void> {
  await db.query(
    `INSERT INTO sellable_item_professional_services (gym_id, sellable_item_id, professional_service_id)
     VALUES (?, ?, ?)`,
    [gymId, itemId, serviceId],
  );
}

/**
 * A class_packages catalogue row plus the gym_charges Sellable Item that
 * traces back to it (the migration-103 shape the package loader relies on),
 * already linked to `serviceId`.
 */
async function createPackageCatalogue(
  gymId: string,
  serviceId: number,
  opts: { name?: string; sessions?: number } = {},
): Promise<{ classPackageId: number; sellableItemId: number; name: string }> {
  const { name = `MPS-Package-${uniq()}`, sessions = 10 } = opts;
  const { insertId: classPackageId } = await db.query(
    `INSERT INTO class_packages (gym_id, name, number_of_sessions, price, validity_days, status)
     VALUES (?, ?, ?, 100.00, 365, 'active')`,
    [gymId, name, sessions],
  );
  const sellableItemId = await createSessionItem(gymId, {
    name,
    units: sessions,
    classPackageId,
  });
  await linkItemToService(gymId, sellableItemId, serviceId);
  return { classPackageId, sellableItemId, name };
}

/** A purchased package instance (`user_class_packages`). */
async function grantPackageToMember(
  gymId: string,
  memberId: number,
  classPackageId: number,
  opts: {
    sessionsRemaining?: number;
    status?: 'active' | 'consumed' | 'expired' | 'cancelled';
    expiresAt?: string;
  } = {},
): Promise<number> {
  const {
    sessionsRemaining = 10,
    status = 'active',
    expiresAt = dayOffset(90),
  } = opts;
  const { insertId } = await db.query(
    `INSERT INTO user_class_packages
       (gym_id, member_id, class_package_id, expires_at, sessions_remaining, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [gymId, memberId, classPackageId, expiresAt, sessionsRemaining, status],
  );
  return insertId;
}

async function createPlan(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `MPS-Plan-${uniq()}`],
  );
  return insertId;
}

/** An assignment (`user_memberships`). Only one ACTIVE row per member exists. */
async function createAssignedPlan(
  gymId: string,
  memberId: number,
  planId: number,
  status: 'draft' | 'awaiting_payment' | 'active' | 'paused' | 'cancelled' | 'expired' = 'active',
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, status, starts_at, base_price, final_price)
     VALUES (?, ?, ?, ?, ?, 40.00, 40.00)`,
    [gymId, memberId, planId, status, dayOffset(-30)],
  );
  return insertId;
}

/**
 * A Promotion carrying one Session benefit (`promotion_session`, migration
 * 155) on `sellableItemId`, applied to `userMembershipId`.
 * Returns the user_membership_promotions row id — the loader's reference_id.
 */
async function applyPromotionWithSessionBenefit(
  gymId: string,
  planId: number,
  userMembershipId: number,
  sellableItemId: number,
  quantity: number,
  status: 'applied' | 'consumed' | 'revoked' = 'applied',
): Promise<number> {
  const { insertId: promotionId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
                            only_applicable_for_new_members)
     VALUES (?, ?, ?, '2099-12-31', 'active', 1, 0)`,
    [gymId, `MPS-Promo-${uniq()}`, dayOffset(-60)],
  );
  await db.query(
    'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
    [gymId, promotionId, planId],
  );
  await db.query(
    'INSERT INTO promotion_session (gym_id, promotion_id, gym_charge_id, quantity) VALUES (?, ?, ?, ?)',
    [gymId, promotionId, sellableItemId, quantity],
  );
  const { insertId } = await db.query(
    `INSERT INTO user_membership_promotions (gym_id, user_membership_id, promotion_id, status)
     VALUES (?, ?, ?, ?)`,
    [gymId, userMembershipId, promotionId, status],
  );
  return insertId;
}

/** An Additional Service attached to an assignment (#631, migration 164). */
async function attachMembershipService(
  gymId: string,
  userMembershipId: number,
  sellableItemId: number,
  opts: { quantity?: number; startsAt?: string; endsAt?: string | null } = {},
): Promise<number> {
  const { quantity = 1, startsAt = dayOffset(-10), endsAt = null } = opts;
  const { insertId } = await db.query(
    `INSERT INTO user_membership_services
       (gym_id, user_membership_id, gym_charge_id, quantity, starts_at, ends_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [gymId, userMembershipId, sellableItemId, quantity, startsAt, endsAt],
  );
  return insertId;
}

// ─── Route helper ─────────────────────────────────────────────────────────────

const listServices = (gymId: string, memberId: number | string) =>
  request
    .get(`/members/${memberId}/professional-services`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId);

// ─── Auth and access guards ───────────────────────────────────────────────────

describe('Auth and access guards', () => {
  let gymId: string;
  let memberId: number;

  beforeAll(async () => {
    gymId = await createTestGym('MPS Auth Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId);
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request
      .get(`/members/${memberId}/professional-services`)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 for a role with NONE access to MEMBERS (accountant)', async () => {
    const gymAccountant = await createTestGym('MPS Accountant Gym');
    await createTestMembership(gymAccountant, 'accountant');
    const accountantMember = await createMember(gymAccountant);

    const res = await listServices(gymAccountant, accountantMember);
    expect(res.status).toBe(403);
  });

  it('returns 403 for a role with NONE access to MEMBERS (member)', async () => {
    const gymMemberRole = await createTestGym('MPS Member Role Gym');
    await createTestMembership(gymMemberRole, 'member');
    const someMember = await createMember(gymMemberRole);

    const res = await listServices(gymMemberRole, someMember);
    expect(res.status).toBe(403);
  });

  it('allows a read-only role (trainer_performance) to read the list', async () => {
    const gymTrainer = await createTestGym('MPS Trainer Gym');
    await createTestMembership(gymTrainer, 'trainer_performance');
    const trainerMember = await createMember(gymTrainer);

    const res = await listServices(gymTrainer, trainerMember);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 400 for a non-numeric memberId', async () => {
    const res = await listServices(gymId, 'not-a-number');
    expect(res.status).toBe(400);
  });

  it('returns 404 for a member id that does not exist', async () => {
    const res = await listServices(gymId, 9999999);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a soft-deleted member', async () => {
    const deletedMember = await createMember(gymId, 'MPS Deleted Member');
    await db.query('UPDATE members SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [deletedMember]);

    const res = await listServices(gymId, deletedMember);
    expect(res.status).toBe(404);
  });
});

// ─── Tenant isolation ─────────────────────────────────────────────────────────

describe('Tenant isolation', () => {
  let gymA: string;
  let gymB: string;
  let gymNoMembership: string;
  let memberInA: number;

  beforeAll(async () => {
    gymA = await createTestGym('MPS Tenant Gym A');
    await createTestMembership(gymA, 'admin');

    // TEST_USER_ID is admin here too, so the request reaches the router and the
    // 404 can only come from the member/gym mismatch.
    gymB = await createTestGym('MPS Tenant Gym B');
    await createTestMembership(gymB, 'admin');

    // A different Clerk user is admin here — TEST_USER_ID has no membership row.
    gymNoMembership = await createTestGym('MPS Tenant Gym No Membership');
    await createTestMembership(gymNoMembership, 'admin', 'other-clerk-user-id');

    memberInA = await createMember(gymA, 'MPS Tenant Member A');
    const service = await createProfessionalService(gymA);
    const pkg = await createPackageCatalogue(gymA, service.id, { sessions: 10 });
    await grantPackageToMember(gymA, memberInA, pkg.classPackageId, { sessionsRemaining: 10 });
  });

  it('returns 404 reading a gym A member with gym B credentials', async () => {
    const res = await listServices(gymB, memberInA);
    expect(res.status).toBe(404);
  });

  it('still returns the grants for the owning gym', async () => {
    const res = await listServices(gymA, memberInA);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].sessions).toBe(10);
  });

  it('returns 403 when the user has no membership in the requested gym', async () => {
    const memberInOther = await createMember(gymNoMembership);
    const res = await listServices(gymNoMembership, memberInOther);
    expect(res.status).toBe(403);
  });
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('GET /members/:memberId/professional-services — happy path', () => {
  let gymId: string;
  let memberId: number;
  let service: { id: number; name: string };
  let pkg: { classPackageId: number; sellableItemId: number; name: string };
  let userClassPackageId: number;

  beforeAll(async () => {
    gymId = await createTestGym('MPS Happy Path Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId, 'MPS Happy Member');

    service = await createProfessionalService(gymId, { name: `MPS Personal Training ${uniq()}` });
    pkg = await createPackageCatalogue(gymId, service.id, {
      name: `MPS PT Class Package (10 Sessions) ${uniq()}`,
      sessions: 10,
    });
    userClassPackageId = await grantPackageToMember(gymId, memberId, pkg.classPackageId, {
      sessionsRemaining: 10,
    });
  });

  it('returns the Professional Service with its id, name and session count', async () => {
    const res = await listServices(gymId, memberId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      professional_service_id: service.id,
      name: service.name,
      sessions: 10,
    });
  });

  it('lists the granting package as the single source', async () => {
    const res = await listServices(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body[0].sources).toHaveLength(1);
    expect(res.body[0].sources[0]).toMatchObject({
      kind: 'class_package',
      reference_id: userClassPackageId,
      sellable_item_id: pkg.sellableItemId,
      sellable_item_name: pkg.name,
      sessions: 10,
    });
  });

  it('returns [] for a member of the same gym holding nothing', async () => {
    const emptyMember = await createMember(gymId, 'MPS Empty Member');
    const res = await listServices(gymId, emptyMember);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('reports the live decremented balance, not the bundled size', async () => {
    const partialMember = await createMember(gymId, 'MPS Partial Member');
    await grantPackageToMember(gymId, partialMember, pkg.classPackageId, { sessionsRemaining: 3 });

    const res = await listServices(gymId, partialMember);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].sessions).toBe(3);
  });
});

// ─── Counts add up across sources ─────────────────────────────────────────────

describe('Counts add up across grant sources', () => {
  let gymId: string;
  let memberId: number;
  let service: { id: number; name: string };
  let pkg: { classPackageId: number; sellableItemId: number; name: string };
  let promotionItemId: number;
  let userClassPackageId: number;
  let umpId: number;

  beforeAll(async () => {
    gymId = await createTestGym('MPS Sum Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId, 'MPS Sum Member');

    service = await createProfessionalService(gymId, { name: `MPS Sum PT ${uniq()}` });

    // Source 1: a purchased 10-session package.
    pkg = await createPackageCatalogue(gymId, service.id, { sessions: 10 });
    userClassPackageId = await grantPackageToMember(gymId, memberId, pkg.classPackageId, {
      sessionsRemaining: 10,
    });

    // Source 2: a Promotion granting 4 sessions of the same service, applied to
    // the member's ACTIVE assignment.
    const planId = await createPlan(gymId);
    const umId = await createAssignedPlan(gymId, memberId, planId, 'active');
    promotionItemId = await createSessionItem(gymId, {
      name: `MPS Promo PT Session ${uniq()}`,
      units: 1,
    });
    await linkItemToService(gymId, promotionItemId, service.id);
    umpId = await applyPromotionWithSessionBenefit(gymId, planId, umId, promotionItemId, 4);
  });

  // The worked example from the #647 issue thread: a purchased 10-class PT
  // package plus 4 PT sessions from the assigned plan's promotion = 14.
  it('sums a purchased package and a promotion Session benefit into one entry', async () => {
    const res = await listServices(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      professional_service_id: service.id,
      name: service.name,
      sessions: 14,
    });
  });

  it('lists both grants in sources, keyed to their own records', async () => {
    const res = await listServices(gymId, memberId);
    expect(res.status).toBe(200);
    const sources = res.body[0].sources;
    expect(sources).toHaveLength(2);

    const fromPackage = sources.find((s: any) => s.kind === 'class_package');
    expect(fromPackage).toMatchObject({
      reference_id: userClassPackageId,
      sellable_item_id: pkg.sellableItemId,
      sessions: 10,
    });

    // reference_id is the *application* row (user_membership_promotions.id),
    // not the promotion_session benefit row.
    const fromPromotion = sources.find((s: any) => s.kind === 'promotion_session');
    expect(fromPromotion).toMatchObject({
      reference_id: umpId,
      sellable_item_id: promotionItemId,
      sessions: 4,
    });
  });

  it('keeps two different Professional Services as separate entries', async () => {
    const otherMember = await createMember(gymId, 'MPS Two Services Member');
    const physio = await createProfessionalService(gymId, { name: `MPS Physio ${uniq()}` });
    const physioPkg = await createPackageCatalogue(gymId, physio.id, { sessions: 5 });
    await grantPackageToMember(gymId, otherMember, pkg.classPackageId, { sessionsRemaining: 10 });
    await grantPackageToMember(gymId, otherMember, physioPkg.classPackageId, { sessionsRemaining: 5 });

    const res = await listServices(gymId, otherMember);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const byId = Object.fromEntries(res.body.map((e: any) => [e.professional_service_id, e.sessions]));
    expect(byId[service.id]).toBe(10);
    expect(byId[physio.id]).toBe(5);
  });

  it("does not leak another member's grants", async () => {
    const strangerMember = await createMember(gymId, 'MPS Stranger Member');
    const res = await listServices(gymId, strangerMember);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ─── Packages that must not be counted ────────────────────────────────────────

describe('Uncountable purchased packages', () => {
  let gymId: string;
  let service: { id: number; name: string };
  let classPackageId: number;

  beforeAll(async () => {
    gymId = await createTestGym('MPS Uncountable Gym');
    await createTestMembership(gymId, 'admin');
    service = await createProfessionalService(gymId, { name: `MPS Uncountable PT ${uniq()}` });
    ({ classPackageId } = await createPackageCatalogue(gymId, service.id, { sessions: 10 }));
  });

  it('excludes a package whose expires_at has passed', async () => {
    const memberId = await createMember(gymId, 'MPS Expired Package Member');
    await grantPackageToMember(gymId, memberId, classPackageId, {
      sessionsRemaining: 10,
      expiresAt: dayOffset(-1),
    });

    const res = await listServices(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("excludes a package with status 'consumed'", async () => {
    const memberId = await createMember(gymId, 'MPS Consumed Package Member');
    await grantPackageToMember(gymId, memberId, classPackageId, {
      sessionsRemaining: 4,
      status: 'consumed',
    });

    const res = await listServices(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("excludes a package with status 'expired' or 'cancelled'", async () => {
    for (const status of ['expired', 'cancelled'] as const) {
      const memberId = await createMember(gymId, `MPS ${status} Package Member`);
      await grantPackageToMember(gymId, memberId, classPackageId, {
        sessionsRemaining: 4,
        status,
      });

      const res = await listServices(gymId, memberId);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    }
  });

  it('excludes a package with zero sessions remaining', async () => {
    const memberId = await createMember(gymId, 'MPS Zero Remaining Member');
    await grantPackageToMember(gymId, memberId, classPackageId, { sessionsRemaining: 0 });

    const res = await listServices(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('counts a package expiring today (expires_at = UTC_DATE())', async () => {
    const memberId = await createMember(gymId, 'MPS Expiring Today Member');
    await grantPackageToMember(gymId, memberId, classPackageId, {
      sessionsRemaining: 2,
      expiresAt: dayOffset(0),
    });

    const res = await listServices(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].sessions).toBe(2);
  });

  it('counts only the still-spendable package when a member holds both', async () => {
    const memberId = await createMember(gymId, 'MPS Mixed Packages Member');
    await grantPackageToMember(gymId, memberId, classPackageId, {
      sessionsRemaining: 6,
    });
    await grantPackageToMember(gymId, memberId, classPackageId, {
      sessionsRemaining: 10,
      expiresAt: dayOffset(-5),
    });

    const res = await listServices(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].sessions).toBe(6);
    expect(res.body[0].sources).toHaveLength(1);
  });
});

// ─── Promotion Session benefits: only live applications count ─────────────────

describe('Promotion Session benefits', () => {
  let gymId: string;
  let service: { id: number; name: string };
  let promotionItemId: number;

  beforeAll(async () => {
    gymId = await createTestGym('MPS Promotion Gym');
    await createTestMembership(gymId, 'admin');
    service = await createProfessionalService(gymId, { name: `MPS Promo Service ${uniq()}` });
    promotionItemId = await createSessionItem(gymId, { name: `MPS Promo Item ${uniq()}`, units: 1 });
    await linkItemToService(gymId, promotionItemId, service.id);
  });

  it('counts a Session benefit applied to an ACTIVE assignment', async () => {
    const memberId = await createMember(gymId, 'MPS Promo Active Member');
    const planId = await createPlan(gymId);
    const umId = await createAssignedPlan(gymId, memberId, planId, 'active');
    await applyPromotionWithSessionBenefit(gymId, planId, umId, promotionItemId, 4);

    const res = await listServices(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ professional_service_id: service.id, sessions: 4 });
    expect(res.body[0].sources[0].kind).toBe('promotion_session');
  });

  it('ignores a Session benefit on a non-active assignment', async () => {
    for (const status of ['paused', 'cancelled', 'expired', 'draft'] as const) {
      const memberId = await createMember(gymId, `MPS Promo ${status} Member`);
      const planId = await createPlan(gymId);
      const umId = await createAssignedPlan(gymId, memberId, planId, status);
      await applyPromotionWithSessionBenefit(gymId, planId, umId, promotionItemId, 4);

      const res = await listServices(gymId, memberId);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    }
  });

  it("ignores a promotion application that is no longer 'applied'", async () => {
    for (const status of ['consumed', 'revoked'] as const) {
      const memberId = await createMember(gymId, `MPS Promo ${status} Application Member`);
      const planId = await createPlan(gymId);
      const umId = await createAssignedPlan(gymId, memberId, planId, 'active');
      await applyPromotionWithSessionBenefit(gymId, planId, umId, promotionItemId, 4, status);

      const res = await listServices(gymId, memberId);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    }
  });
});

// ─── Additional Services attached to an assignment (#631) ─────────────────────

describe('Additional Services attached to an assignment', () => {
  let gymId: string;
  let service: { id: number; name: string };
  let tenSessionItemId: number;

  beforeAll(async () => {
    gymId = await createTestGym('MPS Membership Service Gym');
    await createTestMembership(gymId, 'admin');
    service = await createProfessionalService(gymId, { name: `MPS Attached Service ${uniq()}` });
    tenSessionItemId = await createSessionItem(gymId, {
      name: `MPS Attached 10-Session Item ${uniq()}`,
      units: 10,
    });
    await linkItemToService(gymId, tenSessionItemId, service.id);
  });

  // gym_charges.units is the number of sessions the item bundles, so quantity 2
  // of a 10-session item is 20 sessions.
  it('multiplies quantity by the item units', async () => {
    const memberId = await createMember(gymId, 'MPS Attached Member');
    const planId = await createPlan(gymId);
    const umId = await createAssignedPlan(gymId, memberId, planId, 'active');
    const umsvId = await attachMembershipService(gymId, umId, tenSessionItemId, { quantity: 2 });

    const res = await listServices(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].sessions).toBe(20);
    expect(res.body[0].sources[0]).toMatchObject({
      kind: 'membership_service',
      reference_id: umsvId,
      sellable_item_id: tenSessionItemId,
      sessions: 20,
    });
  });

  it('ignores an attachment whose window has already closed', async () => {
    const memberId = await createMember(gymId, 'MPS Attached Closed Member');
    const planId = await createPlan(gymId);
    const umId = await createAssignedPlan(gymId, memberId, planId, 'active');
    await attachMembershipService(gymId, umId, tenSessionItemId, {
      startsAt: dayOffset(-20),
      endsAt: dayOffset(-1),
    });

    const res = await listServices(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('ignores an attachment that has not started yet', async () => {
    const memberId = await createMember(gymId, 'MPS Attached Future Member');
    const planId = await createPlan(gymId);
    const umId = await createAssignedPlan(gymId, memberId, planId, 'active');
    await attachMembershipService(gymId, umId, tenSessionItemId, { startsAt: dayOffset(5) });

    const res = await listServices(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('ignores an attached item that is not a Session package', async () => {
    const memberId = await createMember(gymId, 'MPS Attached Non Session Member');
    const planId = await createPlan(gymId);
    const umId = await createAssignedPlan(gymId, memberId, planId, 'active');
    const recurringItemId = await createSessionItem(gymId, {
      name: `MPS Attached Service Item ${uniq()}`,
      type: 'service',
      units: null,
    });
    await linkItemToService(gymId, recurringItemId, service.id);
    await attachMembershipService(gymId, umId, recurringItemId, { quantity: 3 });

    const res = await listServices(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ─── Professional Service availability ────────────────────────────────────────

describe('Professional Service availability', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('MPS Availability Gym');
    await createTestMembership(gymId, 'admin');
  });

  it("excludes a service the gym has switched off (gym_professional_services.status = 'inactive')", async () => {
    const memberId = await createMember(gymId, 'MPS Inactive Service Member');
    const service = await createProfessionalService(gymId, {
      name: `MPS Disabled Service ${uniq()}`,
      status: 'inactive',
    });
    const pkg = await createPackageCatalogue(gymId, service.id, { sessions: 10 });
    await grantPackageToMember(gymId, memberId, pkg.classPackageId, { sessionsRemaining: 10 });

    const res = await listServices(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('excludes a soft-deleted Professional Service', async () => {
    const memberId = await createMember(gymId, 'MPS Deleted Service Member');
    const service = await createProfessionalService(gymId, {
      name: `MPS Removed Service ${uniq()}`,
      deleted: true,
    });
    const pkg = await createPackageCatalogue(gymId, service.id, { sessions: 10 });
    await grantPackageToMember(gymId, memberId, pkg.classPackageId, { sessionsRemaining: 10 });

    const res = await listServices(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('keeps the enabled service when the member also holds a disabled one', async () => {
    const memberId = await createMember(gymId, 'MPS Mixed Availability Member');
    const enabled = await createProfessionalService(gymId, { name: `MPS Enabled ${uniq()}` });
    const disabled = await createProfessionalService(gymId, {
      name: `MPS Disabled ${uniq()}`,
      status: 'inactive',
    });
    const enabledPkg = await createPackageCatalogue(gymId, enabled.id, { sessions: 8 });
    const disabledPkg = await createPackageCatalogue(gymId, disabled.id, { sessions: 9 });
    await grantPackageToMember(gymId, memberId, enabledPkg.classPackageId, { sessionsRemaining: 8 });
    await grantPackageToMember(gymId, memberId, disabledPkg.classPackageId, { sessionsRemaining: 9 });

    const res = await listServices(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ professional_service_id: enabled.id, sessions: 8 });
  });

  it('excludes a package whose Sellable Item is linked to no Professional Service', async () => {
    const memberId = await createMember(gymId, 'MPS Unlinked Item Member');
    const { insertId: classPackageId } = await db.query(
      `INSERT INTO class_packages (gym_id, name, number_of_sessions, price, validity_days, status)
       VALUES (?, ?, 10, 100.00, 365, 'active')`,
      [gymId, `MPS-Unlinked-Package-${uniq()}`],
    );
    await createSessionItem(gymId, { units: 10, classPackageId });
    await grantPackageToMember(gymId, memberId, classPackageId, { sessionsRemaining: 10 });

    const res = await listServices(gymId, memberId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
