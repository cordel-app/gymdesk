/**
 * #2125 M6b-51d-5 — the one door through which a test writes an assignment in the legacy
 * `user_memberships` shape.
 *
 * About a hundred fixtures still spell `INSERT INTO` / `UPDATE` / `DELETE FROM user_memberships`.
 * Production writes an assignment through `insertAssignment()` / `writeAssignmentLifecycle()`, which
 * keep its anchor snapshot (`assignment_status`, `assignment_closed_at`, `assignment_ends_at`,
 * `assignment_modified_*`) in step with the legacy row; a fixture has no such writer, so this door
 * runs the statement and then mirrors the rows it touched onto their anchors, exactly as the writer
 * would. When the table is dropped (M6b-51d-7) this module is what translates the legacy-shaped
 * statements onto the plan snapshots, and no test file changes.
 *
 * `legacyAssignmentQuery()` (helpers.ts) goes through it too; the gate in
 * `plan-assignment-legacy-readers.unit.test.ts` fails the build on a test write of the table that
 * does not.
 */
import { db, type QueryResult } from '../infra/db';
import { TEST_ASSIGNMENTS } from './assignmentReads';

type Exec = { query: <T = any>(sql: string, params?: any[]) => Promise<QueryResult<T>> };

export interface TestAssignmentWriteOptions {
  /** The connection or transaction to write on; the pool by default. */
  exec?: Exec;
  /**
   * `false` writes the legacy row alone, for a test that proves a reader ignores it (the two records
   * must disagree). Every other fixture mirrors.
   */
  mirror?: boolean;
}

/**
 * #2125 M6b-51d-7c-1 — every assignment a fixture can name, under the legacy column names: an
 * anchored one off its snapshots (`TEST_ASSIGNMENTS`), and a row a fixture wrote by hand whose first
 * snapshot does not exist yet off that row. Production no longer writes `user_memberships`, so an
 * assignment a route created exists only in the first half.
 */
export const FIXTURE_ASSIGNMENTS = `(
  SELECT id, gym_id, member_id, membership_plan_id, status, starts_at, ends_at, closed_at, created_at, created_by, modified_at, modified_by, deleted_at, deleted_by, purchased_at, replace_on_activation, replaces_user_membership_id FROM ${TEST_ASSIGNMENTS} ta
  UNION ALL
  SELECT id, gym_id, member_id, membership_plan_id, status, starts_at, ends_at, closed_at, created_at, created_by, modified_at, modified_by, deleted_at, deleted_by, purchased_at, replace_on_activation, replaces_user_membership_id FROM user_memberships hw
   WHERE NOT EXISTS (SELECT 1 FROM plan_snapshots a
                      WHERE a.gym_id = hw.gym_id AND a.source_user_membership_id = hw.id AND a.assignment_id = a.id))`;

const STATEMENT = /^\s*(INSERT\s+(?:IGNORE\s+)?INTO|UPDATE|DELETE\s+FROM)\s+user_memberships\b/i;
const UPDATE = /^\s*UPDATE\s+user_memberships\s+SET\s+([\s\S]*?)\s+WHERE\s+([\s\S]*)$/i;

/** The assignment lifecycle columns and their name on the anchor snapshot. */
const ANCHOR_COLUMNS: Record<string, string> = {
  status: 'assignment_status',
  closed_at: 'assignment_closed_at',
  ends_at: 'assignment_ends_at',
  modified_at: 'assignment_modified_at',
  modified_by: 'assignment_modified_by',
  created_by: 'created_by',
};

/**
 * The assignment facts every plan snapshot naming the assignment carries (M6b-51b / 51c: dates,
 * purchase time, replacement choice, soft delete); a fixture's change reaches them all, as
 * the sync spreads a real one.
 */
const SNAPSHOT_COLUMNS = new Set([
  'starts_at', 'purchased_at', 'replace_on_activation', 'deleted_at', 'deleted_by',
]);

const placeholders = (sql: string) => (sql.match(/\?/g) ?? []).length;

/** Splits a list on its top-level commas (not inside parentheses or quotes). */
export function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0; let quote: string | null = null; let cur = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * The assignments a fixture inserted by hand whose anchor has not taken the row's lifecycle yet. A row
 * is mirrored once, when its first snapshot exists; from then on the anchor is the record (routes write
 * it, and the legacy row is never updated by production code since M6b-51d-7b), so a later fixture
 * sync must not copy the row's stale values back.
 */
const awaitingAnchor = new Set<number>();

/**
 * Copies a hand-written row's lifecycle onto its anchor, once, for the named rows still awaiting one.
 * Never a gym-wide repair, and never an assignment a production writer created.
 */
export async function mirrorLegacyLifecycle(exec: Exec, userMembershipIds: readonly number[]): Promise<void> {
  const ids = [...new Set(userMembershipIds.map(Number))].filter((id) => id > 0 && awaitingAnchor.has(id));
  if (ids.length === 0) return;
  const marks = ids.map(() => '?').join(',');
  await exec.query(
    `UPDATE plan_snapshots a
       JOIN user_memberships um ON um.id = a.source_user_membership_id AND um.gym_id = a.gym_id
        SET a.assignment_status = um.status, a.assignment_closed_at = um.closed_at,
            a.assignment_ends_at = um.ends_at, a.assignment_modified_at = um.modified_at,
            a.assignment_modified_by = um.modified_by
      WHERE a.assignment_id = a.id AND um.id IN (${marks})`, ids);
  const { rows } = await exec.query<{ id: number }>(
    `SELECT DISTINCT source_user_membership_id AS id FROM plan_snapshots
      WHERE assignment_id = id AND source_user_membership_id IN (${marks})`, ids);
  for (const r of rows) awaitingAnchor.delete(Number(r.id));
}

