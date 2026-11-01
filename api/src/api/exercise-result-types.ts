import { Tx } from '../infra/db';
import { BASE_EXERCISE_TABLES, ExerciseTables, LEGACY_EXERCISE_TABLES } from '../domain/exerciseTables';
import { resultTypeSlugsForCategory, normalizeExerciseCategory } from '../domain/exerciseCategories';

/**
 * #1360 stage 2: the one writer of `exercise_allowed_result_types`.
 *
 * An exercise's Recorded Metrics are derived from its category
 * (`CATEGORY_RESULT_TYPE_SLUGS`), so the join table is a materialised view of
 * that mapping and never a second source of truth. Every router and the
 * importer write it through here.
 *
 * - supported category → the rows are replaced with exactly the derived set;
 * - missing / unsupported category → the stored rows are left alone (nothing
 *   is guessed, reads and edits keep working).
 */
export async function derivedResultTypeIds(tx: Tx, category: unknown): Promise<number[] | null> {
  const slugs = resultTypeSlugsForCategory(category);
  if (!slugs) return null;
  const { rows } = await tx.query(
    `SELECT id FROM result_types WHERE slug IN (${slugs.map(() => '?').join(',')}) ORDER BY id`,
    [...slugs],
  );
  return rows.map((r: any) => Number(r.id));
}

/** Replace the exercise's rows with the set its category derives. No-op without a supported category. */
export async function syncExerciseResultTypes(tx: Tx, exerciseId: number | string, category: unknown, tables: ExerciseTables = LEGACY_EXERCISE_TABLES): Promise<void> {
  const ids = await derivedResultTypeIds(tx, category);
  if (!ids) return;
  await tx.query(`DELETE FROM ${tables.resultTypes} WHERE exercise_id = ?`, [exerciseId]);
  for (const id of ids) {
    await tx.query(
      `INSERT IGNORE INTO ${tables.resultTypes} (exercise_id, result_type_id) VALUES (?, ?)`,
      [exerciseId, id],
    );
  }
}

/**
 * #2225: Recorded Metrics are configured per exercise. The category only seeds
 * the default set of a NEW exercise (and the importer / backfill); once an
 * exercise exists, changing its category never rewrites its metrics.
 */
export interface RecordedMetricsRequest {
  /** Requested metric ids; `undefined` when the request does not mention them (keep what is stored). */
  ids: number[] | undefined;
  /** The administrator confirmed the permanent deletion of recordings of removed metrics. */
  confirm: boolean;
}

export function parseRecordedMetricsRequest(body: Record<string, any> | undefined): RecordedMetricsRequest {
  const raw = body?.allowed_result_type_ids;
  const confirm = body?.confirm_metric_removal === true;
  if (raw === undefined || raw === null) return { ids: undefined, confirm };
  if (!Array.isArray(raw)) throw Object.assign(new Error('allowed_result_type_ids must be an array of ids.'), { status: 400 });
  const ids = [...new Set(raw.map(Number))];
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw Object.assign(new Error('allowed_result_type_ids must be an array of ids.'), { status: 400 });
  }
  if (ids.length === 0) {
    throw Object.assign(new Error('An exercise needs at least one recorded metric.'), { status: 400 });
  }
  return { ids: ids.sort((a, b) => a - b), confirm };
}

/** Slugs whose member recordings are stored: weight/reps on sets, duration on the log. */
const RECORDED_SLUGS = ['weight', 'repetitions', 'duration'] as const;

export interface MetricRecordings { id: number; slug: string; count: number }

function logScope(tables: ExerciseTables, exerciseId: number | string, gymId: string | null): { where: string; params: any[] } {
  if (tables === BASE_EXERCISE_TABLES) return { where: 'l.base_exercise_id = ?', params: [exerciseId] };
  return { where: 'l.exercise_id = ? AND l.gym_id = ?', params: [exerciseId, gymId] };
}

async function countRecordings(tx: Tx, slug: string, scope: { where: string; params: any[] }): Promise<number> {
  let sql: string;
  if (slug === 'weight' || slug === 'repetitions') {
    const col = slug === 'weight' ? 's.weight' : 's.reps';
    sql = `SELECT COUNT(*) AS n FROM exercise_log_sets s JOIN exercise_logs l ON l.id = s.exercise_log_id WHERE ${scope.where} AND ${col} IS NOT NULL`;
  } else {
    sql = `SELECT COUNT(*) AS n FROM exercise_logs l WHERE ${scope.where} AND l.duration_seconds IS NOT NULL`;
  }
  const { rows } = await tx.query(sql, scope.params);
  return Number(rows[0]?.n ?? 0);
}

