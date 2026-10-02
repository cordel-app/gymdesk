/**
 * #947 — the one declaration of what a goal catalogue row *is* on the frontend:
 * the two kinds, their endpoints, their locale keys, the persisted shape, the
 * values the Edit form is seeded from and the payloads it submits.
 *
 * Every screen that renders a goal catalogue imports it — the Nutrition Goals tab
 * of `nutrition/nutrition-library` and `cordel/nutrition-library`, and since #948
 * the Personal Goals sections of `personal-goals` and `cordel/personal-goals` — so
 * the list row, the read-only expanded row, the Details modal and the Edit form
 * cannot drift apart into four field lists (#799 §26), exactly as
 * `nutritionItemProfile.ts` does for Foods.
 * There is one editor for the pair as well (`GoalLibrarySection`), which names no
 * endpoint: the router root is a prop, which is what keeps the gym's module
 * permissions and `requireSuperadmin` out of the shared UI (#806).
 */

/** The two concepts, kept separate on purpose — §8: they are not synonyms. */
export const GOAL_KINDS = ['personal', 'nutrition'] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

/** Which library a section is rendered in. Decides the API root and nothing else. */
export type GoalScope = 'gym' | 'platform';

/**
 * The router root each (kind, scope) pair talks to. Mirrors the four mounts in
 * `api/src/app.ts`; a section is handed one of these rather than building a path.
 */
export const GOAL_API_ROOTS: Record<GoalScope, Record<GoalKind, string>> = {
  gym: { personal: '/personal-goals', nutrition: '/nutrition-goals' },
  platform: { personal: '/platform/personal-goals', nutrition: '/platform/nutrition-goals' },
};

/**
 * The `recordAudit` entity type each kind writes under — what the Details view's
 * View Audit Log link filters on. Mirrors `GOAL_LIBRARY_AUDIT_ENTITIES` in
 * `api/src/domain/goalLibrary.ts`.
 */
export const GOAL_AUDIT_ENTITIES: Record<GoalKind, string> = {
  personal: 'personal_goal',
  nutrition: 'nutrition_goal',
};

/**
 * The tabs the Nutrition Library is organised into (#947 §1/§2), in order. The
 * same declaration drives both libraries, so neither page can offer a different
 * set of tabs or order them differently — which is also why a tab id is either
 * `'foods'` or a `GoalKind`, so a tab cannot name a catalogue that does not exist.
 *
 * **Personal Goals is no longer one of them** (#948 §3/§9): it is its own section,
 * at `/{locale}/personal-goals` and `/{locale}/cordel/personal-goals`, because a
 * Personal Goal does not depend on Nutrition and is a different entity (§8). What
 * is left here is Foods and Nutrition Goals, which stay exactly as #947 shipped
 * them — the goal catalogue that *is* a nutrition concept keeps its tab.
 *
 * A tab is still a `GoalKind` or `'foods'` rather than a free string, so removing
 * Personal Goals from the strip could not leave a tab pointing at nothing; the
 * *kinds* are unchanged, since `GoalLibrarySection` serves the Personal Goals
 * section from the very same declaration.
 *
 * Each tab's `+ Add` label (§7) belongs to whatever renders that tab: the Foods
 * button is the page's existing one, and a goal section renders its own
 * `<kind>_add` — the section is where the button lives, so that is where its label
 * is resolved.
 */
export const LIBRARY_TABS = [
  { id: 'foods', labelKey: 'tab_foods' },
  { id: 'nutrition', labelKey: 'tab_nutrition_goals' },
] as const;

export type LibraryTabId = (typeof LIBRARY_TABS)[number]['id'];

/**
 * Whether a tab is a goal catalogue rather than Foods.
 *
 * The predicate narrows to the goal *tabs*, not to every `GoalKind`: `personal`
 * is a kind the Personal Goals section renders and no longer a tab, so promising
 * `tab is GoalKind` here would be a type the parameter can never hold.
 */
