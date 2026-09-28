// Integration tests for the Nutrition Dashboard router (#809).
//
// GET /nutrition/dashboard/nutrition-plans returns one card per Nutrition Plan
// Template that at least one *active member* holds an *active* Nutrition Plan
// from, plus one bucket card for the plans created from scratch
// (`member_nutrition_plans.template_id IS NULL`).
//
// The query is driven by the assignments rather than by the Templates, so every
// case below is about which assignments produce a card and how many members
// each card counts.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { invalidateFeatureFlagsCache } from '../infra/featureFlags';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

const PATH = '/nutrition/dashboard/nutrition-plans';

let gymId: string;

interface NutritionPlanCard {
  template_id: number | null;
  name: string | null;
  status: string | null;
  active_members: number;
}

type TemplateStatus = 'active' | 'inactive' | 'draft' | 'deleted';
type PlanStatus = 'active' | 'completed' | 'deleted';
type EnrollmentStatus = 'active' | 'paused' | 'cancelled' | 'expired';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

// Cordel base templates (`nutrition_plan_templates.gym_id IS NULL`) belong to no
// gym, so `cleanupTestGyms()` — which cascades from the gyms it created — never
// reaches them. Every one created here is tracked and deleted explicitly.
const baseTemplateIds: number[] = [];

/** A gym-owned Nutrition Plan Template. */
async function createTemplate(
  gym: string,
  name: string,
  status: TemplateStatus = 'active',
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO nutrition_plan_templates (gym_id, name, status) VALUES (?, ?, ?)`,
    [gym, name, status],
  );
  return insertId;
}

/** A Cordel base Template — `gym_id IS NULL`, assignable by any gym (migration 105). */
async function createBaseTemplate(name: string, status: TemplateStatus = 'active'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO nutrition_plan_templates (gym_id, name, status) VALUES (NULL, ?, ?)`,
    [name, status],
  );
  baseTemplateIds.push(insertId);
  return insertId;
}

async function createMember(gym: string, name = 'ND Test Member'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)`,
    [gym, name, `nd-${unique()}@test.com`],
  );
  return insertId;
}

/** A Membership Plan — only needed because `user_memberships.membership_plan_id` points at one. */
async function createMembershipPlan(gym: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'staff_only', '1')`,
    [gym, `ND Plan ${unique()}`],
  );
  return insertId;
}

const membershipPlanByGym = new Map<string, Promise<number>>();

function membershipPlanFor(gym: string): Promise<number> {
  const existing = membershipPlanByGym.get(gym);
  if (existing) return existing;
  const created = createMembershipPlan(gym);
  membershipPlanByGym.set(gym, created);
  return created;
}

/**
 * Enrolls a member: mirrors what POST /user-memberships writes (the membership
 * row plus the owner row). `createdAt` is settable because the dashboard reads
 * the member's *latest* `user_memberships` row — `created_at DESC, id DESC`.
 */
async function enroll(
  gym: string,
  memberId: number,
  status: EnrollmentStatus = 'active',
  createdAt: string | null = null,
): Promise<number> {
  const planId = await membershipPlanFor(gym);
  const { insertId } = await db.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, status, starts_at, base_price, created_at)
     VALUES (?, ?, ?, ?, CURDATE(), 29.99, COALESCE(?, UTC_TIMESTAMP()))`,
    [gym, memberId, planId, status, createdAt],
  );
  await db.query(
    'INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, 1)',
    [gym, insertId, memberId],
  );
  return insertId;
}

/** A member with an `active` latest enrollment — the only kind the dashboard counts. */
async function createActiveMember(gym: string, name = 'ND Active Member'): Promise<number> {
  const memberId = await createMember(gym, name);
  await enroll(gym, memberId, 'active');
  return memberId;
}

/** A Nutrition Plan assigned to a member; `templateId` null = the no-template bucket. */
async function assignNutritionPlan(
  gym: string,
  memberId: number,
  templateId: number | null,
  status: PlanStatus = 'active',
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO member_nutrition_plans (gym_id, member_id, template_id, name, status)
     VALUES (?, ?, ?, ?, ?)`,
    [gym, memberId, templateId, `ND Nutrition Plan ${unique()}`, status],
  );
  return insertId;
}

