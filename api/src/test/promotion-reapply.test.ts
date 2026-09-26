// #635 stage 9 — a Promotion can be taken off an Assigned Plan and put back on.
//
// The issue thread's Q2 answer asks for Promotions that are "selectable and
// deselectable ... letting the staff or member choose what option suit better".
// Stage 7 shipped only the deselect half, because `ump_unique_pair` (migration
// 022) reserved (assignment, Promotion) across every status. Migration 183
// narrows that to the applications that are still *standing*, so a revoked one
// becomes history and a new one can be written beside it.
//
// What is proven here, over the full Express + MySQL stack:
//   1. Revoking and re-applying works, and the re-apply is a **new**
//      application — the spent one keeps its own `applied_at`/`revoked_at` and
//      its own snapshot, because that window is what the Billing Events range
//      reads (#511 stage 3) and that snapshot is what it was agreed with (§16).
//   2. A *standing* application still cannot be applied twice — 409, from the
//      API's check and from the database's own unique key.
//   3. The new application is agreed as the Promotion stands **today**: a
//      Promotion edited between the revoke and the re-apply reprices only the
//      new one, and never the spent one (§13/§16).
//   4. `can_reapply` is the server's answer about the control, not the
//      frontend's: false while something is standing, false for a Promotion
//      that is no longer active or is outside its own window.
//
// Fixtures are inserted directly; the HTTP API is only used for the action
// under test (CLAUDE.md).

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

async function createPlan(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'staff_only', '1')`,
    [gymId, `PRA-Plan-${uniq()}`],
  );
  return insertId;
}

async function createAssignment(gymId: string, planId: number, basePrice = 100): Promise<number> {
  const { insertId: memberId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'PRA Member', `pra-${uniq()}@test.com`],
  );
  const { insertId } = await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price, membership_fee_price)
     VALUES (?, ?, ?, 'active', CURDATE(), ?, ?)`,
    [gymId, memberId, planId, basePrice, basePrice],
  );
  return insertId;
}

