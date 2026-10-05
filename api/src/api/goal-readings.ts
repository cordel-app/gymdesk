import { db } from '../infra/db';
import type { Tx } from '../infra/db';
import {
  EMPTY_READING_SUMMARY,
  type GoalReadingSummary,
  assignReadingPeriods,
  summarizeReadings,
  toGoalReading,
} from '../domain/goalReadings';

/**
 * #1037 — the one place an Assigned Personal Goal's **readings** are read and
 * written, over the pure rules in `api/src/domain/goalReadings.ts`.
 *
 * It exists so the staff surface (`/member-personal-goals`) and the member's own
 * (`/me/personal-goals`) share every query and every projection: the thread's
 * `Q3` puts readings on both sides, and two copies of "which reading is the
 * latest, and what percentage is that" is exactly how the Member card and My
 * Goals would come to show one member two different progress figures.
 *
 * Two properties are load-bearing:
 *
 * * **A page of assignments costs one query.** `withReadingSummaries()` reads
 *   every reading of the ids it is given in a single statement and summarises
 *   them in memory — never one round trip per row, the rule
 *   `newMemberStatusByMember()` (#927) already follows for a per-row derived
 *   field.
 * * **The gym is always in the predicate.** Every statement here constrains
 *   `gym_id`, and the two routers constrain the assignment itself (`(gym_id,
 *   member_id)` on the member side), so a reading cannot be read or written
 *   across a tenant boundary whatever id a request carries (§35).
 */

const TABLE = 'member_personal_goal_readings';

interface StoredReading {
  id: number;
  member_personal_goal_id: number;
  value: unknown;
  recorded_at: unknown;
  is_initial: unknown;
  created_at: unknown;
  created_by_name: string | null;
  created_by_type: string | null;
}

const COLUMNS = `
  r.id, r.member_personal_goal_id, r.value, r.recorded_at, r.is_initial,
  r.created_at, r.created_by_name, r.created_by_type
`;

/**
 * Every reading of the given assignments, chronological, keyed by assignment —
 * one statement for the whole page. `ORDER BY` carries the id as its
 * tie-breaker for the reason migration 224's index does: §33 allows several
 * readings on one date, and the pair is what makes their order total.
 */
async function loadReadings(
  assignmentIds: number[],
  gymId: string,
): Promise<Map<number, StoredReading[]>> {
  const byAssignment = new Map<number, StoredReading[]>();
  const ids = assignmentIds.filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return byAssignment;

  const marks = ids.map(() => '?').join(', ');
  const { rows } = await db.query<StoredReading>(
    `SELECT ${COLUMNS} FROM ${TABLE} r
     WHERE r.gym_id = ? AND r.member_personal_goal_id IN (${marks})
     ORDER BY r.member_personal_goal_id ASC, r.recorded_at ASC, r.id ASC`,
    [gymId, ...ids],
  );
  for (const row of rows) {
    const key = Number(row.member_personal_goal_id);
    const list = byAssignment.get(key);
    if (list) list.push(row);
    else byAssignment.set(key, [row]);
  }
  return byAssignment;
}

/** mysql2 hands a DECIMAL back as a string; every number this API reports is a number. */
function toNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * One reading on the wire. `period` is §38's answer — which initial-reading
 * period the reading falls in — reported rather than left to the page, so the
 * chart (§23/§24) colours periods without deciding where they start.
 *
 * The actor pair is projected only for the staff surface: who recorded a
 * measurement is an administrative fact, and the member's own screen shows the
 * measurement (the rule `/me/personal-goals`' own `COLUMNS` already applies to
 * the assignment).
 */
function shapeReading(
  row: StoredReading,
  period: number | undefined,
  includeActor: boolean,
) {
  const base = {
    id: Number(row.id),
    value: toNumberOrNull(row.value),
    recorded_at: row.recorded_at,
    is_initial: row.is_initial === 1 || row.is_initial === true || row.is_initial === '1',
    period: period ?? 0,
  };
  if (!includeActor) return base;
  return {
    ...base,
    created_at: row.created_at,
    created_by_name: row.created_by_name,
    created_by_type: row.created_by_type,
  };
}

function summarize(rows: StoredReading[] | undefined, target: number | null): GoalReadingSummary {
  if (!rows || rows.length === 0) return { ...EMPTY_READING_SUMMARY };
  const readings = rows.map(toGoalReading).filter((r): r is NonNullable<typeof r> => r !== null);
  return summarizeReadings(readings, target);
}

/**
 * The §5–§11 header fields, added to every assignment-shaped row a list or a
 * single read answers with. They are **computed on read** (migration 224's
 * header says why there is no stored copy), so a reading added a second ago is
 * already in them.
 */
export async function withReadingSummaries<T extends { id: unknown; target_value: number | null }>(
  rows: T[],
  gymId: string,
): Promise<(T & GoalReadingSummary)[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => Number(row.id));
  const byAssignment = await loadReadings(ids, gymId);
  return rows.map((row) => ({
    ...row,
    ...summarize(byAssignment.get(Number(row.id)), row.target_value),
  }));
}

/** The single-row form of the above. */
export async function withReadingSummary<T extends { id: unknown; target_value: number | null }>(
  row: T,
  gymId: string,
): Promise<T & GoalReadingSummary> {
  const [shaped] = await withReadingSummaries([row], gymId);
  return shaped;
}

/**
 * One assignment's whole reading history plus its summary — what both
 * `GET /:id/readings` routes answer with.
 *
 * Reported oldest-first; §19's newest-first history and §17's chronological
 * chart are the same rows read in opposite directions, so the order is the
 * chart's and the list reverses it rather than the API answering twice.
 */
export async function loadGoalReadings(
  assignmentId: number,
  gymId: string,
  target: number | null,
  { includeActor }: { includeActor: boolean },
) {
  const rows = (await loadReadings([assignmentId], gymId)).get(assignmentId) ?? [];
  const readings = rows.map(toGoalReading).filter((r): r is NonNullable<typeof r> => r !== null);
  const periods = assignReadingPeriods(readings);
  return {
    readings: rows.map((row) => shapeReading(row, periods.get(Number(row.id)), includeActor)),
    ...summarize(rows, target),
  };
}

/**
 * Records one reading. The only writer, so the `is_initial` flag — which is
 * what makes a reading an initial-reading period boundary (§21) — can only be
 * set by a caller that says so explicitly, and never by a field a client
 * passed through.
 *
 * Takes an executor rather than reaching for the pool, because a reading
 * written when a goal is assigned (§4) belongs to the same transaction as the
 * assignment: an initial reading that landed without its assignment, or an
 * assignment whose first reading was lost, are both states no read could
 * explain.
 */
export async function insertGoalReading(
  exec: Tx | typeof db,
  input: {
    gymId: string;
    assignmentId: number;
    value: number;
    recordedAt: string | undefined;
    isInitial: boolean;
    actorName: string | null;
    actorType: string | null;
  },
): Promise<number> {
  const { insertId } = await exec.query(
    `INSERT INTO ${TABLE}
       (gym_id, member_personal_goal_id, value, recorded_at, is_initial,
        created_by_name, created_by_type)
     VALUES (?, ?, ?, COALESCE(?, UTC_TIMESTAMP()), ?, ?, ?)`,
    [
      input.gymId, input.assignmentId, input.value,
      input.recordedAt ?? null, input.isInitial ? 1 : 0,
      input.actorName, input.actorType,
    ],
  );
  return insertId;
}
