import { exerciseNameSearchSql } from './exerciseTranslations';

/**
 * What the exercise lists may be filtered by, and the SQL those filters become
 * (#969 §11, §16, §19).
 *
 * The three screens the ticket names — Base Exercises, the Import modal and a
 * gym's own Exercises — are "the same filtering UX" (§19), and the way that
 * cannot drift is one declaration of the vocabulary plus one builder for the
 * `WHERE` fragment. #964 §18 had already put most of it inline in
 * `platform-exercises.ts`; this module is that query lifted out, so the other
 * two screens get the identical semantics rather than a second interpretation
 * of `?muscle=`.
 *
 * Two of its rules are the ticket's rather than the implementation's:
 *
 *  * **Filtering is server-side** (§16/§17), so nothing here is a hint the
 *    browser then re-applies — with ~900 Base Exercises after the Free Exercise
 *    DB import (#964) the list must not be pulled into the page to be narrowed
 *    there.
 *  * **The metadata filters read the source's own axes verbatim.** `equipment`
 *    is what the ticket's `[ Exercise Type ▾ ]` sketch actually lists
 *    (Bodyweight, Machine, Dumbbell, …) and what the thread settled on; there
 *    is no `exercises.exercise_type` to filter — migration 074 dropped it
 *    (#154) and #1009 gates the name — so no column here invents a taxonomy
 *    (§8), and the options a control offers come from the values present
 *    (`exerciseFacetsSql`), never from a list declared in a page.
 */

/** The statuses a list filter may ask for. `deleted` rows are never listed. */
export const EXERCISE_FILTER_STATUSES = ['active', 'inactive'] as const;
export type ExerciseFilterStatus = (typeof EXERCISE_FILTER_STATUSES)[number];

/**
 * The source metadata columns a list may filter and offer options for — all
 * preserved verbatim from the Free Exercise DB by #964 (`force` is stored as
 * `force_type`, since `force` is reserved in MySQL 8).
 */
export const EXERCISE_METADATA_COLUMNS = ['equipment', 'category', 'level', 'mechanic', 'source'] as const;
export type ExerciseMetadataColumn = (typeof EXERCISE_METADATA_COLUMNS)[number];

/** `?muscle=` (either role), `?primary_muscle=`, `?secondary_muscle=` (§7). */
const MUSCLE_PARAMS = [
  { param: 'muscle', role: null },
  { param: 'primary_muscle', role: 'principal' },
  { param: 'secondary_muscle', role: 'secondary' },
] as const;

/** Whether a multi-select muscle filter means OR or AND within itself (§6). */
export const EXERCISE_MUSCLE_MATCHES = ['any', 'all'] as const;
export type ExerciseMuscleMatch = (typeof EXERCISE_MUSCLE_MATCHES)[number];

/** The default is `any`, which is the behaviour #964's query already had. */
export const DEFAULT_MUSCLE_MATCH: ExerciseMuscleMatch = 'any';

export interface ExerciseListFilter {
  /** Matches the base name or any stored translation (#967 §7, §3/§18 here). */
  q: string | null;
  status: ExerciseFilterStatus | null;
  metadata: { column: ExerciseMetadataColumn; values: string[] }[];
  muscles: { role: 'principal' | 'secondary' | null; values: string[] }[];
  muscleMatch: ExerciseMuscleMatch;
}

/**
 * A repeatable, comma-separated filter value — `?muscle=chest,triceps` and
 * `?muscle=chest&muscle=triceps` mean the same thing, which is what lets a
 * checkbox group send either shape.
 */
export function listParam(value: unknown): string[] | null {
  const raw = Array.isArray(value) ? value : [value];
  const values = raw
    .filter((entry): entry is string => typeof entry === 'string')
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return values.length > 0 ? Array.from(new Set(values)) : null;
}

