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

const STATEMENT = /^\s*(INSERT\s+(?:IGNORE\s+)?INTO|UPDATE|DELETE\s+FROM)\s+user_memberships\b/i;
const UPDATE = /^\s*UPDATE\s+user_memberships\s+SET\s+([\s\S]*?)\s+WHERE\s+([\s\S]*)$/i;

/** The assignment lifecycle columns and their name on the anchor snapshot. */
const ANCHOR_COLUMNS: Record<string, string> = {
  status: 'assignment_status',
  closed_at: 'assignment_closed_at',
  ends_at: 'assignment_ends_at',
  modified_at: 'assignment_modified_at',
  modified_by: 'assignment_modified_by',
};

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
 * Copies a freshly written legacy row's lifecycle onto the anchor of each assignment named, for a
 * fixture that created the row (and maybe its first snapshot) by hand. Only these rows: never a
 * gym-wide repair, which would overwrite what a real route has since written on another anchor.
 */
export async function mirrorLegacyLifecycle(exec: Exec, userMembershipIds: readonly number[]): Promise<void> {
  const ids = [...new Set(userMembershipIds.map(Number))].filter((id) => id > 0);
  if (ids.length === 0) return;
  await exec.query(
    `UPDATE plan_snapshots a
       JOIN user_memberships um ON um.id = a.source_user_membership_id AND um.gym_id = a.gym_id
        SET a.assignment_status = um.status, a.assignment_closed_at = um.closed_at,
            a.assignment_ends_at = um.ends_at, a.assignment_modified_at = um.modified_at,
            a.assignment_modified_by = um.modified_by
      WHERE a.assignment_id = a.id AND um.id IN (${ids.map(() => '?').join(',')})`, ids);
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
    // The rows an UPDATE touches, read before it runs (its WHERE may name the columns it changes).
    const { rows } = await exec.query<{ id: number }>(`SELECT id FROM user_memberships WHERE ${m[2]}`, whereParams);
    const result = await exec.query<T>(sql, params as any[]);
    const anchorSets: string[] = []; const anchorParams: unknown[] = [];
    let offset = 0;
    for (const assignment of splitTopLevel(m[1])) {
      const a = assignment.match(/^(\w+)\s*=\s*([\s\S]+)$/);
      if (!a) throw new Error(`testAssignmentWrite: cannot read ${assignment}`);
      const need = placeholders(a[2]);
      const anchorColumn = ANCHOR_COLUMNS[a[1]];
      if (anchorColumn) { anchorSets.push(`${anchorColumn} = ${a[2]}`); anchorParams.push(...setParams.slice(offset, offset + need)); }
      offset += need;
    }
    const ids = rows.map((r) => Number(r.id));
    if (anchorSets.length > 0 && ids.length > 0) {
      await exec.query(
        `UPDATE plan_snapshots SET ${anchorSets.join(', ')}
          WHERE assignment_id = id AND source_user_membership_id IN (${ids.map(() => '?').join(',')})`,
        [...anchorParams, ...ids]);
    }
    return result;
  }

  const result = await exec.query<T>(sql, params as any[]);
  if (mirror && result.insertId > 0) await mirrorLegacyLifecycle(exec, [result.insertId]);
  return result;
}
