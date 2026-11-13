/**
 * One-off repair of the #2125 M6b dual-write (M6b-2): brings the plan snapshots of Active Product
 * Sets in step with assignments paused, resumed or cancelled before lifecycle changes were written
 * on a copy of a shared snapshot.
 *
 *   npm run plan-assignments:settle                          dry run, every gym
 *   npm run plan-assignments:settle -- --execute             settle every gym
 *   npm run plan-assignments:settle -- <gymId> [--execute]   one gym
 *
 * A dry run writes nothing and reports how many Active sets would be re-synced. With `--execute`
 * each is re-synced in its own transaction; a shared snapshot is copied for the Active set, never
 * written in place. Run `plan-assignments:validate` afterwards. Against a deployed database it runs
 * from the VPS as the compiled `node dist/scripts/settle-plan-assignments.js`.
 */
import 'dotenv/config';
import { db } from '../infra/db';
import { settlePlanAssignmentLifecycles } from '../api/plan-assignment-settle';

if (require.main === module) {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const gymId = args.find((a) => !a.startsWith('--'));
  settlePlanAssignmentLifecycles({ gymId, execute })
    .then(async (report) => {
      console.log(execute
        ? `Settled ${report.settled} of ${report.found} Active Product Set(s); ${report.remaining} remaining.`
        : `Dry run: ${report.found} Active Product Set(s) hold a plan snapshot behind its assignment. Re-run with --execute.`);
      await db.end();
      process.exit(report.remaining === 0 || !execute ? 0 : 1);
    })
    .catch(async (err) => {
      console.error(err);
      await db.end();
      process.exit(2);
    });
}
