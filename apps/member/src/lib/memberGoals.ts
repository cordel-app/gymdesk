// #1036 — **My Goals**: everything the member's goals page decides, with no JSX.
//
// The same split every Members App screen takes: the page renders, this module
// decides. What a goal is called, what its target reads as, which goals are
// still being pursued, what a form submits and which of its fields is wrong are
// all answered here, so the page holds markup and state and nothing else — and
// so all of it is unit-testable without a browser (there is no component-test
// infra in this app; see `my-nutrition-sections.test.ts`).
//
// It decides **no colour and no spacing**: those are `lib/memberChrome.ts`'s
// (#983), and a value spelled here would be the second place the Members App
// paints from.

/**
 * The seeded System Personal Goals (`api/src/domain/goalLibrary.ts`'s
 * `SYSTEM_PERSONAL_GOALS`). A System row's label is its **slug** resolved
 * through `goals.goal_<slug>`, with the row's own `name` as the fallback — the
 * CLAUDE.md rule for a fixed seeded catalogue, and the same resolution the
 * admin's `goalDisplayName()` applies, so a member and the staff who assigned
 * their goal read the same words.
 *
 * A gym's own goal carries **no** slug and is shown under the single name its
 * staff typed, in whatever language they typed it.
 */
export const SYSTEM_PERSONAL_GOAL_SLUGS = [
  'weight_loss', 'weight_gain', 'muscle_gain', 'maintenance',
  'performance', 'recovery', 'energy',
] as const;

/** One row of `GET /me/personal-goals` — an assignment, never a catalogue row. */
export interface MemberGoal {
  id: number;
  personal_goal_id: number;
  /** The **snapshot** taken when it was assigned (§8), not the catalogue's current name. */
  goal_name: string;
  goal_slug: string | null;
  target_value: number | null;
  target_unit: string | null;
  start_date: string | null;
  target_date: string | null;
  /** When it stopped being pursued — removed, achieved or abandoned. */
  end_date: string | null;
  status: 'in_progress' | 'achieved' | 'abandoned';
  notes: string | null;
  deleted_at: string | null;
}

/** One row of `GET /me/personal-goals/available` — a Gym Goal the member may still add. */
export interface AssignableGoal {
  id: number;
  slug: string | null;
  name: string;
  description: string | null;
  target_value: number | null;
  target_unit: string | null;
}

/**
 * The label a goal is shown under.
 *
 * The fallback is decided **before** `t()` is called: next-intl has no
 * `defaultValue` option and prints a missing key verbatim, so asking it for
 * `goals.goal_<slug>` on a gym's own goal would put the key on screen
 * (CLAUDE.md, and the defect #812 reports).
 */
export function goalDisplayName(
  goal: { slug?: string | null; goal_slug?: string | null; name?: string; goal_name?: string },
  t: (key: string) => string,
): string {
  const slug = goal.goal_slug ?? goal.slug ?? null;
  const name = goal.goal_name ?? goal.name ?? '';
  const known = slug !== null && (SYSTEM_PERSONAL_GOAL_SLUGS as readonly string[]).includes(slug);
  return known ? t(`goals.goal_${slug}`) : name;
}

/**
 * `3 kg`, `70 kg`, `0 kg` — and `null` for a goal that has no target at all,
 * which the page renders as nothing rather than as `0` or `—`.
 *
 * A value of **zero is a target**, not an absence: Maintenance is seeded at
 * `0 kg` precisely because a change of zero is what the goal means (#1034 §2),
 * so the check is `=== null` and never falsiness. Trailing zeros are trimmed
 * (`3.00` → `3`) because the column is a DECIMAL(10,2) and `3.00 kg` is not how
 * anyone writes it.
 */
export function formatGoalTarget(goal: { target_value: number | null; target_unit: string | null }): string | null {
  if (goal.target_value === null || goal.target_value === undefined) return null;
  const value = Number(goal.target_value);
  if (!Number.isFinite(value)) return null;
  const text = String(Number(value.toFixed(2)));
  return goal.target_unit ? `${text} ${goal.target_unit}` : text;
}

/**
 * Whether the member is still pursuing this goal. The predicate
 * `mpgoal_live_goal_key` generates its unique key from, mirrored here so the
 * page's two lists split exactly where the server's do.
 */
export function isLiveGoal(goal: Pick<MemberGoal, 'deleted_at' | 'status'>): boolean {
  return goal.deleted_at === null && goal.status === 'in_progress';
}

/** The form behind `Add goal` and `Edit`, as the page holds it. */
export interface GoalFormValues {
  personal_goal_id: string;
  target_value: string;
  target_unit: string;
  start_date: string;
  target_date: string;
  notes: string;
}

export const emptyGoalForm: GoalFormValues = {
  personal_goal_id: '', target_value: '', target_unit: '', start_date: '', target_date: '', notes: '',
};

/**
 * §5 — picking a Gym Goal pre-fills the target it carries, which is what makes
 * the modal's `Target` and `Unit` fields show `3` and `Kg` the moment
 * `Lose weight` is chosen. A goal with no target of its own pre-fills nothing
 * rather than zero.
 */