async function deleteRecordings(tx: Tx, slug: string, scope: { where: string; params: any[] }): Promise<void> {
  if (slug === 'weight' || slug === 'repetitions') {
    const col = slug === 'weight' ? 's.weight' : 's.reps';
    await tx.query(
      `UPDATE exercise_log_sets s JOIN exercise_logs l ON l.id = s.exercise_log_id SET ${col} = NULL WHERE ${scope.where}`,
      scope.params,
    );
    // A set left with nothing recorded is not a reading any more.
    await tx.query(
      `DELETE s FROM exercise_log_sets s JOIN exercise_logs l ON l.id = s.exercise_log_id
        WHERE ${scope.where} AND s.weight IS NULL AND s.reps IS NULL AND s.rpe IS NULL`,
      scope.params,
    );
  } else {
    await tx.query(`UPDATE exercise_logs l SET l.duration_seconds = NULL WHERE ${scope.where}`, scope.params);
  }
}

/**
 * Replace the exercise's Recorded Metrics with `requested`. Metrics being removed that already
 * hold member recordings need `confirm`: without it a 409 `metric_removal_requires_confirmation`
 * lists them with counts and nothing changes; with it the recordings are hard-deleted in the
 * same transaction (scoped to this exercise — a gym's own, or for a Base Exercise every member
 * who logged it).
 */
export async function applyRecordedMetrics(
  tx: Tx,
  exerciseId: number | string,
  gymId: string | null,
  request: RecordedMetricsRequest,
  tables: ExerciseTables = LEGACY_EXERCISE_TABLES,
): Promise<{ removed: MetricRecordings[] }> {
  if (!request.ids) return { removed: [] };
  const { rows: known } = await tx.query(
    `SELECT id, slug FROM result_types WHERE id IN (${request.ids.map(() => '?').join(',')})`, request.ids,
  );
  if (known.length !== request.ids.length) {
    throw Object.assign(new Error('allowed_result_type_ids contains an unknown result type.'), { status: 400 });
  }
  const { rows: current } = await tx.query(
    `SELECT a.result_type_id AS id, rt.slug FROM ${tables.resultTypes} a JOIN result_types rt ON rt.id = a.result_type_id
      WHERE a.exercise_id = ?`, [exerciseId],
  );
  const wanted = new Set(request.ids);
  const scope = logScope(tables, exerciseId, gymId);
  const withData: MetricRecordings[] = [];
  for (const r of current) {
    if (wanted.has(Number(r.id)) || !(RECORDED_SLUGS as readonly string[]).includes(r.slug)) continue;
    const count = await countRecordings(tx, r.slug, scope);
    if (count > 0) withData.push({ id: Number(r.id), slug: r.slug, count });
  }
  if (withData.length > 0 && !request.confirm) {
    throw Object.assign(new Error('Removing these metrics permanently deletes member recordings.'), {
      status: 409, code: 'metric_removal_requires_confirmation', metrics: withData,
    });
  }
  for (const m of withData) await deleteRecordings(tx, m.slug, scope);
  await tx.query(`DELETE FROM ${tables.resultTypes} WHERE exercise_id = ?`, [exerciseId]);
  for (const id of request.ids) {
    await tx.query(`INSERT IGNORE INTO ${tables.resultTypes} (exercise_id, result_type_id) VALUES (?, ?)`, [exerciseId, id]);
  }
  return { removed: withData };
}

/** Category the row will have after the write: the request's when provided, else the stored one. */
export async function effectiveCategory(
  tx: Tx,
  exerciseId: number | string,
  categoryInput: { provided: boolean; value: string | null },
  tables: ExerciseTables = LEGACY_EXERCISE_TABLES,
): Promise<string | null> {
  if (categoryInput.provided) return normalizeExerciseCategory(categoryInput.value);
  const { rows } = await tx.query(`SELECT category FROM ${tables.exercises} WHERE id = ?`, [exerciseId]);
  return rows.length ? normalizeExerciseCategory(rows[0].category) : null;
}

/** Answer the 409 `applyRecordedMetrics` throws; returns false for any other error. */
export function respondMetricRemoval(err: any, res: { status: (n: number) => { json: (b: any) => any } }): boolean {
  if (err?.code !== 'metric_removal_requires_confirmation') return false;
  res.status(409).json({ error: err.message, code: err.code, metrics: err.metrics });
  return true;
}
