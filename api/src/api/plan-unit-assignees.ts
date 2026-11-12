// #2609 stage 3 — the SQL half of `domain/planUnitAssignees.ts`: who a plan's Individual
// Product units may go to, what each unit of a line resolves to on read, and the one writer
// of `plan_*_snapshots.unit_assignees`.

import { db, type Tx } from '../infra/db';
import type { ProductBenefitCategory } from '../domain/productClassification';
import {
  effectiveUnitAssignees, parseUnitAssigneesInput, UNIT_ASSIGNEES_MESSAGES,
} from '../domain/planUnitAssignees';
import { loadEligibleAssignees } from './product-assignee';
import { PLAN_LINE_TABLE, planSnapshotOfAssignment } from './plan-snapshot-lines';
import { ownPlanSnapshot } from './plan-snapshot-ownership';
import { touchDraft } from './product-sets';
import { groupUnitAssignees } from '../domain/planLineAllocation';
import { insertSiblingLine } from './plan-line-allocation';
import type { DraftRefusal, LockedDraft } from './product-set-draft';

type Queryable = Pick<Tx, 'query'>;

export interface UnitAssigneeMember { member_id: number; name: string }

export interface PlanAssigneeContext {
  ownerId: number;
  /** The plan's beneficiaries, owner first, then in the order they were covered. */
  beneficiaryIds: number[];
  /** Everyone a unit may go to: the owner, the owner's family and the beneficiaries. */
  eligible: UnitAssigneeMember[];
}

/** Who the units of one plan snapshot may be given to, and the default order. */
export async function loadPlanAssigneeContext(q: Queryable, gymId: string, planSnapshotId: number): Promise<PlanAssigneeContext | null> {
  const { rows: snap } = await q.query<{ member_id: number; owner_name: string }>(
    `SELECT s.member_id, m.name AS owner_name FROM plan_snapshots s JOIN members m ON m.id = s.member_id
      WHERE s.id = ? AND s.gym_id = ?`, [planSnapshotId, gymId]);
  if (!snap[0]) return null;
  const ownerId = Number(snap[0].member_id);
  const { rows: bens } = await q.query<{ member_id: number; name: string }>(
    `SELECT b.member_id, m.name FROM plan_snapshot_beneficiaries b
       JOIN members m ON m.id = b.member_id AND m.deleted_at IS NULL
      WHERE b.plan_snapshot_id = ? AND b.gym_id = ?
      ORDER BY b.is_owner DESC, b.id ASC`, [planSnapshotId, gymId]);
  const family = await loadEligibleAssignees(q, gymId, ownerId);
  const eligible = new Map<number, string>();
  eligible.set(ownerId, snap[0].owner_name);
  for (const f of family) eligible.set(f.member_id, f.name);
  for (const b of bens) eligible.set(Number(b.member_id), b.name);
  return {
    ownerId,
    beneficiaryIds: bens.map((b) => Number(b.member_id)),
    eligible: [...eligible].map(([member_id, name]) => ({ member_id, name })),
  };
}

/**
 * Adds `unit_assignees` to plan lines read from one plan snapshot: the member each unit is
 * for, or `null` for a shared Product. A row needs `plan_snapshot_id`, `quantity`,
 * `unit_assignees` (stored) and `product_sharing_type`.
 */
export async function withUnitAssignees<T extends Record<string, any>>(
  gymId: string, rows: T[], q: Queryable = db,
): Promise<(T & { unit_assignees: UnitAssigneeMember[] | null })[]> {
  const contexts = new Map<number, PlanAssigneeContext | null>();
  const out: (T & { unit_assignees: UnitAssigneeMember[] | null })[] = [];
  for (const row of rows) {
    const snapId = Number(row.plan_snapshot_id);
    if (!contexts.has(snapId)) contexts.set(snapId, await loadPlanAssigneeContext(q, gymId, snapId));
    const ctx = contexts.get(snapId);
    if (!ctx) { out.push({ ...row, unit_assignees: null }); continue; }
    const ids = effectiveUnitAssignees({
      stored: row.unit_assignees, quantity: Number(row.quantity), sharingType: row.product_sharing_type,
      ownerId: ctx.ownerId, beneficiaryIds: ctx.beneficiaryIds, eligibleIds: ctx.eligible.map((e) => e.member_id),
      assignedMemberId: row.assigned_member_id != null ? Number(row.assigned_member_id) : null,
    });
    const names = new Map(ctx.eligible.map((e) => [e.member_id, e.name]));
    // A split line's member may have left the family since; their name is still theirs.
    const missing = (ids ?? []).filter((id) => !names.has(id));
    if (missing.length > 0) {
      const { rows: extra } = await q.query<{ id: number; name: string }>(
        `SELECT id, name FROM members WHERE gym_id = ? AND id IN (${[...new Set(missing)].map(() => '?').join(',')})`,
        [gymId, ...new Set(missing)]);
      for (const m of extra) names.set(Number(m.id), m.name);
    }
    out.push({ ...row, unit_assignees: ids == null ? null : ids.map((id) => ({ member_id: id, name: names.get(id) ?? '' })) });
  }
  return out;
}