export function formForAssignableGoal(goal: AssignableGoal): GoalFormValues {
  return {
    ...emptyGoalForm,
    personal_goal_id: String(goal.id),
    target_value: goal.target_value === null || goal.target_value === undefined ? '' : String(goal.target_value),
    target_unit: goal.target_unit ?? '',
  };
}

/** Editing starts from what the member already agreed, never from the catalogue (§8). */
export function formForMemberGoal(goal: MemberGoal): GoalFormValues {
  return {
    personal_goal_id: String(goal.personal_goal_id),
    target_value: goal.target_value === null ? '' : String(goal.target_value),
    target_unit: goal.target_unit ?? '',
    start_date: goal.start_date ?? '',
    target_date: goal.target_date ?? '',
    notes: goal.notes ?? '',
  };
}

/** `DECIMAL(10,2)`'s ceiling, mirroring `TARGET_VALUE_MAX` on the API side. */
export const TARGET_VALUE_MAX = 99999999.99;
/** `VARCHAR(20)`, mirroring `TARGET_UNIT_MAX_LENGTH`. */
export const TARGET_UNIT_MAX_LENGTH = 20;
/** `VARCHAR(1000)`, mirroring `NOTES_MAX_LENGTH`. */
export const NOTES_MAX_LENGTH = 1000;

/**
 * What is wrong with the form, as a **locale key** rather than a sentence: the
 * page resolves it, so this module translates nothing and both halves stay
 * assertable (the rule `calendarEventDisplay.ts` already follows).
 *
 * It is deliberately the client half of the server's rules and not a second set
 * of them — a unit with no value is what `chk_mpgoal_target_unit` refuses, and a
 * target date before the start date is what `chk_mpgoal_dates` does. The server
 * still checks both; this only avoids a round trip to be told so.
 */
export function goalFormError(values: GoalFormValues, { requireGoal }: { requireGoal: boolean }): string | null {
  if (requireGoal && !values.personal_goal_id) return 'goals.error_goal_required';

  const rawValue = values.target_value.trim();
  if (rawValue !== '') {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return 'goals.error_target_number';
    if (value < 0) return 'goals.error_target_negative';
    if (value > TARGET_VALUE_MAX) return 'goals.error_target_max';
  }
  const unit = values.target_unit.trim();
  if (unit !== '') {
    if (rawValue === '') return 'goals.error_unit_without_value';
    if (unit.length > TARGET_UNIT_MAX_LENGTH) return 'goals.error_unit_length';
  }
  if (values.start_date && values.target_date && values.target_date < values.start_date) {
    return 'goals.error_dates';
  }
  if (values.notes.trim().length > NOTES_MAX_LENGTH) return 'goals.error_notes_length';
  return null;
}

/**
 * What `POST /me/personal-goals` is sent.
 *
 * An empty field is sent as an explicit `null` rather than omitted, because the
 * two mean different things to the API: omitting `target_value` **inherits the
 * Gym Goal's** (§8's snapshot, which the server takes), while `null` is the
 * member deliberately clearing it. The dialog pre-fills from the catalogue and
 * then submits exactly what is on screen, so what it sends is what the member
 * saw — a field they emptied stays empty instead of coming back filled.
 */
export function toGoalCreatePayload(values: GoalFormValues) {
  return {
    personal_goal_id: Number(values.personal_goal_id),
    ...toGoalUpdatePayload(values),
  };
}

/**
 * What `PUT /me/personal-goals/:id` is sent. `personal_goal_id` is **not** in
 * it: the assignment's goal is immutable, and changing it is a remove plus an
 * add (§12).
 */
export function toGoalUpdatePayload(values: GoalFormValues) {
  const rawValue = values.target_value.trim();
  const unit = values.target_unit.trim();
  const notes = values.notes.trim();
  return {
    target_value: rawValue === '' ? null : Number(rawValue),
    target_unit: unit === '' ? null : unit,
    start_date: values.start_date || null,
    target_date: values.target_date || null,
    notes: notes === '' ? null : notes,
  };
}

/**
 * Which of the four words a goal's pill reads, as a locale key.
 *
 * `removed` is the fourth and is **not** a stored status: a goal the member
 * removed keeps the progress it had (migration 212 keeps the two axes apart),
 * so the row says `in_progress` with a `deleted_at` beside it and reading the
 * column alone would label a removed goal *In progress* in the Past Goals
 * list. Deciding it here is what keeps the page from re-deriving it.
 */
export function goalStatusKey(goal: Pick<MemberGoal, 'deleted_at' | 'status'>): string {
  if (isLiveGoal(goal)) return 'goals.status_in_progress';
  if (goal.deleted_at !== null && goal.status === 'in_progress') return 'goals.status_removed';
  return `goals.status_${goal.status}`;
}

/**
 * The status word the app's own `statusTone()` is asked about, so a Past Goal's
 * pill takes one of the four tones every other Members App status takes (#983)
 * instead of a fifth map: an achieved goal reads as a success, an abandoned one
 * as cancelled, and a goal the member simply removed carries no judgement.
 */
export function goalStatusToneKey(goal: Pick<MemberGoal, 'deleted_at' | 'status'>): string {
  if (goal.status === 'achieved') return 'completed';
  if (goal.status === 'abandoned') return 'cancelled';
  return 'removed';
}
