// #2657 stage 4 — splits the Individual plan lines committed before stage 3 (#2736) into one
// line per member, as the owner asked on #2657: "for existing assignments, migrate or transform
// existing Individual lines so that each Member's allocation is represented independently,
// preserving the existing quantities, discounts, pricing and billing history".
//
// Run by the operator script `npm run plan-lines:split` (`src/scripts/split-committed-plan-lines.ts`),
// a dry run unless `--execute`, never by a migration: the split needs the default unit distribution
// (`effectiveUnitAssignees()`), which is TypeScript, and the scheduled passes must not decide it.
//
// What is split: an unsplit line (`assigned_member_id IS NULL`) of a Product that is not Shared, with
// units, in a plan snapshot an `active` or `pending_payment` Product Set links for billing, and whose
// Product has no member line in that snapshot yet. A Draft's lines are left alone (stage 3 splits
// them when the Draft is committed), and so is a snapshot only history links: its lines were billed
// as they are, and today's beneficiaries say nothing about who held them then.
//
// The split itself is stage 3's `splitPlanLines()`, so the first member keeps the original id and
// every agreed fact (price, treatment, Direct Discount, schedule) is copied onto the other members'
// lines. A Session line carries an allowance, identified by the line's id, so two more things follow
// it in the same transaction:
//   - each allowance renewal (`plan_allowance_renewals`) is shared out over the member lines in
//     proportion to their quantities (`shareUnits()`), a sibling getting its own row for the same
//     date, so each line's grant is its own quantity plus its own renewals and the sum is unchanged;
//   - each holder's unreturned spends (`professional_service_consumptions`, `plan_session`) are
//     moved, oldest staying first, so no line is overspent while another has room
//     (`distributeSpends()`).
// Reservations (`professional_service_reservations`) stay on the original line: the balance is read
// per service, and the spend a reservation becomes at event start is then taken from that line.
//
// Billing does not move: a Product's member lines are billed exactly as the merged line was (stage 3,
// `collectBillableItems()`), and no Billing Event or line references a plan line. A second run finds
// nothing to split.

import { db, type Tx } from '../infra/db';
import type { ProductBenefitCategory } from '../domain/productClassification';
import { distributeSpends, shareUnits } from '../domain/planLineAllocation';
import { PLAN_LINE_CATEGORIES, PLAN_LINE_TABLE } from './plan-snapshot-lines';
import { loadPlanAssigneeContext } from './plan-unit-assignees';
import { memberGroupsOf, splitPlanLines } from './plan-line-allocation';

const SYSTEM_ACTOR = 'System';

export interface CommittedLineSplit {
  /** Plan snapshots holding at least one line to split. */
  snapshots: number;
  /** Lines split (or that would be, on a dry run). */
  lines: number;
  /** Member lines created beside the lines split. */
  member_lines: number;
  /** Allowance renewal rows written for the new member lines. */
  renewals_shared: number;
  /** Spends moved from the original line onto another member's line. */
  spends_moved: number;
  /** Lines left unsplit because no member could be resolved for their units. */
  skipped: number;
}

interface CandidateLine {
  id: number;
  product_id: number;
  quantity: number;
  unit_assignees: unknown;
  sharing_type: string | null;
}

/** The plan snapshots a billing Product Set links that still hold an unsplit Individual line. */
async function candidateSnapshots(gymId: string | null): Promise<Array<{ gym_id: string; plan_snapshot_id: number }>> {
  const arms = PLAN_LINE_CATEGORIES.map((c) => `
    SELECT l.gym_id, l.plan_snapshot_id FROM ${PLAN_LINE_TABLE[c]} l
      LEFT JOIN products p ON p.id = l.product_id AND p.gym_id = l.gym_id
     WHERE ${unsplitLineSql(PLAN_LINE_TABLE[c])}${gymId ? ' AND l.gym_id = ?' : ''}`);
  const { rows } = await db.query<{ gym_id: string; plan_snapshot_id: number }>(
    `SELECT DISTINCT x.gym_id, x.plan_snapshot_id FROM (${arms.join(' UNION ')}) x ORDER BY x.plan_snapshot_id`,
    gymId ? arms.map(() => gymId) : []);
  return rows.map((r) => ({ gym_id: r.gym_id, plan_snapshot_id: Number(r.plan_snapshot_id) }));
}