const get = (gym: string) =>
  request.get(PATH).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

async function cards(gym: string): Promise<NutritionPlanCard[]> {
  const res = await get(gym);
  expect(res.status).toBe(200);
  return res.body as NutritionPlanCard[];
}

beforeAll(async () => {
  gymId = await createTestGym('Nutrition Dashboard Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  // Gym-owned rows first: `member_nutrition_plans.template_id` is ON DELETE SET
  // NULL, so the base templates can only go once nothing is pointing at them.
  await cleanupTestGyms();
  if (baseTemplateIds.length > 0) {
    const marks = baseTemplateIds.map(() => '?').join(',');
    await db.query(`DELETE FROM nutrition_plan_templates WHERE id IN (${marks})`, baseTemplateIds);
  }
  await db.end();
});

describe('GET /nutrition/dashboard/nutrition-plans — auth', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get(PATH);
    expect(res.status).toBe(401);
  });

  it('returns 403 when the user has no membership in the requested gym', async () => {
    const otherGym = await createTestGym('ND No Membership Gym');
    const res = await get(otherGym);
    expect(res.status).toBe(403);
  });

  // `member` is R_OWN on NUTRITION — its data comes from /me/*, never from an
  // admin route, so requireModuleAccess refuses it.
  it('returns 403 for a role without NUTRITION access', async () => {
    const memberGym = await createTestGym('ND Member Role Gym');
    await createTestMembership(memberGym, 'member');
    const res = await get(memberGym);
    expect(res.status).toBe(403);
  });

  // The Dashboard is a read, so read-only NUTRITION is enough — front desk is
  // 'R' in the matrix and must be able to open it.
  it('returns 200 for a read-only NUTRITION role', async () => {
    const frontDeskGym = await createTestGym('ND Front Desk Gym');
    await createTestMembership(frontDeskGym, 'front_desk');
    const res = await get(frontDeskGym);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// The Dashboard is deliberately mounted on the `nutrition` group flag rather
// than `nutrition.nutrition_plans` — turning the Nutrition Plans page off must
// not take the Dashboard with it. Superadmins bypass flags, so the caller here
// is a gym admin.
describe('GET /nutrition/dashboard/nutrition-plans — feature flags', () => {
  const FLAGS = ['nutrition', 'nutrition.nutrition_plans'];
  let originalFlags: Record<string, number> = {};

  beforeAll(async () => {
    const { rows } = await db.query<{ feature_key: string; enabled: number }>(
      `SELECT feature_key, enabled FROM feature_flags WHERE feature_key IN (${FLAGS.map(() => '?').join(',')})`,
      FLAGS,
    );
    originalFlags = Object.fromEntries(rows.map((r) => [r.feature_key, r.enabled]));
  });

  afterEach(async () => {
    for (const [key, enabled] of Object.entries(originalFlags)) {
      await db.query('UPDATE feature_flags SET enabled = ? WHERE feature_key = ?', [enabled, key]);
    }
    invalidateFeatureFlagsCache();
  });

  async function setFlag(key: string, enabled: boolean) {
    await db.query('UPDATE feature_flags SET enabled = ? WHERE feature_key = ?', [enabled ? 1 : 0, key]);
    invalidateFeatureFlagsCache();
  }

  // Without this, a renamed flag would make the two cases below pass vacuously.
  it('has both flags seeded', () => {
    expect(Object.keys(originalFlags).sort()).toEqual([...FLAGS].sort());
  });

  it('still serves the Dashboard when the Nutrition Plans page is switched off', async () => {
    await setFlag('nutrition.nutrition_plans', false);
    expect((await get(gymId)).status).toBe(200);
  });

  it('is blocked by the Nutrition group flag', async () => {
    await setFlag('nutrition', false);
    expect((await get(gymId)).status).toBe(403);
  });
});

describe('GET /nutrition/dashboard/nutrition-plans — tenant isolation', () => {
  it("never returns another gym's templates or counts its assignments", async () => {
    const gymA = await createTestGym('ND Isolation A');
    await createTestMembership(gymA, 'admin');
    const gymB = await createTestGym('ND Isolation B');
    await createTestMembership(gymB, 'admin');

    const templateA = await createTemplate(gymA, 'ND Isolation Template A');
    const templateB = await createTemplate(gymB, 'ND Isolation Template B');
    await assignNutritionPlan(gymA, await createActiveMember(gymA), templateA);
    await assignNutritionPlan(gymB, await createActiveMember(gymB), templateB);

    const fromA = await cards(gymA);
    expect(fromA).toHaveLength(1);
    expect(fromA[0]).toMatchObject({ template_id: templateA, active_members: 1 });

    const fromB = await cards(gymB);
    expect(fromB).toHaveLength(1);
    expect(fromB[0]).toMatchObject({ template_id: templateB, active_members: 1 });
  });

  // Template ids are globally unique and `member_nutrition_plans.template_id`
  // has no gym guard of its own, so only the join's
  // `npt.gym_id = mnp.gym_id OR npt.gym_id IS NULL` stops another gym's
  // Template *name* from being read off this endpoint. Such a plan resolves to
  // no Template and falls into the bucket.
  it("does not resolve a plan pointing at another gym's template", async () => {
    const gymA = await createTestGym('ND Cross Template A');
    await createTestMembership(gymA, 'admin');
    const gymB = await createTestGym('ND Cross Template B');
    const foreignTemplate = await createTemplate(gymB, 'ND Foreign Template');
    await assignNutritionPlan(gymA, await createActiveMember(gymA), foreignTemplate);

    const list = await cards(gymA);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({ template_id: null, name: null, status: null, active_members: 1 });
  });

  // The `mnp.gym_id = ?` filter is what keeps a stray assignment row stored
  // under another gym's id out of this gym's counts.
  it("ignores an assignment row stored under another gym's id", async () => {
    const gymA = await createTestGym('ND Cross Assignment A');
    await createTestMembership(gymA, 'admin');
    const gymB = await createTestGym('ND Cross Assignment B');
    const templateA = await createTemplate(gymA, 'ND Cross Assignment Template');
    await assignNutritionPlan(gymA, await createActiveMember(gymA), templateA);
    // Same template, but the assignment (and its member) belong to gym B.
    await assignNutritionPlan(gymB, await createActiveMember(gymB), templateA);

    const list = await cards(gymA);
    expect(list).toHaveLength(1);
    expect(list[0].active_members).toBe(1);
  });
});

describe('GET /nutrition/dashboard/nutrition-plans — which cards are shown', () => {
  it('shows a template that at least one counted member holds a plan from', async () => {
    const gym = await createTestGym('ND Visibility Gym 1');
    await createTestMembership(gym, 'admin');
    const templateId = await createTemplate(gym, 'ND Held Template');
    await assignNutritionPlan(gym, await createActiveMember(gym), templateId);

    const list = await cards(gym);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      template_id: templateId,
      name: 'ND Held Template',
      status: 'active',
      active_members: 1,
    });
  });

  // The query is driven by the assignments, so a Template nobody holds produces
  // no row at all — not a `0` card. An empty card is the thing #809 §4 does not
  // want on the overview.
  it('produces no card at all for a template with no counted members', async () => {
    const gym = await createTestGym('ND Visibility Gym 2');
    await createTestMembership(gym, 'admin');
    await createTemplate(gym, 'ND Unassigned Template');

    expect(await cards(gym)).toHaveLength(0);
  });

  // The Template's own status is never the filter (§7): it is reported, not
  // applied. An `inactive` or `draft` Template with an active member on it is
  // still part of what the gym is currently delivering.
  it('shows an inactive and a draft template that active members hold plans from', async () => {
    const gym = await createTestGym('ND Visibility Gym 3');
    await createTestMembership(gym, 'admin');
    const inactiveId = await createTemplate(gym, 'ND Alpha Inactive', 'inactive');
    const draftId = await createTemplate(gym, 'ND Beta Draft', 'draft');
    await assignNutritionPlan(gym, await createActiveMember(gym), inactiveId);
    await assignNutritionPlan(gym, await createActiveMember(gym), draftId);

    const list = await cards(gym);
    expect(list).toHaveLength(2);
    expect(list).toEqual([
      { template_id: inactiveId, name: 'ND Alpha Inactive', status: 'inactive', active_members: 1 },
      { template_id: draftId, name: 'ND Beta Draft', status: 'draft', active_members: 1 },
    ]);
  });

  // Dropping the card of a soft-deleted Template would silently remove the
  // members who still hold plans from it, so it keeps its card and reports
  // `deleted` as the status the badge shows.
  it('keeps the card of a soft-deleted template whose members still hold plans', async () => {
    const gym = await createTestGym('ND Visibility Gym 4');
    await createTestMembership(gym, 'admin');
    const templateId = await createTemplate(gym, 'ND Retired Template');
    await assignNutritionPlan(gym, await createActiveMember(gym), templateId);
    await db.query(
      "UPDATE nutrition_plan_templates SET status = 'deleted', deleted_at = UTC_TIMESTAMP() WHERE id = ?",
      [templateId],
    );

    const list = await cards(gym);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      template_id: templateId,
      name: 'ND Retired Template',
      status: 'deleted',
      active_members: 1,
    });
  });

  // A Cordel base Template (`gym_id IS NULL`) is assignable by every gym, so it
  // gets its own card in the gym that assigned from it — it must not collapse
  // into the no-template bucket.
  it('shows a Cordel base template the gym assigned from as its own card', async () => {
    const gym = await createTestGym('ND Visibility Gym 5');
    await createTestMembership(gym, 'admin');
    const baseId = await createBaseTemplate(`ND Base Template ${unique()}`);
    await assignNutritionPlan(gym, await createActiveMember(gym), baseId);

    const list = await cards(gym);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ template_id: baseId, status: 'active', active_members: 1 });
    expect(list[0].name).toMatch(/^ND Base Template /);
  });
});

