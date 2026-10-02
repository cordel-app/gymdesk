/**
 * #964 — the Free Exercise DB dataset, mapped onto this product's Base Exercise
 * model. Everything in this module is **pure**: no database, no network, no
 * filesystem, so every mapping and matching rule is asserted directly
 * (`api/src/test/free-exercise-db.unit.test.ts`). The I/O half is
 * `api/src/scripts/import-free-exercise-db.ts`.
 *
 * The dataset (https://github.com/yuhonas/free-exercise-db, `dist/exercises.json`)
 * is one array of objects shaped like this:
 *
 *     { "id": "3_4_Sit-Up", "name": "3/4 Sit-Up", "force": "pull",
 *       "level": "beginner", "mechanic": "compound", "equipment": "body only",
 *       "primaryMuscles": ["abdominals"], "secondaryMuscles": [],
 *       "instructions": ["Lie down on the floor…", …],
 *       "category": "strength", "images": ["3_4_Sit-Up/0.jpg", …] }
 *
 * ── `images` is read by nothing here, on purpose ────────────────────────────
 *
 * §10 is explicit and unconditional: no image is downloaded, copied, referenced
 * or turned into a media record, and a raw GitHub URL is never stored as an
 * application image. `parseSourceExercise()` therefore does not even carry the
 * field into the parsed shape, so no later code path can reach it by accident —
 * a test asserts that.
 *
 * ── Exercise Type: the taxonomy §7 describes does not exist ─────────────────
 *
 * §7 asks the import to infer an **Exercise Type** from `equipment`/`category`/
 * `mechanic`/`force` "using the existing Exercise Type taxonomy", and lists
 * Bodyweight · Machine · Free Weight · Dumbbell · Barbell · Kettlebell · Cable ·
 * Resistance Band · Cardio · Assisted as examples. That list is the dataset's
 * **equipment** axis, and this product has no such taxonomy: the only column
 * ever named after an exercise type is `exercises.exercise_type` from migration
 * 071 (`reps` | `time` | `distance`), which is a *measurement* axis and which no
 * code path has read since the inline workout editor stopped using it.
 *
 * So the ticket's own closing rule decides it — *preserve the source data → use
 * the existing application model → report the ambiguity rather than inventing
 * data or creating unnecessary taxonomy values*:
 *
 *   • the equipment axis is **preserved verbatim** in `exercises.equipment`
 *     (migration 207), beside `category`, `level`, `mechanic` and `force_type`,
 *     so nothing is lost and §18's Equipment filter has a column to read;
 *   • `exercise_type` is mapped on the axis it actually means, from `category`
 *     (`classifyExerciseType()`), which is the existing taxonomy and gains no new
 *     value;
 *   • a category with no confident mapping is reported as an unmapped Exercise
 *     Type and left at the column's default rather than guessed.
 *
 * Surfacing Equipment in the Base Exercises UI is #969's (filtering) and #965's
 * (the expanded view); this ticket is the data (§20).
 */

import { EXERCISE_TYPES, ExerciseType } from './exerciseTypes';
import { MUSCLE_KEYS, normalizeMuscleKey } from './muscles';

export { EXERCISE_TYPES };
export type { ExerciseType };

/** The value stored in `exercises.source` for every row this dataset produces. */
export const FREE_EXERCISE_DB_SOURCE = 'free-exercise-db';

/** Where the dataset is fetched from when no local file is given. */
export const FREE_EXERCISE_DB_DEFAULT_URL =
  'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json';

/* ── Column widths, so a long source value is truncated here and not by MySQL ─ */

export const EXERCISE_NAME_MAX = 200;
export const EXERCISE_SLUG_MAX = 220;
export const SOURCE_ID_MAX = 120;
const METADATA_MAX = { equipment: 60, category: 60, level: 30, mechanic: 30, force_type: 30 } as const;

/** One dataset entry, after validation. `images` is deliberately absent (§10). */
export interface SourceExercise {
  id: string;
  name: string;
  force: string | null;
  level: string | null;
  mechanic: string | null;
  equipment: string | null;
  category: string | null;
  primaryMuscles: string[];
  secondaryMuscles: string[];
  instructions: string[];
}

