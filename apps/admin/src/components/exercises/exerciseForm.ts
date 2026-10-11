/**
 * The Exercise form, declared once (#805, #806).
 *
 * Every half of every Exercise editing surface renders from here — the gym
 * Exercises page's inline creation card and inline editor, and the platform
 * **Base Exercises** page's two halves — so the section order, the field set
 * and the payloads cannot drift apart the way a second copy of the JSX would.
 * #806 is what moved the module up out of `app/[locale]/exercises/`: the two
 * pages administer the same entity from two places, so the declaration lives
 * beside the shared editor rather than inside one of its callers (the rule
 * `components/nutritionLibrary/` already follows).
 *
 * The module is pure (no React, no i18n runtime), which is what lets the
 * ordering and the payloads be asserted directly in a unit test.
 */

export const EXERCISE_STATUSES = ['active', 'inactive'] as const;
export type ExerciseStatus = (typeof EXERCISE_STATUSES)[number];

/**
 * The form's sections, in the order both halves render them (#805 §3–§9).
 * `media` is last and nothing may be appended after it: the ticket's AC7.
 */
export const EXERCISE_FORM_SECTIONS = [
  { key: 'general', labelKey: 'section_general' },
  { key: 'configuration', labelKey: 'section_configuration' },
  { key: 'result_types', labelKey: 'label_result_types' },
  { key: 'muscles', labelKey: 'section_muscles' },
  { key: 'media', labelKey: 'section_media' },
] as const;

export type ExerciseFormSectionKey = (typeof EXERCISE_FORM_SECTIONS)[number]['key'];

/** GENERAL holds Name, Description and Status, in that order (#805 §5, AC2). */
export const EXERCISE_GENERAL_FIELDS = ['name', 'description', 'status'] as const;

/**
 * #967: the Name field is one input per supported language, not one input. The
 * base locale's is `name` — the value stored on the exercise itself, the one the
 * duplicate check compares and the fallback every other locale resolves to —
 * and each translatable locale's is an entry in `translations`, blank meaning
 * "fall back to the base name" exactly as the Nutrition Library's does (#643).
 *
 * Which locales those are is **not** declared here: the page reads them from the
 * API and hands them to the editor, so there is no second copy of the
 * application's language configuration (the ticket's closing "Important").
 */
export type ExerciseNameTranslations = Record<string, string>;

/** CONFIGURATION holds the per-exercise defaults. */
export const EXERCISE_CONFIGURATION_FIELDS = [
  'min_reps_default',
  'max_reps_default',
  'sets_default',
  'rest_default_seconds',
  'notes_default',
] as const;

/**
 * The `result_types` catalogue as migration 073 seeds it. A slug listed here
 * has a `result_type_<slug>` label in `locales/base/*.json`; anything else is
 * a row added after this list and falls back to the catalogue's own `name`,
 * so the UI can never show a raw translation key (#805 §6, AC4).
 */
export const RESULT_TYPE_SLUGS = [
  'repetitions',
  'weight',
  'distance',
  'duration',
  'pace',
  'speed',
  'calories',
  'rpe',
  'rest_time',
] as const;

export interface ResultTypeRow { id: number; name: string; slug: string }

/**
 * The user-facing label for a result type: the translated one when the slug is
 * part of the seeded catalogue, the catalogue's English `name` otherwise.
 * Never `exercises.result_type_*`.
 */
export function resultTypeLabel(rt: ResultTypeRow, translate: (key: string) => string): string {
  const known = (RESULT_TYPE_SLUGS as readonly string[]).includes(rt.slug);
  return known ? translate(`result_type_${rt.slug}`) : rt.name;
}

export type MuscleRole = 'principal' | 'secondary';

