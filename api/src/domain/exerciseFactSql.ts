/**
 * #2320 — an exercise's category / equipment as the Members App shows them.
 * A Gym Exercise imported before the importer copied `equipment` carries none
 * of its own, so a blank value falls back to the one on the System exercise it
 * was copied from (`cloned_from_id`, which the catalogue view reports for both
 * provenance columns). Read-time only: nothing is written back.
 */
export function exerciseFactSql(alias: string, column: 'category' | 'equipment'): string {
  return `COALESCE(NULLIF(TRIM(${alias}.${column}), ''), (SELECT b.${column} FROM exercise_catalogue b WHERE b.id = ${alias}.cloned_from_id AND b.gym_id IS NULL))`;
}