export type ParseResult =
  | { ok: true; value: SourceExercise }
  | { ok: false; problem: string; sourceId: string | null; name: string | null };

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

/**
 * Validates one raw dataset entry (§15 step 2). A malformed entry is an error
 * value rather than an exception, because §16 requires the run to continue and
 * the report to name what was wrong with which record.
 */
export function parseSourceExercise(raw: unknown): ParseResult {
  const row = (raw ?? {}) as Record<string, unknown>;
  const sourceId = optionalText(row.id);
  const name = optionalText(row.name);
  if (!sourceId) return { ok: false, problem: 'missing id', sourceId: null, name };
  if (sourceId.length > SOURCE_ID_MAX) {
    return { ok: false, problem: `id longer than ${SOURCE_ID_MAX} characters`, sourceId, name };
  }
  if (!name) return { ok: false, problem: 'missing name', sourceId, name: null };
  if (name.length > EXERCISE_NAME_MAX) {
    return { ok: false, problem: `name longer than ${EXERCISE_NAME_MAX} characters`, sourceId, name };
  }
  const primaryMuscles = stringList(row.primaryMuscles);
  const secondaryMuscles = stringList(row.secondaryMuscles);
  return {
    ok: true,
    value: {
      id: sourceId,
      name,
      force: optionalText(row.force),
      level: optionalText(row.level),
      mechanic: optionalText(row.mechanic),
      equipment: optionalText(row.equipment),
      category: optionalText(row.category),
      primaryMuscles,
      secondaryMuscles,
      instructions: stringList(row.instructions),
    },
  };
}

/** Validates the dataset as a whole (§15 step 2) before a single row is written. */
export function parseSourceDataset(raw: unknown): { ok: true; rows: unknown[] } | { ok: false; problem: string } {
  if (Array.isArray(raw)) return { ok: true, rows: raw };
  if (raw && typeof raw === 'object' && Array.isArray((raw as { exercises?: unknown }).exercises)) {
    return { ok: true, rows: (raw as { exercises: unknown[] }).exercises };
  }
  return { ok: false, problem: 'dataset is not an array of exercises' };
}

/* ── Slug (§5) ────────────────────────────────────────────────────────────── */

/**
 * The application slug for an exercise name, spelled as §5's own example does:
 * `Alternate Incline Dumbbell Curl` → `alternate-incline-dumbbell-curl`.
 * Diacritics are folded rather than dropped (`Pilates Reformer Rückenübung` →
 * `…-ruckenubung`), every other run of non-alphanumerics collapses to one
 * hyphen, and the result is bounded by the column.
 *
 * It is generated **once**, when the row is created: an exercise keeps the slug
 * it was created with, so a later rename — by an administrator or in the dataset
 * — does not move a handle other things may already quote (§5: "existing valid
 * slugs should not unnecessarily change").
 */
export function slugifyExerciseName(name: string): string {
  const folded = name.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const slug = folded.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return slug.slice(0, EXERCISE_SLUG_MAX);
}

/**
 * Disambiguates a slug that is already taken by a different exercise. The suffix
 * is the source id's own slug rather than a counter, so the result is stable
 * across runs and does not depend on the order rows are processed in.
 */
export function disambiguateSlug(slug: string, sourceId: string): string {
  const suffix = slugifyExerciseName(sourceId);
  const base = slug || 'exercise';
  if (!suffix || base === suffix) return base.slice(0, EXERCISE_SLUG_MAX);
  return `${base}-${suffix}`.slice(0, EXERCISE_SLUG_MAX);
}

/* ── Muscles (§8) ─────────────────────────────────────────────────────────── */

/**
 * The dataset's muscle names that are this catalogue's existing keys under
 * another name. Everything else is normalized to a key of its own
 * (`middle back` → `middle_back`) and is listed in `MUSCLE_KEYS`, so the picker
 * offers it and the admin shows its translated label.
 *
 * Only these two are aliased: `quadriceps` and `abdominals` are what #62 called
 * `quads` and `core`, and mapping them to new keys would be the duplicate muscle
 * §8 forbids. `lats`, `middle back` and `lower back` deliberately do **not**
 * collapse into the existing `back` — the dataset distinguishes them, and
 * flattening three source values into one would lose exactly the richness the
 * import exists for.
 */