describe('GET /nutrition/dashboard/nutrition-plans — the no-template bucket', () => {
  // Plans built from scratch have no Template to name, so they are one card the
  // frontend labels ("No base nutrition template plan") rather than one card
  // each.
  it('collapses every template-less plan into a single null card', async () => {
    const gym = await createTestGym('ND Bucket Gym 1');
    await createTestMembership(gym, 'admin');
    await assignNutritionPlan(gym, await createActiveMember(gym), null);
    await assignNutritionPlan(gym, await createActiveMember(gym), null);

    const list = await cards(gym);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({ template_id: null, name: null, status: null, active_members: 2 });
  });

  it('orders the bucket last, after the named template cards, which are ordered by name', async () => {
    const gym = await createTestGym('ND Bucket Gym 2');
    await createTestMembership(gym, 'admin');
    const zeta = await createTemplate(gym, 'ND Zeta');
    const alpha = await createTemplate(gym, 'ND Alpha');
    await assignNutritionPlan(gym, await createActiveMember(gym), zeta);
    await assignNutritionPlan(gym, await createActiveMember(gym), alpha);
    await assignNutritionPlan(gym, await createActiveMember(gym), null);

    const list = await cards(gym);
    expect(list.map((c) => c.template_id)).toEqual([alpha, zeta, null]);
    expect(list.map((c) => c.name)).toEqual(['ND Alpha', 'ND Zeta', null]);
  });
});

