/**
 * #1817 / #2110 — the Professional Service form as pure functions, shared by the
 * gym's own page and Cordel's Base page: the row → form mapping, the validation
 * the API repeats and the request payload. English is the base `name` /
 * `description`; Spanish and Catalan are the `translations` the API stores in
 * `professional_service_translations` (for a gym's own service as for a Base one).
 */

export const PS_LOCALES = ['en', 'es', 'ca'] as const;
export type Loc = typeof PS_LOCALES[number];

export interface PsRow {
  id: number;
  name: string;
  description: string | null;
  max_capacity: number | null;
  image_url?: string | null;
  image_thumbnail_url?: string | null;
  display_name: string;
  display_description: string | null;
  /** Gym-side only: a Base catalogue row has no per-gym status. */
  status?: 'active' | 'inactive';
  is_system?: number;
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

export function formFor(s: PsRow): Form {
  const tr = s.translations ?? {};
  return {
    id: s.id,
    max_capacity: s.max_capacity == null ? '' : String(s.max_capacity),
    texts: {
      en: { name: s.name, description: s.description ?? '' },
      es: { name: tr.es?.name ?? '', description: tr.es?.description ?? '' },
      ca: { name: tr.ca?.name ?? '', description: tr.ca?.description ?? '' },
    },
  };
}

/** True when a non-empty Max Capacity is not a positive whole number. */
export function capacityError(value: string): boolean {
  const v = value.trim();
  if (v === '') return false;
  return !/^\d+$/.test(v) || Number(v) <= 0;
}

/**
 * What stops a save, as a key of the `professional_services` namespace. A Base
 * service needs a name in every language; a gym's own needs the English one and
 * leaves the others to fall back (#2110).
 */
export function formErrorKey(f: Form, requireAllTranslations: boolean): 'error_name_required' | 'error_required_translations' | 'error_max_capacity' | null {
  if (!f.texts.en.name.trim()) return 'error_name_required';
  if (requireAllTranslations && PS_LOCALES.some((l) => !f.texts[l].name.trim())) return 'error_required_translations';
  if (capacityError(f.max_capacity)) return 'error_max_capacity';
  return null;
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

/** Client-side search over the base text and every translation. */
export function matchesSearch(s: PsRow, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay = [s.name, s.description, ...Object.values(s.translations ?? {}).flatMap((t) => [t?.name, t?.description])];
  return hay.some((v) => typeof v === 'string' && v.toLowerCase().includes(needle));
}