export const FREE_EXERCISE_DB_MUSCLE_ALIASES: Record<string, string> = {
  quadriceps: 'quads',
  abdominals: 'core',
};

export interface MappedMuscle {
  /** The key stored on `exercise_muscles.muscle`. */
  key: string;
  /** Whether `MUSCLE_KEYS` already offers it — a `false` here is reported (§16). */
  known: boolean;
  /** The dataset's own spelling, for the report. */
  sourceName: string;
}

/**
 * Maps one source muscle name onto a storable key, or `null` when the value
 * cannot become one at all (empty, or nothing but punctuation). A muscle this
 * catalogue does not offer is still mapped and still stored — §8 is explicit
 * that a missing muscle may never fail the import — and comes back with
 * `known: false` so the report can ask for it to be added to `MUSCLE_KEYS`.
 */
export function mapSourceMuscle(sourceName: string): MappedMuscle | null {
  const trimmed = sourceName.trim().toLowerCase();
  if (!trimmed) return null;
  const aliased = FREE_EXERCISE_DB_MUSCLE_ALIASES[trimmed];
  const candidate = aliased ?? trimmed.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const key = normalizeMuscleKey(candidate);
  if (!key) return null;
  return { key, known: (MUSCLE_KEYS as readonly string[]).includes(key), sourceName: sourceName.trim() };
}

export type MuscleRole = 'principal' | 'secondary';
export interface MuscleLink { key: string; role: MuscleRole }

/**
 * The exercise's muscle links, primary first. The dataset already distinguishes
 * the two roles (§8), so nothing is inferred; a muscle listed in both lists
 * stays **principal**, because `exercise_muscles` carries one row per
 * (exercise, muscle) pair and the stronger role is the true one.
 */
export function mapSourceMuscles(src: SourceExercise): { links: MuscleLink[]; mapped: MappedMuscle[]; unmapped: string[] } {
  const links: MuscleLink[] = [];
  const mapped: MappedMuscle[] = [];
  const unmapped: string[] = [];
  const seen = new Set<string>();
  for (const [names, role] of [[src.primaryMuscles, 'principal'], [src.secondaryMuscles, 'secondary']] as const) {
    for (const name of names) {
      const muscle = mapSourceMuscle(name);
      if (!muscle) { unmapped.push(name); continue; }
      if (seen.has(muscle.key)) continue;
      seen.add(muscle.key);
      links.push({ key: muscle.key, role });
      mapped.push(muscle);
    }
  }
  return { links, mapped, unmapped };
}

/* ── Exercise Type (§7) ───────────────────────────────────────────────────── */

/**
 * The mapping onto `EXERCISE_TYPES` (`domain/exerciseTypes.ts`) — the only
 * Exercise Type taxonomy this product has. It is on `category`, which
 * is the one source field that says how an exercise is *measured*:
 *
 *   strength · powerlifting · olympic weightlifting · strongman · plyometrics → reps
 *   stretching                                                               → time
 *   cardio                                                                   → time, reported
 *
 * `cardio` is mapped but flagged: a treadmill run is as plausibly measured in
 * distance as in time, and §7 asks for the closest existing type with the
 * ambiguity reported rather than a new value. An unknown or missing category is
 * left unset (`null`) and reported, never guessed from `equipment` — "barbell"
 * says nothing about measurement.
 */
const CATEGORY_TO_EXERCISE_TYPE: Record<string, { type: ExerciseType; confident: boolean }> = {
  strength: { type: 'reps', confident: true },
  powerlifting: { type: 'reps', confident: true },
  'olympic weightlifting': { type: 'reps', confident: true },
  strongman: { type: 'reps', confident: true },
  plyometrics: { type: 'reps', confident: true },
  stretching: { type: 'time', confident: true },
  cardio: { type: 'time', confident: false },
};

export interface ClassifiedExerciseType {
  type: ExerciseType | null;
  confident: boolean;
  /** The source value the decision was taken from, for the report. */
  sourceValue: string | null;
}

export function classifyExerciseType(src: SourceExercise): ClassifiedExerciseType {
  const category = src.category?.trim().toLowerCase() ?? null;
  const mapping = category ? CATEGORY_TO_EXERCISE_TYPE[category] : undefined;
  if (!mapping) return { type: null, confident: false, sourceValue: src.category ?? null };
  return { type: mapping.type, confident: mapping.confident, sourceValue: src.category ?? null };
}

