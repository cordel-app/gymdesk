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
  muscles?: { key: string; role: string }[] | null;
  effective_image_url?: string | null;
}

export type ExerciseInfoFieldId = 'short_description' | 'description' | 'muscles' | 'categories';

export interface ExerciseInfoMuscle { key: string; role: 'principal' | 'secondary' }

export interface ExerciseInfo {
  name: string;
  imageUrl: string | null;
  shortDescription: string | null;
  description: string | null;
  muscles: ExerciseInfoMuscle[];
  /** Stored category ids (there is one today; a list so a second never needs a new shape). */
  categories: string[];
}

const text = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s ? s : null;
};

export function buildExerciseInfo(row: ExerciseInfoRow): ExerciseInfo {
  const category = text(row.category);
  return {
    name: text(row.display_name) ?? row.name,
    imageUrl: text(row.effective_image_url),
    shortDescription: text(row.display_short_description) ?? text(row.short_description),
    description: text(row.display_description) ?? text(row.description),
    muscles: (row.muscles ?? []).map((m) => ({
      key: m.key,
      role: m.role === 'secondary' ? 'secondary' : 'principal',
    })),
    categories: category ? [category] : [],
  };
}

/** The fields that have content, in display order. */
export function exerciseInfoFields(info: ExerciseInfo): ExerciseInfoFieldId[] {
  const out: ExerciseInfoFieldId[] = [];
  if (info.shortDescription) out.push('short_description');
  if (info.description) out.push('description');
  if (info.muscles.length > 0) out.push('muscles');
  if (info.categories.length > 0) out.push('categories');
  return out;
}
