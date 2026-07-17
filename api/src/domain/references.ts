import { db } from '../infra/db';

/**
 * #62: generic dependency lookup for shared catalog entities. Each entity
 * type registers a resolver that reports where it is referenced (ignoring
 * soft-deleted records) so the admin app can warn before edit/delete.
 * Future catalog entities (class types, benefits, equipment, …) plug in by
 * registering a resolver — the endpoint shape and dialog stay generic.
 */

export interface EntityReference {
  id: number;
  name: string;
}

export interface ReferenceReport {
  entityId: number;
  usageCount: number;
  references: EntityReference[];
}

type ReferenceResolver = (gymId: string, entityId: number, limit: number) => Promise<ReferenceReport>;

const registry = new Map<string, ReferenceResolver>();

export function registerReferenceResolver(entityType: string, resolver: ReferenceResolver): void {
  registry.set(entityType, resolver);
}

export async function getReferences(
  entityType: string, gymId: string, entityId: number, limit = 20,
): Promise<ReferenceReport> {
  const resolver = registry.get(entityType);
  if (!resolver) throw new Error(`No reference resolver registered for entity type "${entityType}"`);
  // Clamped and inlined into SQL below — mysql2's execute() does not bind
  // LIMIT placeholders reliably.
  const safeLimit = Math.min(Math.max(Math.floor(limit) || 20, 1), 100);
  return resolver(gymId, entityId, safeLimit);
}

/**
 * Shared SQL shape: one COUNT(DISTINCT …) query plus one LIMITed name query —
 * the count stays exact and cheap even with thousands of references, and the
 * dialog never loads more rows than it shows.
 */
async function resolveWithQueries(
  entityId: number, limit: number,
  countSql: string, listSql: string, params: unknown[],
): Promise<ReferenceReport> {
  const [{ rows: countRows }, { rows: references }] = await Promise.all([
    db.query(countSql, params),
    db.query(`${listSql} LIMIT ${limit}`, params),
  ]);
  return { entityId, usageCount: Number(countRows[0]?.total ?? 0), references };
}

/* ---- Workout Template: referenced by Training Plan Templates ---- */
registerReferenceResolver('workout_template', (gymId, entityId, limit) => resolveWithQueries(
  entityId, limit,
  `SELECT COUNT(DISTINCT tpt.id) AS total
     FROM training_plan_template_workouts j
     JOIN training_plan_templates tpt ON tpt.id = j.training_plan_template_id
    WHERE j.workout_template_id = ? AND j.gym_id = ? AND tpt.status != 'deleted'`,
  `SELECT DISTINCT tpt.id, tpt.name
     FROM training_plan_template_workouts j
     JOIN training_plan_templates tpt ON tpt.id = j.training_plan_template_id
    WHERE j.workout_template_id = ? AND j.gym_id = ? AND tpt.status != 'deleted'
    ORDER BY tpt.name ASC`,
  [entityId, gymId],
));

/* ---- Exercise: referenced by Workout Templates ---- */
registerReferenceResolver('exercise', (gymId, entityId, limit) => resolveWithQueries(
  entityId, limit,
  `SELECT COUNT(DISTINCT wt.id) AS total
     FROM workout_template_exercises wte
     JOIN workout_template_blocks b ON b.id = wte.workout_template_block_id AND b.deleted_at IS NULL
     JOIN workout_templates wt ON wt.id = b.workout_template_id AND wt.deleted_at IS NULL
    WHERE wte.exercise_id = ? AND wte.gym_id = ? AND wte.deleted_at IS NULL`,
  `SELECT DISTINCT wt.id, wt.name
     FROM workout_template_exercises wte
     JOIN workout_template_blocks b ON b.id = wte.workout_template_block_id AND b.deleted_at IS NULL
     JOIN workout_templates wt ON wt.id = b.workout_template_id AND wt.deleted_at IS NULL
    WHERE wte.exercise_id = ? AND wte.gym_id = ? AND wte.deleted_at IS NULL
    ORDER BY wt.name ASC`,
  [entityId, gymId],
));
