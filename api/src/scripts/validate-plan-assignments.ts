/**
 * Read-only drift check of the #2125 M6b dual-write (migration 419).
 *
 *   npm run plan-assignments:validate            every gym
 *   npm run plan-assignments:validate -- <gymId> one gym
 *
 * Writes nothing. While `user_memberships` and `plan_snapshots` both record a Membership Plan
 * assignment, this lists where they disagree: identity (`assignment_id`) and lifecycle (status,
 * dates, owner, the replace target). Exit code 1 while any check has rows, so it can gate dropping
 * `user_memberships` in M6b-4. Against a deployed database it runs from the VPS as the compiled
 * `node dist/scripts/validate-plan-assignments.js`.
 */
import 'dotenv/config';
import { db } from '../infra/db';
import { findPlanAssignmentDrift } from '../api/plan-assignment-drift';

if (require.main === module) {
  const gymId = process.argv[2];
  findPlanAssignmentDrift(db, gymId)
    .then(async (report) => {
      for (const c of report.checks) {
        console.log(`${c.count === 0 ? 'OK  ' : 'DIFF'} ${c.name}: ${c.count}  (${c.description})`);
        for (const row of c.sample) console.log(`       ${JSON.stringify(row)}`);
        if (c.count > c.sample.length) console.log(`       ... ${c.count - c.sample.length} more`);
      }
      console.log(report.clean ? 'Clean: both records agree.' : 'Drift found: see the checks above.');
      await db.end();
      process.exit(report.clean ? 0 : 1);
    })
    .catch(async (err) => {
      console.error(err);
      await db.end();
      process.exit(2);
    });
}
