/**
 * #1817 / #2110 — the Professional Service form as pure functions, shared by the
 * gym's own page and Cordel's Base page: the row → form mapping, the validation
 * the API repeats and the request payload. English is the base `name` /
 * `description`; Spanish and Catalan are the `translations` the API stores in
 * `professional_service_translations` (for a gym's own service as for a Base one).
 */

/**
 * #2664: a service's Booking Type, mirroring `SERVICE_BOOKING_TYPES` in
 * `api/src/domain/serviceBookingType.ts` (and its CHECK). Configuration only:
 * nothing in booking reads it yet.
 */
export const PS_BOOKING_TYPES = ['family_only', 'open_group'] as const;
export type PsBookingType = typeof PS_BOOKING_TYPES[number];
export const DEFAULT_PS_BOOKING_TYPE: PsBookingType = 'open_group';

/** The locale key a Booking Type reads under; an unknown stored value falls back to the default's. */
export function bookingTypeLabelKey(value: string | null | undefined): `booking_type_${PsBookingType}` {
  const v = (PS_BOOKING_TYPES as readonly string[]).includes(value ?? '') ? (value as PsBookingType) : DEFAULT_PS_BOOKING_TYPE;
  return `booking_type_${v}`;
}

export const PS_LOCALES = ['en', 'es', 'ca'] as const;
export type Loc = typeof PS_LOCALES[number];

export interface PsRow {
  id: number;
  name: string;
  description: string | null;
  max_capacity: number | null;
  min_participants?: number | null;
  booking_type?: PsBookingType;
  image_url?: string | null;
  base_professional_service_id?: number | null;
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
  /** #2293: Unlimited disables Max Capacity (stored as no capacity, NULL). */
  unlimited: boolean;
  min_participants: string;
  booking_type: PsBookingType;
  texts: Record<Loc, { name: string; description: string }>;
}

export function emptyForm(): Form {
  return {
    id: null,
    max_capacity: '',
    unlimited: true,
    min_participants: '',
    booking_type: DEFAULT_PS_BOOKING_TYPE,
    texts: { en: { name: '', description: '' }, es: { name: '', description: '' }, ca: { name: '', description: '' } },
  };
}

export function formFor(s: PsRow): Form {
  const tr = s.translations ?? {};
  return {
    id: s.id,
    max_capacity: s.max_capacity == null ? '' : String(s.max_capacity),
    unlimited: s.max_capacity == null,
    min_participants: s.min_participants == null ? '' : String(s.min_participants),
    booking_type: (PS_BOOKING_TYPES as readonly string[]).includes(s.booking_type ?? '') ? s.booking_type! : DEFAULT_PS_BOOKING_TYPE,
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

/** True when a non-empty Minimum Participants is not a positive whole number. */
export function minParticipantsFormatError(value: string): boolean {
  return capacityError(value);
}

/** True when the minimum exceeds a limited capacity (an Unlimited one has no ceiling). */
export function minExceedsCapacity(f: Form): boolean {
  if (f.unlimited || f.min_participants.trim() === '' || f.max_capacity.trim() === '') return false;
  return Number(f.min_participants) > Number(f.max_capacity);
}

/**
 * What stops a save, as a key of the `professional_services` namespace. A Base
 * service needs a name in every language; a gym's own needs the English one and
 * leaves the others to fall back (#2110).
 */
export function formErrorKey(f: Form, requireAllTranslations: boolean): 'error_name_required' | 'error_required_translations' | 'error_max_capacity' | 'error_min_participants' | 'error_min_exceeds_capacity' | null {
  if (!f.texts.en.name.trim()) return 'error_name_required';
  if (requireAllTranslations && PS_LOCALES.some((l) => !f.texts[l].name.trim())) return 'error_required_translations';
  if (!f.unlimited && (f.max_capacity.trim() === '' || capacityError(f.max_capacity))) return 'error_max_capacity';
  if (minParticipantsFormatError(f.min_participants)) return 'error_min_participants';
  if (minExceedsCapacity(f)) return 'error_min_exceeds_capacity';
  return null;
}

export function toPayload(f: Form) {
  const tr = (l: 'es' | 'ca') => ({
    name: f.texts[l].name.trim(),
    description: f.texts[l].description.trim() || null,
  });
  const cap = f.unlimited ? '' : f.max_capacity.trim();
  const min = f.min_participants.trim();
  return {
    name: f.texts.en.name.trim(),
    description: f.texts.en.description.trim() || null,
    max_capacity: cap === '' ? null : Number(cap),
    min_participants: min === '' ? null : Number(min),
    booking_type: f.booking_type,
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

export type PsTextField = 'name' | 'description';

/** `{ locale: value }` of one field across every supported language (#2331). */
export function textValuesOf(texts: Form['texts'], field: PsTextField): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of PS_LOCALES) out[l] = texts[l][field];
  return out;
}

/** The read-only row's texts in the form's shape, so one function serves both views. */
export function textsOfRow(s: PsRow): Form['texts'] {
  return formFor(s).texts;
}

/** The form with one field's values from the translations modal applied. */
export function applyTextValues(f: Form, field: PsTextField, values: Record<string, string>): Form {
  const texts = { ...f.texts };
  for (const l of PS_LOCALES) texts[l] = { ...texts[l], [field]: values[l] ?? '' };
  return { ...f, texts };
}
