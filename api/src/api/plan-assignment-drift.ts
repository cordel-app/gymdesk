/**
 * #2125 M6b-1 — the read-only consistency check of Membership Plan assignments. An assignment is its
 * plan snapshots (migration 458 dropped `user_memberships`): its id is its anchor snapshot's own
 * (#2125 N1, migration 461), and the anchor carries its identity and lifecycle.
 *
 * It writes nothing and decides nothing: each check is one SELECT that lists the inconsistent rows.
 * `npm run plan-assignments:validate` prints it and exits 1 while any check has rows.
 *
 * It checks identity and the re-keyed links; the lifecycle has a single record, so nothing to compare.
 */

import { primaryPlanSnapshotSql } from './plan-snapshot-lines';

type Exec = { query: <T = any>(sql: string, params?: any[]) => Promise<{ rows: T[] }> };

export interface DriftCheck {
  name: string;
  description: string;
  count: number;
  /** The first rows, for a person to look at; `count` is the whole number. */
  sample: Array<Record<string, unknown>>;
}

export interface DriftReport { clean: boolean; checks: DriftCheck[] }

const SAMPLE_SIZE = 20;

/**
 * #2125 N2 — an assignment's anchor is the snapshot whose id is the assignment's id and that anchors
 * itself; `anchor_plan_snapshot_id` names it on every snapshot of the assignment. The derived table of every
 * anchor, used by the checks below.
 */
const ANCHORS_SQL = `(SELECT gym_id, id AS anchor_id FROM plan_snapshots WHERE anchor_plan_snapshot_id = id)`;

/** `a` and `b` name the two sides; NULL-safe, and a DATETIME is compared to the second. */
const differs = (a: string, b: string) => `NOT (${a} <=> ${b})`;