/**
 * Runs one legacy-shaped assignment write. An `UPDATE` writes the lifecycle columns it sets onto the
 * anchors of the rows it touched too (the same expressions and values), as `writeAssignmentLifecycle()`
 * does; an `INSERT` mirrors the new row onto its anchor once one names it.
 */
export async function testAssignmentWrite<T = any>(
  sql: string, params: unknown[] = [], opts: TestAssignmentWriteOptions = {},
): Promise<QueryResult<T>> {
  const exec: Exec = opts.exec ?? (db as unknown as Exec);
  const kind = sql.match(STATEMENT)?.[1]?.toUpperCase();
  if (!kind) throw new Error(`testAssignmentWrite: not a user_memberships write: ${sql.slice(0, 80)}`);
  const mirror = opts.mirror !== false && !kind.startsWith('DELETE');

  if (mirror && kind === 'UPDATE') {
    const m = sql.match(UPDATE);
    if (!m) throw new Error(`testAssignmentWrite: cannot read the WHERE of ${sql.slice(0, 80)}`);
    const setParams = params.slice(0, placeholders(m[1]));
    const whereParams = params.slice(placeholders(m[1]));
    // The rows an UPDATE touches, read before it runs (its WHERE may name the columns it changes):
    // an assignment a route created has no `user_memberships` row since M6b-51d-7c-1.
    const { rows } = await exec.query<{ id: number }>(
      `SELECT id FROM ${FIXTURE_ASSIGNMENTS} x WHERE ${m[2]}`, whereParams);
    const result = await exec.query<T>(sql, params as any[]);
    const anchorSets: string[] = []; const anchorParams: unknown[] = [];
    const snapSets: string[] = []; const snapParams: unknown[] = [];
    let offset = 0;
    for (const assignment of splitTopLevel(m[1])) {
      const a = assignment.match(/^(\w+)\s*=\s*([\s\S]+)$/);
      if (!a) throw new Error(`testAssignmentWrite: cannot read ${assignment}`);
      const need = placeholders(a[2]);
      const values = setParams.slice(offset, offset + need);
      const anchorColumn = ANCHOR_COLUMNS[a[1]];
      if (anchorColumn) { anchorSets.push(`${anchorColumn} = ${a[2]}`); anchorParams.push(...values); }
      if (SNAPSHOT_COLUMNS.has(a[1])) { snapSets.push(`${a[1]} = ${a[2]}`); snapParams.push(...values); }
      if (a[1] === 'replaces_user_membership_id') {
        if (!/^NULL$/i.test(a[2].trim())) throw new Error('testAssignmentWrite: only a NULL replacement is translated');
        snapSets.push('replaces_assignment_id = NULL');
      }
      offset += need;
    }
    const ids = rows.map((r) => Number(r.id));
    const named = ids.map(() => '?').join(',');
    if (anchorSets.length > 0 && ids.length > 0) {
      await exec.query(
        `UPDATE plan_snapshots SET ${anchorSets.join(', ')}
          WHERE assignment_id = id AND source_user_membership_id IN (${named})`,
        [...anchorParams, ...ids]);
    }
    if (snapSets.length > 0 && ids.length > 0) {
      await exec.query(
        `UPDATE plan_snapshots SET ${snapSets.join(', ')} WHERE source_user_membership_id IN (${named})`,
        [...snapParams, ...ids]);
    }
    return result;
  }

  // #2125 M6b-51d-7c-1: production allocates every id from `plan_assignment_ids` and no longer writes
  // the table, so its own AUTO_INCREMENT would hand out an id a route already used. A hand-written
  // row takes a registry id too.
  let allocated: number | null = null;
  if (kind.startsWith('INSERT')) {
    const ins = sql.match(/^(\s*INSERT\s+(?:IGNORE\s+)?INTO\s+user_memberships\s*)\(([^)]*)\)(\s*VALUES\s*)\(([\s\S]*)\)\s*$/i);
    if (!ins) throw new Error(`testAssignmentWrite: cannot read the INSERT ${sql.slice(0, 80)}`);
    const columns = ins[2].split(',').map((c) => c.trim());
    if (!columns.includes('id')) {
      const tokens = splitTopLevel(ins[4]);
      const g = columns.indexOf('gym_id');
      if (g < 0 || tokens[g] !== '?') throw new Error('testAssignmentWrite: an INSERT names its gym_id as a ?');
      const gymParam = params[tokens.slice(0, g).reduce((n, t) => n + placeholders(t), 0)];
      const { insertId: id } = await exec.query('INSERT INTO plan_assignment_ids (gym_id) VALUES (?)', [gymParam]);
      allocated = Number(id);
      sql = `${ins[1]}(id, ${ins[2]})${ins[3]}(?, ${ins[4]})`;
      params = [allocated, ...params];
    }
  }
  const result = await exec.query<T>(sql, params as any[]);
  if (allocated != null) (result as any).insertId = allocated;
  if (mirror && result.insertId > 0) {
    awaitingAnchor.add(Number(result.insertId));
    await mirrorLegacyLifecycle(exec, [result.insertId]);
  }
  return result;
}