/** An unsplit, non-Shared line with units, of a billing snapshot, whose Product has no member line. */
function unsplitLineSql(table: string): string {
  return `l.assigned_member_id IS NULL AND l.quantity > 0
      AND (p.sharing_type IS NULL OR p.sharing_type <> 'shared')
      AND EXISTS (SELECT 1 FROM product_set_plan_snapshots psj
                    JOIN product_sets ps ON ps.id = psj.product_set_id
                   WHERE psj.plan_snapshot_id = l.plan_snapshot_id AND psj.entitlement_only = 0
                     AND ps.status IN ('active', 'pending_payment'))
      AND NOT EXISTS (SELECT 1 FROM ${table} m
                       WHERE m.plan_snapshot_id = l.plan_snapshot_id AND m.product_id = l.product_id
                         AND m.assigned_member_id IS NOT NULL)`;
}

async function candidateLines(tx: Tx, gymId: string, snapshotId: number, category: ProductBenefitCategory): Promise<CandidateLine[]> {
  const table = PLAN_LINE_TABLE[category];
  const { rows } = await tx.query<CandidateLine>(
    `SELECT l.id, l.product_id, l.quantity, l.unit_assignees, p.sharing_type
       FROM ${table} l
       LEFT JOIN products p ON p.id = l.product_id AND p.gym_id = l.gym_id
      WHERE l.plan_snapshot_id = ? AND l.gym_id = ? AND ${unsplitLineSql(table)}
      ORDER BY l.id
      FOR UPDATE`, [snapshotId, gymId]);
  return rows.map((r) => ({ ...r, id: Number(r.id), product_id: Number(r.product_id), quantity: Number(r.quantity) }));
}

/** Splits one plan snapshot's committed Individual lines; answers what it did. */
async function splitSnapshot(tx: Tx, gymId: string, snapshotId: number, out: CommittedLineSplit, log: (line: string) => void): Promise<boolean> {
  const ctx = await loadPlanAssigneeContext(tx, gymId, snapshotId);
  if (!ctx) return false;
  let touched = false;
  for (const category of PLAN_LINE_CATEGORIES) {
    const table = PLAN_LINE_TABLE[category];
    for (const line of await candidateLines(tx, gymId, snapshotId, category)) {
      const groups = memberGroupsOf(line, ctx);
      if (groups.length === 0) {
        out.skipped++;
        log(`skip ${category} line #${line.id} (snapshot ${snapshotId}): no member for its units`);
        continue;
      }
      await splitPlanLines(tx, gymId, snapshotId, category, ctx, new Set([line.product_id]));
      const { rows: after } = await tx.query<{ id: number; assigned_member_id: number; quantity: number }>(
        `SELECT id, assigned_member_id, quantity FROM ${table}
          WHERE plan_snapshot_id = ? AND gym_id = ? AND product_id = ? AND assigned_member_id IS NOT NULL`,
        [snapshotId, gymId, line.product_id]);
      const byMember = new Map(after.map((r) => [Number(r.assigned_member_id), { id: Number(r.id), quantity: Number(r.quantity) }]));
      // In group order: the first member's line is the original one.
      const memberLines = groups.map((g) => byMember.get(g.memberId)).filter((l): l is { id: number; quantity: number } => l != null);
      if (memberLines[0]?.id !== line.id) throw new Error(`split of ${category} line #${line.id} did not keep its id`);
      out.lines++;
      out.member_lines += memberLines.length - 1;
      touched = true;
      log(`split ${category} line #${line.id} (snapshot ${snapshotId}, product ${line.product_id}, quantity ${line.quantity}) into ` +
        groups.map((g) => `member ${g.memberId} × ${g.quantity}`).join(', '));
      if (category === 'session' && memberLines.length > 1) {
        await followAllowance(tx, gymId, line.id, memberLines, out);
      }
    }
  }
  return touched;
}