export async function findPlanAssignmentDrift(exec: Exec, gymId?: string): Promise<DriftReport> {
  const scope = (alias: string) => (gymId ? ` AND ${alias}.gym_id = ?` : '');
  const params = gymId ? [gymId] : [];
  const checks: DriftCheck[] = [];
  const add = async (name: string, description: string, sql: string, p: unknown[] = params) => {
    const { rows } = await exec.query<Record<string, unknown>>(sql, p as any[]);
    checks.push({ name, description, count: rows.length, sample: rows.slice(0, SAMPLE_SIZE) });
  };

  // #2125 N2: `anchor_plan_snapshot_id` is the only record of a snapshot's assignment (migration 462 dropped
  // its legacy twin column); NULL means the snapshot names none (an unconfirmed Draft's), so the
  // one identity check left is that a named snapshot points at a snapshot that anchors itself.
  await add('assignment_identity_split',
    'A plan snapshot whose anchor_plan_snapshot_id names a snapshot that is not an anchor.',
    `SELECT s.id AS plan_snapshot_id, s.gym_id, s.anchor_plan_snapshot_id
       FROM plan_snapshots s
       LEFT JOIN ${ANCHORS_SQL} a ON a.gym_id = s.gym_id AND a.anchor_id = s.anchor_plan_snapshot_id
      WHERE s.anchor_plan_snapshot_id IS NOT NULL AND a.anchor_id IS NULL${scope('s')} ORDER BY s.id`);

  // #2125 M6b-51d-7b: the lifecycle, start date, purchase time, replacement and modifier are no longer
  // written on `user_memberships` (the anchor and the plan snapshots are their only record), so the
  // three checks that compared them with the legacy row (`lifecycle_mismatch`, `modifier_mismatch`,
  // `assignment_lifecycle_mismatch`) are retired.

  // #2125 N3a: a payment request names its assignment by `anchor_plan_snapshot_id` alone (migration
  // 463), which must be an anchor of the request's own gym.
  await add('payment_request_assignment_mismatch',
    'A payment request whose anchor_plan_snapshot_id is not an assignment anchor of its gym.',
    `SELECT pr.id AS payment_request_id, pr.gym_id, pr.anchor_plan_snapshot_id
       FROM payment_requests pr
       LEFT JOIN ${ANCHORS_SQL} a ON a.gym_id = pr.gym_id AND a.anchor_id = pr.anchor_plan_snapshot_id
      WHERE pr.anchor_plan_snapshot_id IS NOT NULL AND a.anchor_id IS NULL${scope('pr')}
      ORDER BY pr.id`);

  // #2125 M6b-36 / M6b-46: a Product Set's link (migration 432) is the anchor of the assignment it
  // names. Since migration 441 dropped `product_sets.user_membership_id`, the check is that the link
  // is the anchor of the legacy assignment the snapshot it points at names.
  await add('product_set_assignment_mismatch',
    'A Product Set whose plan_assignment_id is not the anchor of the assignment it names.',
    `SELECT ps.id AS product_set_id, ps.gym_id, ps.status, ps.plan_assignment_id,
            a.anchor_id AS expected_plan_assignment_id
       FROM product_sets ps
       JOIN plan_snapshots cur ON cur.id = ps.plan_assignment_id
       LEFT JOIN ${ANCHORS_SQL} a ON a.gym_id = cur.gym_id AND a.anchor_id = cur.anchor_plan_snapshot_id
      WHERE cur.anchor_plan_snapshot_id IS NULL OR NOT (ps.plan_assignment_id <=> a.anchor_id)${scope('ps')}
      ORDER BY ps.id`);

  // #2125 N3d — an assignment's identity is its anchor, and every anchor stands for one assignment
  // that is really there. Three ways that can fail, none reachable through the writers:
  //
  // An anchor with no lifecycle: `seedAnchorLifecycle()` gives every new anchor its status, and
  // `lockAssignmentRecord()` reads a NULL status as "no such assignment", so such an anchor names an
  // id every writer refuses.
  await add('anchor_without_lifecycle',
    'An assignment anchor (anchor_plan_snapshot_id = id) whose assignment_status is NULL.',
    `SELECT s.id AS anchor_id, s.gym_id, s.member_id, s.membership_plan_id
       FROM plan_snapshots s
      WHERE s.anchor_plan_snapshot_id = s.id AND s.assignment_status IS NULL${scope('s')}
      ORDER BY s.id`);

  // A confirmed plan with no identity: the projection opens or continues an assignment on the
  // primary plan of every Active Product Set holding a plan (`projectActiveProductSet()`), so that
  // snapshot always names an anchor. One that names none is a running plan no assignment answers for.
  await add('active_plan_without_anchor',
    'An Active Product Set holding a plan whose primary plan snapshot names no assignment anchor.',
    `SELECT ps.id AS product_set_id, ps.gym_id, ps.owner_member_id, ps.membership_plan_id,
            ${primaryPlanSnapshotSql('ps.id', 'ps.gym_id')} AS primary_plan_snapshot_id
       FROM product_sets ps
      WHERE ps.status = 'active' AND ps.membership_plan_id IS NOT NULL${scope('ps')}
        AND NOT EXISTS (
          SELECT 1 FROM plan_snapshots s
           WHERE s.id = ${primaryPlanSnapshotSql('ps.id', 'ps.gym_id')}
             AND s.anchor_plan_snapshot_id IS NOT NULL)
      ORDER BY ps.id`);

  // A cancelled Draft leaves no identity: discarding a Draft deletes the snapshots only its set
  // linked (`deleteProductSetAndOwnPlanSnapshots()` → `deleteUnlinkedPlanSnapshots()`), its anchor
  // with them. An assignment none of whose snapshots any Product Set links is that leftover: an id
  // the Admin can still address with no version behind it. A confirmed assignment is never one,
  // since the sets it was billed through (superseded included) keep linking its snapshots.
  await add('orphan_assignment_identity',
    'An assignment anchor none of whose plan snapshots any Product Set links.',
    `SELECT a.id AS anchor_id, a.gym_id, a.member_id, a.assignment_status
       FROM plan_snapshots a
      WHERE a.anchor_plan_snapshot_id = a.id${scope('a')}
        AND NOT EXISTS (
          SELECT 1 FROM plan_snapshots s
            JOIN product_set_plan_snapshots j ON j.plan_snapshot_id = s.id
           WHERE s.anchor_plan_snapshot_id = a.id)
      ORDER BY a.id`);

  return { clean: checks.every((c) => c.count === 0), checks };
}