async function createPromotion(gymId: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO promotions
       (gym_id, name, description, starts_at, ends_at, lifecycle_status, stackable,
        only_applicable_for_new_members, free_months, paid_months, bonus_months)
     VALUES (?, ?, 'Agreed description', '2020-01-01', '2099-12-31', 'active', 1, 0, 0, 6, 0)`,
    [gymId, name],
  );
  return insertId;
}

async function targetPlan(gymId: string, promotionId: number, planId: number) {
  await db.query(
    'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
    [gymId, promotionId, planId],
  );
}

async function setMembershipFeeBenefit(gymId: string, promotionId: number, action: string, value: number) {
  await db.query(
    `INSERT INTO promotion_membership_fee_benefits
       (gym_id, promotion_id, quantity, frequency_interval, frequency_unit, duration_months, enabled, action, value)
     VALUES (?, ?, 1, 1, 'month', NULL, 1, ?, ?)
     ON DUPLICATE KEY UPDATE action = VALUES(action), value = VALUES(value)`,
    [gymId, promotionId, action, value],
  );
}

const applyPromotion = (gymId: string, umId: number, promotionId: number) =>
  request
    .post(`/user-memberships/${umId}/promotions`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ promotion_id: promotionId });

const revokePromotion = (gymId: string, umId: number, promotionId: number) =>
  request
    .delete(`/user-memberships/${umId}/promotions/${promotionId}`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId);

const listPromotions = (gymId: string, umId: number) =>
  request.get(`/user-memberships/${umId}/promotions`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

/**
 * The fee the assignment's next cycle comes to. #635 stage 15 — nothing is
 * stored, so this asks the API, which resolves the assignment's snapshot against
 * its standing applications.
 */
async function membershipFee(gymId: string, umId: number): Promise<number> {
  const res = await request
    .get(`/user-memberships/${umId}`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId);
  return Number(res.body.membership_fee);
}

/** Every application of one Promotion on one assignment, oldest first. */
async function applicationRows(umId: number, promotionId: number) {
  const { rows } = await db.query<{ id: number; status: string; revoked_at: string | null; snapshot: any }>(
    `SELECT id, status, revoked_at, snapshot FROM user_membership_promotions
     WHERE user_membership_id = ? AND promotion_id = ? ORDER BY id ASC`,
    [umId, promotionId],
  );
  return rows;
}

// ─── Deselect, then select again ──────────────────────────────────────────────

describe('POST /user-memberships/:id/promotions — re-applying a revoked Promotion', () => {
  let gymId: string;
  let planId: number;

  beforeAll(async () => {
    gymId = await createTestGym('PRA Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId);
  });

  it('accepts the Promotion again once it has been revoked', async () => {
    const umId = await createAssignment(gymId, planId);
    const promotionId = await createPromotion(gymId, `Reapply-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);

    expect((await applyPromotion(gymId, umId, promotionId)).status).toBe(201);
    expect((await revokePromotion(gymId, umId, promotionId)).status).toBe(200);
    expect((await applyPromotion(gymId, umId, promotionId)).status).toBe(201);

    const rows = await applicationRows(umId, promotionId);
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('revoked');
    expect(rows[0].revoked_at).toBeTruthy();
    expect(rows[1].status).toBe('applied');
    expect(rows[1].revoked_at).toBeNull();
  });

  it('keeps the spent application as history rather than resurrecting it', async () => {
    const umId = await createAssignment(gymId, planId);
    const promotionId = await createPromotion(gymId, `History-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    await applyPromotion(gymId, umId, promotionId);

    const [before] = await applicationRows(umId, promotionId);
    await revokePromotion(gymId, umId, promotionId);
    await applyPromotion(gymId, umId, promotionId);

    const rows = await applicationRows(umId, promotionId);
    // The original row is untouched apart from its revocation: a re-apply that
    // reused it would rewrite the window the ledger was tagged against.
    expect(rows[0].id).toBe(before.id);
    expect(rows[1].id).not.toBe(before.id);

    const res = await listPromotions(gymId, umId);
    const cards = res.body.filter((r: any) => r.promotion_id === promotionId);
    expect(cards).toHaveLength(2);
    expect(cards.filter((c: any) => c.display_status === 'active')).toHaveLength(1);
    expect(cards.filter((c: any) => c.display_status === 'inactive')).toHaveLength(1);
  });

  it('refuses a second application while one is still standing', async () => {
    const umId = await createAssignment(gymId, planId);
    const promotionId = await createPromotion(gymId, `Standing-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    await applyPromotion(gymId, umId, promotionId);

    const res = await applyPromotion(gymId, umId, promotionId);
    expect(res.status).toBe(409);
    expect(await applicationRows(umId, promotionId)).toHaveLength(1);
  });

  it('lets the database refuse a second standing row on its own', async () => {
    // Migration 183's `ump_one_standing_per_promotion`: the API's check runs
    // inside a transaction that locks the assignment, and this is the backstop
    // under it — two concurrent applies cannot both win.
    const umId = await createAssignment(gymId, planId);
    const promotionId = await createPromotion(gymId, `Backstop-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    await applyPromotion(gymId, umId, promotionId);

    await expect(db.query(
      `INSERT INTO user_membership_promotions (gym_id, user_membership_id, promotion_id, applied_by, status)
       VALUES (?, ?, ?, 'someone', 'applied')`,
      [gymId, umId, promotionId],
    )).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });

  it('stamps applied_at on the same clock revoked_at uses', async () => {
    // The two now bound the same window, several times over per pair: a
    // replacement application's `applied_at` is compared against the
    // `revoked_at` of the one it replaced. Migration 022 defaulted this column
    // to `CURRENT_TIMESTAMP` (the session time zone); migration 183 moves it to
    // `UTC_TIMESTAMP()`, which is what the revoke path stamps.
    const { rows } = await db.query<{ column_default: string | null }>(
      `SELECT COLUMN_DEFAULT AS column_default FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_membership_promotions'
         AND COLUMN_NAME = 'applied_at'`,
    );
    expect(rows[0].column_default ?? '').toMatch(/utc_timestamp/i);
  });

  it('allows a second *revoked* row, which the old unique key forbade', async () => {
    const umId = await createAssignment(gymId, planId);
    const promotionId = await createPromotion(gymId, `Twice-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);

    for (const _round of [1, 2]) {
      expect((await applyPromotion(gymId, umId, promotionId)).status).toBe(201);
      expect((await revokePromotion(gymId, umId, promotionId)).status).toBe(200);
    }
    expect((await applyPromotion(gymId, umId, promotionId)).status).toBe(201);

    const rows = await applicationRows(umId, promotionId);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.status === 'applied')).toHaveLength(1);
  });
});

// ─── What the re-applied agreement is ────────────────────────────────────────

