/**
 * #2125 M6b-51d-5 — the one door through which a test writes an assignment in the legacy
 * `user_memberships` shape.
 *
 * About a hundred fixtures still spell `INSERT INTO` / `UPDATE` / `DELETE FROM user_memberships`.
 * Since M6b-51d-7c-2 that table no longer exists: an assignment is its plan snapshots, whose anchor
 * carries its identity and lifecycle. This door keeps the fixtures' rows here, in memory, until the
 * fixture gives the row its first snapshot; then it copies the row's lifecycle onto the anchor
 * (`mirrorLegacyLifecycle()`) and the snapshots are the record from then on. An `UPDATE` reaches the
 * anchor and snapshots of the rows it names (the same expressions and values), as the production
 * writers do; a `DELETE` forgets a row not anchored yet. `fixtureAssignments()` is every assignment a
 * fixture can name, under the legacy column names.
 *
 * `legacyAssignmentQuery()` (helpers.ts) goes through it too; the gate in
 * `plan-assignment-legacy-readers.unit.test.ts` fails the build on a test statement on the table that
 * does not.
 */
import { escape } from 'mysql2';
import { db, type QueryResult } from '../infra/db';
import { TEST_ASSIGNMENTS } from './assignmentReads';
import { reserveHandAssignmentId } from './handAnchor';

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

/** The legacy columns a fixture row carries; any other column a statement names is ignored. */
const COLUMNS = [
  'id', 'gym_id', 'member_id', 'membership_plan_id', 'status', 'starts_at', 'ends_at', 'closed_at',
  'created_at', 'created_by', 'modified_at', 'modified_by', 'deleted_at', 'deleted_by', 'purchased_at',
  'replace_on_activation', 'replaces_user_membership_id',
] as const;
type Column = typeof COLUMNS[number];
type HandRow = Partial<Record<Column, unknown>> & { id: number; gym_id: string };
const DATE_COLUMNS = new Set<Column>(['starts_at', 'ends_at']);

/** The rows fixtures wrote by hand, by assignment id (this test file's process only). */
const handRows = new Map<number, HandRow>();

/** A value as a fixture row stores it: dates as `YYYY-MM-DD`, times as UTC `YYYY-MM-DD HH:MM:SS`. */
function stored(column: Column, value: unknown): unknown {
  if (value instanceof Date) {
    const iso = value.toISOString();
    return DATE_COLUMNS.has(column) ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
  }
  if (Buffer.isBuffer(value)) return value.toString();
  return value;
}

/** A hand-written row, for a fixture that needs its values. */
export function handRow(id: number): HandRow | undefined {
  return handRows.get(Number(id));
}

const handRowsSql = (): string => {
  const select = (r: Partial<HandRow> | null) => `SELECT ${COLUMNS.map((c) => `${r ? escape(r[c] ?? null) : 'NULL'} AS ${c}`).join(', ')}`;
  if (handRows.size === 0) return `(${select(null)} FROM DUAL WHERE FALSE)`;
  return `(${[...handRows.values()].map((r) => select(r)).join(' UNION ALL ')})`;
};

/**
 * #2125 M6b-51d-7c-1/2 — every assignment a fixture can name, under the legacy column names: an
 * anchored one off its snapshots (`TEST_ASSIGNMENTS`), and a row a fixture wrote by hand whose first
 * snapshot does not exist yet off this module's memory. Read it fresh per statement.
 */