/* ── Instructions (§9) ────────────────────────────────────────────────────── */

/**
 * The dataset's instruction steps as one `exercises.description` value. The order
 * is preserved and the wording is not touched (§9): the steps are numbered,
 * which is the closest the current model gets to "keep them as individual steps"
 * — `exercises` has no instruction-step table and §11 forbids a parallel
 * structure, so one TEXT column holding one step per line is the model's own
 * shape. A later ticket that gives exercises real steps can split on the
 * numbering.
 */
export function composeInstructions(steps: string[]): string | null {
  const cleaned = steps.map((step) => step.trim()).filter(Boolean);
  if (cleaned.length === 0) return null;
  if (cleaned.length === 1) return cleaned[0];
  return cleaned.map((step, index) => `${index + 1}. ${step}`).join('\n');
}

/* ── Source metadata (§6) ─────────────────────────────────────────────────── */

export interface SourceMetadata {
  equipment: string | null;
  category: string | null;
  level: string | null;
  mechanic: string | null;
  force_type: string | null;
}

/** The five metadata columns, verbatim from the dataset and bounded by the column. */
export function sourceMetadata(src: SourceExercise): SourceMetadata {
  const cut = (value: string | null, max: number) => (value ? value.slice(0, max) : null);
  return {
    equipment: cut(src.equipment, METADATA_MAX.equipment),
    category: cut(src.category, METADATA_MAX.category),
    level: cut(src.level, METADATA_MAX.level),
    mechanic: cut(src.mechanic, METADATA_MAX.mechanic),
    force_type: cut(src.force, METADATA_MAX.force_type),
  };
}

/* ── Matching an existing Base Exercise (§12) ─────────────────────────────── */

/** The columns the importer reads for every base row before it decides anything. */
export interface ExistingBaseExercise {
  id: number;
  name: string;
  slug: string | null;
  source: string | null;
  source_id: string | null;
  status: string;
  description: string | null;
  exercise_type: string | null;
  equipment: string | null;
  category: string | null;
  level: string | null;
  mechanic: string | null;
  force_type: string | null;
  /** The muscle keys the row already carries — an update adds what is missing, never removes. */
  existingMuscleKeys: string[];
}

export type MatchKind = 'source_id' | 'slug' | 'name';

export interface ExerciseMatch {
  row: ExistingBaseExercise;
  kind: MatchKind;
}

const norm = (value: string) => value.trim().toLowerCase();

/**
 * Finds the Base Exercise this dataset entry already is, in §12's order:
 * provenance first, then the stable slug, then a carefully controlled exact-name
 * fallback. The two fallbacks only ever match a row that carries **no**
 * provenance of its own — a row already claimed by another source id is a
 * different exercise that happens to share a name or a slug, which is the
 * accidental merge §12 warns about, so it is reported as a potential duplicate
 * instead (`potentialDuplicate`).
 *
 * Name matching is exact on the trimmed, case-folded name. Nothing fuzzier:
 * `Barbell Curl` and `Barbell Curl (Standing)` are two exercises.
 */
export function matchExistingExercise(
  src: SourceExercise,
  candidates: ExistingBaseExercise[],
): { match: ExerciseMatch | null; potentialDuplicate: ExistingBaseExercise | null } {
  const bySource = candidates.find(
    (row) => row.source === FREE_EXERCISE_DB_SOURCE && row.source_id === src.id,
  );
  if (bySource) return { match: { row: bySource, kind: 'source_id' }, potentialDuplicate: null };

  const slug = slugifyExerciseName(src.name);
  const unclaimed = (row: ExistingBaseExercise) => !row.source_id;

  const bySlug = candidates.filter((row) => row.slug && norm(row.slug) === slug && row.status !== 'deleted');
  const freeSlug = bySlug.find(unclaimed);
  if (freeSlug) return { match: { row: freeSlug, kind: 'slug' }, potentialDuplicate: null };
  if (bySlug.length > 0) return { match: null, potentialDuplicate: bySlug[0] };

  const byName = candidates.filter((row) => norm(row.name) === norm(src.name) && row.status !== 'deleted');
  const freeName = byName.find(unclaimed);
  if (freeName) return { match: { row: freeName, kind: 'name' }, potentialDuplicate: null };
  if (byName.length > 0) return { match: null, potentialDuplicate: byName[0] };

  return { match: null, potentialDuplicate: null };
}

