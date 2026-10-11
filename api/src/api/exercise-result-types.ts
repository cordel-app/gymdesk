import { Tx } from '../infra/db';
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
export async function syncExerciseResultTypes(tx: Tx, exerciseId: number | string, category: unknown): Promise<void> {
  const ids = await derivedResultTypeIds(tx, category);
  if (!ids) return;
  await tx.query('DELETE FROM exercise_allowed_result_types WHERE exercise_id = ?', [exerciseId]);
  for (const id of ids) {
    await tx.query(
      'INSERT IGNORE INTO exercise_allowed_result_types (exercise_id, result_type_id) VALUES (?, ?)',
      [exerciseId, id],
    );
  }
}

/**
 * Throws a 400 when the request names result types that contradict the
 * category. A request that omits `allowed_result_type_ids` is always fine.
 */
export async function assertRequestedResultTypesMatch(
  tx: Tx,
  category: unknown,
  requested: number[] | undefined,
): Promise<void> {
  if (!requested) return;
  const derived = await derivedResultTypeIds(tx, category);
  if (!derived) {
    throw Object.assign(
      new Error('allowed_result_type_ids cannot be set without a supported category; metrics are derived from the category.'),
      { status: 400 },
    );
  }
  const a = [...new Set(requested.map(Number))].sort((x, y) => x - y);
  if (a.length !== derived.length || a.some((v, i) => v !== derived[i])) {
    throw Object.assign(
      new Error('allowed_result_type_ids contradict the exercise category; metrics are derived from the category.'),
      { status: 400 },
    );
  }
}

/** Category the row will have after the write: the request's when provided, else the stored one. */
export async function effectiveCategory(
  tx: Tx,
  exerciseId: number | string,
  categoryInput: { provided: boolean; value: string | null },
): Promise<string | null> {
  if (categoryInput.provided) return normalizeExerciseCategory(categoryInput.value);
  const { rows } = await tx.query('SELECT category FROM exercises WHERE id = ?', [exerciseId]);
  return rows.length ? normalizeExerciseCategory(rows[0].category) : null;
}
