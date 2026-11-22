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
// #2880 narrows (1) for a Draft: a Promotion applied to a Draft is a provisional
// reference, so taking it off deletes the reference and putting it back inserts
// one fresh row — no Inactive entry accumulates. The history above is a
// confirmed assignment's; the cases below run on Drafts and assert the Draft rule.
//
// Fixtures are inserted directly; the HTTP API is only used for the action
// under test (CLAUDE.md).

import { TEST_ASSIGNMENTS } from './assignmentReads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { confirmDraftPromotionSnapshots } from '../api/membership-promotions';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  ensureTestProductSet,
  request, legacyChildQuery, createTestDraftAssignment } from './helpers';

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
  // #1863: a Plan Promotion applies (and re-applies) only to a plan added in a
  // Draft, so the assignment is a Draft with its own plan snapshot.
  const insertId = await createTestDraftAssignment(gymId, Number(memberId), planId, { config: { base_price: basePrice } });
  // #1325 PR 3b: an adjustment belongs to the member's ProductSet. Not linked
  // to the assignment: these cases exercise the assignment-keyed apply path.
  await ensureTestProductSet(gymId, memberId);
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
       (gym_id, promotion_id, duration_months, enabled, action, value)
     VALUES (?, ?, NULL, 1, ?, ?)
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
 * What the assignment pays now. #635 stage 15 removed the stored price, so this
 * reads the resolved `membership_fee` the API reports instead of a column.
 */
/** #2833: the Draft's confirmation is what takes the applications' snapshots. */
async function confirmDraft(gymId: string, productSetId: number): Promise<void> {
  await db.transaction((tx) => confirmDraftPromotionSnapshots(tx, gymId, productSetId));
}