export function fixtureAssignments(): string {
  const cols = COLUMNS.join(', ');
  return `(
  SELECT ${cols} FROM ${TEST_ASSIGNMENTS} ta
  UNION ALL
  SELECT ${cols} FROM ${handRowsSql()} hw
   WHERE NOT EXISTS (SELECT 1 FROM plan_snapshots a
                      WHERE a.gym_id = hw.gym_id AND a.anchor_plan_snapshot_id = hw.id AND a.anchor_plan_snapshot_id = a.id))`;
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
  for (const id of ids) {
    const r = handRows.get(id);
    if (!r) { awaitingAnchor.delete(id); continue; }
    const { rowCount } = await exec.query(
      `UPDATE plan_snapshots SET assignment_status = ?, assignment_closed_at = ?, assignment_ends_at = ?,
              assignment_modified_at = ?, assignment_modified_by = ?
        WHERE anchor_plan_snapshot_id = id AND anchor_plan_snapshot_id = ? AND gym_id = ?`,
      [r.status ?? 'active', r.closed_at ?? null, r.ends_at ?? null, r.modified_at ?? null, r.modified_by ?? null,
        id, r.gym_id]);
    if (Number(rowCount) > 0) awaitingAnchor.delete(id);
  }
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
  const kind = sql.match(STATEMENT)?.[1]?.toUpperCase().replace(/\s+/g, ' ');
  if (!kind) throw new Error(`testAssignmentWrite: not a user_memberships write: ${sql.slice(0, 80)}`);
  const mirror = opts.mirror !== false;

  if (kind.startsWith('INSERT')) return insertHandRow<T>(exec, sql, params, mirror);

  if (kind.startsWith('DELETE')) {
    const m = sql.match(/^\s*DELETE\s+FROM\s+user_memberships\s+WHERE\s+([\s\S]*)$/i);
    if (!m) throw new Error(`testAssignmentWrite: cannot read the DELETE ${sql.slice(0, 80)}`);
    const { rows } = await exec.query<{ id: number }>(`SELECT id FROM ${fixtureAssignments()} x WHERE ${m[1]}`, params as any[]);
    // An anchored assignment is its snapshots, which the caller deals with; only a hand row goes.
    for (const r of rows) { handRows.delete(Number(r.id)); awaitingAnchor.delete(Number(r.id)); }
    return { rows: [], rowCount: rows.length, insertId: 0 } as QueryResult<T>;
  }

  const m = sql.match(UPDATE);
  if (!m) throw new Error(`testAssignmentWrite: cannot read the WHERE of ${sql.slice(0, 80)}`);
  const setParams = params.slice(0, placeholders(m[1]));
  const whereParams = params.slice(placeholders(m[1]));
  // The rows an UPDATE touches, read before it runs (its WHERE may name the columns it changes).
  const { rows } = await exec.query<{ id: number }>(
    `SELECT id FROM ${fixtureAssignments()} x WHERE ${m[2]}`, whereParams);
  const ids = rows.map((r) => Number(r.id));
  const assignments = splitTopLevel(m[1]).map((assignment) => {
    const a = assignment.match(/^(\w+)\s*=\s*([\s\S]+)$/);
    if (!a) throw new Error(`testAssignmentWrite: cannot read ${assignment}`);
    return { column: a[1], expr: a[2] };
  });

  // A hand row takes the new values, each expression evaluated against the row as it stood.
  const known = assignments.filter((a) => (COLUMNS as readonly string[]).includes(a.column) && a.column !== 'id');
  for (const id of ids.filter((i) => handRows.has(i))) {
    let offset = 0; const exprs: string[] = []; const exprParams: unknown[] = [];
    for (const a of assignments) {
      const need = placeholders(a.expr);
      if (known.includes(a)) { exprs.push(`${a.expr} AS ${a.column}`); exprParams.push(...setParams.slice(offset, offset + need)); }
      offset += need;
    }
    if (exprs.length === 0) continue;
    const { rows: values } = await exec.query<Record<string, unknown>>(
      `SELECT ${exprs.join(', ')} FROM ${handRowsSql()} x WHERE x.id = ?`, [...exprParams, id]);
    const row = handRows.get(id)!;
    for (const a of known) row[a.column as Column] = stored(a.column as Column, values[0]?.[a.column]);
  }

  if (mirror && ids.length > 0) {
    const anchorSets: string[] = []; const anchorParams: unknown[] = [];
    const snapSets: string[] = []; const snapParams: unknown[] = [];
    let offset = 0;
    for (const a of assignments) {
      const need = placeholders(a.expr);
      const values = setParams.slice(offset, offset + need);
      const anchorColumn = ANCHOR_COLUMNS[a.column];
      if (anchorColumn) { anchorSets.push(`${anchorColumn} = ${a.expr}`); anchorParams.push(...values); }
      if (SNAPSHOT_COLUMNS.has(a.column)) { snapSets.push(`${a.column} = ${a.expr}`); snapParams.push(...values); }
      if (a.column === 'replaces_user_membership_id') {
        if (!/^NULL$/i.test(a.expr.trim())) throw new Error('testAssignmentWrite: only a NULL replacement is translated');
        snapSets.push('replaces_assignment_id = NULL');
      }
      offset += need;
    }
    const named = ids.map(() => '?').join(',');
    if (anchorSets.length > 0) {
      await exec.query(
        `UPDATE plan_snapshots SET ${anchorSets.join(', ')}
          WHERE anchor_plan_snapshot_id = id AND anchor_plan_snapshot_id IN (${named})`,
        [...anchorParams, ...ids]);
    }
    if (snapSets.length > 0) {
      await exec.query(
        `UPDATE plan_snapshots SET ${snapSets.join(', ')} WHERE anchor_plan_snapshot_id IN (${named})`,
        [...snapParams, ...ids]);
    }
  }
  return { rows: [], rowCount: ids.length, insertId: 0 } as QueryResult<T>;
}

