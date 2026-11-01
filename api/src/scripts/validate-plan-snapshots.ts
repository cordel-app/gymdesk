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

interface Check { name: string; expected: number; actual: number }

const PLAN_SNAPSHOT_FOR_APPLICATION = `COALESCE(
  (SELECT s.id FROM plan_snapshots s WHERE s.product_set_id = ump.product_set_id),
  (SELECT s2.id FROM plan_snapshots s2 JOIN product_sets p2 ON p2.id = s2.product_set_id
    WHERE ump.user_membership_id IS NOT NULL AND p2.user_membership_id = ump.user_membership_id
    ORDER BY p2.version DESC, p2.id DESC LIMIT 1))`;

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
  await add('plan_promotion_snapshots (Membership Plan applications with a snapshot to hang on)',
    `SELECT COUNT(*) n FROM user_membership_promotions ump
       JOIN promotions pr ON pr.id = ump.promotion_id AND pr.applies_to = 'membership_plan'
      WHERE ump.recurrent_snapshot_id IS NULL AND ${PLAN_SNAPSHOT_FOR_APPLICATION} IS NOT NULL`,
    'SELECT COUNT(*) n FROM plan_promotion_snapshots');
  for (const [target, source] of [
    ['plan_promotion_session_product_snapshots', 'user_membership_promotion_session_snapshot'],
    ['plan_promotion_oneoff_product_snapshots', 'user_membership_promotion_oneoff_snapshot'],
    ['plan_promotion_periodical_product_snapshots', 'user_membership_promotion_periodical_snapshot'],
  ]) {
    await add(`${target} (grants of copied applications)`,
      `SELECT COUNT(*) n FROM ${source} g JOIN plan_promotion_snapshots pp ON pp.source_id = g.user_membership_promotion_id`,
      `SELECT COUNT(*) n FROM ${target}`);
  }

  const { rows: gaps } = await db.query<Record<string, unknown>>(
    `SELECT ump.id AS user_membership_promotion_id, ump.gym_id, ump.promotion_id, ump.product_set_id,
            ump.user_membership_id, 'plan application with no plan snapshot' AS reason
       FROM user_membership_promotions ump
       JOIN promotions pr ON pr.id = ump.promotion_id AND pr.applies_to = 'membership_plan'
      WHERE ump.recurrent_snapshot_id IS NULL AND ${PLAN_SNAPSHOT_FOR_APPLICATION} IS NULL`);
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