async function finalPrice(gymId: string, umId: number): Promise<number> {
  const res = await request.get(`/user-memberships/${umId}`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
  return Number(res.body.membership_fee);
}

/** Every application of one Promotion on one assignment, oldest first. */
async function applicationRows(umId: number, promotionId: number) {
  const { rows } = await legacyChildQuery<{ id: number; status: string; revoked_at: string | null; snapshot: any; product_set_id: number }>(
    `SELECT id, status, revoked_at, snapshot, product_set_id FROM user_membership_promotions
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

    // #2880: the Draft holds its current selection, once.
    const rows = await applicationRows(umId, promotionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('applied');
    expect(rows[0].revoked_at).toBeNull();
  });

  it('leaves no Inactive entry on a Draft after removing and re-applying (#2880)', async () => {
    const umId = await createAssignment(gymId, planId);
    const promotionId = await createPromotion(gymId, `History-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    await applyPromotion(gymId, umId, promotionId);

    const [before] = await applicationRows(umId, promotionId);
    await revokePromotion(gymId, umId, promotionId);
    await applyPromotion(gymId, umId, promotionId);

    const rows = await applicationRows(umId, promotionId);
    // The removed reference was deleted, not kept as revoked; the re-apply is one fresh reference.
    expect(before.status).toBe('applied');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('applied');
    expect(rows[0].snapshot).toBeNull();

    const res = await listPromotions(gymId, umId);
    const cards = res.body.filter((r: any) => r.promotion_id === promotionId);
    expect(cards).toHaveLength(1);
    expect(cards[0].display_status).toBe('active');
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

    // #3026 stage 3d-1: the application is the plan snapshot's row, and so is the backstop
    // (`plan_promotion_snapshots_standing`, UNIQUE since migration 450).
    await expect(db.query(
      `INSERT INTO plan_promotion_snapshots (gym_id, plan_snapshot_id, promotion_id, status)
       SELECT pps.gym_id, pps.plan_snapshot_id, pps.promotion_id, 'applied'
         FROM plan_promotion_snapshots pps JOIN plan_snapshots s ON s.id = pps.plan_snapshot_id
        WHERE pps.gym_id = ? AND s.source_user_membership_id = ? AND pps.promotion_id = ?`,
      [gymId, umId, promotionId],
    )).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });

  it('stamps applied_at on the same clock revoked_at uses', async () => {
    // The two now bound the same window, several times over per pair: a
    // replacement application's `applied_at` is compared against the
    // `revoked_at` of the one it replaced. Migration 022 defaulted this column
    // to `CURRENT_TIMESTAMP` (the session time zone); migration 183 moves it to
    // `UTC_TIMESTAMP()`, which is what the revoke path stamps.
    const { rows } = await db.query<any>(
      `SELECT COLUMN_DEFAULT AS column_default FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'plan_promotion_snapshots'
         AND COLUMN_NAME = 'applied_at'`,
    );
    expect(rows[0].column_default ?? '').toMatch(/utc_timestamp/i);
  });

  it('keeps one row however many times a Draft toggles the Promotion (#2880)', async () => {
    const umId = await createAssignment(gymId, planId);
    const promotionId = await createPromotion(gymId, `Twice-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);

    for (const _round of [1, 2]) {
      expect((await applyPromotion(gymId, umId, promotionId)).status).toBe(201);
      expect((await revokePromotion(gymId, umId, promotionId)).status).toBe(200);
    }
    expect((await applyPromotion(gymId, umId, promotionId)).status).toBe(201);

    const rows = await applicationRows(umId, promotionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('applied');
  });

  it('removing the Promotion leaves nothing on the Draft, and confirmation persists nothing for it (#2880)', async () => {
    const umId = await createAssignment(gymId, planId);
    const promotionId = await createPromotion(gymId, `Removed-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    await applyPromotion(gymId, umId, promotionId);
    const [{ product_set_id: setId }] = await applicationRows(umId, promotionId);
    expect((await revokePromotion(gymId, umId, promotionId)).status).toBe(200);
    expect(await applicationRows(umId, promotionId)).toHaveLength(0);

    await confirmDraft(gymId, Number(setId));
    const { rows } = await legacyChildQuery(
      'SELECT id FROM user_membership_promotions WHERE gym_id = ? AND product_set_id = ? AND promotion_id = ?',
      [gymId, setId, promotionId]);
    expect(rows).toHaveLength(0);
  });

  it('confirmation discards a removed reference left revoked by an earlier toggle (#2880)', async () => {
    const umId = await createAssignment(gymId, planId);
    const kept = await createPromotion(gymId, `Kept-${uniq()}`);
    const dropped = await createPromotion(gymId, `Dropped-${uniq()}`);
    await targetPlan(gymId, kept, planId);
    await targetPlan(gymId, dropped, planId);
    await applyPromotion(gymId, umId, kept);
    await applyPromotion(gymId, umId, dropped);
    const [{ product_set_id: setId }] = await applicationRows(umId, kept);
    // A revoked reference written before removal became a deletion.
    await db.query(
      `UPDATE plan_promotion_snapshots pps
         JOIN product_set_plan_snapshots j ON j.plan_snapshot_id = pps.plan_snapshot_id
          SET pps.status = 'revoked', pps.revoked_at = UTC_TIMESTAMP()
        WHERE pps.gym_id = ? AND j.product_set_id = ? AND pps.promotion_id = ?`,
      [gymId, setId, dropped]);

    await confirmDraft(gymId, Number(setId));
    const { rows } = await legacyChildQuery(
      `SELECT promotion_id, status, snapshot_confirmed_at IS NOT NULL AS confirmed
         FROM user_membership_promotions WHERE gym_id = ? AND product_set_id = ? ORDER BY id`,
      [gymId, setId]);
    expect(rows.map((r) => [Number(r.promotion_id), r.status, Number(r.confirmed)])).toEqual([[kept, 'applied', 1]]);
    // A retried confirmation writes nothing more.
    await confirmDraft(gymId, Number(setId));
    const again = await legacyChildQuery('SELECT id FROM user_membership_promotions WHERE gym_id = ? AND product_set_id = ?', [gymId, setId]);
    expect(again.rows).toHaveLength(1);
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

  it('snapshots the edited Promotion onto the standing application at confirmation (#2833)', async () => {
    const umId = await createAssignment(gymId, planId, 100);
    const promotionId = await createPromotion(gymId, `Edited-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    await setMembershipFeeBenefit(gymId, promotionId, 'fixed_discount', 20);

    await applyPromotion(gymId, umId, promotionId);
    expect(await finalPrice(gymId, umId)).toBeCloseTo(80, 2);
    await revokePromotion(gymId, umId, promotionId);
    expect(await finalPrice(gymId, umId)).toBeCloseTo(100, 2);

    // The Promotion is repriced between the two decisions. §13 keeps that off
    // the existing (spent) application; the new one is a new agreement.
    await setMembershipFeeBenefit(gymId, promotionId, 'fixed_discount', 35);
    await db.query('UPDATE promotions SET description = ? WHERE id = ?', ['Repriced', promotionId]);

    expect((await applyPromotion(gymId, umId, promotionId)).status).toBe(201);
    expect(await finalPrice(gymId, umId)).toBeCloseTo(65, 2);

    // #2833/#2880: on a Draft the one current selection holds no snapshot; the
    // confirmation snapshots it from the Promotion as it is then.
    const draftRows = await applicationRows(umId, promotionId);
    expect(draftRows.map((r) => r.snapshot)).toEqual([null]);
    await confirmDraft(gymId, Number(draftRows[0].product_set_id));
    const rows = await applicationRows(umId, promotionId);
    expect(rows).toHaveLength(1);
    const current = rows[0].snapshot as any;
    expect(current.membership_fee_benefits[0].value).toBeCloseTo(35, 2);
    expect(current.description).toBe('Repriced');
  });

  it('moves the price through the Draft version, writing no ledger adjustment (#1325, #1863)', async () => {
    const umId = await createAssignment(gymId, planId, 100);
    const promotionId = await createPromotion(gymId, `Ledger-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    await setMembershipFeeBenefit(gymId, promotionId, 'fixed_discount', 10);

    await applyPromotion(gymId, umId, promotionId);
    await revokePromotion(gymId, umId, promotionId);
    await applyPromotion(gymId, umId, promotionId);

    // A version's price is resolved from its frozen configuration and its
    // obligations are replaced, so there is no adjustment to record.
    const { rows } = await db.query<{ notes: string }>(
      `SELECT notes FROM billing_events
        WHERE gym_id = ? AND event_type = 'adjustment'
          AND member_id = (SELECT member_id FROM ${TEST_ASSIGNMENTS} um WHERE id = ?)`,
      [gymId, umId],
    );
    expect(rows).toEqual([]);
    expect(await finalPrice(gymId, umId)).toBeCloseTo(90, 2);
  });

  it('grants the Products again, snapshotted onto the new application', async () => {
    const umId = await createAssignment(gymId, planId, 100);
    const promotionId = await createPromotion(gymId, `Grants-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    const { insertId: lockerId } = await db.query(
      `INSERT INTO products
         (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
       VALUES (?, ?, 'service', 10, 'EUR', 'month', 'active', 'available', 0)`,
      [gymId, `Locker-${uniq()}`],
    );
    await db.query(
      'INSERT INTO promotion_periodical (gym_id, promotion_id, product_id, quantity) VALUES (?, ?, ?, 2)',
      [gymId, promotionId, lockerId],
    );

    await applyPromotion(gymId, umId, promotionId);
    await revokePromotion(gymId, umId, promotionId);
    // The item is repriced in between: the confirmation freezes the price it has then.
    await db.query('UPDATE products SET amount = 18 WHERE id = ?', [lockerId]);
    await applyPromotion(gymId, umId, promotionId);

    const rows = await applicationRows(umId, promotionId);
    expect(rows).toHaveLength(1);
    const grantSnapshots = () => legacyChildQuery(
      `SELECT user_membership_promotion_id, unit_price FROM user_membership_promotion_periodical_snapshot
       WHERE user_membership_promotion_id = ? ORDER BY user_membership_promotion_id ASC`,
      [rows[0].id],
    );
    // #2833: a Draft writes no grant snapshot rows; the confirmation writes the
    // standing application's, at the price the item has then.
    expect((await grantSnapshots()).rows).toHaveLength(0);
    await confirmDraft(gymId, Number(rows[0].product_set_id));
    const { rows: snapshots } = await grantSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(Number(snapshots[0].user_membership_promotion_id)).toBe(Number(rows[0].id));
    expect(parseFloat(snapshots[0].unit_price)).toBeCloseTo(18, 2);
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

  it('leaves no card for a Promotion removed from a Draft (#2880)', async () => {
    const umId = await createAssignment(gymId, planId);
    const promotionId = await createPromotion(gymId, `FlagRevoked-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    await applyPromotion(gymId, umId, promotionId);
    await revokePromotion(gymId, umId, promotionId);

    expect(await cardFor(umId, promotionId)).toBeUndefined();
  });

  it('is false, and the apply refused, once the Promotion is no longer active', async () => {
    const umId = await createAssignment(gymId, planId);
    const promotionId = await createPromotion(gymId, `FlagInactive-${uniq()}`);
    await targetPlan(gymId, promotionId, planId);
    await applyPromotion(gymId, umId, promotionId);
    await revokePromotion(gymId, umId, promotionId);
    await db.query("UPDATE promotions SET lifecycle_status = 'inactive' WHERE id = ?", [promotionId]);

    expect(await cardFor(umId, promotionId)).toBeUndefined();
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

    expect(await cardFor(umId, promotionId)).toBeUndefined();
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

  it('never re-applies a Promotion on another gym\'s assignment', async () => {
    const res = await applyPromotion(gymB, umA, promotionA);
    expect(res.status).toBe(404);
    expect(await applicationRows(umA, promotionA)).toHaveLength(0);
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
    await legacyChildQuery(
      `INSERT INTO user_membership_promotions (gym_id, user_membership_id, promotion_id, applied_by, status, revoked_at)
       VALUES (?, ?, ?, 'someone', 'revoked', UTC_TIMESTAMP())`,
      [readOnlyGym, umId, promotionId],
    );

    expect((await applyPromotion(readOnlyGym, umId, promotionId)).status).toBe(403);
    expect(await applicationRows(umId, promotionId)).toHaveLength(1);
  });
});
