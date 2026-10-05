/**
 * #947 — the Nutrition Library's two goal catalogues: **Personal Goals** (what
 * the member wants to achieve) and **Nutrition Goals** (what the plan should
 * target nutritionally).
 *
 * This module is the one place that decides what the two have in common: the
 * kinds themselves, the table each lives in, the audit entity type each records
 * under, and the System rows migration 206 seeds. Everything else about them is
 * identical by construction, which is why one router factory serves both on the
 * gym side and one on the platform side — and why a third goal catalogue would
 * be a line here plus a table, not a third router.
 *
 * They are deliberately **two tables** and not one with a `kind` column: §8 of
 * the ticket keeps the concepts separate in the data model as well as the UI,
 * and the two are on diverging paths — since #1034 a **Personal** Goal carries a
 * measurable target (migration 218) while a Nutrition Goal's own target values
 * ("2,000 kcal") are still a later ticket's, which is exactly the divergence a
 * discriminator column could not express. `MEASURABLE_GOAL_KINDS` below is the
 * one place that says which kinds have the pair.
 *
 * Ownership is the Foods library's, unchanged (§5): `gym_id IS NULL` is a
 * **System** row, administered from Cordel and read-only to every gym; a
 * non-NULL `gym_id` is that gym's own. Soft delete is `status = 'deleted'`.
 */

export const GOAL_LIBRARY_KINDS = ['personal', 'nutrition'] as const;
export type GoalLibraryKind = (typeof GOAL_LIBRARY_KINDS)[number];

/** The table each kind lives in. Mirrored by migration 206. */
export const GOAL_LIBRARY_TABLES: Record<GoalLibraryKind, string> = {
  personal: 'personal_goals',
  nutrition: 'nutrition_goals',
};

/**
 * The `recordAudit({ entityType })` value each kind writes under. Both carry an
 * `AUDIT_ENTITY_REGISTRY` entry (`api/src/infra/audit-registry.ts`) — without one
 * the rows write but carry no `entity_name` and the type never reaches the Audit
 * Log's entity-type filter.
 */
export const GOAL_LIBRARY_AUDIT_ENTITIES: Record<GoalLibraryKind, string> = {
  personal: 'personal_goal',
  nutrition: 'nutrition_goal',
};

/**
 * The `feature_flags` key each kind is mounted behind (`app.ts`), declared here
 * because it is the same per-kind fact the table and the audit entity are:
 * **Nutrition Goals** is a tab of the Nutrition Library and rides its key,
 * while **Personal Goals** has its own (migration 211, #948 §8 — gating it on
 * the Library's would 403 a section of a different domain).
 *
 * Since #1070 the key is also what the permission guards are given, so a
 * feature-level override (`FEATURE_PERMISSION_OVERRIDES`) applies to exactly the
 * catalogue it names: a Personal Trainer has `RW` on Personal Goals and the
 * module's `R_ASSIGNED` on Nutrition Goals, from one declaration and no branch
 * on the kind.
 */
export const GOAL_LIBRARY_FEATURE_KEYS: Record<GoalLibraryKind, string> = {
  personal: 'nutrition.personal_goals',
  nutrition: 'nutrition.nutrition_library',
};

