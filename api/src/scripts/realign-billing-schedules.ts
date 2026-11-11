/**
 * #2125 M5c — moves every existing billing schedule onto the billing calendar
 * (monthly on the 1st, 4-weekly on the 2026-11-02 grid, weekly on Mondays;
 * yearly untouched) and regenerates the not-yet-attempted future obligations
 * that move with it. The rule is `api/schedule-realignment.ts`.
 *
 *   npm run schedules:realign                 # dry run: every chain is realigned and rolled back
 *   npm run schedules:realign -- --execute    # commits
 *
 * One transaction per chain, so a chain that fails is reported and left exactly
 * as it was while the others proceed. Future obligations that already have a
 * payment attempt are kept and listed, never deleted or duplicated. Idempotent:
 * a second run finds every anchor on its grid and changes nothing.
 *
 * The deployed database is VCN-private, so against it the compiled script runs
 * from the VPS (`node dist/scripts/realign-billing-schedules.js`).
 */
import 'dotenv/config';
import { db } from '../infra/db';
import { realignChainSchedules, type ChainRealignment } from '../api/schedule-realignment';

class DryRunRollback extends Error {
  constructor(readonly result: ChainRealignment) { super('dry run'); }
}

async function main(): Promise<void> {
  const execute = process.argv.slice(2).includes('--execute');
  const today = new Date().toISOString().slice(0, 10);
  const { rows: chains } = await db.query<{ gym_id: string; root: number }>(
    `SELECT DISTINCT gym_id, root_product_set_id AS root FROM product_set_schedules ORDER BY gym_id, root_product_set_id`);

  let moved = 0, deleted = 0, created = 0, failed = 0;
  const kept: number[] = [];
  for (const chain of chains) {
    let result: ChainRealignment | null = null;
    try {
      result = await db.transaction(async (tx) => {
        const r = await realignChainSchedules(tx, { gymId: String(chain.gym_id), rootProductSetId: Number(chain.root), today });
        if (!execute) throw new DryRunRollback(r);
        return r;
      });
    } catch (err) {
      if (err instanceof DryRunRollback) result = err.result;
      else {
        failed += 1;
        console.error(`chain ${chain.root} (gym ${chain.gym_id}) FAILED, left unchanged:`, (err as Error).message);
        continue;
      }
    }
    if (!result || result.schedules.length === 0) continue;
    for (const s of result.schedules) {
      moved += 1; deleted += s.deletedEvents; kept.push(...s.keptAttempted);
      console.log(`chain ${result.rootProductSetId} schedule ${s.scheduleId} (${s.cadence}): ${s.from} -> ${s.to}, `
        + `${s.deletedEvents} future event(s) removed${s.keptAttempted.length ? `, attempted kept: ${s.keptAttempted.join(',')}` : ''}`);
    }
    created += result.createdEvents;
    if (result.activeProductSetId == null) console.log(`chain ${result.rootProductSetId}: no Active version, nothing regenerated`);
    if (result.sameCadenceSchedules) console.log(`chain ${result.rootProductSetId}: several schedules share a cadence (consolidated by the (owner, periodicity) re-keying)`);
  }
  console.log(`${execute ? 'EXECUTED' : 'DRY RUN (rolled back)'}: ${moved} schedule(s) moved, ${deleted} future event(s) removed, `
    + `${created} regenerated, ${kept.length} attempted future event(s) kept, ${failed} chain(s) failed.`);
  await db.end();
  if (failed > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(err);
  try { await db.end(); } catch { /* already closed */ }
  process.exit(1);
});
