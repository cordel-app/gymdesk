import {
  BASE_LOCALE,
  SUPPORTED_LOCALES,
  SupportedLocale,
  TRANSLATABLE_LOCALES,
  isSupportedLocale,
} from '../infra/locale';

/**
 * The one translated-name mechanism (#643, generalised by #967).
 *
 * Translated *data* lives in a `(entity_id, locale)` junction table with the
 * entity's own `name` column as the base value and the fallback — never one row
 * per language and never a `name_es`/`name_ca` column (CLAUDE.md). #643 built
 * that for `nutrition_library_items`; #967 needed the same thing for
 * `exercises`, and rather than a second copy of the SQL (which is how two
 * surfaces come to resolve a name two ways) the rules live here once and each
 * entity supplies only its table, its FK column and its subquery alias.
 *
 * Callers never use this module directly — `domain/nutritionLibrary.ts` and
 * `domain/exerciseTranslations.ts` are the two entity-facing wrappers, so a
 * query reads `localizedExerciseNameSql('e', locale)` rather than carrying the
 * configuration around with it.
 */
export interface TranslatedNameConfig {
  /** The junction table: one row per (entity, locale). */
  table: string;
  /** Its FK column back to the owning entity's `id`. */
  entityColumn: string;
  /**
   * Alias for {@link table} inside the correlated subquery. Distinct per entity
   * so a query that already joins the junction table cannot shadow it.
   */
  subqueryAlias: string;
  /** The `name` column's VARCHAR length, which bounds an incoming payload. */
  maxNameLength: number;
}

/**
 * The SQL literal for `locale`, or null when it is the base locale (or, which
 * cannot happen through `getRequestLocale`, not a configured locale at all) and
 * the caller should read the base `name` column instead.
 *
 * The locale is interpolated rather than parameterised because the same
 * expression is embedded in dozens of queries that each carry their own
 * positional params — threading one more `?` through every call site is where
 * the bugs would be. What makes that safe is that the string returned here is
 * always an element of `SUPPORTED_LOCALES`, built at boot from the env var and
 * filtered through a strict BCP-47 pattern: the argument is only ever compared
 * against that list, never embedded, so no caller-supplied bytes reach the
 * query — by data flow, not by trusting that the check upstream was done right.
 */
export function localeLiteral(locale: SupportedLocale): string | null {
  if (locale === BASE_LOCALE) return null;
  const supported = SUPPORTED_LOCALES.find((candidate) => candidate === locale);
  return supported ? `'${supported}'` : null;
}

/**
 * SQL expression resolving the entity's name in `locale`, falling back to its
 * base `name` column when that locale has no row. Collapses to a plain column
 * reference for the base locale, so the common path costs nothing.
 *
 * @param alias table alias of the owning entity in the enclosing query
 */
export function translatedNameSql(cfg: TranslatedNameConfig, alias: string, locale: SupportedLocale): string {
  const literal = localeLiteral(locale);
  if (!literal) return `${alias}.name`;
  const t = cfg.subqueryAlias;
  return `COALESCE((SELECT ${t}.name FROM ${cfg.table} ${t}
            WHERE ${t}.${cfg.entityColumn} = ${alias}.id AND ${t}.locale = ${literal}), ${alias}.name)`;
}

/** {@link translatedNameSql} with an output alias, for SELECT lists. */
export function translatedNameExpr(
  cfg: TranslatedNameConfig,
  alias: string,
  locale: SupportedLocale,
  as: string,
): string {
  return `${translatedNameSql(cfg, alias, locale)} AS ${as}`;
}

/**
 * A `LIKE` search that matches the base name **or any** stored translation, so
 * a staff member searching for what is on their screen finds it — and so does
 * one searching in another language (#967 §7). Carries **two** placeholders;
 * bind the same pattern to both.
 */
export function translatedNameSearchSql(cfg: TranslatedNameConfig, alias: string): string {
  const t = `${cfg.subqueryAlias}_q`;
  return `(${alias}.name LIKE ? OR EXISTS (
            SELECT 1 FROM ${cfg.table} ${t}
             WHERE ${t}.${cfg.entityColumn} = ${alias}.id AND ${t}.name LIKE ?))`;
}

/**
 * A `JSON_OBJECTAGG` of every stored translation for the row, as
 * `{ locale: name }` — `NULL` when the entity has none, which
 * {@link normalizeTranslationsField} turns into `{}`.
 *
 * It rides along with the row rather than being a second read because the
 * editing surfaces seed their form from the row they already hold (#800): a form
 * seeded without the translations would submit an empty replace-all set and
 * clear them on the first save.
 */
export function translationsAggregateExpr(
  cfg: TranslatedNameConfig,
  alias: string,
  as = 'translations',
): string {
  const t = `${cfg.subqueryAlias}_all`;
  return `(SELECT JSON_OBJECTAGG(${t}.locale, ${t}.name) FROM ${cfg.table} ${t}
            WHERE ${t}.${cfg.entityColumn} = ${alias}.id) AS ${as}`;
}

