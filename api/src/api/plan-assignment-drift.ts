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
 * #2125 M8 — the anchor of an assignment as `anchorsOf()` (`plan-assignment-sync.ts`) decides it: the
 * snapshot already anchoring it, else the lowest snapshot naming it. Used inside a GROUP BY per assignment id.
 */
const ANCHOR_ID_SQL = 'COALESCE(MIN(CASE WHEN assignment_id = id THEN id END), MIN(id))';

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

  await add('snapshot_without_assignment_id',
    'A plan snapshot with no assignment identity.',
    `SELECT s.id AS plan_snapshot_id, s.gym_id FROM plan_snapshots s
      WHERE s.assignment_id IS NULL${scope('s')} ORDER BY s.id`);

  await add('assignment_identity_split',
    'A plan snapshot whose assignment_id is not the anchor of its assignment id.',
    `SELECT s.id AS plan_snapshot_id, s.gym_id, s.source_user_membership_id AS user_membership_id,
            s.assignment_id, a.anchor_id AS expected_assignment_id
       FROM plan_snapshots s
       JOIN (SELECT gym_id, source_user_membership_id AS um_id, ${ANCHOR_ID_SQL} AS anchor_id
               FROM plan_snapshots WHERE source_user_membership_id IS NOT NULL
              GROUP BY gym_id, source_user_membership_id) a
         ON a.gym_id = s.gym_id AND a.um_id = s.source_user_membership_id
      WHERE NOT (s.assignment_id <=> a.anchor_id)${scope('s')} ORDER BY s.id`);

  await add('assignment_id_names_two_assignments',
    'One assignment_id carried by snapshots that name different assignment ids.',
    `SELECT s.assignment_id, s.gym_id, COUNT(DISTINCT s.source_user_membership_id) AS assignments
       FROM plan_snapshots s
      WHERE s.assignment_id IS NOT NULL AND s.source_user_membership_id IS NOT NULL${scope('s')}
      GROUP BY s.assignment_id, s.gym_id HAVING COUNT(DISTINCT s.source_user_membership_id) > 1
      ORDER BY s.assignment_id`);

  // #2125 N1: an assignment's id is its anchor's own (migration 461 dropped the `plan_assignment_ids`
  // registry), so a snapshot naming an id other than its anchor's is drift.
  await add('assignment_id_is_not_anchor_id',
    'A plan snapshot naming an assignment id other than its own anchor snapshot id.',
    `SELECT s.id AS plan_snapshot_id, s.gym_id, s.source_user_membership_id AS user_membership_id, s.assignment_id
       FROM plan_snapshots s
      WHERE s.source_user_membership_id IS NOT NULL${scope('s')}
        AND NOT (s.source_user_membership_id <=> s.assignment_id)
      ORDER BY s.id`);

  // #2125 M6b-51d-7b: the lifecycle, start date, purchase time, replacement and modifier are no longer
  // written on `user_memberships` (the anchor and the plan snapshots are their only record), so the
  // three checks that compared them with the legacy row (`lifecycle_mismatch`, `modifier_mismatch`,
  // `assignment_lifecycle_mismatch`) are retired.

  // #2125 M6b-34: a payment request's re-keyed assignment (migration 431), by the same rule.
  await add('payment_request_assignment_mismatch',
    'A payment request whose plan_assignment_id is not the anchor of its user_membership_id.',
    `SELECT pr.id AS payment_request_id, pr.gym_id, pr.user_membership_id, pr.plan_assignment_id,
            a.anchor_id AS expected_plan_assignment_id
       FROM payment_requests pr
       LEFT JOIN (SELECT gym_id, source_user_membership_id AS um_id, ${ANCHOR_ID_SQL} AS anchor_id
                    FROM plan_snapshots WHERE source_user_membership_id IS NOT NULL
                   GROUP BY gym_id, source_user_membership_id) a
              ON a.gym_id = pr.gym_id AND a.um_id = pr.user_membership_id
      WHERE NOT (pr.plan_assignment_id <=> a.anchor_id)${scope('pr')}
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
       LEFT JOIN (SELECT gym_id, source_user_membership_id AS um_id, ${ANCHOR_ID_SQL} AS anchor_id
                    FROM plan_snapshots WHERE source_user_membership_id IS NOT NULL
                   GROUP BY gym_id, source_user_membership_id) a
              ON a.gym_id = cur.gym_id AND a.um_id = cur.source_user_membership_id
      WHERE cur.source_user_membership_id IS NULL OR NOT (ps.plan_assignment_id <=> a.anchor_id)${scope('ps')}
      ORDER BY ps.id`);

  return { clean: checks.every((c) => c.count === 0), checks };
}
