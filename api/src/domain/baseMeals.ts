/**
 * #3328 — Cordel's Base Meals: the one place what a Base Meal is, where its
 * image lives and which of its objects may be deleted. Pure: no database, no
 * bucket.
 *
 * The name and description are the base-locale (English) values and fallback,
 * every other locale is a row of `base_meal_translations` handled by
 * `nutritionGoalTranslations.ts` (kind `base_meal`); the slug is generated once
 * from the name (`allocateGlobalSlug('base_meals', …)`) and never rewritten, which
 * is why the image key is built from the id and the **slug** and never moves.
 */
import {
  MEALS_FOLDER,
  PLATFORM_STORAGE_ROOT,
  sanitizeStorageObjectName,
  storageKeyFromObjectUrl,
} from '../infra/storage';

export { MEALS_FOLDER };

/**
 * The meals migration 478 seeds, in their display order: the slug is today's
 * fixed `meal_type` value (stage 2 backfills the plans' meals by it). Mirrors the
 * migration's `SEEDS`; `base-meals.unit.test.ts` asserts the two agree.
 */
export const SYSTEM_BASE_MEALS: ReadonlyArray<{ slug: string; en: string; es: string; ca: string }> = [
  { slug: 'recien_levantado', en: 'Just Woken Up', es: 'Recién levantado', ca: 'Just llevat' },
  { slug: 'breakfast', en: 'Breakfast', es: 'Desayuno', ca: 'Esmorzar' },
  { slug: 'media_manana', en: 'Mid-Morning Snack', es: 'Media mañana', ca: 'Mig matí' },
  { slug: 'lunch', en: 'Lunch', es: 'Comida', ca: 'Dinar' },
  { slug: 'snack', en: 'Snack', es: 'Merienda', ca: 'Berenar' },
  { slug: 'dinner', en: 'Dinner', es: 'Cena', ca: 'Sopar' },
  { slug: 'antes_de_dormir', en: 'Before Bed', es: 'Antes de dormir', ca: 'Abans de dormir' },
  { slug: 'two_three_hours_before_training', en: '2–3 Hours Before Training', es: '2-3 horas antes del entrenamiento', ca: "2-3 hores abans de l'entrenament" },
  { slug: 'immediately_before_training', en: 'Immediately Before Training', es: 'Inmediatamente antes del entrenamiento', ca: "Immediatament abans de l'entrenament" },
  { slug: 'immediately_after_training', en: 'Immediately After Training', es: 'Inmediatamente después del entrenamiento', ca: "Immediatament després de l'entrenament" },
];

/** The slug as it appears in an object key (a generated slug already is; a seeded one keeps its `_`). */
function keyName(slug: string): string {
  return sanitizeStorageObjectName(slug, 'meal').slice(0, 80).replace(/-$/, '');
}

/** `cordel/meals/<id>-<slug>.webp` — the 1080 × 1080 master. Deterministic: a replacement overwrites it. */
export function buildBaseMealImageKey(mealId: number | string, slug: string): string {
  return `${PLATFORM_STORAGE_ROOT}/${MEALS_FOLDER}/${mealId}-${keyName(slug)}.webp`;
}

/** The 256 × 256 sibling: the master's key with `-thumbnail` before the extension. */
export function buildBaseMealImageThumbnailKey(mealId: number | string, slug: string): string {
  return `${PLATFORM_STORAGE_ROOT}/${MEALS_FOLDER}/${mealId}-${keyName(slug)}-thumbnail.webp`;
}

/** Folder markers between the bucket root and `meals/`, outermost first. */
export function baseMealImageFolderKeys(): string[] {
  return [`${PLATFORM_STORAGE_ROOT}/`, `${PLATFORM_STORAGE_ROOT}/${MEALS_FOLDER}/`];
}

/** Whether the object behind `url` is under `cordel/meals/` and so may be deleted when replaced or removed. */
export function isOwnedBaseMealImageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const key = storageKeyFromObjectUrl(url);
  return !!key && key.startsWith(`${PLATFORM_STORAGE_ROOT}/${MEALS_FOLDER}/`);
}

/**
 * #3328 stage 3 — a Base Meal's status. `inactive` keeps the meal (every plan
 * meal referencing it still reads it) but stops it being offered or accepted as
 * a new choice. Mirrored by `chk_base_meals_status` (migration 484) and the
 * admin's Status select; a new status goes in both.
 */
export const BASE_MEAL_STATUSES = ['active', 'inactive'] as const;
export type BaseMealStatus = typeof BASE_MEAL_STATUSES[number];

/** A request's `status`: absent keeps the stored value, anything outside the set is a 400 (never coerced). */
export function parseBaseMealStatusInput(
  body: unknown,
): { value: BaseMealStatus | undefined } | { error: string } {
  const raw = (body as any)?.status;
  if (raw === undefined) return { value: undefined };
  if (typeof raw === 'string' && (BASE_MEAL_STATUSES as readonly string[]).includes(raw)) {
    return { value: raw as BaseMealStatus };
  }
  return { error: `status must be one of: ${BASE_MEAL_STATUSES.join(', ')}` };
}