describe('Re-applying agrees the Promotion as it stands today (#635 §16)', () => {
  let gymId: string;
  let planId: number;

  beforeAll(async () => {
    gymId = await createTestGym('PRA Pricing Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId);
  });

  it('snapshots the edited Promotion onto the new application and leaves the spent one alone', async () => {
    const umId = await createAssignment(gymId, planId, 100);
    const promotionId = await createPromotion(gymId, `Edited-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    await setMembershipFeeBenefit(gymId, promotionId, 'fixed_discount', 20);

    await applyPromotion(gymId, umId, promotionId);
    expect(await membershipFee(gymId, umId)).toBeCloseTo(80, 2);
    await revokePromotion(gymId, umId, promotionId);
    expect(await membershipFee(gymId, umId)).toBeCloseTo(100, 2);

    // The Promotion is repriced between the two decisions. §13 keeps that off
    // the existing (spent) application; the new one is a new agreement.
    await setMembershipFeeBenefit(gymId, promotionId, 'fixed_discount', 35);
    await db.query('UPDATE promotions SET description = ? WHERE id = ?', ['Repriced', promotionId]);

    expect((await applyPromotion(gymId, umId, promotionId)).status).toBe(201);
    expect(await membershipFee(gymId, umId)).toBeCloseTo(65, 2);

    const rows = await applicationRows(umId, promotionId);
    const spent = rows[0].snapshot as any;
    const current = rows[1].snapshot as any;
    expect(spent.membership_fee_benefits[0].value).toBeCloseTo(20, 2);
    expect(current.membership_fee_benefits[0].value).toBeCloseTo(35, 2);
    expect(spent.description).toBe('Agreed description');
    expect(current.description).toBe('Repriced');
  });

  it('records the price movement in the ledger, as any apply does', async () => {
    const umId = await createAssignment(gymId, planId, 100);
    const promotionId = await createPromotion(gymId, `Ledger-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    await setMembershipFeeBenefit(gymId, promotionId, 'fixed_discount', 10);

    await applyPromotion(gymId, umId, promotionId);
    await revokePromotion(gymId, umId, promotionId);
    await applyPromotion(gymId, umId, promotionId);

    const { rows } = await db.query<{ notes: string; amount: string }>(
      `SELECT notes, amount FROM billing_events
       WHERE user_membership_id = ? AND event_type = 'adjustment' ORDER BY id ASC`,
      [umId],
    );
    expect(rows.map((r) => r.notes)).toEqual(['Promotion applied', 'Promotion revoked', 'Promotion applied']);
    expect(parseFloat(rows[2].amount)).toBeCloseTo(-10, 2);
    expect(await membershipFee(gymId, umId)).toBeCloseTo(90, 2);
  });

  it('grants the Sellable Items again, snapshotted onto the new application', async () => {
    const umId = await createAssignment(gymId, planId, 100);
    const promotionId = await createPromotion(gymId, `Grants-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    const { insertId: lockerId } = await db.query(
      `INSERT INTO gym_charges
         (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
       VALUES (?, ?, 'service', 10, 'EUR', 'month', 'active', 'available', 0)`,
      [gymId, `Locker-${uniq()}`],
    );
    await db.query(
      'INSERT INTO promotion_periodical (gym_id, promotion_id, gym_charge_id, quantity) VALUES (?, ?, ?, 2)',
      [gymId, promotionId, lockerId],
    );

    await applyPromotion(gymId, umId, promotionId);
    await revokePromotion(gymId, umId, promotionId);
    // The item is repriced in between: the new application freezes the new
    // price, the spent one keeps the agreed one (§17).
    await db.query('UPDATE gym_charges SET amount = 18 WHERE id = ?', [lockerId]);
    await applyPromotion(gymId, umId, promotionId);

    const rows = await applicationRows(umId, promotionId);
    const { rows: snapshots } = await db.query<{ user_membership_promotion_id: number; unit_price: string }>(
      `SELECT user_membership_promotion_id, unit_price FROM user_membership_promotion_periodical_snapshot
       WHERE user_membership_promotion_id IN (?, ?) ORDER BY user_membership_promotion_id ASC`,
      [rows[0].id, rows[1].id],
    );
    expect(snapshots).toHaveLength(2);
    expect(parseFloat(snapshots[0].unit_price)).toBeCloseTo(10, 2);
    expect(parseFloat(snapshots[1].unit_price)).toBeCloseTo(18, 2);
  });
});

// ─── can_reapply: what the card is allowed to offer ──────────────────────────

describe('GET /user-memberships/:id/promotions — can_reapply', () => {
  let gymId: string;
  let planId: number;

  beforeAll(async () => {
    gymId = await createTestGym('PRA Flag Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId);
  });

  async function cardFor(umId: number, promotionId: number, applicationId?: number) {
    const res = await listPromotions(gymId, umId);
    expect(res.status).toBe(200);
    const cards = res.body.filter((r: any) => r.promotion_id === promotionId);
    return applicationId != null ? cards.find((c: any) => c.id === applicationId) : cards[0];
  }

  it('is false while the application is standing', async () => {
    const umId = await createAssignment(gymId, planId);
    const promotionId = await createPromotion(gymId, `FlagStanding-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    await applyPromotion(gymId, umId, promotionId);

    expect((await cardFor(umId, promotionId)).can_reapply).toBe(false);
  });

  it('is true for a revoked application whose Promotion is still live', async () => {
    const umId = await createAssignment(gymId, planId);
    const promotionId = await createPromotion(gymId, `FlagRevoked-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    await applyPromotion(gymId, umId, promotionId);
    await revokePromotion(gymId, umId, promotionId);

    expect((await cardFor(umId, promotionId)).can_reapply).toBe(true);
  });

  it('is false on the spent application once a new one stands in its place', async () => {
    const umId = await createAssignment(gymId, planId);
    const promotionId = await createPromotion(gymId, `FlagReplaced-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    await applyPromotion(gymId, umId, promotionId);
    await revokePromotion(gymId, umId, promotionId);
    await applyPromotion(gymId, umId, promotionId);

    const rows = await applicationRows(umId, promotionId);
    expect((await cardFor(umId, promotionId, rows[0].id)).can_reapply).toBe(false);
    expect((await cardFor(umId, promotionId, rows[1].id)).can_reapply).toBe(false);
  });

  it('is false, and the apply refused, once the Promotion is no longer active', async () => {
    const umId = await createAssignment(gymId, planId);
    const promotionId = await createPromotion(gymId, `FlagInactive-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    await applyPromotion(gymId, umId, promotionId);
    await revokePromotion(gymId, umId, promotionId);
    await db.query("UPDATE promotions SET lifecycle_status = 'inactive' WHERE id = ?", [promotionId]);

    expect((await cardFor(umId, promotionId)).can_reapply).toBe(false);
    expect((await applyPromotion(gymId, umId, promotionId)).status).toBe(400);
  });

  it('is false, and the apply refused, once the Promotion is outside its own window', async () => {
    const umId = await createAssignment(gymId, planId);
    const promotionId = await createPromotion(gymId, `FlagWindow-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    await applyPromotion(gymId, umId, promotionId);
    await revokePromotion(gymId, umId, promotionId);
    // The Promotion's own dates move, not the snapshot's: the agreed window
    // stays where it was, only a *new* agreement is out of reach.
    await db.query("UPDATE promotions SET ends_at = '2020-12-31' WHERE id = ?", [promotionId]);

    expect((await cardFor(umId, promotionId)).can_reapply).toBe(false);
    expect((await applyPromotion(gymId, umId, promotionId)).status).toBe(400);
  });
});

// ─── Tenant isolation and auth ───────────────────────────────────────────────

describe('Re-applying a Promotion — tenant isolation and auth', () => {
  let gymA: string;
  let gymB: string;
  let umA: number;
  let promotionA: number;

  beforeAll(async () => {
    gymA = await createTestGym('PRA Gym A');
    await createTestMembership(gymA, 'admin');
    gymB = await createTestGym('PRA Gym B');
    await createTestMembership(gymB, 'admin');

    const planId = await createPlan(gymA);
    umA = await createAssignment(gymA, planId);
    promotionA = await createPromotion(gymA, `Isolated-${uniq()}`);
    await targetPlan(gymA, promotionA, planId);
    await applyPromotion(gymA, umA, promotionA);
    await revokePromotion(gymA, umA, promotionA);
  });

  it('never re-applies another gym\'s revoked application', async () => {
    const res = await applyPromotion(gymB, umA, promotionA);
    expect(res.status).toBe(404);
    expect(await applicationRows(umA, promotionA)).toHaveLength(1);
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request
      .post(`/user-memberships/${umA}/promotions`)
      .set('x-gym-id', gymA)
      .send({ promotion_id: promotionA });
    expect(res.status).toBe(401);
  });

  it('returns 403 when a read-only role tries to re-apply', async () => {
    const readOnlyGym = await createTestGym('PRA Read Only');
    await createTestMembership(readOnlyGym, 'accountant');
    const planId = await createPlan(readOnlyGym);
    const umId = await createAssignment(readOnlyGym, planId);
    const promotionId = await createPromotion(readOnlyGym, `ReadOnly-${uniq()}`);
    await targetPlan(readOnlyGym, promotionId, planId);
    await db.query(
      `INSERT INTO user_membership_promotions (gym_id, user_membership_id, promotion_id, applied_by, status, revoked_at)
       VALUES (?, ?, ?, 'someone', 'revoked', UTC_TIMESTAMP())`,
      [readOnlyGym, umId, promotionId],
    );

    expect((await applyPromotion(readOnlyGym, umId, promotionId)).status).toBe(403);
    expect(await applicationRows(umId, promotionId)).toHaveLength(1);
  });
});
