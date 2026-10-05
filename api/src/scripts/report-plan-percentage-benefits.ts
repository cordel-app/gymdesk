/**
 * Read-only report: which Membership Plan benefit lines still carry the
 * `% Discount` treatment #997 retired.
 *
 *   npm run plans:percentage-benefits
 *
 * §6 asks that existing `% Discount` configurations be "identified and handled
 * through an explicit migration/data-cleanup process", and in the same breath
 * forbids converting them: silently writing `Waive` would make a €20 item free,
 * and silently reading them as `No benefit` would start charging €20 for a line
 * agreed at €16. So nothing is converted — `LEGACY_PLAN_BENEFIT_ACTIONS` keeps
 * them readable, priced and billable exactly as stored — and *this* is the
 * identification step. It writes nothing, so it is safe against production.
 *
 * It reports the two sides separately, because only one of them is a gym's to
 * fix in the editor:
 *
 *   - **catalogue** — `membership_plan_{session,oneoff,periodical}`. The Plans
 *     page renders the stored value as a disabled option, so these are
 *     corrected by picking `No benefit` or `Waive` on the line. Until somebody
 *     does, the Plan keeps quoting and billing the percentage.
 *   - **assignments** — `user_membership_{session,oneoff,periodical}`, the
 *     Assigned Plan snapshot. These are what a member was *agreed* at (#635
 *     §17) and what the nightly run charges, so correcting one is renegotiating
 *     a contract rather than tidying a catalogue. The snapshot editor takes
 *     quantity alone, which is why they are listed and not editable: they are
 *     here so a gym can see that correcting a Plan leaves them untouched.
 *
 * A **Promotion** is deliberately absent: §8 leaves percentages on the
 * Promotion side exactly as they are, so a `promotion_*` row carrying one is
 * not a finding.
 *
 * Why a script and not a route: it answers a question about every gym at once
 * and has no tenant context, exactly like the other operator scripts here.
 */

import 'dotenv/config';
import { db } from '../infra/db';
import { LEGACY_PLAN_BENEFIT_ACTIONS } from '../domain/productBenefitActions';

/** The two groups of Plan-side tables, in the order the report prints them. */
export const PLAN_CATALOGUE_TABLES = [
  'membership_plan_session',
  'membership_plan_oneoff',
  'membership_plan_periodical',
] as const;

export const PLAN_ASSIGNMENT_TABLES = [
  'user_membership_session',
  'user_membership_oneoff',
  'user_membership_periodical',
] as const;

export interface LegacyBenefitLine {
  table: string;
  gym_id: string | null;
  /** The Membership Plan (catalogue) or the Assigned Plan (snapshot) the line sits on. */
  owner_id: number | null;
  owner_name: string | null;
  product_id: number | null;
  product_name: string | null;
  quantity: number;
  action: string;
  value: string | number | null;
}

export interface LegacyBenefitReport {
  catalogue: LegacyBenefitLine[];
  assignments: LegacyBenefitLine[];
}

const LEGACY = LEGACY_PLAN_BENEFIT_ACTIONS.map((a) => `'${a}'`).join(', ');

function catalogueSql(table: string): string {
  return `SELECT '${table}' AS \`table\`, b.gym_id,
                 b.membership_plan_id AS owner_id, mp.name AS owner_name,
                 b.product_id, p.name AS product_name, b.quantity, b.\`action\`, b.\`value\`
          FROM ${table} b
          LEFT JOIN membership_plans mp ON mp.id = b.membership_plan_id
          LEFT JOIN products p ON p.id = b.product_id
          WHERE b.\`action\` IN (${LEGACY})
          ORDER BY b.gym_id ASC, b.membership_plan_id ASC, b.product_id ASC`;
}

function assignmentSql(table: string): string {
  return `SELECT '${table}' AS \`table\`, b.gym_id,
                 b.user_membership_id AS owner_id, mp.name AS owner_name,
                 b.product_id, p.name AS product_name, b.quantity, b.\`action\`, b.\`value\`
          FROM ${table} b
          LEFT JOIN user_memberships um ON um.id = b.user_membership_id
          LEFT JOIN membership_plans mp ON mp.id = um.membership_plan_id
          LEFT JOIN products p ON p.id = b.product_id
          WHERE b.\`action\` IN (${LEGACY})
          ORDER BY b.gym_id ASC, b.user_membership_id ASC, b.product_id ASC`;
}

export async function buildLegacyBenefitReport(): Promise<LegacyBenefitReport> {
  const catalogue: LegacyBenefitLine[] = [];
  for (const table of PLAN_CATALOGUE_TABLES) {
    const { rows } = await db.query<LegacyBenefitLine>(catalogueSql(table));
    catalogue.push(...rows);
  }
  const assignments: LegacyBenefitLine[] = [];
  for (const table of PLAN_ASSIGNMENT_TABLES) {
    const { rows } = await db.query<LegacyBenefitLine>(assignmentSql(table));
    assignments.push(...rows);
  }
  return { catalogue, assignments };
}

function describe(row: LegacyBenefitLine, ownerLabel: string): string {
  const product = row.product_name ?? `product #${row.product_id ?? '—'}`;
  const owner = row.owner_name ?? '—';
  return `  gym ${row.gym_id ?? '—'}  ${ownerLabel} #${row.owner_id ?? '—'} ${owner}`
    + `  ${product} × ${row.quantity}  ${row.action} ${row.value ?? '—'}%  (${row.table})`;
}

/* istanbul ignore next: the CLI wrapper; buildLegacyBenefitReport is what tests cover. */
async function main() {
  const report = await buildLegacyBenefitReport();
  console.log('Membership Plan benefit lines still configured with % Discount');
  console.log('(correct each in the Plan\'s Benefit section — pick No benefit or Waive):');
  if (report.catalogue.length === 0) console.log('  none');
  for (const row of report.catalogue) console.log(describe(row, 'plan'));
  console.log('');
  console.log('Assigned Plan snapshot lines carrying % Discount');
  console.log('(what those members were agreed at and what the nightly run charges — left as they are):');
  if (report.assignments.length === 0) console.log('  none');
  for (const row of report.assignments) console.log(describe(row, 'assignment'));
  await db.end();
}

// Only run when invoked directly, so the functions above can be imported by tests.
if (process.argv[1] && process.argv[1].includes('report-plan-percentage-benefits')) {
  main().catch(async (err) => {
    console.error(err);
    await db.end().catch(() => {});
    process.exit(1);
  });
}