/* ── What the importer writes (§12, §15) ──────────────────────────────────── */

export interface ExerciseWriteFields {
  name?: string;
  slug?: string;
  source?: string;
  source_id?: string;
  description?: string | null;
  exercise_type?: ExerciseType;
  equipment?: string | null;
  category?: string | null;
  level?: string | null;
  mechanic?: string | null;
  force_type?: string | null;
}

export type ImportAction = 'create' | 'update' | 'unchanged' | 'skip';

export interface ImportPlan {
  action: ImportAction;
  /** Only for `create`/`update`. */
  fields: ExerciseWriteFields;
  /** Links to add. An update never *removes* a link an administrator may have added. */
  muscles: MuscleLink[];
  /** `source_id` for a row this run stamps provenance onto for the first time. */
  adopted: boolean;
  skipReason?: 'deleted_locally';
  /** For the report: the match that was used, if any. */
  matchKind: MatchKind | null;
}

/**
 * Decides what this dataset entry does to the catalogue.
 *
 * **The importer never overwrites something an administrator can edit.** A
 * create writes everything; an update keeps the row's own `name` and
 * `description` when they are already filled — §13's "do not automatically
 * delete or rewrite" and §9's "do not rewrite the instructions" together mean a
 * second run must not undo a correction somebody made on the Base Exercises
 * page. What an update *does* keep in step is the source's own facts: the
 * provenance pair, the slug a row adopted and the five metadata columns, because
 * those are the dataset's values and nothing in the product edits them.
 *
 * Muscle links are added, never removed, for the same reason (§14's spirit one
 * table over): a Base Exercise an administrator has re-tagged keeps its tags.
 *
 * A row matched by provenance but soft-deleted is **skipped**: provenance
 * survives a delete precisely so the importer can see that somebody removed this
 * exercise on purpose, and re-creating it is not "idempotent", it is undoing an
 * administrator's decision (§13).
 */
export function planExerciseImport(
  src: SourceExercise,
  match: ExerciseMatch | null,
  options: { slug: string },
): ImportPlan {
  const metadata = sourceMetadata(src);
  const type = classifyExerciseType(src);
  const description = composeInstructions(src.instructions);
  const { links } = mapSourceMuscles(src);

  if (!match) {
    const fields: ExerciseWriteFields = {
      name: src.name,
      slug: options.slug,
      source: FREE_EXERCISE_DB_SOURCE,
      source_id: src.id,
      description,
      ...metadata,
    };
    if (type.type) fields.exercise_type = type.type;
    return { action: 'create', fields, muscles: links, adopted: false, matchKind: null };
  }

  const row = match.row;
  if (row.status === 'deleted') {
    return { action: 'skip', fields: {}, muscles: [], adopted: false, skipReason: 'deleted_locally', matchKind: match.kind };
  }

  const fields: ExerciseWriteFields = {};
  const adopted = row.source !== FREE_EXERCISE_DB_SOURCE || row.source_id !== src.id;
  if (adopted) {
    fields.source = FREE_EXERCISE_DB_SOURCE;
    fields.source_id = src.id;
  }
  if (!row.slug) fields.slug = options.slug;
  if (!row.name?.trim()) fields.name = src.name;
  if (!row.description?.trim() && description) fields.description = description;
  if (type.type && !row.exercise_type) fields.exercise_type = type.type;
  for (const key of ['equipment', 'category', 'level', 'mechanic', 'force_type'] as const) {
    if ((row[key] ?? null) !== metadata[key]) fields[key] = metadata[key];
  }

  const held = new Set(row.existingMuscleKeys.map((key) => key.trim().toLowerCase()));
  const newLinks = links.filter((link) => !held.has(link.key));
  const action: ImportAction =
    Object.keys(fields).length > 0 || newLinks.length > 0 ? 'update' : 'unchanged';
  return { action, fields, muscles: newLinks, adopted, matchKind: match.kind };
}
