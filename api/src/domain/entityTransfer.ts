import { PLATFORM_STORAGE_ROOT } from '../infra/storage';
import { MUSCLE_SEXES, MuscleSex } from './muscleImages';
import { parseMuscleTranslations } from './muscleTranslations';

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
export const TRANSFER_ENTITY_TYPES = ['muscles'] as const;
export type TransferEntityType = (typeof TRANSFER_ENTITY_TYPES)[number];

/** The image slots each type carries, in the order an archive lists them. */
export const TRANSFER_IMAGE_SLOTS: Record<TransferEntityType, readonly string[]> = {
  muscles: MUSCLE_SEXES,
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