export interface ExerciseFormValues {
  /** The base-locale name (#967): what `exercises.name` stores. */
  name: string;
  /** #967: `{ locale: name }` for the translatable locales; blank = fall back. */
  translations: ExerciseNameTranslations;
  description: string;
  /** #717 Q6: offered by the creation form only — the editor manages the video through its upload control. */
  video_url: string;
  min_reps_default: string;
  max_reps_default: string;
  sets_default: string;
  rest_default_seconds: string;
  notes_default: string;
  /** #1360: one of the supported categories, or '' for none. */
  category: string;
  status: string;
}

export function emptyExerciseForm(): ExerciseFormValues {
  return {
    name: '', translations: {}, description: '', video_url: '',
    min_reps_default: '', max_reps_default: '', sets_default: '', rest_default_seconds: '', notes_default: '',
    category: '',
    status: 'active',
  };
}

export interface ExerciseRowValues {
  name: string;
  /**
   * #967: the stored per-locale names, as the single-row read returns them. A
   * list row does not carry them, so the editor seeds an empty map and the first
   * save of a form opened from a list would clear them — which is why both pages
   * seed from `GET /exercises/:id` and why the routers leave `translations`
   * untouched when a payload omits the field.
   */
  translations?: ExerciseNameTranslations | null;
  description: string | null;
  video_url: string | null;
  min_reps_default: number | null;
  max_reps_default: number | null;
  sets_default: number | null;
  rest_default_seconds: number | null;
  notes_default: string | null;
  category?: string | null;
  status: string;
}

export function exerciseFormFromRow(e: ExerciseRowValues): ExerciseFormValues {
  return {
    name: e.name,
    translations: { ...(e.translations ?? {}) },
    description: e.description ?? '',
    video_url: e.video_url ?? '',
    min_reps_default: e.min_reps_default != null ? String(e.min_reps_default) : '',
    max_reps_default: e.max_reps_default != null ? String(e.max_reps_default) : '',
    sets_default: e.sets_default != null ? String(e.sets_default) : '',
    rest_default_seconds: e.rest_default_seconds != null ? String(e.rest_default_seconds) : '',
    notes_default: e.notes_default ?? '',
    category: e.category ?? '',
    status: e.status,
  };
}

export function isExerciseFormValid(form: ExerciseFormValues): boolean {
  return form.name.trim().length > 0;
}

const intOrNull = (v: string) => (v ? parseInt(v, 10) : null);
const textOrNull = (v: string) => (v.trim() || null);

interface PayloadExtras {
  muscles: Map<string, MuscleRole>;
  /** Unused since #1360 stage 2: Recorded Metrics are derived from the category by the API. */
  resultTypeIds?: Set<number>;
}

/**
 * #967: only the languages the user actually typed are submitted, and a blank
 * one is submitted as absent rather than as an empty string — the API's
 * replace-all write then drops that locale's row and the name falls back to the
 * base value. The object is always present, because omitting it entirely means
 * "leave the stored translations alone".
 */
export function trimmedTranslations(translations: ExerciseNameTranslations): ExerciseNameTranslations {
  const out: ExerciseNameTranslations = {};
  for (const [locale, name] of Object.entries(translations ?? {})) {
    const trimmed = (name ?? '').trim();
    if (trimmed) out[locale] = trimmed;
  }
  return out;
}

function sharedPayload(form: ExerciseFormValues, { muscles }: PayloadExtras) {
  return {
    name: form.name.trim(),
    translations: trimmedTranslations(form.translations),
    description: textOrNull(form.description),
    min_reps_default: intOrNull(form.min_reps_default),
    max_reps_default: intOrNull(form.max_reps_default),
    sets_default: intOrNull(form.sets_default),
    rest_default_seconds: intOrNull(form.rest_default_seconds),
    notes_default: textOrNull(form.notes_default),
    // #1360: the API judges it (absent keeps, null clears, unknown is a 400).
    category: form.category || null,
    status: form.status,
    muscles: Array.from(muscles.entries()).map(([key, role]) => ({ key, role })),
  };
}

/**
 * The creation payload — `POST /exercises` for a Gym Exercise, `POST
 * /platform/exercises` for a Base Exercise (#806 §6: the fields are shared, the
 * route is the context's). No form submits `video_url` (#1380): the video is
 * managed through the upload control.
 */
