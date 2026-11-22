/**
 * #2125 M6b-51d-1 — also the one place a `user_memberships` row is created (`insertAssignment()`),
 * under an id allocated by the `plan_assignment_ids` registry rather than by the table itself, so the
 * assignment's public id survives the table.
 *
 * #2125 M6b-51c-3 — the one place a `user_memberships` row is written after it was created: its
 * lifecycle (status, `closed_at`, `ends_at`), its dates and the facts that move with them.
 *
 * Until this stage seventeen statements across eleven modules spelled the same `UPDATE user_memberships`
 * each in their own way. They now describe the change and this writer spells the statement, so the
 * next stage, which writes the lifecycle on the assignment's plan snapshot and retires the legacy row,
 * changes this module and no caller. Nothing here decides a transition: each caller keeps its own
 * guard (the `from` statuses below), its audit row (`recordStatusChange()`) and its snapshot sync.
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
  /** A new start date; absent leaves it. */
  startsAt?: string | null;
  /** `fill`: the purchase time is stamped now where none is stored. */
  purchasedAt?: 'fill';
  /** Staff's Add-or-Replace answer, carried across Save & Pay (#2125 stage 3). */
  replaceOnActivation?: boolean;
  /** Who made the change. `undefined` (and `touch: false`) leaves `modified_at`/`modified_by` alone. */
  actor?: string | null;
  touch?: boolean;
}

/** The columns a change may write, and their name on the assignment's anchor snapshot (M6b-51c-4). */
type Column = 'status' | 'closed_at' | 'ends_at' | 'modified_at' | 'modified_by';
const LEGACY = (c: Column | 'starts_at' | 'purchased_at' | 'replace_on_activation') => c;
const ANCHOR = (c: Column) => `assignment_${c}`;

/** The SET list of a change for one record, with `now`/`today` bound so both records get one value. */
function setList(
  change: AssignmentLifecycleChange, name: (c: Column) => string, clock: { now: string; today: string },
  legacyOnly: boolean,
): { sets: string[]; params: unknown[] } {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (legacyOnly && change.startsAt != null) { sets.push(`${LEGACY('starts_at')} = ?`); params.push(change.startsAt); }
  const ends = name('ends_at');
  if (change.endsAt === 'today_if_null') { sets.push(`${ends} = COALESCE(${ends}, ?)`); params.push(clock.today); }
  else if (change.endsAt === 'clear') sets.push(`${ends} = NULL`);
  else if (change.endsAt) { sets.push(`${ends} = ?`); params.push(change.endsAt.set); }
  if (change.status != null) { sets.push(`${name('status')} = ?`); params.push(change.status); }
  const closed = name('closed_at');
  if (change.closedAt === 'keep_or_now') { sets.push(`${closed} = COALESCE(${closed}, ?)`); params.push(clock.now); }
  else if (change.closedAt === 'now') { sets.push(`${closed} = ?`); params.push(clock.now); }
  else if (change.closedAt === 'clear') sets.push(`${closed} = NULL`);
  if (legacyOnly && change.purchasedAt === 'fill') {
    sets.push(`${LEGACY('purchased_at')} = COALESCE(${LEGACY('purchased_at')}, ?)`);
    params.push(clock.now);
  }
  if (legacyOnly && change.replaceOnActivation !== undefined) {
    sets.push(`${LEGACY('replace_on_activation')} = ?`);
    params.push(change.replaceOnActivation ? 1 : 0);
  }
  if (change.touch !== false && change.actor !== undefined) {
    sets.push(`${name('modified_at')} = ?`, `${name('modified_by')} = ?`);
    params.push(clock.now, change.actor);
  }
  return { sets, params };
}

/**
 * Writes one assignment's change; answers how many rows it wrote (0 when a guard refused it).
 * M6b-51c-4: a change that passed its guards is mirrored onto the assignment's anchor snapshot
 * (`assignment_status`, `assignment_closed_at`, `assignment_ends_at`, `assignment_modified_*`),
 * with the same clock value, so the two records agree to the second.
 * M6b-51d-6: the guards (`from`, `notFrom`, `onlyIfEndsAtNull`) are asked of the anchor, the record
 * that survives `user_memberships`; the legacy row is then written by id, unguarded. Only an
 * assignment no anchor states yet (its first snapshot not stamped) is still judged on the legacy row.
 */
export async function writeAssignmentLifecycle(
  exec: Exec, gymId: string, userMembershipId: number, change: AssignmentLifecycleChange,
): Promise<number> {
  const { rows: clockRows } = await exec.query<{ now: string; today: string }>(
    `SELECT DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:%s') AS now, DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') AS today`);
  const clock = { now: String(clockRows[0].now), today: String(clockRows[0].today) };
  const legacy = setList(change, LEGACY, clock, true);
  if (legacy.sets.length === 0) return 0;
  const from = change.from == null ? [] : (typeof change.from === 'string' ? [change.from] : [...change.from]);

  const { rows: anchors } = await exec.query<{ status: string | null; ends_at: unknown }>(
    `SELECT assignment_status AS status, assignment_ends_at AS ends_at FROM plan_snapshots
      WHERE gym_id = ? AND source_user_membership_id = ? AND assignment_id = id`,
    [gymId, userMembershipId]);
  const anchor = anchors[0];
  const judgedOnAnchor = anchor != null && anchor.status != null;
  if (judgedOnAnchor && !anchorPasses(String(anchor.status), anchor.ends_at, change, from)) return 0;

  const where: string[] = ['id = ?', 'gym_id = ?'];
  const params: unknown[] = [...legacy.params, userMembershipId, gymId];
  if (!judgedOnAnchor) {
    if (from.length > 0) { where.push(`status IN (${from.map(() => '?').join(',')})`); params.push(...from); }
    if (change.notFrom && change.notFrom.length > 0) {
      where.push(`status NOT IN (${change.notFrom.map(() => '?').join(',')})`);
      params.push(...change.notFrom);
    }
    if (change.onlyIfEndsAtNull) where.push('ends_at IS NULL');
  }

  const { rowCount } = await exec.query(
    `UPDATE user_memberships SET ${legacy.sets.join(', ')} WHERE ${where.join(' AND ')}`, params);
  if (judgedOnAnchor) {
    await writeAnchorLifecycle(exec, gymId, userMembershipId, change, clock);
    return Math.max(rowCount, 1);
  }
  if (rowCount > 0) await writeAnchorLifecycle(exec, gymId, userMembershipId, change, clock);
  return rowCount;
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

async function writeAnchorLifecycle(
  exec: Exec, gymId: string, userMembershipId: number, change: AssignmentLifecycleChange,
  clock: { now: string; today: string },
): Promise<void> {
  const anchor = setList(change, ANCHOR, clock, false);
  if (anchor.sets.length === 0) return;
  await exec.query(
    `UPDATE plan_snapshots SET ${anchor.sets.join(', ')}
      WHERE gym_id = ? AND source_user_membership_id = ? AND assignment_id = id`,
    [...anchor.params, gymId, userMembershipId]);
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
  const { rowCount } = await exec.query(
    `DELETE FROM user_memberships WHERE gym_id = ? AND status = 'in_cart' AND id IN (${keep.map(() => '?').join(',')})`,
    [gymId, ...keep]);
  return Number(rowCount ?? 0);
}
