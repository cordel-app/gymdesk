/**
 * #2125 M5c — moves every existing billing schedule onto the billing calendar
 * (monthly on the 1st, 4-weekly on the 2026-11-02 grid, weekly on Mondays;
 * yearly untouched) and regenerates the not-yet-attempted future obligations
 * that move with it. The rule is `api/schedule-realignment.ts`.
 *
 *   npm run schedules:realign                 # dry run: every chain is realigned and rolled back
 *   npm run schedules:realign -- --execute    # commits
 *
 * One transaction per owner (#2125 M5c-3; per chain before), so an owner that fails is reported and left exactly
 * as it was while the others proceed. Future obligations that already have a
 * payment attempt are kept and listed, never deleted or duplicated. Idempotent:
 * a second run finds every anchor on its grid and changes nothing.
 *
 * #2125 M5c-2: it also consolidates a chain's schedules that are one schedule
 * (`consolidateChainSchedules()`); an event that cannot be merged (a past or
 * attempted one colliding with the target's for the same period) is listed and
 * left on its own schedule, never deleted or duplicated.
 *
 * The deployed database is VCN-private, so against it the compiled script runs
 * from the VPS (`node dist/scripts/realign-billing-schedules.js`).
 */
import 'dotenv/config';
import { db } from '../infra/db';
import { realignOwnerSchedules, type ChainRealignment } from '../api/schedule-realignment';

class DryRunRollback extends Error {
  constructor(readonly result: ChainRealignment) { super('dry run'); }
}

async function main(): Promise<void> {
  const execute = process.argv.slice(2).includes('--execute');
  const today = new Date().toISOString().slice(0, 10);
  // #2125 M5c-3: one transaction per owner, since a schedule is the owner's (`(owner, periodicity)`).
  const { rows: chains } = await db.query<{ gym_id: string; owner: number }>(
    `SELECT DISTINCT gym_id, owner_member_id AS owner FROM product_set_schedules ORDER BY gym_id, owner_member_id`);

  let moved = 0, deleted = 0, created = 0, failed = 0, merged = 0;
  const kept: number[] = [];
  for (const chain of chains) {
    let result: ChainRealignment | null = null;
    try {
      result = await db.transaction(async (tx) => {
        const r = await realignOwnerSchedules(tx, { gymId: String(chain.gym_id), ownerMemberId: Number(chain.owner), today });
        if (!execute) throw new DryRunRollback(r);
        return r;
      });
    } catch (err) {
      if (err instanceof DryRunRollback) result = err.result;
      else {
        failed += 1;
        console.error(`owner ${chain.owner} (gym ${chain.gym_id}) FAILED, left unchanged:`, (err as Error).message);
        continue;
      }
    }
    if (!result || (result.schedules.length === 0 && result.consolidations.length === 0)) continue;
    for (const s of result.schedules) {
      moved += 1; deleted += s.deletedEvents; kept.push(...s.keptAttempted);
      console.log(`owner ${result.ownerMemberId} schedule ${s.scheduleId} (${s.cadence}): ${s.from} -> ${s.to}, `
        + `${s.deletedEvents} future event(s) removed${s.keptAttempted.length ? `, attempted kept: ${s.keptAttempted.join(',')}` : ''}`);
    }
    created += result.createdEvents;
    if (result.activeProductSetId == null) console.log(`owner ${result.ownerMemberId}: no Active version, nothing regenerated`);
    for (const c of result.consolidations) {
      merged += c.removed ? 1 : 0; kept.push(...c.keptEvents);
      console.log(`owner ${result.ownerMemberId} schedule ${c.mergedScheduleId} -> ${c.targetScheduleId}: `
        + `${c.repointedEvents} event(s) moved, ${c.regeneratedEvents} colliding future event(s) regenerated`
        + (c.keptEvents.length ? `, NOT merged (past or attempted, kept on schedule ${c.mergedScheduleId}): ${c.keptEvents.join(',')}` : '')
        + (c.removed ? ', schedule removed' : ''));
    }
  }
  console.log(`${execute ? 'EXECUTED' : 'DRY RUN (rolled back)'}: ${moved} schedule(s) moved, ${deleted} future event(s) removed, `
    + `${created} regenerated, ${merged} schedule(s) consolidated, ${kept.length} attempted or unmergeable event(s) kept, ${failed} owner(s) failed.`);
  await db.end();
  if (failed > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(err);
  try { await db.end(); } catch { /* already closed */ }
  process.exit(1);
});
