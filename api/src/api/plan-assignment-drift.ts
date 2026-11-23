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

  return { clean: checks.every((c) => c.count === 0), checks };
}
