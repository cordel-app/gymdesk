/**
 * #948 §4 — what an **Assigned Personal Goal** is: one row of
 * `member_personal_goals` (migration 212), a Personal Goal the gym's library
 * offers assigned to one member with the target, the dates, the progress status
 * and the notes it was agreed with.
 *
 * This module is the one place that decides the vocabulary and what a submitted
 * field means, so the router, the tests and the admin cannot disagree about it —
 * the shape `api/src/domain/goalLibrary.ts` already has for the catalogue itself.
 * A Personal Goal is **not** a Nutrition concept (§8): nothing here reads a
 * nutrition plan, a nutrition goal or a library food, and nothing may be added
 * that does.
 *
 * Two things it deliberately does not hold: a *default* status (the column's own
 * DEFAULT is `in_progress`, written once in the migration) and any notion of
 * progress *measurement*. A row records the target that was agreed and the
 * status someone chose; recording how far along a member is, or deriving the
 * status from a measurement, is a later ticket's.
 */

/**
 * The progress of an assignment. Mirrored by `chk_mpgoal_status` (migration
 * 212), so a new value goes in **two** places: this list and the CHECK beside
 * it — adding only the first makes every write of it fail.
 *
 * Deletion is deliberately **not** one of them: a soft-deleted assignment is
 * `deleted_at IS NOT NULL` and keeps the progress it had, unlike the goal
 * catalogue's own `status IN ('active','deleted')`, which has no second axis to
 * lose (migration 212's header explains the split).
 */
export const PERSONAL_GOAL_ASSIGNMENT_STATUSES = ['in_progress', 'achieved', 'abandoned'] as const;
export type PersonalGoalAssignmentStatus = (typeof PERSONAL_GOAL_ASSIGNMENT_STATUSES)[number];

export function isPersonalGoalAssignmentStatus(value: unknown): value is PersonalGoalAssignmentStatus {
  return typeof value === 'string'
    && (PERSONAL_GOAL_ASSIGNMENT_STATUSES as readonly string[]).includes(value);
}

/** `target_unit` is VARCHAR(20), `notes` VARCHAR(1000) (migration 212). */
export const TARGET_UNIT_MAX_LENGTH = 20;
export const NOTES_MAX_LENGTH = 1000;

/** `target_value` is DECIMAL(10,2): eight integer digits and two decimals. */
export const TARGET_VALUE_MAX = 99999999.99;

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Every normalizer below answers one of three things, and the first is the
 * load-bearing one: **`undefined` means the request did not mention the field**,
 * so a `PUT` leaves the stored value exactly as it is. `null` is an explicit
 * clear, and a value is a value. A normalizer that collapsed the first two would
 * make every partial update wipe the fields it did not carry — the distinction
 * CLAUDE.md draws for every replace-all section `PUT` in the codebase.
 */
export type Normalized<T> = { value: T } | { error: string };

export function normalizeTargetValue(input: unknown): Normalized<number | null | undefined> {
  if (input === undefined) return { value: undefined };
  if (input === null || input === '') return { value: null };
  const n = typeof input === 'number' ? input : Number(input);
  if (typeof input !== 'number' && typeof input !== 'string') {
    return { error: 'target_value must be a number' };
  }
  if (!Number.isFinite(n)) return { error: 'target_value must be a number' };
  if (n < 0) return { error: 'target_value must be zero or greater' };
  if (n > TARGET_VALUE_MAX) return { error: `target_value must be at most ${TARGET_VALUE_MAX}` };
  // Rounded to the column's own scale rather than refused: a target typed as
  // `5.005` is a human entering a weight, not an error worth a 400, and storing
  // it unrounded would read back as something the form never submitted.
  return { value: Math.round(n * 100) / 100 };
}

export function normalizeTargetUnit(input: unknown): Normalized<string | null | undefined> {
  if (input === undefined) return { value: undefined };
  if (input === null) return { value: null };
  if (typeof input !== 'string') return { error: 'target_unit must be a string' };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { value: null };
  if (trimmed.length > TARGET_UNIT_MAX_LENGTH) {
    return { error: `target_unit must be at most ${TARGET_UNIT_MAX_LENGTH} characters` };
  }
  return { value: trimmed };
}

export function normalizeNotes(input: unknown): Normalized<string | null | undefined> {
  if (input === undefined) return { value: undefined };
  if (input === null) return { value: null };
  if (typeof input !== 'string') return { error: 'notes must be a string' };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { value: null };
  if (trimmed.length > NOTES_MAX_LENGTH) {
    return { error: `notes must be at most ${NOTES_MAX_LENGTH} characters` };
  }
  return { value: trimmed };
}

export function normalizeGoalDate(input: unknown, field: 'start_date' | 'target_date'): Normalized<string | null | undefined> {
  if (input === undefined) return { value: undefined };
  if (input === null || input === '') return { value: null };
  if (typeof input !== 'string' || !DATE_PATTERN.test(input)) {
    return { error: `${field} must be a date (YYYY-MM-DD)` };
  }
  // Rejected here rather than left to MySQL, which would answer a driver error
  // the global handler turns into a bare 500 (#966).
  const parsed = new Date(`${input}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input) {
    return { error: `${field} must be a real date (YYYY-MM-DD)` };
  }
  return { value: input };
}

export function normalizeStatus(input: unknown, { required }: { required: boolean }): Normalized<PersonalGoalAssignmentStatus | undefined> {
  if (input === undefined || input === null || input === '') {
    if (required) return { error: 'status is required' };
    return { value: undefined };
  }
  if (!isPersonalGoalAssignmentStatus(input)) {
    return { error: `status must be one of ${PERSONAL_GOAL_ASSIGNMENT_STATUSES.join(', ')}` };
  }
  return { value: input };
}

/**
 * The two cross-field rules, applied to the values a write will *end up* with
 * rather than to the ones it submitted — a `PUT` that clears `target_value`
 * while leaving a stored `target_unit` in place is the case a per-field check
 * misses, and the CHECKs beside the table would answer it as a driver error
 * (a bare 500, #966) instead of the 400 it is.
 */
export function goalAssignmentFieldError(next: {
  targetValue: number | null;
  targetUnit: string | null;
  startDate: string | null;
  targetDate: string | null;
}): string | null {
  if (next.targetUnit !== null && next.targetValue === null) {
    return 'target_unit requires a target_value';
  }
  if (next.startDate !== null && next.targetDate !== null && next.targetDate < next.startDate) {
    return 'target_date must be on or after start_date';
  }
  return null;
}

/**
 * The search predicate the list endpoint uses. An assignment has no name of its
 * own, so the term matches the member and the goal it names — both of which the
 * list already joins — plus the notes, which is the only free text on the row.
 *
 * The goal's own `name` is the **stored** one: a seeded System goal is shown
 * under a locale key the admin resolves from its slug (`goalDisplayName()`), so
 * there is no localized column to search, exactly as the catalogue's own
 * `buildGoalListWhere` reasons.
 */
export function buildAssignmentListWhere(
  search: unknown,
  base: string[],
  baseParams: unknown[] = [],
): { where: string; params: unknown[] } {
  const term = typeof search === 'string' ? search.trim() : '';
  const where = [...base];
  const params = [...baseParams];
  if (term) {
    where.push('(m.name LIKE ? OR pg.name LIKE ? OR pg.slug LIKE ? OR mpg.notes LIKE ?)');
    const like = `%${term}%`;
    params.push(like, like, like, like);
  }
  return { where: where.join(' AND '), params };
}
