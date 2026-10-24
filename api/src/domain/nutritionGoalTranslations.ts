import { Tx } from '../infra/db';
import {
  BASE_LOCALE,
  SupportedLocale,
  TRANSLATABLE_LOCALES,
  isSupportedLocale,
} from '../infra/locale';
import { localeLiteral } from './nameTranslations';
import { GOAL_NAME_MAX_LENGTH } from './goalLibrary';

/**
 * A Nutrition Goal's name and description in every supported language (#1623).
 *
 * `nutrition_goals.name` / `description` are the base-locale values and the
 * fallback; every other locale is one row of `nutrition_goal_translations`
 * (migration 282) carrying **both** texts, since a goal's name and description
 * are edited and read together. The rules are #967's: a locale with no (or a
 * blank) value falls back to the base one, a write that omits `translations`
 * leaves the stored rows alone and an explicit `{}` clears them.
 *
 * It is a sibling of `domain/nameTranslations.ts` rather than a use of it
 * because that mechanism stores a name alone.
 */
export const GOAL_DESCRIPTION_MAX_LENGTH = 1000;

/**
 * #1719 — Personal Goals carry the same translated name and description in
 * `personal_goal_translations` (migration 292). One module serves both kinds, so
 * the rules (fallback, replace-all, omit-keeps) cannot drift between them.
 */
export type TranslatedGoalKind = 'nutrition' | 'personal' | 'base_personal';

const KIND_TABLES: Record<TranslatedGoalKind, { table: string; fk: string }> = {
  nutrition: { table: 'nutrition_goal_translations', fk: 'nutrition_goal_id' },
  personal: { table: 'personal_goal_translations', fk: 'personal_goal_id' },
  // #1849 stage 2b: the Base Personal Goals' own junction (migration 304).
  base_personal: { table: 'base_personal_goal_translations', fk: 'base_personal_goal_id' },
};

export interface GoalTranslation {
  name: string;
  description: string | null;
}

/**
 * The System goals' texts migration 282 seeds, keyed by slug. Mirrors the
 * migration's `SEEDS` (plain JS, cannot import this); a unit test asserts the
 * two agree.
 */
export const SYSTEM_NUTRITION_GOAL_TEXTS: Record<string, { en: string; es: GoalTranslation; ca: GoalTranslation }> = {
  calories: {
    en: 'Daily energy intake target.',
    es: { name: 'Calorías', description: 'Objetivo de ingesta diaria de energía.' },
    ca: { name: 'Calories', description: "Objectiu d'ingesta diària d'energia." },
  },
  protein: {
    en: 'Daily protein intake target.',
    es: { name: 'Proteínas', description: 'Objetivo de ingesta diaria de proteínas.' },
    ca: { name: 'Proteïnes', description: "Objectiu d'ingesta diària de proteïnes." },
  },
  carbohydrates: {
    en: 'Daily carbohydrate intake target.',
    es: { name: 'Carbohidratos', description: 'Objetivo de ingesta diaria de carbohidratos.' },
    ca: { name: 'Hidrats de carboni', description: "Objectiu d'ingesta diària d'hidrats de carboni." },
  },
  fats: {
    en: 'Daily fat intake target.',
    es: { name: 'Grasas', description: 'Objetivo de ingesta diaria de grasas.' },
    ca: { name: 'Greixos', description: "Objectiu d'ingesta diària de greixos." },
  },
  fiber: {
    en: 'Daily fiber intake target.',
    es: { name: 'Fibra', description: 'Objetivo de ingesta diaria de fibra.' },
    ca: { name: 'Fibra', description: "Objectiu d'ingesta diària de fibra." },
  },
  water: {
    en: 'Daily water intake target.',
    es: { name: 'Agua', description: 'Objetivo de ingesta diaria de agua.' },
    ca: { name: 'Aigua', description: "Objectiu d'ingesta diària d'aigua." },
  },
  fasting: {
    en: 'Fasting window to follow.',
    es: { name: 'Ayuno', description: 'Ventana de ayuno a seguir.' },
    ca: { name: 'Dejuni', description: 'Finestra de dejuni a seguir.' },
  },
};

