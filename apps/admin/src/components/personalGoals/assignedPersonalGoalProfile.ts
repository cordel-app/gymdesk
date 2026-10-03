/**
 * #948 §4 — the one declaration of what an **Assigned Personal Goal** is on the
 * frontend: the persisted row, the statuses it may hold, the values its form
 * holds them in, the persisted-row → form mapping the Edit action seeds with, the
 * payloads the form submits, and the formatters both halves display it through.
 *
 * It lives in `components/` rather than beside one page because the entity is
 * administered from **two** screens — the gym-wide Assigned Personal Goals
 * section and the Member card's own PERSONAL GOALS section — and CLAUDE.md's rule
 * for that case is that the shared declaration moves up rather than sideways
 * (`components/nutritionLibrary/` for the Nutrition Library, #799). One form body
 * serves both (`AssignedPersonalGoalForm`), so a field, a label or a validation
 * rule is changed in one place (#806).
 *
 * It names **no endpoint beyond the router root** and decides no permission: the
 * `canWrite` gate and the module access are each page's (#806), and nothing here
 * knows whether the section it feeds sits behind an Edit mode.
 */

/** The router root. One mount (`api/src/app.ts`), so one constant. */
export const ASSIGNED_PERSONAL_GOALS_ROOT = '/member-personal-goals';

/** The `recordAudit` entity type — what `⋮ → Details`' View Audit Log filters on. */
export const ASSIGNED_PERSONAL_GOAL_AUDIT_ENTITY = 'member_personal_goal';

/**
 * Mirrors `PERSONAL_GOAL_ASSIGNMENT_STATUSES` in
 * `api/src/domain/personalGoalAssignment.ts` (and `chk_mpgoal_status`, migration
 * 212), so the selector cannot offer a value the CHECK would refuse. A new status
 * goes in **three** places: that module, the CHECK beside it, and this mirror.
 *
 * Deletion is deliberately absent: an unassigned goal is gone from every list,
 * and the row keeps the progress it had (migration 212's header).
 */
export const ASSIGNED_GOAL_STATUSES = ['in_progress', 'achieved', 'abandoned'] as const;
export type AssignedGoalStatus = (typeof ASSIGNED_GOAL_STATUSES)[number];

/** A row as `GET /member-personal-goals` returns it. */
export interface AssignedPersonalGoalRow {
  id: number;
  gym_id: string;
  member_id: number;
  personal_goal_id: number;
  /** A number, not mysql2's DECIMAL string — the router converts it once. */
  target_value: number | null;
  target_unit: string | null;
  start_date: string | null;
  target_date: string | null;
  status: AssignedGoalStatus;
  notes: string | null;
  created_at: string;
  modified_at: string | null;
  created_by_name: string | null;
  modified_by_name: string | null;
  member_name: string;
  /** The catalogue row's **stored** name — the fallback `goalDisplayName()` uses. */
  goal_name: string;
  /** Non-null only for one of migration 206's seeded System goals. */
  goal_slug: string | null;
  /** `null` = a System goal, administered from Cordel (#947 §5). */
  goal_gym_id: string | null;
}

