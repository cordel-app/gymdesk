// #2657 stage 3 (option A) — the SQL half of `domain/planLineAllocation.ts`: an Individual
// Product line of a Membership Plan is stored once per member.
//
// `syncPlanLineAllocations()` is the one writer that splits a line and keeps the
// catalogue-mandatory lines in step with the plan's beneficiaries (#1187). It runs on every
// Draft write (`touch()` in `product-set-draft.ts`) and when an assignment's Draft is created
// (`createDraftSetForAssignment()`), over the plan snapshots the set owns: a snapshot another
// Product Set links is immutable to this one (#2125 M4b-1), and the writer that edits it owns it
// first, so it is split the moment it becomes this set's own.

import type { Tx } from '../infra/db';
import type { ProductBenefitCategory } from '../domain/productClassification';
import { effectiveUnitAssignees } from '../domain/planUnitAssignees';
import { groupUnitAssignees, reconcileMandatoryMembers } from '../domain/planLineAllocation';
import { PLAN_LINE_CATEGORIES, PLAN_LINE_TABLE, planSnapshotSharedSql } from './plan-snapshot-lines';
import { loadPlanAssigneeContext } from './plan-unit-assignees';

/** Every column a sibling line copies from the line it was split from, besides the id, quantity and member. */
const COPIED_COLUMNS: Record<ProductBenefitCategory, string> = {
  session: 'gym_id, plan_snapshot_id, product_id, item_name, item_type, unit_price, item_billing_frequency, currency, `action`, `value`, mandatory, direct_discount_percent, frequency',
  oneoff: 'gym_id, plan_snapshot_id, product_id, item_name, item_type, unit_price, item_billing_frequency, currency, `action`, `value`, mandatory, direct_discount_percent',
  periodical: 'gym_id, plan_snapshot_id, product_id, item_name, item_type, unit_price, item_billing_frequency, currency, `action`, `value`, mandatory, direct_discount_percent, schedule_id',
};

/** Inserts a line for `memberId` copying every agreed fact of `fromLineId` (never its source_id). */
export async function insertSiblingLine(
  tx: Tx, category: ProductBenefitCategory, fromLineId: number, memberId: number | null, quantity: number,
): Promise<number> {
  const table = PLAN_LINE_TABLE[category];
  const cols = COPIED_COLUMNS[category];
  const { insertId } = await tx.query(
    `INSERT INTO ${table} (${cols}, quantity, assigned_member_id)
     SELECT ${cols}, ?, ? FROM ${table} WHERE id = ?`, [quantity, memberId, fromLineId]);
  return Number(insertId);
}

interface LineRow {
  id: number;
  product_id: number;
  quantity: number;
  unit_assignees: unknown;
  assigned_member_id: number | null;
  sharing_type: string | null;
  catalogue_mandatory: number | null;
}

async function loadLines(tx: Tx, gymId: string, snapshotId: number, category: ProductBenefitCategory): Promise<LineRow[]> {
  const { rows } = await tx.query<LineRow>(
    `SELECT b.id, b.product_id, b.quantity, b.unit_assignees, b.assigned_member_id,
            gc.sharing_type, gc.mandatory AS catalogue_mandatory
       FROM ${PLAN_LINE_TABLE[category]} b
       LEFT JOIN products gc ON gc.id = b.product_id AND gc.gym_id = b.gym_id
      WHERE b.plan_snapshot_id = ? AND b.gym_id = ?
      ORDER BY b.id`, [snapshotId, gymId]);
  return rows.map((r) => ({
    ...r,
    id: Number(r.id),
    product_id: Number(r.product_id),
    quantity: Number(r.quantity),
    assigned_member_id: r.assigned_member_id == null ? null : Number(r.assigned_member_id),
  }));
}

/**
 * Splits every unsplit Individual line of the set's own plan snapshots into one line per member
 * (the units each member holds under the default distribution, or the stored per-unit override),
 * then keeps the catalogue-mandatory lines in step with the beneficiaries (#1187): a Shared one is
 * one line of `max(1, beneficiaries)` units, an Individual one is one unit per beneficiary (the
 * owner when nobody is covered). The first member's line keeps the original line's id, so what
 * refers to the line by id keeps referring to a line of that Product.
 */