export function isGoalTab(tab: LibraryTabId): tab is Exclude<LibraryTabId, 'foods'> {
  return tab !== 'foods';
}

/** A row as `GET /{personal,nutrition}-goals` and the `/platform/*` pair return it. */
export interface GoalRow {
  id: number;
  /** `null` = a System row, owned by the platform and read-only to every gym (§5). */
  gym_id: string | null;
  /**
   * A seeded System row's stable handle, `null` for everything else — a gym's own
   * goal and a System goal Cordel added later both carry only a name. It is what
   * `goalDisplayName()` resolves a locale key from, never shown raw.
   */
  slug: string | null;
  name: string;
  description: string | null;
  status: 'active' | 'deleted';
  created_at: string;
  created_by_name: string | null;
  modified_at: string | null;
  modified_by_name: string | null;
  deleted_at: string | null;
  deleted_by_name: string | null;
}

export interface GoalListResponse {
  items: GoalRow[];
  total: number;
  limit: number;
  offset: number;
}

/** The editable fields, in the shape both halves of the form hold them. */
export interface GoalFormValues {
  name: string;
  description: string;
}

export function emptyGoalForm(): GoalFormValues {
  return { name: '', description: '' };
}

/** Persisted row → Edit form values: the single mapping both pages seed from. */
export function toGoalFormValues(goal: GoalRow): GoalFormValues {
  return { name: goal.name, description: goal.description ?? '' };
}

/**
 * What `POST` and `PUT` carry. Declared beside the row → form mapping so a field
 * the form holds cannot quietly stop being submitted (#805).
 *
 * `description` is always present, as `''` when empty: the routers read an empty
 * string as "clear it" and an absent key as "leave it alone", and an inline form
 * that cleared a description has to mean the former.
 */
export function toGoalPayload(form: GoalFormValues): { name: string; description: string } {
  return { name: form.name.trim(), description: form.description.trim() };
}

/** Whether this row is the platform's (System) rather than the gym's own. */
export function isSystemGoal(goal: GoalRow): boolean {
  return goal.gym_id === null;
}

/**
 * The slugs migration 206 seeds, mirroring `SYSTEM_PERSONAL_GOALS` /
 * `SYSTEM_NUTRITION_GOALS` in `api/src/domain/goalLibrary.ts` — so a new System
 * goal goes in **three** places: that module, the migration's seed list beside it
 * and this mirror. `goal-library-ui.test.ts` asserts the first and the third
 * agree, the way `result-types` and the Session Benefit frequencies already do.
 *
 * It exists because a label is only translatable when a locale key was written
 * for it: these fourteen have one, and a goal Cordel or a gym adds later does not.
 */
export const SYSTEM_GOAL_SLUGS: Record<GoalKind, readonly string[]> = {
  personal: ['weight_loss', 'weight_gain', 'muscle_gain', 'maintenance', 'performance', 'recovery', 'energy'],
  nutrition: ['calories', 'protein', 'carbohydrates', 'fats', 'fiber', 'water', 'fasting'],
};

/**
 * The name to show for a goal.
 *
 * A seeded System row's label is its `goal_library.<kind>_goal_<slug>` key, so the
 * seven System goals of each kind read in the viewer's language — the CLAUDE.md
 * rule for a fixed seeded catalogue (migration 073's `result_types`, whose
 * `resultTypeLabel()` is this function's shape). The fallback is the row's own
 * `name`, and which of the two applies is decided **before** `translate()` is
 * called: next-intl has no `defaultValue` option and prints a missing key
 * verbatim, so asking for an unwritten key would render
 * `goal_library.personal_goal_x` on screen.
 */
export function goalDisplayName(
  goal: Pick<GoalRow, 'slug' | 'name'>,
  kind: GoalKind,
  translate: (key: string) => string,
): string {
  const known = goal.slug !== null && SYSTEM_GOAL_SLUGS[kind].includes(goal.slug);
  return known ? translate(`${kind}_goal_${goal.slug}`) : goal.name;
}
