/**
 * Read-only validation of the #2126 stage 1 backfill (migration 348).
 *
 *   npm run product-snapshots:validate
 *
 * Writes nothing. For each legacy source it counts the rows the new tables should hold and the
 * rows they do, and lists the gaps that need manual handling (a recurring line with no Product
 * Set version, a Product-target application with no owning line) rather than guessing a home
 * for them. Exit code 1 when any count differs, so it can gate dropping a legacy table later.
 */
import 'dotenv/config';
import { db } from '../infra/db';

interface Check { name: string; expected: number; actual: number }

async function count(sql: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(sql);
  return Number(rows[0].n);
}

export async function validateProductSnapshots(): Promise<{ checks: Check[]; gaps: Array<Record<string, unknown>> }> {
  const checks: Check[] = [];
  const add = async (name: string, expected: string, actual: string) =>
    checks.push({ name, expected: await count(expected), actual: await count(actual) });

  await add('product_session_snapshots (Sessions purchases)',
    "SELECT COUNT(*) n FROM member_products_oneoff_snapshot WHERE product_type = 'sessions'",
    'SELECT COUNT(*) n FROM product_session_snapshots');
  await add('product_oneoff_snapshots (other purchases)',
    "SELECT COUNT(*) n FROM member_products_oneoff_snapshot WHERE product_type <> 'sessions'",
    'SELECT COUNT(*) n FROM product_oneoff_snapshots');
  await add('product_periodical_snapshots (recurring lines of a version)',
    `SELECT COUNT(*) n FROM member_products_recurrent_snapshot s
       JOIN product_sets ps ON ps.id = s.product_set_id AND ps.gym_id = s.gym_id`,
    'SELECT COUNT(*) n FROM product_periodical_snapshots');
  await add('product_promotion_snapshots (purchase Promotions + line-owned Product applications)',
    `SELECT (SELECT COUNT(*) FROM member_products_oneoff_promotion_snapshot)
          + (SELECT COUNT(*) FROM user_membership_promotions ump
               JOIN promotions pr ON pr.id = ump.promotion_id AND pr.applies_to = 'product'
              WHERE ump.recurrent_snapshot_id IS NOT NULL) AS n`,
    'SELECT COUNT(*) n FROM product_promotion_snapshots');
  await add('product_promotion_grant_snapshots (grants of copied applications)',
    `SELECT COUNT(*) n FROM (
       SELECT g.user_membership_promotion_id FROM user_membership_promotion_session_snapshot g
       UNION ALL SELECT g.user_membership_promotion_id FROM user_membership_promotion_oneoff_snapshot g
       UNION ALL SELECT g.user_membership_promotion_id FROM user_membership_promotion_periodical_snapshot g) x
       JOIN product_promotion_snapshots pp ON pp.source_application_id = x.user_membership_promotion_id`,
    'SELECT COUNT(*) n FROM product_promotion_grant_snapshots');

  const { rows: lines } = await db.query<Record<string, unknown>>(
    `SELECT s.id AS recurrent_snapshot_id, s.gym_id, s.product_id, 'recurring line with no Product Set version' AS reason
       FROM member_products_recurrent_snapshot s
       LEFT JOIN product_sets ps ON ps.id = s.product_set_id AND ps.gym_id = s.gym_id
      WHERE ps.id IS NULL`);
  const { rows: apps } = await db.query<Record<string, unknown>>(
    `SELECT ump.id AS user_membership_promotion_id, ump.gym_id, ump.promotion_id, ump.product_set_id,
            'Product application with no owning line' AS reason
       FROM user_membership_promotions ump
       JOIN promotions pr ON pr.id = ump.promotion_id AND pr.applies_to = 'product'
      WHERE ump.recurrent_snapshot_id IS NULL`);
  return { checks, gaps: [...lines, ...apps] };
}

if (require.main === module) {
  validateProductSnapshots()
    .then(async ({ checks, gaps }) => {
      for (const c of checks) console.log(`${c.expected === c.actual ? 'OK  ' : 'DIFF'} ${c.name}: expected ${c.expected}, found ${c.actual}`);
      if (gaps.length) console.log(`${gaps.length} gap(s) for manual handling:`, JSON.stringify(gaps));
      await db.end();
      process.exit(checks.some((c) => c.expected !== c.actual) ? 1 : 0);
    })
    .catch(async (err) => { console.error(err); await db.end(); process.exit(2); });
}