function textParam(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Reads a request's query into {@link ExerciseListFilter}, or says what is
 * wrong with it.
 *
 * An unknown value is an error for the two closed sets (`status`,
 * `muscle_match`) and silently ignored for everything else: the metadata
 * columns hold free text from the source, so there is no set to compare a value
 * against, and a filter nobody has data for simply matches nothing.
 */
export function parseExerciseListFilter(
  query: Record<string, unknown>,
): { filter: ExerciseListFilter } | { error: string } {
  const status = textParam(query.status);
  if (status && !(EXERCISE_FILTER_STATUSES as readonly string[]).includes(status)) {
    return { error: `status must be one of: ${EXERCISE_FILTER_STATUSES.join(', ')}` };
  }
  const match = textParam(query.muscle_match)?.toLowerCase() ?? null;
  if (match && !(EXERCISE_MUSCLE_MATCHES as readonly string[]).includes(match)) {
    return { error: `muscle_match must be one of: ${EXERCISE_MUSCLE_MATCHES.join(', ')}` };
  }
  const metadata: ExerciseListFilter['metadata'] = [];
  for (const column of EXERCISE_METADATA_COLUMNS) {
    const values = listParam(query[column]);
    if (values) metadata.push({ column, values });
  }
  const muscles: ExerciseListFilter['muscles'] = [];
  for (const { param, role } of MUSCLE_PARAMS) {
    const values = listParam(query[param]);
    if (values) muscles.push({ role, values });
  }
  return {
    filter: {
      q: textParam(query.q),
      status: (status as ExerciseFilterStatus | null) ?? null,
      metadata,
      muscles,
      muscleMatch: (match as ExerciseMuscleMatch | null) ?? DEFAULT_MUSCLE_MATCH,
    },
  };
}

/** Whether a parsed filter narrows anything at all. */
export function isExerciseListFiltered(filter: ExerciseListFilter): boolean {
  return Boolean(filter.q || filter.status)
    || filter.metadata.length > 0
    || filter.muscles.length > 0;
}

/**
 * The `AND …` fragment a parsed filter becomes, to append to a query that has
 * already scoped the rows it owns (the gym, or `gym_id IS NULL`, and
 * `status != 'deleted'`).
 *
 * @param alias the `exercises` alias in the enclosing query
 */
export function exerciseListFilterSql(
  alias: string,
  filter: ExerciseListFilter,
): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];

  if (filter.status) {
    parts.push(`${alias}.status = ?`);
    params.push(filter.status);
  }
  if (filter.q) {
    // #967 §7: the base name or any stored translation. The slug is an
    // internal identifier (#1356) and is never searched.
    parts.push(`(${exerciseNameSearchSql(alias)})`);
    params.push(`%${filter.q}%`, `%${filter.q}%`);
  }
  for (const { column, values } of filter.metadata) {
    // The column itself, not `LOWER(…)`: the table's collation is
    // `utf8mb4_0900_ai_ci`, so the comparison is already case- and
    // accent-insensitive, and wrapping the column in a function only makes any
    // index on it unusable (§17).
    parts.push(`${alias}.${column} IN (${values.map(() => '?').join(', ')})`);
    params.push(...values);
  }
  for (const { role, values } of filter.muscles) {
    // `all` is one EXISTS per muscle, which is what AND within the filter means
    // (§6); `any` is the single `IN` #964's query already had.
    const groups = filter.muscleMatch === 'all' ? values.map((value) => [value]) : [values];
    for (const group of groups) {
      parts.push(`EXISTS (SELECT 1 FROM exercise_muscles em
        WHERE em.exercise_id = ${alias}.id
          AND em.muscle IN (${group.map(() => '?').join(', ')})${role ? ' AND em.role = ?' : ''})`);
      params.push(...group);
      if (role) params.push(role);
    }
  }

  return { sql: parts.map((part) => ` AND ${part}`).join(''), params };
}

/**
 * The options every metadata control offers: the distinct values actually
 * present among the rows in scope (§8 — no invented taxonomy, §9 — a control
 * with no values is not rendered at all).
 *
 * One statement rather than one per column, because the facets travel together:
 * a page reads them once and hides the controls that came back empty.
 *
 * @param scopeSql a `WHERE` body scoping the rows (e.g. `e.gym_id IS NULL AND
 *   e.status != 'deleted'`), using the alias `e`
 */
export function exerciseFacetsSql(scopeSql: string): string {
  return EXERCISE_METADATA_COLUMNS
    .map((column) => `SELECT '${column}' AS facet, e.${column} AS value
      FROM exercises e
      WHERE ${scopeSql} AND e.${column} IS NOT NULL AND e.${column} <> ''
      GROUP BY e.${column}`)
    .join('\n    UNION ALL\n    ');
}

/**
 * {@link exerciseFacetsSql} with its scope's own parameters bound, once per
 * column.
 *
 * The scope is one `WHERE` body repeated across the union's arms, so a
 * parameterised one — `e.gym_id = ?`, which is every context except the
 * platform's — needs its values repeated as many times as there are columns.
 * How many arms the statement has is this module's to know, which is why the
 * repetition lives here rather than in a router counting
 * `EXERCISE_METADATA_COLUMNS` for itself.
 */
export function exerciseFacetsQuery(
  scopeSql: string,
  scopeParams: unknown[] = [],
): { sql: string; params: unknown[] } {
  return {
    sql: exerciseFacetsSql(scopeSql),
    params: EXERCISE_METADATA_COLUMNS.flatMap(() => scopeParams),
  };
}

/** Groups {@link exerciseFacetsSql}'s rows into the map a page reads. */
export function groupExerciseFacets(
  rows: { facet: string; value: string }[],
): Record<ExerciseMetadataColumn, string[]> {
  const facets = Object.fromEntries(
    EXERCISE_METADATA_COLUMNS.map((column) => [column, [] as string[]]),
  ) as Record<ExerciseMetadataColumn, string[]>;
  for (const row of rows) {
    const column = row.facet as ExerciseMetadataColumn;
    if (!facets[column] || typeof row.value !== 'string') continue;
    facets[column].push(row.value);
  }
  for (const column of EXERCISE_METADATA_COLUMNS) {
    facets[column].sort((a, b) => a.localeCompare(b));
  }
  return facets;
}