/** Shares a split Session line's renewals and moves each holder's spends across its member lines. */
async function followAllowance(
  tx: Tx, gymId: string, originalId: number, memberLines: Array<{ id: number; quantity: number }>, out: CommittedLineSplit,
): Promise<void> {
  const weights = memberLines.map((l) => l.quantity);
  const renewed = memberLines.map(() => 0);
  const { rows: renewals } = await tx.query<{ id: number; renewal_date: string; quantity: number }>(
    `SELECT id, DATE_FORMAT(renewal_date, '%Y-%m-%d') AS renewal_date, quantity
       FROM plan_allowance_renewals WHERE plan_session_snapshot_id = ? AND gym_id = ? ORDER BY renewal_date FOR UPDATE`,
    [originalId, gymId]);
  for (const r of renewals) {
    const shares = shareUnits(Number(r.quantity), weights);
    if (shares[0] > 0) {
      await tx.query('UPDATE plan_allowance_renewals SET quantity = ? WHERE id = ?', [shares[0], r.id]);
    } else {
      await tx.query('DELETE FROM plan_allowance_renewals WHERE id = ?', [r.id]);
    }
    renewed[0] += shares[0];
    for (let i = 1; i < memberLines.length; i++) {
      if (shares[i] <= 0) continue;
      await tx.query(
        `INSERT INTO plan_allowance_renewals (gym_id, plan_session_snapshot_id, renewal_date, quantity, created_by)
         VALUES (?, ?, ?, ?, ?)`, [gymId, memberLines[i].id, r.renewal_date, shares[i], SYSTEM_ACTOR]);
      renewed[i] += shares[i];
      out.renewals_shared++;
    }
  }

  const capacities = memberLines.map((l, i) => l.quantity + renewed[i]);
  const { rows: spends } = await tx.query<{ id: number; member_id: number }>(
    `SELECT id, member_id FROM professional_service_consumptions
      WHERE gym_id = ? AND source_kind = 'plan_session' AND source_reference_id = ? AND returned_at IS NULL
      ORDER BY id FOR UPDATE`, [gymId, originalId]);
  const byHolder = new Map<number, number[]>();
  for (const s of spends) {
    const holder = Number(s.member_id);
    byHolder.set(holder, [...(byHolder.get(holder) ?? []), Number(s.id)]);
  }
  for (const ids of byHolder.values()) {
    const counts = distributeSpends(ids.length, capacities);
    // The oldest spends stay on the original line, the newer ones fill the other lines in order.
    let at = counts[0];
    for (let i = 1; i < memberLines.length; i++) {
      const move = ids.slice(at, at + counts[i]);
      at += counts[i];
      if (move.length === 0) continue;
      await tx.query(
        `UPDATE professional_service_consumptions SET source_reference_id = ?
          WHERE id IN (${move.map(() => '?').join(', ')})`, [memberLines[i].id, ...move]);
      out.spends_moved += move.length;
    }
  }
}

/** Splits every committed Individual plan line still held unsplit (of one gym with `gymId`), one snapshot per transaction. */
export async function splitCommittedPlanLines(
  opts: { execute: boolean; gymId?: string | null; log?: (line: string) => void } = { execute: false },
): Promise<CommittedLineSplit> {
  const log = opts.log ?? (() => {});
  const out: CommittedLineSplit = { snapshots: 0, lines: 0, member_lines: 0, renewals_shared: 0, spends_moved: 0, skipped: 0 };
  const ROLLBACK = Symbol('dry-run');
  for (const snap of await candidateSnapshots(opts.gymId ?? null)) {
    try {
      await db.transaction(async (tx: Tx) => {
        // The snapshot's beneficiaries decide the default distribution; hold them still.
        await tx.query('SELECT id FROM plan_snapshots WHERE id = ? AND gym_id = ? FOR UPDATE', [snap.plan_snapshot_id, snap.gym_id]);
        if (await splitSnapshot(tx, snap.gym_id, snap.plan_snapshot_id, out, log)) out.snapshots++;
        if (!opts.execute) throw ROLLBACK;
      });
    } catch (err) {
      if (err !== ROLLBACK) throw err;
    }
  }
  return out;
}