/** What `status` may hold. Mirrored by `chk_<prefix>_status` (migration 206). */
export const GOAL_STATUSES = ['active', 'deleted'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/**
 * #1034 §1 — which kinds carry a **target** (`target_value` + `target_unit`,
 * migration 218). Exactly one does.
 *
 * It is a declaration rather than a branch on the kind in each router because
 * the two catalogues are served by one factory: the list's projection, the
 * create and the update all ask this, so a kind cannot have the pair in one
 * statement and not in the next — and `nutrition_goals` has no such columns, so
 * a router that projected them anyway would answer ER_BAD_FIELD_ERROR, which the
 * global handler turns into a bare 500 (#966).
 *
 * Making a second kind measurable therefore goes in **three** places: this list,
 * the two columns plus their CHECKs on that kind's table, and the admin's own
 * mirror (`MEASURABLE_GOAL_KINDS` in
 * `apps/admin/src/components/goalLibrary/goalProfile.ts`).
 */
export const MEASURABLE_GOAL_KINDS: readonly GoalLibraryKind[] = ['personal'];

export function isMeasurableGoalKind(kind: GoalLibraryKind): boolean {
  return MEASURABLE_GOAL_KINDS.includes(kind);
}

/**
 * #1035 stage 2 — which kinds carry an **image** (`image_url`, migration 225).
 * Exactly one does, for the same reason exactly one is measurable: the ticket's
 * bucket tree (`docs/cloudflare_structure.md`) names
 * `goals/{personal_goal_id}-{personal_goal_name}.png` and nothing for a
 * Nutrition Goal, and the two catalogues are two tables precisely so they can
 * diverge (migration 206's header).
 *
 * It is a declaration rather than a branch on the kind in each router because
 * one factory serves both: the list's projection, the single-row read and the
 * two image routes all ask this, so a kind cannot have the column in one
 * statement and not in the next — and `nutrition_goals` has no such column, so
 * a router that projected it anyway would answer ER_BAD_FIELD_ERROR, which the
 * global handler turns into a bare 500 (#966). The image **routes** are
 * registered only for a kind that has one, so a Nutrition Goal's `/:id/image`
 * is a 404 rather than a control that writes nowhere.
 *
 * Giving a second kind an image therefore goes in **three** places: this list,
 * the column on that kind's table, and the admin's own mirror
 * (`IMAGE_GOAL_KINDS` in `apps/admin/src/components/goalLibrary/goalProfile.ts`).
 */
export const IMAGE_GOAL_KINDS: readonly GoalLibraryKind[] = ['personal'];

export function goalKindHasImage(kind: GoalLibraryKind): boolean {
  return IMAGE_GOAL_KINDS.includes(kind);
}

/**
 * The System rows migration 206 seeds, in display order.
 *
 * The slugs are the ones the Nutrition Plan routers already validate a plan
 * goal's `item_name` against, partitioned between the two concepts — so a later
 * ticket can link a plan's goal to its catalogue row without renaming anything —
 * plus `fasting`, which this ticket adds (§4). Nothing reads them that way yet:
 * assigning goals to plans or members is out of scope.
 *
 * A slug is a **System** row's label handle and only a System row's
 * (`chk_<prefix>_slug_system_only`): the admin resolves
 * `goal_library.<kind>_goal_<slug>` for it and falls back to the row's own
 * `name`, which is the CLAUDE.md rule for a fixed seeded catalogue. A gym's own
 * goal carries no slug and is shown under the single name its staff typed.
 */
export const SYSTEM_PERSONAL_GOALS = [
  { slug: 'weight_loss', name: 'Weight Loss' },
  { slug: 'weight_gain', name: 'Weight Gain' },
  { slug: 'muscle_gain', name: 'Muscle Gain' },
  { slug: 'maintenance', name: 'Maintenance' },
  { slug: 'performance', name: 'Performance' },
  { slug: 'recovery', name: 'Recovery' },
  { slug: 'energy', name: 'Energy' },
] as const;

/**
 * #1034 §2 — the target migration 218 seeds onto each System **Personal** Goal,
 * keyed by slug. A slug absent from the map deliberately has none: Performance,
 * Recovery and Energy carry no magnitude or unit that follows from what they
 * represent, and a number invented for them would be the "same generic target"
 * §2 forbids wearing a different value (§13 requires a unit only "for measurable
 * goals", which is the same concession). `—` is a legitimate target, and a gym
 * may set one on its own copy of the goal or per assignment.
 *
 * It mirrors `SEED_TARGETS` in that migration — the migration is plain JS and
 * cannot import this module — and `goal-library-domain.unit.test.ts` asserts the
 * two agree, so a default changed in one place fails the build rather than
 * drifting.
 */
export const SYSTEM_PERSONAL_GOAL_TARGETS: Record<string, { value: number; unit: string }> = {
  weight_loss: { value: 3, unit: 'kg' },
  weight_gain: { value: 3, unit: 'kg' },
  muscle_gain: { value: 2, unit: 'kg' },
  maintenance: { value: 0, unit: 'kg' },
};

export const SYSTEM_NUTRITION_GOALS = [
  { slug: 'calories', name: 'Calories' },
  { slug: 'protein', name: 'Protein' },
  { slug: 'carbohydrates', name: 'Carbohydrates' },
  { slug: 'fats', name: 'Fats' },
  { slug: 'fiber', name: 'Fiber' },
  { slug: 'water', name: 'Water' },
  { slug: 'fasting', name: 'Fasting' },
] as const;

export const SYSTEM_GOALS: Record<GoalLibraryKind, readonly { slug: string; name: string }[]> = {
  personal: SYSTEM_PERSONAL_GOALS,
  nutrition: SYSTEM_NUTRITION_GOALS,
};

export function isGoalLibraryKind(value: unknown): value is GoalLibraryKind {
  return typeof value === 'string' && (GOAL_LIBRARY_KINDS as readonly string[]).includes(value);
}

/** `name` is VARCHAR(255) (migration 206). */
export const GOAL_NAME_MAX_LENGTH = 255;

/**
 * The value to store for a submitted `name`, or an error.
 *
 * `undefined` means the request did not mention the field, which is what lets a
 * `PUT` stay a partial update; an empty or whitespace-only string is an error
 * rather than a clear, because the column is NOT NULL and a goal with no name is
 * a row nothing can render.
 */
export function normalizeGoalName(
  input: unknown,
  { required }: { required: boolean },
): { value: string | undefined } | { error: string } {
  if (input === undefined || input === null) {
    return required ? { error: 'name is required' } : { value: undefined };
  }
  if (typeof input !== 'string') return { error: 'name must be a string' };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { error: 'name is required' };
  if (trimmed.length > GOAL_NAME_MAX_LENGTH) {
    return { error: `name must be at most ${GOAL_NAME_MAX_LENGTH} characters` };
  }
  return { value: trimmed };
}

/**
 * The search predicate the two list endpoints share. A goal has no translation
 * junction table (see the slug note above), so there is one name to match —
 * unlike the Foods library's `buildListWhere`, which also searches the locale's
 * translated name.
 */
export function buildGoalListWhere(
  search: unknown,
  base: string[],
  baseParams: unknown[] = [],
): { where: string; params: unknown[] } {
  const term = typeof search === 'string' ? search.trim() : '';
  const where = [...base];
  const params = [...baseParams];
  if (term) {
    where.push('(g.name LIKE ? OR g.slug LIKE ?)');
    params.push(`%${term}%`, `%${term}%`);
  }
  return { where: where.join(' AND '), params };
}
