import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { createDraft } from '../api/product-sets';
import { snapshotProductSetFromPlan } from '../api/product-set-configuration';
import { applyPromotionToProductSet } from '../api/membership-promotions';
import { primaryPlanSnapshotId } from '../api/plan-snapshot-lines';

// #3026 stage 1: "already applied" is read from the plan snapshot being edited
// (`plan_promotion_snapshots`), not from the Product Set's legacy applications.
let gymId: string;
let planId: number;
let promoId: number;
let strictId: number;
const TODAY = new Date().toISOString().slice(0, 10);
const actor = { name: 'T', type: 'staff' };

beforeAll(async () => {
  gymId = await createTestGym();
  const { insertId: plan } = await db.query(
    'INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status) VALUES (?, ?, ?, ?)', [gymId, `P-${Date.now()}`, 'active', 'public']);
  planId = plan;
  const { insertId: m } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'M', `scope-${Date.now()}@example.com`]);
  const { insertId: promo } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
                             only_applicable_for_new_members, paid_months, applies_to)
     VALUES (?, ?, '2020-01-01', '2099-12-31', 'active', 1, 0, 12, 'membership_plan')`, [gymId, `Promo-${Date.now()}`]);
  promoId = promo;
  await db.query('INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
    [gymId, promoId, planId]);
  const { insertId: strict } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
                             only_applicable_for_new_members, paid_months, applies_to)
     VALUES (?, ?, '2020-01-01', '2099-12-31', 'active', 0, 0, 12, 'membership_plan')`, [gymId, `Strict-${Date.now()}`]);
  strictId = strict;
  await db.query('INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
    [gymId, strictId, planId]);
  (globalThis as any).__owner = m;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('Plan Promotion duplicate check is scoped to the edited plan snapshot', () => {
  it('refuses a duplicate on the same snapshot, and reads stacking from the snapshot', async () => {
    const owner = (globalThis as any).__owner as number;
    await db.transaction(async (tx) => {
      const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: TODAY, actor });
      if (d.kind !== 'created') throw new Error(d.kind);
      const setId = d.productSet.id;
      await snapshotProductSetFromPlan(tx, { gymId, productSetId: setId, membershipPlanId: planId, membershipFeePrice: 30, startsAt: TODAY });
      await applyPromotionToProductSet(tx, gymId, 'T', setId, promoId);
      await expect(applyPromotionToProductSet(tx, gymId, 'T', setId, promoId)).rejects.toMatchObject({ status: 409 });

      const snap = await primaryPlanSnapshotId(tx, gymId, setId);
      await tx.query('DELETE FROM plan_promotion_snapshots WHERE plan_snapshot_id = ?', [snap]);
      // The snapshot holds nothing, so a non-stackable Promotion has nothing to conflict with.
      await expect(applyPromotionToProductSet(tx, gymId, 'T', setId, strictId)).resolves.toBeTruthy();
    });
  });
});