/** The System Personal Goals' translated names migration 292 seeds (mirrors its `SEEDS`). */
export const SYSTEM_PERSONAL_GOAL_TRANSLATIONS: Record<string, { es: string; ca: string }> = {
  weight_loss: { es: 'Pérdida de peso', ca: 'Pèrdua de pes' },
  weight_gain: { es: 'Aumento de peso', ca: 'Augment de pes' },
  muscle_gain: { es: 'Ganancia muscular', ca: 'Guany muscular' },
  maintenance: { es: 'Mantenimiento', ca: 'Manteniment' },
  performance: { es: 'Rendimiento', ca: 'Rendiment' },
  recovery: { es: 'Recuperación', ca: 'Recuperació' },
  energy: { es: 'Energía', ca: 'Energia' },
};

function column(col: 'name' | 'description', alias: string, locale: SupportedLocale, kind: TranslatedGoalKind): string {
  const { table, fk } = KIND_TABLES[kind];
  const literal = localeLiteral(locale);
  if (!literal) return `${alias}.${col}`;
  return `COALESCE((SELECT NULLIF(ngt.${col}, '') FROM ${table} ngt
            WHERE ngt.${fk} = ${alias}.id AND ngt.locale = ${literal}), ${alias}.${col})`;
}

/** `display_name` and `display_description`, resolved for `locale` with the base value as fallback. */
export function localizedGoalExprs(alias: string, locale: SupportedLocale, kind: TranslatedGoalKind = 'nutrition'): string {
  return `${column('name', alias, locale, kind)} AS display_name,
    ${column('description', alias, locale, kind)} AS display_description`;
}

/**
 * The row's own `{ locale: { name, description } }` map, projected beside the
 * base values on **every** read (list included): `⋮ → Edit` seeds its form from
 * the row the page already holds, and a form seeded without it would submit an
 * empty replace-all set and wipe the translations on the first save.
 */
export function goalTranslationsExpr(alias: string, as = 'translations', kind: TranslatedGoalKind = 'nutrition'): string {
  const { table, fk } = KIND_TABLES[kind];
  return `(SELECT JSON_OBJECTAGG(ngta.locale, JSON_OBJECT('name', ngta.name, 'description', ngta.description))
            FROM ${table} ngta WHERE ngta.${fk} = ${alias}.id) AS ${as}`;
}

/** The aggregate's `NULL`-for-none as the `{}` the API contract promises. */
export function withGoalTranslations<T extends { translations?: unknown }>(row: T): T {
  if (row === null || row === undefined) return row;
  let value: unknown = row.translations;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...row, translations: value };
  return { ...row, translations: {} };
}

/**
 * A `?search=` predicate matching the base name, the slug or **any** stored
 * translated name (#967 §7: a gym searching in one language finds the goal
 * whatever language its screen is in). Carries three placeholders — bind the
 * same pattern to all of them.
 */
export function goalTranslatedSearchSql(alias: string, kind: TranslatedGoalKind = 'nutrition'): string {
  const { table, fk } = KIND_TABLES[kind];
  return `(${alias}.name LIKE ? OR ${alias}.slug LIKE ? OR EXISTS (
            SELECT 1 FROM ${table} ngts
             WHERE ngts.${fk} = ${alias}.id AND ngts.name LIKE ?))`;
}

/**
 * Validate a `translations` payload: an object keyed by a supported non-base
 * locale whose values are `{ name?, description? }` strings (or null).
 */
