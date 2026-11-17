import { db, Tx } from '../infra/db';
import { generateSlug, nextAvailableSlug } from '../domain/entitySlug';

/**
 * #2951: the I/O half of `domain/entitySlug.ts` — picks the slug a new row of
 * one of the platform-wide tables is created with. Each of these tables is one
 * scope (it has no gym-specific rows), so the slugs it already holds, deleted
 * rows included, are what a new one must avoid: a slug is never reused, so a
 * deleted row keeps its own. The UNIQUE key on the column is the backstop for a
 * concurrent create.
 */
export type GlobalSlugTable = 'gyms' | 'payment_providers' | 'base_payment_methods';

const FALLBACK: Record<GlobalSlugTable, string> = {
  gyms: 'gym',
  payment_providers: 'payment-provider',
  base_payment_methods: 'payment-method',
};

export async function allocateGlobalSlug(
  table: GlobalSlugTable,
  name: string | null | undefined,
  exec: Pick<Tx, 'query'> = db,
): Promise<string> {
  const base = generateSlug(name, FALLBACK[table]);
  // `base` holds only [a-z0-9-], so it needs no LIKE escaping.
  const { rows } = await exec.query<{ slug: string }>(
    `SELECT slug FROM ${table} WHERE slug = ? OR slug LIKE ?`,
    [base, `${base}-%`],
  );
  return nextAvailableSlug(base, rows.map((r) => r.slug));
}

/** The `[a-z0-9-]` slugs of `rows` matching `base` or `base-<n>`, for `nextAvailableSlug()`. */
async function takenSlugs(
  exec: Pick<Tx, 'query'>,
  table: 'base_exercises' | 'exercises' | GoalSlugTable | 'professional_services',
  base: string,
  scope: { gymId: number | string } | null | 'base_rows',
  column: 'slug' | 'entity_slug' = 'slug',
): Promise<string[]> {
  // `base_rows`: the Base rows of a table that holds both kinds (`gym_id IS NULL`).
  const where = scope === 'base_rows' ? 'gym_id IS NULL AND ' : scope ? 'gym_id = ? AND ' : '';
  // A slug carried over from a Base Exercise may hold characters a LIKE pattern reads (`_`), so
  // the suffix pattern escapes them; the exact match needs no escaping.
  const like = `${base.replace(/[\\%_]/g, (c) => `\\${c}`)}-%`;
  const { rows } = await exec.query<{ slug: string }>(
    `SELECT ${column} AS slug FROM ${table} WHERE ${where}(${column} = ? OR ${column} LIKE ?)`,
    [...(scope && scope !== 'base_rows' ? [scope.gymId] : []), base, like],
  );
  return rows.map((r) => r.slug);
}

/**
 * #2951 stage 2: the slug a new Base Exercise is created with — from its name, unique among the
 * Base Exercises (deleted ones included, so a slug is never reused).
 */
export async function allocateBaseExerciseSlug(
  name: string | null | undefined,
  exec: Pick<Tx, 'query'> = db,
): Promise<string> {
  const base = generateSlug(name, 'exercise');
  return nextAvailableSlug(base, await takenSlugs(exec, 'base_exercises', base, null));
}

/**
 * #2951 stage 2: the slug a new gym exercise is created with, unique within that gym (deleted
 * rows included; `exercises_gym_slug_unique` is the backstop). A copy of a Base Exercise passes
 * the Base Exercise's own slug as `carried` and keeps it (§6), suffixed only when the gym already
 * holds it; any other exercise is slugged from its name.
 */
export async function allocateGymExerciseSlug(
  gymId: number | string,
  source: { name: string | null | undefined; carried?: string | null },
  exec: Pick<Tx, 'query'> = db,
): Promise<string> {
  const base = source.carried?.trim() || generateSlug(source.name, 'exercise');
  return nextAvailableSlug(base, await takenSlugs(exec, 'exercises', base, { gymId }));
}

type GoalSlugTable = 'base_personal_goals' | 'base_nutrition_goals' | 'personal_goals' | 'nutrition_goals';

/**
 * #2951 stage 3: the slug a new Base Personal Goal or Base Nutrition Goal is created with — from
 * its name, unique within its own table (deleted rows included, so a slug is never reused; the
 * live-only `base_*_goals_live_slug` key is the backstop). A seeded goal's slug (`weight_loss`)
 * predates this rule and is its locale label handle; it is never rewritten.
 */
export async function allocateBaseGoalSlug(
  table: 'base_personal_goals' | 'base_nutrition_goals',
  name: string | null | undefined,
  exec: Pick<Tx, 'query'> = db,
): Promise<string> {
  const base = generateSlug(name, 'goal');
  return nextAvailableSlug(base, await takenSlugs(exec, table, base, null));
}

/**
 * #2951 stage 3: the slug a new gym-owned Personal Goal or Nutrition Goal is created with, held in
 * `entity_slug` (the gym tables' `slug` column stays the System label handle, always NULL on a gym
 * row) and unique within that gym (deleted rows included; `*_gym_entity_slug_unique` is the
 * backstop). A copy imported from a Base goal passes the Base goal's slug as `carried` and keeps it
 * (§6), suffixed only when the gym already holds it.
 */
export async function allocateGymGoalSlug(
  table: 'personal_goals' | 'nutrition_goals',
  gymId: number | string,
  source: { name: string | null | undefined; carried?: string | null },
  exec: Pick<Tx, 'query'> = db,
): Promise<string> {
  const base = source.carried?.trim() || generateSlug(source.name, 'goal');
  return nextAvailableSlug(base, await takenSlugs(exec, table, base, { gymId }, 'entity_slug'));
}

/**
 * #2951 stage 4: the slug a new Professional Service is created with. Base services (`gym_id IS
 * NULL`) and each gym's own services are separate scopes of the one table (deleted rows included,
 * so a slug is never reused; `ps_scope_slug_unique` is the backstop). A gym service imported from
 * a Base one passes the Base service's slug as `carried` and keeps it (§6), suffixed only when the
 * gym already holds it; any other service — a Duplicate included — is slugged from its name.
 */
export async function allocateProfessionalServiceSlug(
  gymId: number | string | null,
  source: { name: string | null | undefined; carried?: string | null },
  exec: Pick<Tx, 'query'> = db,
): Promise<string> {
  const base = source.carried?.trim() || generateSlug(source.name, 'professional-service');
  const scope = gymId === null ? 'base_rows' as const : { gymId };
  return nextAvailableSlug(base, await takenSlugs(exec, 'professional_services', base, scope));
}
