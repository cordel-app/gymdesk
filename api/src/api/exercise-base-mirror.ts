import { Tx } from '../infra/db';
import { SYSTEM_ACTOR } from '../domain/auditActor';
import { BASE_EXERCISE_TABLES as B, LEGACY_EXERCISE_TABLES as L } from '../domain/exerciseTables';

/**
 * #1849 stage E2 — the transitional mirror of a Base exercise onto the legacy System
 * row of the same id. Cordel's router and the Free Exercise DB importer write
 * `base_exercises`; the plan tables (`workout_template_exercises`, `workout_exercises`,
 * `exercise_logs`, `member_standalone_exercises`) and `exercises.cloned_from_id` still
 * reference the legacy row by id until E3, so the row is kept equal to the Base one.
 * Removed with the legacy System rows in the final Exercises stage.
 */

const COLUMNS = [
  'name', 'description', 'short_description', 'status', 'min_reps_default', 'max_reps_default',
  'rest_default_seconds', 'sets_default', 'source', 'source_id', 'slug', 'equipment', 'category',
  'level', 'mechanic', 'force_type', 'image_male_url', 'image_female_url', 'video_male_url',
  'video_female_url', 'created_at', 'created_by', 'modified_at', 'modified_by', 'deleted_at', 'deleted_by',
] as const;

/**
 * A new Base exercise takes its id from the legacy `exercises` sequence (a placeholder
 * row is inserted and deleted), so Base and gym-owned ids stay disjoint.
 */
export async function reserveBaseExerciseId(tx: Tx): Promise<number> {
  const { insertId } = await tx.query(
    `INSERT INTO exercises (gym_id, name, status, created_by)
     VALUES (NULL, CONCAT('__reserved_id_', UUID()), 'deleted', ?)`,
    [SYSTEM_ACTOR],
  );
  await tx.query('DELETE FROM exercises WHERE id = ?', [insertId]);
  return insertId;
}

/** Copies a Base exercise and its junctions onto the legacy System row of the same id (inside the caller's transaction). */
export async function mirrorExerciseToLegacy(tx: Tx, id: number | string): Promise<void> {
  const cols = COLUMNS.join(', ');
  const updates = COLUMNS.filter((c) => c !== 'created_at').map((c) => `${c} = VALUES(${c})`).join(', ');
  await tx.query(
    `INSERT INTO ${L.exercises} (id, gym_id, ${cols})
     SELECT id, NULL, ${cols} FROM ${B.exercises} WHERE id = ?
     ON DUPLICATE KEY UPDATE ${updates}`,
    [id],
  );
  await tx.query(`DELETE FROM ${L.translations} WHERE exercise_id = ?`, [id]);
  await tx.query(
    `INSERT INTO ${L.translations} (exercise_id, locale, name, created_at, modified_at)
     SELECT exercise_id, locale, name, created_at, modified_at FROM ${B.translations} WHERE exercise_id = ?`,
    [id],
  );
  await tx.query(`DELETE FROM ${L.descriptions} WHERE exercise_id = ?`, [id]);
  await tx.query(
    `INSERT INTO ${L.descriptions} (exercise_id, locale, short_description, description, created_at, modified_at)
     SELECT exercise_id, locale, short_description, description, created_at, modified_at FROM ${B.descriptions} WHERE exercise_id = ?`,
    [id],
  );
  await tx.query(`DELETE FROM ${L.muscles} WHERE exercise_id = ?`, [id]);
  await tx.query(
    `INSERT INTO ${L.muscles} (gym_id, exercise_id, role, muscle, muscle_id, created_at)
     SELECT NULL, exercise_id, role, muscle, muscle_id, created_at FROM ${B.muscles} WHERE exercise_id = ?`,
    [id],
  );
  await tx.query(`DELETE FROM ${L.resultTypes} WHERE exercise_id = ?`, [id]);
  await tx.query(
    `INSERT INTO ${L.resultTypes} (exercise_id, result_type_id) SELECT exercise_id, result_type_id FROM ${B.resultTypes} WHERE exercise_id = ?`,
    [id],
  );
}