/** The members a unit of this assignment's plan may be given to (the selector's options). */
export async function loadAssignmentAssigneeOptions(gymId: string, planSnapshotId: number | null): Promise<UnitAssigneeMember[]> {
  if (planSnapshotId == null) return [];
  return (await loadPlanAssigneeContext(db, gymId, planSnapshotId))?.eligible ?? [];
}

const SECTIONS: ProductBenefitCategory[] = ['session', 'oneoff', 'periodical'];

export function parseSection(raw: unknown): ProductBenefitCategory | null {
  return SECTIONS.includes(raw as ProductBenefitCategory) ? (raw as ProductBenefitCategory) : null;
}

/**
 * The Draft writer: replaces the per-unit distribution of one Individual Product of the
 * plan snapshot that is `userMembershipId`'s contract in this Draft. Owns the snapshot first
 * (#2125 M4b-1), so a snapshot another Product Set links is never written.
 *
 * #2657 stage 3: an Individual Product is held as one line per member, so the distribution is
 * written as those lines: the units are counted over every line of the Product, each member
 * named keeps (or gets) one line with their units — the agreed facts of a new member's line
 * copied from a line of the same Product — and a member no longer named loses theirs.
 */
export async function writeUnitAssignees(
  tx: Tx, draft: LockedDraft, userMembershipId: number,
  input: { section: ProductBenefitCategory; productId: number; assignees: unknown },
): Promise<{ ok: true } | DraftRefusal> {
  const snapshotId = await planSnapshotOfAssignment(tx, draft.gym_id, draft.id, userMembershipId);
  if (snapshotId == null) return { kind: 'invalid', message: 'This version has no Membership Plan to configure' };
  const table = PLAN_LINE_TABLE[input.section];
  const { rows } = await tx.query<{ quantity: number; sharing_type: string | null }>(
    `SELECT b.quantity, gc.sharing_type FROM ${table} b
       LEFT JOIN products gc ON gc.id = b.product_id AND gc.gym_id = b.gym_id
      WHERE b.plan_snapshot_id = ? AND b.gym_id = ? AND b.product_id = ?`,
    [snapshotId, draft.gym_id, input.productId]);
  if (!rows[0]) return { kind: 'invalid', message: 'The plan does not include this Product in that section' };
  const ctx = await loadPlanAssigneeContext(tx, draft.gym_id, snapshotId);
  if (!ctx) return { kind: 'invalid', message: 'This version has no Membership Plan to configure' };
  const total = rows.reduce((sum, r) => sum + Number(r.quantity), 0);
  const parsed = parseUnitAssigneesInput({
    raw: input.assignees, quantity: total, sharingType: rows[0].sharing_type,
    eligibleIds: ctx.eligible.map((e) => e.member_id),
  });
  if (!parsed.ok) return { kind: 'invalid', message: UNIT_ASSIGNEES_MESSAGES[parsed.error] };
  const target = await ownPlanSnapshot(tx, draft.gym_id, draft.id, snapshotId);
  const { rows: lines } = await tx.query<{ id: number; assigned_member_id: number | null }>(
    `SELECT id, assigned_member_id FROM ${table} WHERE plan_snapshot_id = ? AND gym_id = ? AND product_id = ? ORDER BY id`,
    [target, draft.gym_id, input.productId]);
  const byMember = new Map(lines.filter((l) => l.assigned_member_id != null).map((l) => [Number(l.assigned_member_id), Number(l.id)]));
  const unsplit = lines.filter((l) => l.assigned_member_id == null).map((l) => Number(l.id));
  const kept = new Set<number>();
  for (const group of groupUnitAssignees(parsed.assignees)) {
    let lineId = byMember.get(group.memberId);
    if (lineId == null && unsplit.length > 0) {
      lineId = unsplit.shift() as number;
      await tx.query(`UPDATE ${table} SET assigned_member_id = ? WHERE id = ?`, [group.memberId, lineId]);
    }
    if (lineId == null) {
      lineId = await insertSiblingLine(tx, input.section, Number(lines[0].id), group.memberId, group.quantity);
    } else {
      await tx.query(`UPDATE ${table} SET quantity = ?, unit_assignees = NULL WHERE id = ?`, [group.quantity, lineId]);
    }
    kept.add(lineId);
  }
  const dropped = lines.map((l) => Number(l.id)).filter((id) => !kept.has(id));
  if (dropped.length > 0) {
    await tx.query(`DELETE FROM ${table} WHERE id IN (${dropped.map(() => '?').join(',')})`, dropped);
  }
  await touchDraft(tx, draft.gym_id, draft.id);
  return { ok: true };
}
