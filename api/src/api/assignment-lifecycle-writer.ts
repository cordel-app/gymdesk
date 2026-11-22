/**
 * #2125 M6b-51d-1 — also the one place a `user_memberships` row is created (`insertAssignment()`),
 * under an id allocated by the `plan_assignment_ids` registry rather than by the table itself, so the
 * assignment's public id survives the table.
 *
 * #2125 M6b-51c-3 — the one writer of an assignment's lifecycle (status, `closed_at`, `ends_at`, the
 * modifier). Callers describe the change and this module spells the statement. Since M6b-51d-7b it
 * writes the anchor snapshot only; the `user_memberships` row is created (`insertAssignment()`) and
 * deleted (`deleteDraftAssignments()`) here and never updated. Nothing here decides a transition: each
 * caller keeps its own guard (the `from` statuses below), its audit row and its snapshot sync.
 */
import type { Tx } from '../infra/db';

type Exec = { query: Tx['query'] };

export interface AssignmentLifecycleChange {
  /** The new status; absent leaves it as it is. */
  status?: string | null;
  /** Only a row whose current status is one of these is written. */
  from?: string | readonly string[];
  /** Never a row whose current status is one of these. */
  notFrom?: readonly string[];
  /** `keep_or_now`: stamp now where none is stored; `now`: stamp now; `clear`: NULL. */
  closedAt?: 'keep_or_now' | 'now' | 'clear';
  /** A date (or NULL) to store; `today_if_null`: today where none is stored; `clear`: NULL. */
  endsAt?: { set: string | null } | 'today_if_null' | 'clear';
  /** Only a row with no end date is written. */
  onlyIfEndsAtNull?: boolean;
  /** Who made the change. `undefined` (and `touch: false`) leaves `modified_at`/`modified_by` alone. */
  actor?: string | null;
  touch?: boolean;
}

/** The lifecycle columns a change may write, on the assignment's anchor snapshot (M6b-51c-4). */
type Column = 'status' | 'closed_at' | 'ends_at' | 'modified_at' | 'modified_by';
const ANCHOR = (c: Column) => `assignment_${c}`;

/** The SET list of a change, with `now`/`today` bound once. */
function setList(change: AssignmentLifecycleChange, clock: { now: string; today: string }): { sets: string[]; params: unknown[] } {
  const sets: string[] = [];
  const params: unknown[] = [];
  const ends = ANCHOR('ends_at');
  if (change.endsAt === 'today_if_null') { sets.push(`${ends} = COALESCE(${ends}, ?)`); params.push(clock.today); }
  else if (change.endsAt === 'clear') sets.push(`${ends} = NULL`);
  else if (change.endsAt) { sets.push(`${ends} = ?`); params.push(change.endsAt.set); }
  if (change.status != null) { sets.push(`${ANCHOR('status')} = ?`); params.push(change.status); }
  const closed = ANCHOR('closed_at');
  if (change.closedAt === 'keep_or_now') { sets.push(`${closed} = COALESCE(${closed}, ?)`); params.push(clock.now); }
  else if (change.closedAt === 'now') { sets.push(`${closed} = ?`); params.push(clock.now); }
  else if (change.closedAt === 'clear') sets.push(`${closed} = NULL`);
  if (change.touch !== false && change.actor !== undefined) {
    sets.push(`${ANCHOR('modified_at')} = ?`, `${ANCHOR('modified_by')} = ?`);
    params.push(clock.now, change.actor);
  }
  return { sets, params };
}

/**
 * Writes one assignment's change on its anchor snapshot; answers 1, or 0 when a guard refused it or
 * no anchor states the assignment.
 *
 * M6b-51c-4 put the lifecycle on the anchor (`assignment_status`, `assignment_closed_at`,
 * `assignment_ends_at`, `assignment_modified_*`); M6b-51d-6 judged the guards (`from`, `notFrom`,
 * `onlyIfEndsAtNull`) there. Since M6b-51d-7b the anchor is the only record written: the
 * `user_memberships` row keeps the values it was created with and nothing reads them. The start date,
 * the purchase time and the replacement are the plan snapshot's and have their own writers
 * (`writeDraftAssignmentDates()`, `writeAssignmentPurchasedAt()`, `writeAssignmentReplacement()`).
 */