export function validateGoalTranslations(value: unknown): { error: string } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'translations must be an object keyed by locale' };
  }
  for (const [locale, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isSupportedLocale(locale)) {
      return { error: `translations contains an unsupported locale: ${locale}` };
    }
    if (locale === BASE_LOCALE) {
      return { error: `translations must not contain the base locale '${BASE_LOCALE}' — use name and description` };
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: `translations.${locale} must be an object` };
    }
    const { name, description } = entry as Record<string, unknown>;
    if (name !== undefined && name !== null) {
      if (typeof name !== 'string') return { error: `translations.${locale}.name must be a string` };
      if (name.trim().length > GOAL_NAME_MAX_LENGTH) {
        return { error: `translations.${locale}.name must be ${GOAL_NAME_MAX_LENGTH} characters or fewer` };
      }
    }
    if (description !== undefined && description !== null) {
      if (typeof description !== 'string') return { error: `translations.${locale}.description must be a string` };
      if (description.trim().length > GOAL_DESCRIPTION_MAX_LENGTH) {
        return { error: `translations.${locale}.description must be ${GOAL_DESCRIPTION_MAX_LENGTH} characters or fewer` };
      }
    }
    // A description with no name has nothing to hang off: the name is the row's
    // NOT NULL column, and a half-filled locale is the one invalid state.
    const hasName = typeof name === 'string' && name.trim().length > 0;
    const hasDescription = typeof description === 'string' && description.trim().length > 0;
    if (hasDescription && !hasName) {
      return { error: `translations.${locale}.name is required when a description is given` };
    }
  }
  return null;
}

/**
 * The `translations` object a write accepted, or `undefined` when the request
 * did not mention the field — which leaves the stored rows alone. An explicit
 * `{}` clears them.
 */
export function parseGoalTranslations(
  body: Record<string, unknown> | undefined,
): { translations?: Record<string, { name?: string | null; description?: string | null }>; error?: string } {
  if (!body || !('translations' in body)) return {};
  const invalid = validateGoalTranslations(body.translations);
  if (invalid) return { error: invalid.error };
  return { translations: (body.translations ?? {}) as Record<string, { name?: string | null; description?: string | null }> };
}

/**
 * Replace **all** translations of one goal inside the caller's transaction: a
 * locale the payload omits, or leaves without a name, loses its row and falls
 * back to the base texts.
 */
export async function replaceGoalTranslations(
  tx: Tx,
  goalId: number | string,
  translations: Record<string, { name?: string | null; description?: string | null }>,
  kind: TranslatedGoalKind = 'nutrition',
): Promise<void> {
  const { table: TABLE, fk } = KIND_TABLES[kind];
  const byLocale = new Map<string, { name: string; description: string | null }>();
  for (const [locale, entry] of Object.entries(translations ?? {})) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (!name) continue;
    const description = typeof entry?.description === 'string' ? entry.description.trim() : '';
    byLocale.set(locale.trim().toLowerCase(), { name, description: description || null });
  }
  const kept = TRANSLATABLE_LOCALES.filter((locale) => byLocale.has(locale));

  if (kept.length === 0) {
    await tx.query(`DELETE FROM ${TABLE} WHERE ${fk} = ?`, [goalId]);
    return;
  }
  const marks = kept.map(() => '?').join(',');
  await tx.query(
    `DELETE FROM ${TABLE} WHERE ${fk} = ? AND locale NOT IN (${marks})`,
    [goalId, ...kept],
  );
  for (const locale of kept) {
    const entry = byLocale.get(locale)!;
    await tx.query(
      `INSERT INTO ${TABLE} (${fk}, locale, name, description) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), modified_at = UTC_TIMESTAMP()`,
      [goalId, locale, entry.name, entry.description],
    );
  }
}

/** Copy one goal's translations onto another (Duplicate): they travel with the text they translate. */
export async function copyGoalTranslations(
  tx: Tx,
  sourceId: number | string,
  targetId: number | string,
  kind: TranslatedGoalKind = 'nutrition',
): Promise<void> {
  const { table: TABLE, fk } = KIND_TABLES[kind];
  await tx.query(
    `INSERT INTO ${TABLE} (${fk}, locale, name, description)
      SELECT ?, locale, name, description FROM ${TABLE} WHERE ${fk} = ?
      ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), modified_at = UTC_TIMESTAMP()`,
    [targetId, sourceId],
  );
}