describe('GET /nutrition/dashboard/nutrition-plans — counting active members', () => {
  // A `completed` plan is no longer currently assigned (§3) and a `deleted` one
  // is gone from every other Nutrition screen, so neither belongs in a count of
  // what the gym is delivering today.
  it('counts only active nutrition plans, not completed or deleted ones', async () => {
    const gym = await createTestGym('ND Counting Gym 1');
    await createTestMembership(gym, 'admin');
    const templateId = await createTemplate(gym, 'ND Plan Status Template');
    await assignNutritionPlan(gym, await createActiveMember(gym), templateId, 'active');
    await assignNutritionPlan(gym, await createActiveMember(gym), templateId, 'completed');
    await assignNutritionPlan(gym, await createActiveMember(gym), templateId, 'deleted');

    const list = await cards(gym);
    expect(list).toHaveLength(1);
    expect(list[0].active_members).toBe(1);
  });

  // "Active member" is the Members page's `enrollment_status = 'active'`, so a
  // card's count and a filter on that page have to agree.
  it('counts only members whose enrollment is active', async () => {
    const gym = await createTestGym('ND Counting Gym 2');
    await createTestMembership(gym, 'admin');
    const templateId = await createTemplate(gym, 'ND Enrollment Template');

    const active = await createMember(gym, 'ND Enrolled');
    await enroll(gym, active, 'active');
    await assignNutritionPlan(gym, active, templateId);

    for (const status of ['paused', 'cancelled', 'expired'] as const) {
      const memberId = await createMember(gym, `ND ${status}`);
      await enroll(gym, memberId, status);
      await assignNutritionPlan(gym, memberId, templateId);
    }

    const list = await cards(gym);
    expect(list).toHaveLength(1);
    expect(list[0].active_members).toBe(1);
  });

  // No `user_memberships` row means no enrollment status at all — the subquery
  // is NULL, which `= 'active'` is not.
  it('does not count a member with no membership row at all', async () => {
    const gym = await createTestGym('ND Counting Gym 3');
    await createTestMembership(gym, 'admin');
    const templateId = await createTemplate(gym, 'ND Never Enrolled Template');
    await assignNutritionPlan(gym, await createMember(gym, 'ND Never Enrolled'), templateId);

    expect(await cards(gym)).toHaveLength(0);
  });

  // The *latest* row decides, not "has any active row": an older `active` row
  // plus a newer `cancelled` one is a member who has left.
  it("takes the member's latest membership row, not any active one", async () => {
    const gym = await createTestGym('ND Counting Gym 4');
    await createTestMembership(gym, 'admin');
    const templateId = await createTemplate(gym, 'ND Latest Row Template');
    const memberId = await createMember(gym, 'ND Left The Gym');
    await enroll(gym, memberId, 'active', '2024-01-01 00:00:00');
    await enroll(gym, memberId, 'cancelled', '2025-01-01 00:00:00');
    await assignNutritionPlan(gym, memberId, templateId);

    expect(await cards(gym)).toHaveLength(0);
  });

  // ...and the mirror image, so the case above cannot pass because *no* row is
  // ever read: the same two rows in the other order do count.
  it('counts a member whose latest membership row is the active one', async () => {
    const gym = await createTestGym('ND Counting Gym 5');
    await createTestMembership(gym, 'admin');
    const templateId = await createTemplate(gym, 'ND Rejoined Template');
    const memberId = await createMember(gym, 'ND Rejoined');
    await enroll(gym, memberId, 'cancelled', '2024-01-01 00:00:00');
    await enroll(gym, memberId, 'active', '2025-01-01 00:00:00');
    await assignNutritionPlan(gym, memberId, templateId);

    const list = await cards(gym);
    expect(list).toHaveLength(1);
    expect(list[0].active_members).toBe(1);
  });

  it('does not count a soft-deleted member', async () => {
    const gym = await createTestGym('ND Counting Gym 6');
    await createTestMembership(gym, 'admin');
    const templateId = await createTemplate(gym, 'ND Deleted Member Template');
    const memberId = await createActiveMember(gym, 'ND Deleted Member');
    await assignNutritionPlan(gym, memberId, templateId);
    await db.query('UPDATE members SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [memberId]);

    expect(await cards(gym)).toHaveLength(0);
  });

  // The card's label is "Active members", so the count is
  // COUNT(DISTINCT member_id): two active plans from the same Template are one
  // member, not two.
  it('counts a member holding two active plans from the same template once', async () => {
    const gym = await createTestGym('ND Counting Gym 7');
    await createTestMembership(gym, 'admin');
    const templateId = await createTemplate(gym, 'ND Two Plans Template');
    const memberId = await createActiveMember(gym, 'ND Two Plans');
    await assignNutritionPlan(gym, memberId, templateId);
    await assignNutritionPlan(gym, memberId, templateId);
    await assignNutritionPlan(gym, await createActiveMember(gym), templateId);

    const list = await cards(gym);
    expect(list).toHaveLength(1);
    expect(list[0].active_members).toBe(2);
  });

  it('returns active_members as a number, not a string', async () => {
    const gym = await createTestGym('ND Counting Gym 8');
    await createTestMembership(gym, 'admin');
    const templateId = await createTemplate(gym, 'ND Numeric Count Template');
    await assignNutritionPlan(gym, await createActiveMember(gym), templateId);

    const list = await cards(gym);
    expect(typeof list[0].active_members).toBe('number');
  });
});
