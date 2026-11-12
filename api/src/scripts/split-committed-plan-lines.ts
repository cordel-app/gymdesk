/**
 * #2657 stage 4 — split the Individual plan lines committed before stage 3 (#2736) into one
 * line per member, with their allowance renewals and spends.
 *
 *   npm run plan-lines:split                 # dry run (default)
 *   npm run plan-lines:split -- --execute    # write
 *   npm run plan-lines:split -- --gym=<id>   # one gym only
 *
 * Against a deployed database, run from the VPS as the compiled
 * `node dist/scripts/split-committed-plan-lines.js`. Repeatable: a second run finds nothing.
 * See `api/src/api/plan-line-split-committed.ts` for what is split and what follows a line.
 */
import 'dotenv/config';
import { db } from '../infra/db';
import { splitCommittedPlanLines } from '../api/plan-line-split-committed';

async function main() {
  const execute = process.argv.includes('--execute');
  const gymId = process.argv.find((a) => a.startsWith('--gym='))?.slice('--gym='.length) || null;
  const res = await splitCommittedPlanLines({ execute, gymId, log: (line) => console.log(line) });
  console.log(`\n${execute ? 'Executed' : 'Dry run'}: ${res.lines} lines split in ${res.snapshots} plan snapshots, ` +
    `${res.member_lines} member lines created, ${res.renewals_shared} renewals shared, ${res.spends_moved} spends moved, ` +
    `${res.skipped} skipped.`);
  await db.end();
}

main().catch(async (err) => { console.error(err); await db.end().catch(() => {}); process.exit(1); });
