/**
 * #1849 stage 2d — read-only audit of the Personal Goal references.
 *
 *   npm run goals:audit-base-links
 *
 * Prints, per check, how many rows would block moving the references from the
 * legacy System rows to `base_personal_goals`, plus row counts. Writes nothing;
 * exit code 1 when any check is non-zero. Run it before and after migration 316
 * and before stages 2e/2f.
 */
import 'dotenv/config';
import { db } from '../infra/db';
import { baseGoalLinkChecks } from '../domain/baseGoalLinkAudit';

async function main() {
  const { checks, params } = baseGoalLinkChecks();
  let failed = 0;
  for (const [i, check] of checks.entries()) {
    const { rows } = await db.query<{ n: number }>(check.sql, params[i]);
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0 && !check.informational) failed += 1;
    console.log(`${n === 0 ? 'OK  ' : check.informational ? 'INFO' : 'FAIL'} ${check.key}: ${n} — ${check.description}`);
  }
  for (const table of ['personal_goals', 'base_personal_goals', 'member_personal_goals', 'gym_personal_goals']) {
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
