/**
 * #2203 — what the exercise details modal (opened from an Assigned Training
 * Plan) shows. Pure: the modal fetches the exercise and hands the row here, so
 * the rules for "which fields exist" are testable without rendering.
 *
 * Localised content comes from the API (`display_*`), the base columns are only
 * the fallback; a field with no content is omitted so the layout never shows an
 * empty heading.
 */
export interface ExerciseInfoRow {
  name: string;
  display_name?: string | null;
  short_description?: string | null;
  display_short_description?: string | null;
  description?: string | null;
  display_description?: string | null;
  category?: string | null;
  equipment?: string | null;
  muscles?: { key: string; role: string }[] | null;
  effective_image_url?: string | null;
  /** #2306: the full-size master of each position (never a thumbnail). */
  effective_image_male_url?: string | null;
  effective_image_female_url?: string | null;
}

export type ExerciseInfoFieldId = 'short_description' | 'description' | 'muscles' | 'equipment' | 'categories';

export interface ExerciseInfoMuscle { key: string; role: 'principal' | 'secondary' }

export interface ExerciseInfo {
  name: string;
  imageUrl: string | null;
  shortDescription: string | null;
  description: string | null;
  muscles: ExerciseInfoMuscle[];
  /** Stored equipment value (free text from the dataset), humanised by the modal. */
  equipment: string | null;
  /** Stored category ids (there is one today; a list so a second never needs a new shape). */
  categories: string[];
}

const text = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s ? s : null;
};

export function buildExerciseInfo(row: ExerciseInfoRow, gender?: 'male' | 'female' | null): ExerciseInfo {
  const category = text(row.category);
  return {
    name: text(row.display_name) ?? row.name,
    // #2306: a clicked gendered thumbnail opens that gender's own master; no gender → the default.
    imageUrl: gender ? text(gender === 'female' ? row.effective_image_female_url : row.effective_image_male_url) : text(row.effective_image_url),
    shortDescription: text(row.display_short_description) ?? text(row.short_description),
    description: text(row.display_description) ?? text(row.description),
    muscles: (row.muscles ?? []).map((m) => ({
      key: m.key,
      role: m.role === 'secondary' ? 'secondary' : 'principal',
    })),
    equipment: text(row.equipment),
    categories: category ? [category] : [],
  };
}

/** The fields that have content, in display order. */
export function exerciseInfoFields(info: ExerciseInfo): ExerciseInfoFieldId[] {
  const out: ExerciseInfoFieldId[] = [];
  if (info.shortDescription) out.push('short_description');
  if (info.description) out.push('description');
  if (info.muscles.length > 0) out.push('muscles');
  if (info.equipment) out.push('equipment');
  if (info.categories.length > 0) out.push('categories');
  return out;
}

/**
 * #3407 — whether the modal draws its "No image" placeholder where the image
 * goes: the original failed to load, or a clicked sex position turned out to
 * have no original once the details loaded. An exercise opened from its name
 * with no image at all keeps no image area (#2203).
 */
export function showImagePlaceholder({ imageUrl, imageBroken, gender, loaded }: {
  imageUrl: string | null; imageBroken: boolean; gender?: 'male' | 'female' | null; loaded: boolean;
}): boolean {
  if (imageUrl) return imageBroken;
  return loaded && !!gender;
}
