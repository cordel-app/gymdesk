import { PLATFORM_STORAGE_ROOT } from '../infra/storage';
import { ENTITY_SLUG_MAX } from './entitySlug';
import { EXERCISE_SLUG_MAX } from './freeExerciseDb';
import { ExerciseGender } from './exerciseGenderMedia';
import { MUSCLE_SEXES, MuscleSex } from './muscleImages';
import { parseMuscleTranslations } from './muscleTranslations';

/**
 * A Base Exercise's archive carries its two gender-specific images. Its videos are
 * not moved (#2952 stage 6): a video upload needs a frame the browser captures from
 * the MP4, so an import leaves the stored videos exactly as they are.
 */
export const BASE_EXERCISE_IMAGE_SLOTS = ['image_male', 'image_female'] as const;

export function exerciseGenderFromSlot(slot: string): ExerciseGender | null {
  if (slot === 'image_male') return 'male';
  if (slot === 'image_female') return 'female';
  return null;
}

/**
 * #2952 — Cordel → Export / Import. The pure half of the transfer: which entity
 * types may be moved, what one imported record must hold, and which stored
 * objects an export may read. `api/src/api/platform-transfer.ts` is the I/O half.
 *
 * An entity is identified by its `slug` alone (#2951): an import creates the
 * entity when no row carries that slug and updates the one that does. An update
 * writes the entity's own content (name, translations, images) and never a
 * relationship to another entity, and the slug itself never changes.
 *
 * The types are added one stage at a time; the Admin lists exactly the ones
 * `GET /platform/transfer/types` answers, so a type that cannot be moved yet is
 * absent rather than offered and broken.
 */
export const TRANSFER_ENTITY_TYPES = [
  'muscles', 'payment_providers', 'base_payment_methods', 'base_professional_services',
  'base_personal_goals', 'base_nutrition_goals', 'base_nutrition_library', 'base_exercises', 'gyms',
] as const;
export type TransferEntityType = (typeof TRANSFER_ENTITY_TYPES)[number];

/** The image slots each type carries, in the order an archive lists them. */
export const TRANSFER_IMAGE_SLOTS: Record<TransferEntityType, readonly string[]> = {
  muscles: MUSCLE_SEXES,
  payment_providers: [],
  base_payment_methods: ['image'],
  base_professional_services: ['image'],
  base_personal_goals: ['image'],
  base_nutrition_goals: ['image'],
  base_nutrition_library: ['image'],
  base_exercises: BASE_EXERCISE_IMAGE_SLOTS,
  gyms: [],
};

export function parseTransferEntityType(value: unknown): TransferEntityType | null {
  return typeof value === 'string' && (TRANSFER_ENTITY_TYPES as readonly string[]).includes(value)
    ? (value as TransferEntityType)
    : null;
}

/**
 * A muscle slug is the catalogue's snake_case shape (`middle_back`), at most 60
 * characters — what `slugFromMuscleName()` produces. An imported slug of any
 * other shape is refused rather than normalised, since normalising it would
 * give the entity a different identity from the one the archive names.
 */
const MUSCLE_SLUG_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

export function isValidMuscleSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 60 && MUSCLE_SLUG_PATTERN.test(value);
}

export interface MuscleTransferRecord {
  slug: string;
  name: string;
  /** Absent keeps the stored translations; `{}` clears them. */
  translations?: Record<string, string>;
}

/** Judges one imported muscle: `{ record }`, or `{ error }` naming the field. */
export function parseMuscleTransferRecord(body: unknown): { record: MuscleTransferRecord } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  if (!isValidMuscleSlug(b.slug)) return { error: 'slug must be lowercase letters, digits and underscores (at most 60)' };
  if (typeof b.name !== 'string' || !b.name.trim()) return { error: 'name is required' };
  const name = b.name.trim();
  if (name.length > 120) return { error: 'name must be at most 120 characters' };
  const tr = parseMuscleTranslations(b);
  if (tr.error) return { error: tr.error };
  return { record: { slug: b.slug, name, ...(tr.translations ? { translations: tr.translations } : {}) } };
}

export function parseTransferImageSlot(type: TransferEntityType, value: unknown): string | null {
  return typeof value === 'string' && TRANSFER_IMAGE_SLOTS[type].includes(value) ? value : null;
}

export function muscleSexFromSlot(slot: string): MuscleSex | null {
  return (MUSCLE_SEXES as readonly string[]).includes(slot) ? (slot as MuscleSex) : null;
}

/**
 * An export may read back only a platform object (`cordel/…`), named by a key
 * with no empty, `.` or `..` segment — never a gym's private folder and never a
 * key a caller composed to climb out of the root.
 */
export function isTransferableObjectKey(key: string | null | undefined): key is string {
  if (!key || !key.startsWith(`${PLATFORM_STORAGE_ROOT}/`)) return false;
  return key.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Whether an import created the entity or updated the one carrying its slug. */
export type TransferAction = 'created' | 'updated';

/** The per-person budget of the import's image uploads (many per run, unlike an editor's). */
export const TRANSFER_IMAGE_RATE_LIMIT_DEFAULT_MAX = 600;
export const TRANSFER_IMAGE_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export function transferImageRateLimitMax(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TRANSFER_IMAGE_RATE_LIMIT_MAX);
  return Number.isInteger(n) && n > 0 ? n : TRANSFER_IMAGE_RATE_LIMIT_DEFAULT_MAX;
}

/**
 * A slug of #2951's shape: lowercase letters and digits in hyphen-separated
 * runs, at most `ENTITY_SLUG_MAX` — what `generateSlug()` produces for every
 * entity but Muscles. An imported slug of any other shape is refused rather
 * than normalised, for the reason `isValidMuscleSlug()` gives.
 */
