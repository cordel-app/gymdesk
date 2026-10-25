/**
 * #1849 stage E3 (Exercises) — read-only audit of the exercise references.
 *
 *   npm run exercises:audit-base-links
 *
 * Prints, per check, how many rows break the exercise-reference rules of the five places
 * (see baseExerciseLinkAudit.ts), plus row counts. Writes
 * nothing; exit code 1 when any check is non-zero. Run it before and after
 * the E5 cut-over and the E6 delete.
 */
import 'dotenv/config';
import { db } from '../infra/db';
import { EXERCISE_REFERENCE_TABLES, baseExerciseLinkChecks } from '../domain/baseExerciseLinkAudit';

async function main() {
  const { checks, params } = baseExerciseLinkChecks();
  let failed = 0;
  for (const [i, check] of checks.entries()) {
    const { rows } = await db.query<{ n: number }>(check.sql, params[i]);
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0 && !check.informational) failed += 1;
    console.log(`${n === 0 ? 'OK  ' : check.informational ? 'INFO' : 'FAIL'} ${check.key}: ${n} — ${check.description}`);
  }
  for (const table of ['exercises', 'base_exercises', ...EXERCISE_REFERENCE_TABLES.map((r) => r.table)]) {
    const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    console.log(`rows ${table}: ${rows[0].n}`);
  }
  await db.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await db.end();
  process.exit(1);
});