export interface AssignedPersonalGoalListResponse {
  items: AssignedPersonalGoalRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * The editable fields, in the shape both halves of the form hold them.
 *
 * `member_id` and `personal_goal_id` are part of the *create* form only: the
 * assignment is what gets edited, never which member or which goal it is (the
 * router refuses to move either), so the Edit form holds them as the row's own
 * read-only context.
 */
export interface AssignedPersonalGoalFormValues {
  member_id: string;
  personal_goal_id: string;
  target_value: string;
  target_unit: string;
  start_date: string;
  target_date: string;
  status: AssignedGoalStatus;
  notes: string;
}

export function emptyAssignedPersonalGoalForm(memberId?: number): AssignedPersonalGoalFormValues {
  return {
    member_id: memberId === undefined ? '' : String(memberId),
    personal_goal_id: '',
    target_value: '',
    target_unit: '',
    start_date: '',
    target_date: '',
    // The column's own default, so a form that never touches the selector
    // submits what the API would have stored anyway.
    status: 'in_progress',
    notes: '',
  };
}

/** Persisted row → Edit form values: the single mapping both screens seed from. */
export function toAssignedPersonalGoalFormValues(row: AssignedPersonalGoalRow): AssignedPersonalGoalFormValues {
  return {
    member_id: String(row.member_id),
    personal_goal_id: String(row.personal_goal_id),
    target_value: row.target_value === null ? '' : String(row.target_value),
    target_unit: row.target_unit ?? '',
    start_date: dateInputValue(row.start_date),
    target_date: dateInputValue(row.target_date),
    status: row.status,
    notes: row.notes ?? '',
  };
}

/**
 * A DATE arrives as `2026-01-01T00:00:00.000Z` or as `2026-01-01` depending on
 * the driver; `<input type="date">` takes only the second form.
 */
export function dateInputValue(value: string | null): string {
  return value ? String(value).slice(0, 10) : '';
}

/**
 * What `POST` carries. Declared beside the row → form mapping so a field the form
 * holds cannot quietly stop being submitted (#805).
 *
 * Every optional field is sent as `null` when empty rather than omitted: the API
 * reads an absent key as "leave it alone", which on a create means the same thing
 * but on the `PUT` below does not — and one payload builder that behaves
 * differently per route is how the two drift.
 */
export function toAssignedPersonalGoalCreatePayload(form: AssignedPersonalGoalFormValues) {
  return {
    member_id: Number(form.member_id),
    personal_goal_id: Number(form.personal_goal_id),
    ...editableFields(form),
  };
}

/**
 * What `PUT` carries — the editable fields alone. `member_id` and
 * `personal_goal_id` are deliberately absent: the router ignores them, and a
 * payload that carried them would suggest a reassignment it will not perform.
 */
export function toAssignedPersonalGoalUpdatePayload(form: AssignedPersonalGoalFormValues) {
  return editableFields(form);
}

function editableFields(form: AssignedPersonalGoalFormValues) {
  const value = form.target_value.trim();
  return {
    target_value: value === '' ? null : Number(value),
    target_unit: form.target_unit.trim() || null,
    start_date: form.start_date || null,
    target_date: form.target_date || null,
    status: form.status,
    notes: form.notes.trim() || null,
  };
}

/**
 * The client-side half of `goalAssignmentFieldError()` — the same two cross-field
 * rules, so the form says what is wrong beside the fields instead of waiting for
 * the API's 400. The server's copy stays the enforcement point: this one only
 * decides whether to submit.
 *
 * It answers a **locale key**, never a sentence: the words belong to whichever
 * page renders the form (#901), which is also what keeps this module JSX- and
 * i18n-free.
 */
export function assignedPersonalGoalFormError(form: AssignedPersonalGoalFormValues): string | null {
  if (!form.member_id) return 'error_member_required';
  if (!form.personal_goal_id) return 'error_goal_required';
  const value = form.target_value.trim();
  if (value !== '' && !(Number.isFinite(Number(value)) && Number(value) >= 0)) {
    return 'error_target_value';
  }
  if (form.target_unit.trim() !== '' && value === '') return 'error_unit_needs_value';
  if (form.start_date && form.target_date && form.target_date < form.start_date) {
    return 'error_target_date_order';
  }
  return null;
}

/**
 * The target as one phrase — `5 kg`, or `5` for a value with no unit, and `—`
 * when there is none at all. Both screens ask for it rather than composing the
 * pair themselves, so a target cannot read two ways on one card.
 */
export function formatTarget(row: Pick<AssignedPersonalGoalRow, 'target_value' | 'target_unit'>): string {
  if (row.target_value === null) return '—';
  // Trailing zeros trimmed: a DECIMAL(10,2) of `5.00` is a target somebody typed
  // as `5`, and `5.00 kg` reads as a precision the gym never claimed.
  const value = String(Number(row.target_value));
  return row.target_unit ? `${value} ${row.target_unit}` : value;
}

/** A date for display, or `—`. The locale is the caller's. */
export function formatGoalDate(value: string | null, locale: string): string {
  const iso = dateInputValue(value);
  if (!iso) return '—';
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale, {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

/** The dates as one phrase — `1 Jan 2026 → 30 Jun 2026`, with `—` for a missing end. */
export function formatGoalPeriod(
  row: Pick<AssignedPersonalGoalRow, 'start_date' | 'target_date'>,
  locale: string,
): string {
  const start = formatGoalDate(row.start_date, locale);
  const target = formatGoalDate(row.target_date, locale);
  if (start === '—' && target === '—') return '—';
  return `${start} → ${target}`;
}