const ENTITY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidEntitySlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= ENTITY_SLUG_MAX && ENTITY_SLUG_PATTERN.test(value);
}

/** The fields of a Payment Provider an archive carries: its own content, never `is_default`. */
export const PAYMENT_PROVIDER_TRANSFER_FIELDS = ['name', 'provider_key', 'description', 'status'] as const;

/** The fields of a Base Payment Method an archive carries. */
export const BASE_PAYMENT_METHOD_TRANSFER_FIELDS = ['code', 'status', 'translations'] as const;

/**
 * Splits one imported record into its slug and the writer's input: only the
 * listed fields are kept, so anything else an archive carries (an id, a flag
 * that is the platform's own setting, a relationship) never reaches a writer.
 * The values themselves are judged by the entity's own writer.
 */
export function parseSlugTransferRecord(
  body: unknown,
  fields: readonly string[],
  opts: { goalSlug?: boolean; exerciseSlug?: boolean } = {},
): { record: { slug: string; input: Record<string, unknown> } } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  if (opts.exerciseSlug ? !isValidExerciseSlug(b.slug) : opts.goalSlug ? !isValidGoalSlug(b.slug) : !isValidEntitySlug(b.slug)) {
    const separators = opts.goalSlug ? 'hyphens or underscores' : 'hyphens';
    const max = opts.exerciseSlug ? EXERCISE_SLUG_MAX : ENTITY_SLUG_MAX;
    return { error: `slug must be lowercase letters and digits separated by ${separators} (at most ${max})` };
  }
  const input: Record<string, unknown> = {};
  for (const field of fields) if (b[field] !== undefined) input[field] = b[field];
  return { record: { slug: b.slug as string, input } };
}

/**
 * The fields of a Base Professional Service an archive carries: its own content.
 * Never `is_system`, `system_key` or a gym's availability row
 * (`gym_professional_services`), which are the platform's and each gym's own.
 */
export const BASE_PROFESSIONAL_SERVICE_TRANSFER_FIELDS = [
  'name', 'description', 'max_capacity', 'min_participants', 'booking_type', 'translations',
] as const;

/**
 * A Base goal's slug: #2951's hyphenated shape for a goal Cordel created, or the
 * snake_case label handle a seeded goal kept (`weight_loss`, migration 438), at
 * most `ENTITY_SLUG_MAX`. Any other shape is refused, never normalised.
 */
const GOAL_SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export function isValidGoalSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= ENTITY_SLUG_MAX && GOAL_SLUG_PATTERN.test(value);
}

/** The fields of a Base Personal Goal an archive carries: its own content (never a gym's copy or availability). */
export const BASE_PERSONAL_GOAL_TRANSFER_FIELDS = [
  'name', 'description', 'target_value', 'target_unit', 'target_type', 'translations',
] as const;

/** The fields of a Base Nutrition Goal an archive carries. */
export const BASE_NUTRITION_GOAL_TRANSFER_FIELDS = ['name', 'description', 'translations'] as const;

/**
 * The fields of a Base Nutrition Library food an archive carries: its own content.
 * Its categories and nutritional qualities are global lookups (`nutrition_library_categories`,
 * `nutritional_qualities`) identified across databases by their slug, so the archive
 * names them as `category_slugs` / `quality_slugs`; they are a relationship, so an
 * import applies them only when it creates the food (a category is required then)
 * and never on an update.
 */
export const BASE_FOOD_TRANSFER_FIELDS = ['name', 'description', 'translations', 'description_translations'] as const;

/**
 * A list of lookup slugs as an archive names them: `undefined` when absent, else
 * an array of distinct non-empty strings (`{ error }` otherwise). Whether each
 * names an existing lookup row is the I/O half's question.
 */
export function parseLookupSlugs(value: unknown, field: string): { slugs?: string[] } | { error: string } {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) {
    return { error: `${field} must be an array of slugs` };
  }
  return { slugs: [...new Set((value as string[]).map((v) => v.trim()))] };
}

/**
 * A Base Exercise's slug: #2951's hyphenated shape, at most `EXERCISE_SLUG_MAX` —
 * longer than the other entities' because the Free Exercise DB importer (#964)
 * stored slugs of up to that length, and a stored slug is never rewritten.
 */
export function isValidExerciseSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= EXERCISE_SLUG_MAX && ENTITY_SLUG_PATTERN.test(value);
}

/**
 * The fields of a Base Exercise an archive carries: its own content. Its muscles
 * (`muscles`: `{ key, role }`, keyed by the muscle's slug) and its Recorded Metrics
 * (`result_type_slugs`, the seeded `result_types` slugs) are relationships: an
 * import applies them only when it creates the exercise and never on an update.
 * The Free Exercise DB provenance and metadata (`source`, `source_id`, `level`,
 * `mechanic`, `force_type`) are not editable through the exercise's writers and
 * are not carried.
 */
export const BASE_EXERCISE_TRANSFER_FIELDS = [
  'name', 'description', 'short_description', 'category', 'equipment',
  'min_reps_default', 'max_reps_default', 'rest_default_seconds', 'sets_default', 'status',
  'translations', 'description_translations',
] as const;

/**
 * The fields of a Gym an archive carries (#2952 stage 7): its own general content.
 * Never a reference to another entity (`theme_id`, `payment_provider_id`), a
 * secret (`website_api_key_hash`), the storage prefix of the gym's bucket, nor
 * what the gym's own settings screens write (fiscal identity, localization),
 * which have writers of their own. `plan` is set only when the import creates
 * the gym, because the gym's updater does not write it.
 */
export const GYM_TRANSFER_FIELDS = ['name', 'description', 'plan', 'status'] as const;
