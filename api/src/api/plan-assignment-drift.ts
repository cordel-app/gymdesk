/**
 * #2125 M6b-1 — the read-only comparison of the two records of a Membership Plan assignment while
 * both exist: the `user_memberships` row (still the source of truth) and the plan snapshot that is
 * its contract (`assignmentPlanSnapshotId()`), which takes over in M6b-4.
 *
 * It writes nothing and decides nothing: each check is one SELECT that lists the rows on which the
 * two sides disagree. `npm run plan-assignments:validate` prints it and exits 1 while any check has
 * rows; dropping `user_memberships` (M6b-4) requires it to be clean.
 *
 * `lifecycle_mismatch` reports `shared = 1` when the snapshot is linked by more than one Product
 * Set. Such a snapshot is immutable to the sync, so a status or date that moved on the assignment
 * has not reached it. Since M6b-2 the Active set gets a copy for such a change
 * (`settleSharedPlanLifecycle()`), so what is left under `shared = 1` is history (a superseded set's
 * snapshot) or a change made before that stage (`npm run plan-assignments:settle`).
 */
import { assignmentPlanSnapshotId } from './assignment-config';
import { assignmentModifierSql } from '../domain/planAssignments';

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

/** `a` and `b` name the two sides; NULL-safe, and a DATETIME is compared to the second. */
const differs = (a: string, b: string) => `NOT (${a} <=> ${b})`;

