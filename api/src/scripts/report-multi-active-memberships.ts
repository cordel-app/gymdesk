/**
 * Read-only report: which Members hold more than one live Membership Plan.
 *
 *   npm run memberships:multi-active
 *
 * #956 makes "one member, one Membership Plan" the rule, and the ticket asks
 * that the Members already violating it be **identified before** anything is
 * cancelled ("Existing members with multiple active plans"). This is that
 * identification step: it writes nothing, so it is safe to run against
 * production, and it is what to run before `npm run db:migrate` applies
 * migration 213.
 *
 * It reports the two kinds of violation separately, because only one of them is
 * swept:
 *
 *   - **owned** — the same Member owns several live assignments. Migration 213
 *     cancels all but the current one (`active` before `paused`, then the latest
 *     `starts_at`, then the latest row), because the restored UNIQUE index on
 *     `active_member_key` cannot be created while they exist. The `keeper`
 *     column names the row that survives, so this report says in advance exactly
 *     what the migration will do.
 *   - **covered** — a Member who is a covered member of one live assignment
 *     (typically a family plan someone else owns) *and* is covered by another.
 *     The index is keyed on the owner, so these survive the migration
 *     untouched: cancelling a family plan because one of the people it covers
 *     has their own would take it away from everyone else on it. The API
 *     refuses every *new* assignment for such a Member, so the set can only
 *     shrink; resolving the ones that exist is the gym's call, which is what
 *     this half of the report is for.
 *
 * It also reports the one thing that makes migration 213 **refuse to run**: a
 * live assignment with no `gym_id`. That column is nullable on
 * `user_memberships` and NOT NULL on `billing_events`, so the ledger row the
 * sweep writes for such a row cannot be inserted. Better to see it here, with
 * the ids, than as a driver-level null error at migrate time.
 *
 * Why a script and not a route: it answers a question about every gym at once
 * and has no tenant context, exactly like the other operator scripts here.
 */

import { config } from 'dotenv';
import { db } from '../infra/db';
import { LIVE_ASSIGNMENT_STATUSES } from '../domain/oneActivePlan';

config();

export interface MultiActiveAssignment {
  user_membership_id: number;
  gym_id: string;
  owner_member_id: number;
  owner_member_name: string | null;
  membership_plan_id: number | null;
  membership_plan_name: string | null;
  status: string;
  starts_at: string;
  /** True for the one row migration 213 keeps. Only set on an `owned` conflict. */
  keeper?: boolean;
}

export interface MultiActiveReport {
  /** Keyed by the owning member; what migration 213 sweeps. */
  owned: Array<{ member_id: number; member_name: string | null; assignments: MultiActiveAssignment[] }>;
  /** Keyed by the covered member; what migration 213 deliberately leaves. */
  covered: Array<{ member_id: number; member_name: string | null; assignments: MultiActiveAssignment[] }>;
  /** Live assignments with no `gym_id`: migration 213 refuses to run while any exists. */
  orphans: Array<{ user_membership_id: number; owner_member_id: number; status: string }>;
}

const LIVE = LIVE_ASSIGNMENT_STATUSES.map((s) => `'${s}'`).join(', ');

/**
 * The same ordering migration 213's sweep uses, so the `keeper` this reports is
 * the row that migration keeps. Expressed in SQL rather than in JS for the
 * reason every date comparison in this codebase is: `starts_at` is a DATE and
 * must not cross a timezone conversion to be compared.
 */
const LIVE_ASSIGNMENTS_SQL = `
  SELECT um.id AS user_membership_id, um.gym_id, um.member_id AS owner_member_id,
         m.name AS owner_member_name,
         um.membership_plan_id, mp.name AS membership_plan_name, um.status,
         DATE_FORMAT(um.starts_at, '%Y-%m-%d') AS starts_at
  FROM user_memberships um
  JOIN members m ON m.id = um.member_id
  LEFT JOIN membership_plans mp ON mp.id = um.membership_plan_id
  WHERE um.status IN (${LIVE})
  ORDER BY um.gym_id ASC, (um.status = 'active') DESC, um.starts_at DESC, um.id DESC
`;

