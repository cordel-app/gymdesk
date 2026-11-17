/**
 * #2951: the one place an entity's slug is generated from its name.
 *
 * A slug is lowercase, has its accents and diacritics removed, turns every run
 * of spaces and special characters into one hyphen and has no leading or
 * trailing hyphen (`Personal Training (1:1)` → `personal-training-1-1`). It is
 * generated **once**, when the row is created, and never regenerated: renaming
 * an entity leaves its slug alone.
 *
 * Uniqueness is per entity type and ownership scope, never global. Within one
 * scope a taken slug gets a numeric suffix (`squat`, `squat-2`, `squat-3`),
 * which `nextAvailableSlug()` decides from the slugs the scope already holds.
 * The migration that backfills existing rows spells the same two rules in plain
 * JavaScript (a migration imports no application code); a unit test keeps the
 * two in step.
 */

/** Longest slug stored; every slug column in scope is at least this wide. */
export const ENTITY_SLUG_MAX = 120;

/** What a name with no letters or digits becomes, so a slug is never empty. */
export const FALLBACK_SLUG = 'item';

export function generateSlug(name: string | null | undefined, fallback: string = FALLBACK_SLUG): string {
  const folded = String(name ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const slug = folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  return trimHyphens(trimHyphens(slug).slice(0, ENTITY_SLUG_MAX)) || fallback;
}

/**
 * Leading and trailing hyphens removed, in one linear pass. A loop rather than
 * an anchored `-+$` regex, which backtracks polynomially on a long run of
 * hyphens in a name a caller supplies (CodeQL `js/polynomial-redos`).
 */
function trimHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 45) start++;
  while (end > start && value.charCodeAt(end - 1) === 45) end--;
  return value.slice(start, end);
}

/**
 * The first of `base`, `base-2`, `base-3`, … not in `taken`. The suffix is kept
 * within `ENTITY_SLUG_MAX` by shortening the base, never by dropping the suffix.
 */
export function nextAvailableSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${trimHyphens(base.slice(0, ENTITY_SLUG_MAX - suffix.length))}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}