/**
 * Keeps an `INSERT INTO user_memberships (…) VALUES (…)` as a hand row under an id from the
 * reserved plan snapshot id (`reserveHandAssignmentId()`), since production derives an id from a snapshot.
 */
async function insertHandRow<T>(exec: Exec, sql: string, params: unknown[], mirror: boolean): Promise<QueryResult<T>> {
  const ins = sql.match(/^\s*INSERT\s+(?:IGNORE\s+)?INTO\s+user_memberships\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)\s*$/i);
  if (!ins) throw new Error(`testAssignmentWrite: cannot read the INSERT ${sql.slice(0, 80)}`);
  const columns = ins[1].split(',').map((c) => c.trim());
  const tokens = splitTopLevel(ins[2]);
  if (columns.length !== tokens.length) throw new Error('testAssignmentWrite: column/value mismatch');
  const { rows: evaluated } = await exec.query<Record<string, unknown>>(
    `SELECT ${tokens.map((t, i) => `${t} AS c${i}`).join(', ')}`, params as any[]);
  const values: Partial<Record<Column, unknown>> = {};
  columns.forEach((c, i) => {
    if ((COLUMNS as readonly string[]).includes(c)) values[c as Column] = stored(c as Column, evaluated[0][`c${i}`]);
  });
  if (values.gym_id == null) throw new Error('testAssignmentWrite: an INSERT names its gym_id');
  // #2125 N2: the id is a reserved plan snapshot id, which the row's first snapshot is re-keyed onto
  // (`handAnchor.ts`), so `anchor_plan_snapshot_id` can name it as it names a real assignment's anchor.
  const id = values.id != null ? Number(values.id)
    : await reserveHandAssignmentId(exec, String(values.gym_id), values.member_id == null ? null : Number(values.member_id));
  const { rows: clock } = await exec.query<{ now: string }>(
    "SELECT DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:%s') AS now");
  handRows.set(id, {
    status: 'active', replace_on_activation: 0, created_at: clock[0].now,
    ...values, id, gym_id: String(values.gym_id),
  });
  if (mirror) {
    awaitingAnchor.add(id);
    await mirrorLegacyLifecycle(exec, [id]);
  }
  return { rows: [], rowCount: 1, insertId: id } as QueryResult<T>;
}
