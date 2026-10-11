/**
 * #1360 stage 2 — derive `exercise_allowed_result_types` from `exercises.category`.
 *
 *   npm run exercises:backfill-result-types              # dry run (default)
 *   npm run exercises:backfill-result-types -- --execute # write
 *
 * Only exercises whose stored category is already one of the seven supported
 * values are touched; every other exercise (NULL, unsupported, legacy) is listed
 * and left exactly as it is — nothing is guessed. Workout logs, plans and
 * templates reference `result_type_id` directly and are not modified.
 */
import 'dotenv/config';
import { db } from '../infra/db';
import { isExerciseCategory } from '../domain/exerciseCategories';
import { derivedResultTypeIds, syncExerciseResultTypes } from '../api/exercise-result-types';

async function main() {
  const execute = process.argv.includes('--execute');
  const { rows } = await db.query<any>(
    `SELECT e.id, e.name, e.category,
            (SELECT GROUP_CONCAT(eart.result_type_id ORDER BY eart.result_type_id)
               FROM exercise_allowed_result_types eart WHERE eart.exercise_id = e.id) AS current_ids
       FROM exercises e WHERE e.status != 'deleted' ORDER BY e.id`,
  );
  let changed = 0, unchanged = 0, skipped = 0;
  for (const r of rows) {
    if (!isExerciseCategory(r.category)) {
      skipped += 1;
      console.log(`skip   #${r.id} ${r.name} — category ${JSON.stringify(r.category)} is not supported; rows left as they are`);
      continue;
    }
    await db.transaction(async (tx) => {
      const derived = (await derivedResultTypeIds(tx, r.category)) ?? [];
      const current = r.current_ids ? String(r.current_ids).split(',').map(Number) : [];
      if (derived.join(',') === current.join(',')) { unchanged += 1; return; }
      changed += 1;
      console.log(`${execute ? 'update' : 'would update'} #${r.id} ${r.name} [${r.category}]: ${current.join(',') || '(none)'} -> ${derived.join(',')}`);
      if (execute) await syncExerciseResultTypes(tx, r.id, r.category);
    });
  }
  console.log(`\n${execute ? 'Executed' : 'Dry run'}: ${changed} changed, ${unchanged} already correct, ${skipped} skipped (unsupported category).`);
  await db.end();
}

main().catch(async (err) => { console.error(err); await db.end().catch(() => {}); process.exit(1); });