/** The aggregate's `NULL`-for-none as the `{}` the API contract promises. */
export function normalizeTranslationsField<T extends { translations?: unknown }>(row: T): T {
  // A caller that found no row passes it through untouched rather than being
  // handed an object that only carries an empty map.
  if (row === null || row === undefined) return row;
  const value = row.translations;
  if (value && typeof value === 'object' && !Array.isArray(value)) return row;
  // mysql2 hands a JSON column back parsed; a string means a driver that did not.
  if (typeof value === 'string') {
    try {
      return { ...row, translations: JSON.parse(value) };
    } catch { /* fall through to the empty map */ }
  }
  return { ...row, translations: {} };
}

/** A runner for one statement — `db` itself, or a transaction's connection. */
export interface TranslationQueryRunner {
  query: (sql: string, params?: any[]) => Promise<any>;
}

/** Translations for a set of entity ids, as a map: id → { locale: name }. */
export async function loadTranslationsMapFor(
  cfg: TranslatedNameConfig,
  runner: TranslationQueryRunner,
  entityIds: number[],
): Promise<Record<number, Record<string, string>>> {
  if (entityIds.length === 0) return {};
  const marks = entityIds.map(() => '?').join(',');
  const { rows } = await runner.query(
    `SELECT ${cfg.entityColumn} AS entity_id, locale, name FROM ${cfg.table}
      WHERE ${cfg.entityColumn} IN (${marks})
      ORDER BY locale`,
    entityIds,
  );
  const map: Record<number, Record<string, string>> = {};
  for (const row of rows as { entity_id: number; locale: string; name: string }[]) {
    if (!map[row.entity_id]) map[row.entity_id] = {};
    map[row.entity_id][row.locale] = row.name;
  }
  return map;
}

/**
 * Replace **all** translations for one entity: the payload is the complete set,
 * so a locale the caller omits (or sends blank) loses its row and falls back to
 * the base name. The runner is the caller's, so this participates in the
 * transaction that writes the row itself rather than opening one of its own.
 */
export async function replaceTranslationsFor(
  cfg: TranslatedNameConfig,
  runner: TranslationQueryRunner,
  entityId: number | string,
  translations: Record<string, string>,
): Promise<void> {
  // Locale keys are matched case-insensitively (`validateTranslationsPayload`
  // accepts `ES` as readily as `es`), so canonicalise them before the lookup
  // below — otherwise a payload that validated fine would save nothing.
  const byLocale = new Map<string, string>();
  for (const [locale, name] of Object.entries(translations ?? {})) {
    byLocale.set(locale.trim().toLowerCase(), typeof name === 'string' ? name.trim() : '');
  }

  const kept = TRANSLATABLE_LOCALES.filter((locale) => byLocale.get(locale));

  // Clear the locales this payload drops, then upsert the rest: an edit keeps
  // the row's original `created_at` and stamps `modified_at`, which a
  // delete-then-insert would lose.
  if (kept.length === 0) {
    await runner.query(`DELETE FROM ${cfg.table} WHERE ${cfg.entityColumn} = ?`, [entityId]);
  } else {
    const marks = kept.map(() => '?').join(',');
    await runner.query(
      `DELETE FROM ${cfg.table} WHERE ${cfg.entityColumn} = ? AND locale NOT IN (${marks})`,
      [entityId, ...kept],
    );
  }
  for (const locale of kept) {
    await runner.query(
      `INSERT INTO ${cfg.table} (${cfg.entityColumn}, locale, name) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), modified_at = UTC_TIMESTAMP()`,
      [entityId, locale, byLocale.get(locale)],
    );
  }
}

/**
 * Copy one entity's translations onto another (a duplicate, a clone, or a Base
 * Exercise imported into a gym's catalogue). A copy is a copy: the translations
 * travel with the name they translate, or the copy would read in English for
 * every viewer the original served in their own language.
 */
export async function copyTranslationsFor(
  cfg: TranslatedNameConfig,
  runner: TranslationQueryRunner,
  sourceId: number | string,
  targetId: number | string,
): Promise<void> {
  await runner.query(
    `INSERT INTO ${cfg.table} (${cfg.entityColumn}, locale, name)
      SELECT ?, locale, name FROM ${cfg.table} WHERE ${cfg.entityColumn} = ?
      ON DUPLICATE KEY UPDATE name = VALUES(name), modified_at = UTC_TIMESTAMP()`,
    [targetId, sourceId],
  );
}

/**
 * Validate a `translations` payload: an object keyed by supported locale, with
 * string values. The base locale is rejected — it is the entity's own `name`
 * column, not a translation — and unknown locales are rejected rather than
 * silently dropped, so a typo'd key doesn't look like it saved.
 */
export function validateTranslationsPayload(
  value: unknown,
  maxNameLength: number,
): { error: string } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'translations must be an object keyed by locale' };
  }
  for (const [locale, name] of Object.entries(value as Record<string, unknown>)) {
    if (!isSupportedLocale(locale)) {
      return { error: `translations contains an unsupported locale: ${locale}` };
    }
    if (locale === BASE_LOCALE) {
      return { error: `translations must not contain the base locale '${BASE_LOCALE}' — use name` };
    }
    if (name !== null && typeof name !== 'string') {
      return { error: `translations.${locale} must be a string` };
    }
    if (typeof name === 'string' && name.trim().length > maxNameLength) {
      return { error: `translations.${locale} must be ${maxNameLength} characters or fewer` };
    }
  }
  return null;
}
