/**
 * #2125 M6b-2 — the one-off repair for lifecycle changes made before the copy-before-write writer
 * existed: an Active Product Set whose plan snapshot still reads the state it had before its
 * assignment was paused, resumed or cancelled, because the snapshot was shared and the sync left it.
 *
 * It decides nothing of its own: each listed set is re-synced (`syncPlanSnapshot()`), which is what
 * a new lifecycle change does. One transaction per set, so a failure leaves the others settled.
 */
import { db } from '../infra/db';
import { findUnsettledActiveSets } from './plan-assignment-lifecycle';
import { syncPlanSnapshot } from './plan-snapshot-sync';

export interface SettleReport { found: number; settled: number; remaining: number }

export async function settlePlanAssignmentLifecycles(
  opts: { gymId?: string; execute: boolean },
): Promise<SettleReport> {
  const sets = await findUnsettledActiveSets(db, opts.gymId);
  if (!opts.execute) return { found: sets.length, settled: 0, remaining: sets.length };
  for (const set of sets) {
    await db.transaction((tx) => syncPlanSnapshot(tx, set.gymId, set.productSetId));
  }
  const remaining = (await findUnsettledActiveSets(db, opts.gymId)).length;
  return { found: sets.length, settled: sets.length - remaining, remaining };
}
