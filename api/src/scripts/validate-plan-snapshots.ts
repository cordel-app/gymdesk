/**
 * Read-only validation of the #2125 stage 1 backfill (migration 347).
 *
 *   npm run plan-snapshots:validate
 *
 * Writes nothing. For each legacy source it counts the rows the new tables should hold and the
 * rows they do, and lists the gaps that need manual handling (a Membership Plan Promotion
 * application whose assignment has no plan snapshot, for example) rather than guessing a home
 * for them. Exit code 1 when any count differs, so it can gate dropping a legacy table later.
 */
import 'dotenv/config';
import { db } from '../infra/db';
import { productSetOfLegacyAssignmentSql } from '../domain/planAssignments';

interface Check { name: string; expected: number; actual: number }

async function count(sql: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(sql);
  return Number(rows[0].n);
}

export async function validatePlanSnapshots(): Promise<{ checks: Check[]; gaps: Array<Record<string, unknown>> }> {
  const checks: Check[] = [];
  const add = async (name: string, expected: string, actual: string) =>
    checks.push({ name, expected: await count(expected), actual: await count(actual) });

  await add('plan_snapshot_beneficiaries (owner of every snapshot)',
    'SELECT COUNT(*) n FROM plan_snapshots',
    'SELECT COUNT(*) n FROM plan_snapshot_beneficiaries WHERE is_owner = 1');
  // #3026 stage 3d-2: a Membership Plan Promotion application is the plan snapshot's own row; there
  // is no legacy record left to compare it with.
  const gaps: Array<Record<string, unknown>> = [];
  return { checks, gaps };
}

if (require.main === module) {
  validatePlanSnapshots()
    .then(async ({ checks, gaps }) => {
      for (const c of checks) console.log(`${c.expected === c.actual ? 'OK  ' : 'DIFF'} ${c.name}: expected ${c.expected}, found ${c.actual}`);
      if (gaps.length) console.log(`${gaps.length} gap(s) for manual handling:`, JSON.stringify(gaps));
      await db.end();
      process.exit(checks.some((c) => c.expected !== c.actual) ? 1 : 0);
    })
    .catch(async (err) => { console.error(err); await db.end(); process.exit(2); });
}
