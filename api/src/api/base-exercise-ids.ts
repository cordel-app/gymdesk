import { Tx } from '../infra/db';
import { SYSTEM_ACTOR } from '../domain/auditActor';

/**
 * #1849 (Exercises) — Base exercise ids. Cordel writes `base_exercises` alone; the legacy
 * System rows and the transitional mirror onto them were removed with migration 343.
 */

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
