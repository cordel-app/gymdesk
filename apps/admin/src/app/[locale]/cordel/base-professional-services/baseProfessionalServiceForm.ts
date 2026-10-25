/**
 * #1817 — the Base Professional Service form, as pure functions: the row →
 * form mapping, the validation the API repeats, and the request payload.
 * English is the base `name` / `description`; Spanish and Catalan are the
 * `translations` the API stores in `professional_service_translations`.
 */

export const BASE_PS_LOCALES = ['en', 'es', 'ca'] as const;
export type Loc = typeof BASE_PS_LOCALES[number];

export interface BasePs {
  id: number;
  name: string;
  description: string | null;
  max_capacity: number | null;
  image_url?: string | null;
  image_thumbnail_url?: string | null;
  display_name: string;
  display_description: string | null;
  created_at: string | null;
  created_by: string | null;
  modified_at: string | null;
  modified_by: string | null;
  translations: Partial<Record<'es' | 'ca', { name: string; description: string | null }>>;
}

export interface Form {
  id: number | null;
  max_capacity: string;
  texts: Record<Loc, { name: string; description: string }>;
}

export function emptyForm(): Form {
  return {
    id: null,
    max_capacity: '',
    texts: { en: { name: '', description: '' }, es: { name: '', description: '' }, ca: { name: '', description: '' } },
  };
}

export function formFor(s: BasePs): Form {
  return {
    id: s.id,
    max_capacity: s.max_capacity == null ? '' : String(s.max_capacity),
    texts: {
      en: { name: s.name, description: s.description ?? '' },
      es: { name: s.translations.es?.name ?? '', description: s.translations.es?.description ?? '' },
      ca: { name: s.translations.ca?.name ?? '', description: s.translations.ca?.description ?? '' },
    },
  };
}

/** True when a non-empty Max Capacity is not a positive whole number. */
export function capacityError(value: string): boolean {
  const v = value.trim();
  if (v === '') return false;
  return !/^\d+$/.test(v) || Number(v) <= 0;
}

export function toPayload(f: Form) {
  const tr = (l: 'es' | 'ca') => ({
    name: f.texts[l].name.trim(),
    description: f.texts[l].description.trim() || null,
  });
  const cap = f.max_capacity.trim();
  return {
    name: f.texts.en.name.trim(),
    description: f.texts.en.description.trim() || null,
    max_capacity: cap === '' ? null : Number(cap),
    translations: { es: tr('es'), ca: tr('ca') },
  };
}
