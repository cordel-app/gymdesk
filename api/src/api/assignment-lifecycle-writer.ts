/**
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

/** Writes one assignment's change; answers how many rows it wrote (0 when a guard refused it). */
export async function writeAssignmentLifecycle(
  exec: Exec, gymId: string, userMembershipId: number, change: AssignmentLifecycleChange,
): Promise<number> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (change.startsAt != null) { sets.push('starts_at = ?'); params.push(change.startsAt); }
  if (change.endsAt === 'today_if_null') sets.push('ends_at = COALESCE(ends_at, UTC_DATE())');
  else if (change.endsAt === 'clear') sets.push('ends_at = NULL');
  else if (change.endsAt) { sets.push('ends_at = ?'); params.push(change.endsAt.set); }
  if (change.status != null) { sets.push('status = ?'); params.push(change.status); }
  if (change.closedAt === 'keep_or_now') sets.push('closed_at = COALESCE(closed_at, UTC_TIMESTAMP())');
  else if (change.closedAt === 'now') sets.push('closed_at = UTC_TIMESTAMP()');
  else if (change.closedAt === 'clear') sets.push('closed_at = NULL');
  if (change.purchasedAt === 'fill') sets.push('purchased_at = COALESCE(purchased_at, UTC_TIMESTAMP())');
  if (change.replaceOnActivation !== undefined) {
    sets.push('replace_on_activation = ?');
    params.push(change.replaceOnActivation ? 1 : 0);
  }
  if (change.touch !== false && change.actor !== undefined) {
    sets.push('modified_at = UTC_TIMESTAMP()', 'modified_by = ?');
    params.push(change.actor);
  }
  if (sets.length === 0) return 0;

  const where: string[] = ['id = ?', 'gym_id = ?'];
  params.push(userMembershipId, gymId);
  const from = change.from == null ? [] : (typeof change.from === 'string' ? [change.from] : [...change.from]);
  if (from.length > 0) { where.push(`status IN (${from.map(() => '?').join(',')})`); params.push(...from); }
  if (change.notFrom && change.notFrom.length > 0) {
    where.push(`status NOT IN (${change.notFrom.map(() => '?').join(',')})`);
    params.push(...change.notFrom);
  }
  if (change.onlyIfEndsAtNull) where.push('ends_at IS NULL');

  const { rowCount } = await exec.query(
    `UPDATE user_memberships SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`, params);
  return rowCount;
}
