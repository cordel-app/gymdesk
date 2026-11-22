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
import { repairAnchorLifecycles } from '../api/plan-assignment-sync';

type Exec = { query: <T = any>(sql: string, params?: any[]) => Promise<QueryResult<T>> };

export interface TestAssignmentWriteOptions {
  /** The connection or transaction to write on; the pool by default. */
  exec?: Exec;
  /**
   * `false` writes the legacy row alone, for a test of the drift report that needs the two records to
   * disagree. Every other fixture mirrors.
   */
  mirror?: boolean;
}

const STATEMENT = /^\s*(INSERT\s+(?:IGNORE\s+)?INTO|UPDATE|DELETE\s+FROM)\s+user_memberships\b/i;
const UPDATE = /^\s*UPDATE\s+user_memberships\s+SET\s+([\s\S]*?)\s+WHERE\s+([\s\S]*)$/i;

const placeholders = (sql: string) => (sql.match(/\?/g) ?? []).length;

/** Runs one legacy-shaped assignment write and mirrors the rows it wrote onto their anchors. */
export async function testAssignmentWrite<T = any>(
  sql: string, params: unknown[] = [], opts: TestAssignmentWriteOptions = {},
): Promise<QueryResult<T>> {
  const exec: Exec = opts.exec ?? (db as unknown as Exec);
  const kind = sql.match(STATEMENT)?.[1]?.toUpperCase();
  if (!kind) throw new Error(`testAssignmentWrite: not a user_memberships write: ${sql.slice(0, 80)}`);
  const mirror = opts.mirror !== false && !kind.startsWith('DELETE');

  // The gyms an UPDATE touches, read before it runs (its WHERE may name the columns it changes).
  let gyms: string[] = [];
  if (mirror && kind === 'UPDATE') {
    const m = sql.match(UPDATE);
    if (!m) throw new Error(`testAssignmentWrite: cannot read the WHERE of ${sql.slice(0, 80)}`);
    const whereParams = params.slice(placeholders(m[1]));
    const { rows } = await exec.query<{ gym_id: string }>(
      `SELECT DISTINCT gym_id FROM user_memberships WHERE ${m[2]}`, whereParams);
    gyms = rows.map((r) => String(r.gym_id));
  }

  const result = await exec.query<T>(sql, params as any[]);

  if (mirror && kind !== 'UPDATE' && result.insertId > 0) {
    const { rows } = await exec.query<{ gym_id: string }>(
      'SELECT gym_id FROM user_memberships WHERE id = ?', [result.insertId]);
    gyms = rows.map((r) => String(r.gym_id));
  }
  for (const gym of gyms) await repairAnchorLifecycles(exec, gym);
  return result;
}