export async function buildMultiActiveReport(): Promise<MultiActiveReport> {
  const { rows: orphans } = await db.query<{
    user_membership_id: number; owner_member_id: number; status: string;
  }>(
    `SELECT id AS user_membership_id, member_id AS owner_member_id, status
     FROM user_memberships
     WHERE status IN (${LIVE}) AND gym_id IS NULL
     ORDER BY id ASC`,
  );
  const { rows: live } = await db.query<MultiActiveAssignment>(LIVE_ASSIGNMENTS_SQL);
  if (live.length === 0) return { owned: [], covered: [], orphans };

  const byId = new Map(live.map((row) => [Number(row.user_membership_id), row]));

  // Owned: group by the owning member, in the sweep's own order.
  const ownedGroups = new Map<number, MultiActiveAssignment[]>();
  for (const row of live) {
    const list = ownedGroups.get(Number(row.owner_member_id)) ?? [];
    list.push(row);
    ownedGroups.set(Number(row.owner_member_id), list);
  }

  // Covered: group by every member each live assignment covers, owner included.
  const { rows: coveredRows } = await db.query<{
    user_membership_id: number; member_id: number; member_name: string | null;
  }>(
    `SELECT umm.user_membership_id, umm.member_id, m.name AS member_name
     FROM user_membership_members umm
     JOIN members m ON m.id = umm.member_id
     JOIN user_memberships um ON um.id = umm.user_membership_id
     WHERE um.status IN (${LIVE})`,
  );
  const coveredGroups = new Map<number, { name: string | null; ids: number[] }>();
  for (const row of coveredRows) {
    const entry = coveredGroups.get(Number(row.member_id)) ?? { name: row.member_name, ids: [] };
    entry.ids.push(Number(row.user_membership_id));
    coveredGroups.set(Number(row.member_id), entry);
  }

  const owned: MultiActiveReport['owned'] = [];
  for (const [memberId, assignments] of ownedGroups) {
    if (assignments.length < 2) continue;
    owned.push({
      member_id: memberId,
      member_name: assignments[0].owner_member_name,
      assignments: assignments.map((row, i) => ({ ...row, keeper: i === 0 })),
    });
  }

  const covered: MultiActiveReport['covered'] = [];
  for (const [memberId, entry] of coveredGroups) {
    if (entry.ids.length < 2) continue;
    // Already reported as an `owned` conflict, and about to be swept — listing
    // it twice would read as two problems where there is one.
    if ((ownedGroups.get(memberId)?.length ?? 0) > 1) continue;
    covered.push({
      member_id: memberId,
      member_name: entry.name,
      assignments: entry.ids
        .map((id) => byId.get(id))
        .filter((row): row is MultiActiveAssignment => row !== undefined),
    });
  }

  owned.sort((a, b) => a.member_id - b.member_id);
  covered.sort((a, b) => a.member_id - b.member_id);
  return { owned, covered, orphans };
}

function describe(row: MultiActiveAssignment): string {
  const plan = row.membership_plan_name ?? `plan #${row.membership_plan_id ?? '—'}`;
  const mark = row.keeper === true ? ' ← keeper' : row.keeper === false ? ' ← will be cancelled' : '';
  return `      #${row.user_membership_id}  ${row.status.padEnd(7)}  from ${row.starts_at}  ${plan}${mark}`;
}

/* istanbul ignore next: the CLI wrapper; buildMultiActiveReport is what tests cover. */
async function main() {
  const report = await buildMultiActiveReport();
  console.log('Members owning more than one live Membership Plan (migration 213 sweeps these):');
  if (report.owned.length === 0) console.log('  none');
  for (const group of report.owned) {
    console.log(`  member #${group.member_id} ${group.member_name ?? ''} (gym ${group.assignments[0].gym_id})`);
    for (const row of group.assignments) console.log(describe(row));
  }
  console.log('');
  console.log('Members covered by more than one live Membership Plan (left as they are — resolve by hand):');
  if (report.covered.length === 0) console.log('  none');
  for (const group of report.covered) {
    console.log(`  member #${group.member_id} ${group.member_name ?? ''}`);
    for (const row of group.assignments) console.log(describe(row));
  }
  console.log('');
  console.log('Live assignments with no gym_id (migration 213 refuses to run while any exists):');
  if (report.orphans.length === 0) console.log('  none');
  for (const row of report.orphans) {
    console.log(`  #${row.user_membership_id}  ${row.status}  owner member #${row.owner_member_id}`);
  }
  await db.end();
}

// Only run when invoked directly, so the functions above can be imported by tests.
if (process.argv[1] && process.argv[1].includes('report-multi-active-memberships')) {
  main().catch(async (err) => {
    console.error(err);
    await db.end().catch(() => {});
    process.exit(1);
  });
}