export async function syncPlanLineAllocations(tx: Tx, gymId: string, productSetId: number): Promise<void> {
  const { rows: snaps } = await tx.query<{ id: number; n: number }>(
    `SELECT s.id, (SELECT COUNT(*) FROM plan_snapshot_beneficiaries b WHERE b.plan_snapshot_id = s.id AND b.gym_id = s.gym_id) AS n
       FROM product_set_plan_snapshots psj JOIN plan_snapshots s ON s.id = psj.plan_snapshot_id
      WHERE psj.product_set_id = ? AND s.gym_id = ? AND psj.entitlement_only = 0
        AND NOT ${planSnapshotSharedSql('s.id', 'psj.product_set_id')}`,
    [productSetId, gymId]);
  for (const snap of snaps) {
    const snapshotId = Number(snap.id);
    const count = Math.max(1, Number(snap.n ?? 0));
    const ctx = await loadPlanAssigneeContext(tx, gymId, snapshotId);
    if (!ctx) continue;
    const eligibleIds = ctx.eligible.map((e) => e.member_id);
    const target = ctx.beneficiaryIds.length > 0 ? ctx.beneficiaryIds : [ctx.ownerId];
    for (const category of PLAN_LINE_CATEGORIES) {
      const table = PLAN_LINE_TABLE[category];
      let lines = await loadLines(tx, gymId, snapshotId, category);

      // 1. Split.
      for (const line of lines) {
        if (line.assigned_member_id != null || line.sharing_type === 'shared') continue;
        const assignees = effectiveUnitAssignees({
          stored: line.unit_assignees, quantity: line.quantity, sharingType: line.sharing_type,
          ownerId: ctx.ownerId, beneficiaryIds: ctx.beneficiaryIds, eligibleIds,
        }) ?? [];
        const existing = new Map(lines
          .filter((l) => l.product_id === line.product_id && l.assigned_member_id != null && l.id !== line.id)
          .map((l) => [l.assigned_member_id as number, l.id]));
        let reused = false;
        for (const group of groupUnitAssignees(assignees)) {
          const sibling = existing.get(group.memberId);
          if (sibling != null) {
            await tx.query(`UPDATE ${table} SET quantity = quantity + ? WHERE id = ?`, [group.quantity, sibling]);
          } else if (!reused) {
            await tx.query(
              `UPDATE ${table} SET assigned_member_id = ?, quantity = ?, unit_assignees = NULL WHERE id = ?`,
              [group.memberId, group.quantity, line.id]);
            reused = true;
          } else {
            await insertSiblingLine(tx, category, line.id, group.memberId, group.quantity);
          }
        }
        if (!reused) await tx.query(`DELETE FROM ${table} WHERE id = ?`, [line.id]);
      }

      // 2. Catalogue-mandatory lines follow the beneficiaries.
      lines = await loadLines(tx, gymId, snapshotId, category);
      const mandatoryProducts = new Set(lines.filter((l) => Number(l.catalogue_mandatory) === 1).map((l) => l.product_id));
      for (const productId of mandatoryProducts) {
        const ofProduct = lines.filter((l) => l.product_id === productId);
        if (ofProduct[0].sharing_type === 'shared') {
          await tx.query(
            `UPDATE ${table} SET quantity = ? WHERE plan_snapshot_id = ? AND gym_id = ? AND product_id = ? AND quantity <> ?`,
            [count, snapshotId, gymId, productId, count]);
          continue;
        }
        const split = ofProduct.filter((l) => l.assigned_member_id != null);
        if (split.length === 0) continue;
        const { remove, add } = reconcileMandatoryMembers(split.map((l) => l.assigned_member_id as number), target);
        for (const memberId of add) await insertSiblingLine(tx, category, split[0].id, memberId, 1);
        for (const memberId of remove) {
          const line = split.find((l) => l.assigned_member_id === memberId);
          if (line) await tx.query(`DELETE FROM ${table} WHERE id = ?`, [line.id]);
        }
        await tx.query(
          `UPDATE ${table} SET quantity = 1 WHERE plan_snapshot_id = ? AND gym_id = ? AND product_id = ? AND quantity <> 1`,
          [snapshotId, gymId, productId]);
      }
    }
  }
}