const LIFECYCLE_FIELDS: Array<{ field: string; um: string; snap: string }> = [
  { field: 'status', um: 'um.status', snap: 'cfg.status' },
  { field: 'member_id', um: 'um.member_id', snap: 'cfg.member_id' },
  { field: 'membership_plan_id', um: 'um.membership_plan_id', snap: 'cfg.membership_plan_id' },
  { field: 'starts_at', um: 'um.starts_at', snap: 'cfg.starts_at' },
  { field: 'ends_at', um: 'um.ends_at', snap: 'cfg.ends_at' },
  { field: 'closed_at', um: 'um.closed_at', snap: 'cfg.closed_at' },
  { field: 'purchased_at', um: 'um.purchased_at', snap: 'cfg.purchased_at' },
  { field: 'replace_on_activation', um: 'um.replace_on_activation', snap: 'cfg.replace_on_activation' },
  { field: 'deleted_at', um: 'um.deleted_at', snap: 'cfg.deleted_at' },
  {
    field: 'replaces_assignment_id',
    um: `(SELECT MIN(r.id) FROM plan_snapshots r
           WHERE r.gym_id = um.gym_id AND r.source_user_membership_id = um.replaces_user_membership_id)`,
    snap: 'cfg.replaces_assignment_id',
  },
];

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
    'A plan snapshot whose assignment_id is not the first snapshot naming its user_memberships row.',
    `SELECT s.id AS plan_snapshot_id, s.gym_id, s.source_user_membership_id AS user_membership_id,
            s.assignment_id, a.anchor_id AS expected_assignment_id
       FROM plan_snapshots s
       JOIN (SELECT gym_id, source_user_membership_id AS um_id, MIN(id) AS anchor_id
               FROM plan_snapshots WHERE source_user_membership_id IS NOT NULL
              GROUP BY gym_id, source_user_membership_id) a
         ON a.gym_id = s.gym_id AND a.um_id = s.source_user_membership_id
      WHERE NOT (s.assignment_id <=> a.anchor_id)${scope('s')} ORDER BY s.id`);

  await add('assignment_id_names_two_assignments',
    'One assignment_id carried by snapshots that name different user_memberships rows.',
    `SELECT s.assignment_id, s.gym_id, COUNT(DISTINCT s.source_user_membership_id) AS user_memberships
       FROM plan_snapshots s
      WHERE s.assignment_id IS NOT NULL AND s.source_user_membership_id IS NOT NULL${scope('s')}
      GROUP BY s.assignment_id, s.gym_id HAVING COUNT(DISTINCT s.source_user_membership_id) > 1
      ORDER BY s.assignment_id`);

  await add('assignment_without_snapshot',
    'A user_memberships row no plan snapshot names.',
    `SELECT um.id AS user_membership_id, um.gym_id, um.status FROM user_memberships um
      WHERE NOT EXISTS (SELECT 1 FROM plan_snapshots s
                         WHERE s.source_user_membership_id = um.id AND s.gym_id = um.gym_id)${scope('um')}
      ORDER BY um.id`);

  await add('snapshot_names_missing_assignment',
    'A plan snapshot naming a user_memberships row that does not exist.',
    `SELECT s.id AS plan_snapshot_id, s.gym_id, s.source_user_membership_id AS user_membership_id
       FROM plan_snapshots s
      WHERE s.source_user_membership_id IS NOT NULL${scope('s')}
        AND NOT EXISTS (SELECT 1 FROM user_memberships um
                         WHERE um.id = s.source_user_membership_id AND um.gym_id = s.gym_id)
      ORDER BY s.id`);

  const anyDiffers = LIFECYCLE_FIELDS.map((f) => differs(f.um, f.snap)).join(' OR ');
  const fieldList = `CONCAT_WS(',', ${LIFECYCLE_FIELDS.map((f) => `IF(${differs(f.um, f.snap)}, '${f.field}', NULL)`).join(', ')})`;
  await add('lifecycle_mismatch',
    'An assignment whose current plan snapshot holds a different lifecycle value (fields lists which).',
    `SELECT um.id AS user_membership_id, um.gym_id, cfg.id AS plan_snapshot_id, cfg.assignment_id,
            ${fieldList} AS fields, um.status AS assignment_status, cfg.status AS snapshot_status,
            ((SELECT COUNT(DISTINCT sh.product_set_id) FROM product_set_plan_snapshots sh
               WHERE sh.plan_snapshot_id = cfg.id) > 1) AS shared
       FROM user_memberships um
       JOIN plan_snapshots cfg ON cfg.id = ${assignmentPlanSnapshotId('um.id', 'um.gym_id')}
      WHERE (${anyDiffers})${scope('um')}
      ORDER BY um.id`);

  // #2125 M6b-31: the Member card's plan history reports the latest modifier across the
  // assignment's snapshots (`assignmentModifierSql()`), so that is what is compared, never one
  // snapshot's own pair (a shared snapshot keeps the modifier it was written with).
  await add('modifier_mismatch',
    'An assignment whose latest snapshot modifier differs from the user_memberships row.',
    `SELECT um.id AS user_membership_id, um.gym_id, pa.assignment_id,
            um.modified_by AS assignment_modified_by, ${assignmentModifierSql('modified_by')} AS snapshot_modified_by
       FROM user_memberships um
       JOIN plan_snapshots pa ON pa.id = (SELECT MIN(x.id) FROM plan_snapshots x
                                           WHERE x.source_user_membership_id = um.id AND x.gym_id = um.gym_id)
      WHERE (${differs('um.modified_at', assignmentModifierSql('modified_at'))}
             OR ${differs('um.modified_by', assignmentModifierSql('modified_by'))})${scope('um')}
      ORDER BY um.id`);

  // #2125 M6b-51c-4: the assignment's lifecycle on its anchor snapshot (migration 452).
  await add('assignment_lifecycle_mismatch',
    'An assignment whose anchor snapshot holds a different status, closed time, end date or modifier.',
    `SELECT um.id AS user_membership_id, um.gym_id, a.id AS anchor_id,
            um.status AS assignment_status, a.assignment_status AS anchor_status
       FROM user_memberships um
       JOIN plan_snapshots a ON a.id = (SELECT MIN(x.id) FROM plan_snapshots x
                                         WHERE x.source_user_membership_id = um.id AND x.gym_id = um.gym_id)
      WHERE (${differs('um.status', 'a.assignment_status')} OR ${differs('um.closed_at', 'a.assignment_closed_at')}
             OR ${differs('um.ends_at', 'a.assignment_ends_at')} OR ${differs('um.modified_at', 'a.assignment_modified_at')}
             OR ${differs('um.modified_by', 'a.assignment_modified_by')})${scope('um')}
      ORDER BY um.id`);

  // #2125 M6b-34: a payment request's re-keyed assignment (migration 431), by the same rule.
  await add('payment_request_assignment_mismatch',
    'A payment request whose plan_assignment_id is not the anchor of its user_membership_id.',
    `SELECT pr.id AS payment_request_id, pr.gym_id, pr.user_membership_id, pr.plan_assignment_id,
            a.anchor_id AS expected_plan_assignment_id
       FROM payment_requests pr
       LEFT JOIN (SELECT gym_id, source_user_membership_id AS um_id, MIN(id) AS anchor_id
                    FROM plan_snapshots WHERE source_user_membership_id IS NOT NULL
                   GROUP BY gym_id, source_user_membership_id) a
              ON a.gym_id = pr.gym_id AND a.um_id = pr.user_membership_id
      WHERE NOT (pr.plan_assignment_id <=> a.anchor_id)${scope('pr')}
      ORDER BY pr.id`);

  // #2125 M6b-36 / M6b-46: a Product Set's link (migration 432) is the anchor of the assignment it
  // names. Since migration 441 dropped `product_sets.user_membership_id`, the check is that the link
  // is the lowest snapshot naming the same legacy assignment as the snapshot it points at.
  await add('product_set_assignment_mismatch',
    'A Product Set whose plan_assignment_id is not the anchor (lowest snapshot) of the assignment it names.',
    `SELECT ps.id AS product_set_id, ps.gym_id, ps.status, ps.plan_assignment_id,
            a.anchor_id AS expected_plan_assignment_id
       FROM product_sets ps
       JOIN plan_snapshots cur ON cur.id = ps.plan_assignment_id
       LEFT JOIN (SELECT gym_id, source_user_membership_id AS um_id, MIN(id) AS anchor_id
                    FROM plan_snapshots WHERE source_user_membership_id IS NOT NULL
                   GROUP BY gym_id, source_user_membership_id) a
              ON a.gym_id = cur.gym_id AND a.um_id = cur.source_user_membership_id
      WHERE cur.source_user_membership_id IS NULL OR NOT (ps.plan_assignment_id <=> a.anchor_id)${scope('ps')}
      ORDER BY ps.id`);

  return { clean: checks.every((c) => c.count === 0), checks };
}