export async function writeAssignmentLifecycle(
  exec: Exec, gymId: string, userMembershipId: number, change: AssignmentLifecycleChange,
): Promise<number> {
  const { rows: clockRows } = await exec.query<{ now: string; today: string }>(
    `SELECT DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:%s') AS now, DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') AS today`);
  const clock = { now: String(clockRows[0].now), today: String(clockRows[0].today) };
  const { sets, params } = setList(change, clock);
  if (sets.length === 0) return 0;
  const from = change.from == null ? [] : (typeof change.from === 'string' ? [change.from] : [...change.from]);

  const { rows: anchors } = await exec.query<{ status: string | null; ends_at: unknown }>(
    `SELECT assignment_status AS status, assignment_ends_at AS ends_at FROM plan_snapshots
      WHERE gym_id = ? AND source_user_membership_id = ? AND assignment_id = id`,
    [gymId, userMembershipId]);
  const anchor = anchors[0];
  if (!anchor || anchor.status == null) return 0;
  if (!anchorPasses(String(anchor.status), anchor.ends_at, change, from)) return 0;
  await exec.query(
    `UPDATE plan_snapshots SET ${sets.join(', ')}
      WHERE gym_id = ? AND source_user_membership_id = ? AND assignment_id = id`,
    [...params, gymId, userMembershipId]);
  return 1;
}

/** The change's guards, judged on the anchor's lifecycle (pure). */
export function anchorPasses(
  status: string, endsAt: unknown, change: Pick<AssignmentLifecycleChange, 'notFrom' | 'onlyIfEndsAtNull'>,
  from: readonly string[],
): boolean {
  if (from.length > 0 && !from.includes(status)) return false;
  if (change.notFrom && change.notFrom.includes(status)) return false;
  if (change.onlyIfEndsAtNull && endsAt != null) return false;
  return true;
}

/** What a new assignment is created with; everything else starts NULL or at its column default. */
export interface NewAssignment {
  gymId: string;
  memberId: number;
  membershipPlanId: number;
  startsAt: string | Date;
  endsAt?: string | Date | null;
  status: string;
  /** The plan a Replace cancels (`assign-new-plan`, #2125 stage 20). */
  replacesUserMembershipId?: number | null;
  purchasedAt?: string | Date | null;
  createdBy: string | null;
}

/**
 * Allocates an assignment id (M6b-51d-1, migration 455): one row of `plan_assignment_ids` per id ever
 * handed out, so `user_memberships` allocates nothing and its retirement keeps every id unique.
 */
export async function allocateAssignmentId(exec: Exec, gymId: string): Promise<number> {
  const { insertId } = await exec.query('INSERT INTO plan_assignment_ids (gym_id) VALUES (?)', [gymId]);
  const id = Number(insertId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Assignment id allocation returned no id');
  return id;
}

/** Creates an assignment under a registry id and answers that id. Decides nothing about the row. */
export async function insertAssignment(exec: Exec, a: NewAssignment): Promise<number> {
  const id = await allocateAssignmentId(exec, a.gymId);
  await exec.query(
    `INSERT INTO user_memberships
       (id, gym_id, member_id, membership_plan_id, starts_at, ends_at, status,
        replaces_user_membership_id, purchased_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, a.gymId, a.memberId, a.membershipPlanId, a.startsAt, a.endsAt ?? null, a.status,
      a.replacesUserMembershipId ?? null, a.purchasedAt ?? null, a.createdBy]);
  return id;
}

/**
 * #2125 M6b-51d-3 — the one place a `user_memberships` row is deleted: a Draft (`in_cart`) assignment
 * discarded with its version, which billed nothing. Any other status is left alone, so a caller that
 * names a committed assignment by mistake deletes nothing. Decides nothing about the assignment: the
 * callers lock it (its anchor snapshot) and delete its version themselves. Answers the rows deleted.
 */
export async function deleteDraftAssignments(exec: Exec, gymId: string, ids: readonly number[]): Promise<number> {
  const keep = ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
  if (keep.length === 0) return 0;
  // M6b-51d-7b: the row's own status is the one it was created with; the anchor says whether it is
  // still a Draft. A caller that discarded the Draft's version first has deleted the anchor with it,
  // and then only a row created in the cart may go.
  const { rowCount } = await exec.query(
    `DELETE FROM user_memberships
      WHERE gym_id = ? AND id IN (${keep.map(() => '?').join(',')})
        AND IF(EXISTS (SELECT 1 FROM plan_snapshots a
                        WHERE a.gym_id = user_memberships.gym_id AND a.source_user_membership_id = user_memberships.id
                          AND a.assignment_id = a.id),
               EXISTS (SELECT 1 FROM plan_snapshots a
                        WHERE a.gym_id = user_memberships.gym_id AND a.source_user_membership_id = user_memberships.id
                          AND a.assignment_id = a.id AND a.assignment_status = 'in_cart'),
               status = 'in_cart')`,
    [gymId, ...keep]);
  return Number(rowCount ?? 0);
}