export function toExerciseCreatePayload(form: ExerciseFormValues, extras: PayloadExtras) {
  return sharedPayload(form, extras);
}

/**
 * The update payload — `PUT /exercises/:id` or `PUT /platform/exercises/:id` —
 * deliberately without `video_url` (#717 Q6): the editor has no control for it,
 * and re-sending the value the editor opened with would repoint a reference an
 * upload had since replaced and drop its poster with it.
 */
export function toExerciseUpdatePayload(form: ExerciseFormValues, extras: PayloadExtras) {
  return sharedPayload(form, extras);
}

// ─── The read-only half (#965) ────────────────────────────────────────────────
//
// `⋮ → Edit` writes and an expanded card reads (#797–#800), and both halves of an
// Exercise render from this one module: `ExerciseEditor` from the section order
// and the field lists above, `ExerciseReadOnlyView` from the same two plus the row
// shapes below. A field added to the form is therefore a field both halves show,
// which is #965 §14's whole point.

/** The em dash every read-only Exercise value falls back to. */
export const EXERCISE_EMPTY_VALUE = '—';

/** A value, or the em dash. Zero-length and whitespace-only read as empty. */
export function exerciseDisplayValue(value: string | number | null | undefined): string {
  if (typeof value === 'number') return String(value);
  const trimmed = value?.trim();
  return trimmed ? trimmed : EXERCISE_EMPTY_VALUE;
}

/**
 * A stored UTC timestamp as a local date and time, or the em dash. MySQL hands
 * back `YYYY-MM-DD HH:MM:SS` for a DATETIME, which Safari refuses to parse — the
 * `T` and the `Z` are what make it a string every browser reads as UTC.
 */
export function formatExerciseTimestamp(value: string | null | undefined): string {
  if (!value) return EXERCISE_EMPTY_VALUE;
  const parsed = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(parsed.getTime())) return EXERCISE_EMPTY_VALUE;
  return parsed.toLocaleString();
}

/** A stored UTC timestamp as a local date alone — what a list column shows. */
export function formatExerciseDate(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : EXERCISE_EMPTY_VALUE;
}

/**
 * The media columns a preview needs, plus the two timestamps that bust the
 * browser's cache for a replaced object (#715). `name` is the image's `alt`.
 */
export interface ExerciseMediaRow {
  name: string;
  /**
   * #967: the name in the caller's own language, resolved server-side with the
   * base `name` as the fallback. Every surface that *shows* a name reads it —
   * `exerciseName()` is what decides that — while `name` stays the base value an
   * edit form submits back.
   */
  display_name?: string | null;
  image_url: string | null;
  image_thumbnail_url: string | null;
  video_url: string | null;
  video_thumbnail_url: string | null;
  created_at: string;
  modified_at: string | null;
}

/**
 * What the read-only expanded view renders: the fields the editor writes, plus
 * the two relations and the media it shows. It is the **list row** both halves
 * already have — never a second read of the exercise (#797's rule), which is what
 * keeps the read-only view and the form it seeds from unable to disagree.
 */
export interface ExerciseReadOnlyRow extends ExerciseRowValues, ExerciseMediaRow {
  id: number;
  muscles: { key: string; role: string }[] | null;
  allowed_result_types: ResultTypeRow[] | null;
}

/**
 * What `⋮ → Details` renders (#965 §12): the technical metadata the expanded card
 * no longer carries. The actor names are the snapshot migration 208 added for a
 * Base Exercise and the `gym_memberships` join for a gym's own, resolved by
 * whichever router served the row — the modal only reports what it was handed.
 */
export interface ExerciseAuditRow {
  id: number;
  name: string;
  /** #967: the resolved name, which is what the modal's subtitle reads. */
  display_name?: string | null;
  created_at: string;
  created_by_name: string | null;
  modified_at: string | null;
  modified_by_name: string | null;
}
