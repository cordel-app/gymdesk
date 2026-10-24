/**
 * #1849 stage F3 (Foods) — read-only audit of the Food references.
 *
 *   npm run foods:audit-base-links
 *
 * Prints, per check, how many rows break the Food-reference rules of the five tables
 * (see baseFoodLinkAudit.ts), plus row counts. Writes
 * nothing; exit code 1 when any check is non-zero. Run it before and after migrations
 * 332 and 333.
 */
import 'dotenv/config';
import { db } from '../infra/db';
import { FOOD_REFERENCE_TABLES, baseFoodLinkChecks } from '../domain/baseFoodLinkAudit';

async function main() {
  const { checks, params } = baseFoodLinkChecks();
  let failed = 0;
  for (const [i, check] of checks.entries()) {
    const { rows } = await db.query<{ n: number }>(check.sql, params[i]);
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0 && !check.informational) failed += 1;
    console.log(`${n === 0 ? 'OK  ' : check.informational ? 'INFO' : 'FAIL'} ${check.key}: ${n} — ${check.description}`);
  }
  for (const table of ['nutrition_library_items', 'base_nutrition_library_items', ...FOOD_REFERENCE_TABLES]) {
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
