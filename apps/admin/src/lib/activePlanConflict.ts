/**
 * #956 stage 2 — reading the backend's "this member already has a plan" answer.
 *
 * Stage 1 made every assignment path refuse an unconfirmed replacement with
 * `409 { error: 'active_plan_exists', message, current_plan, conflicts }`, and
 * deliberately put both plan names and the current plan's dates in that body so
 * the confirmation dialog needs no second read of what it is about to cancel.
 * This module is the one place that recognises that body and decides what the
 * dialog says about it; `components/ReplacePlanDialog.tsx` is the one place that
 * draws it. It is JSX-free so the rules stay directly assertable, exactly as
 * `lib/billingEventSimulation.ts` is to its component.
 *
 * It decides nothing the server has not already decided: a replacement happens
 * because the caller re-sends with `confirm: true`, and the backend remains the
 * enforcement point (the rule is `domain/oneActivePlan.ts`'s, under the row
 * lock). Nothing here may grow a second status list, a second date rule, or a
 * client-side "does this member have a plan" check — the 409 is the answer.
 */

/** The error code stage 1 answers with. Mirrors `ACTIVE_PLAN_EXISTS` in the API. */
export const ACTIVE_PLAN_EXISTS = 'active_plan_exists';

/**
 * #2125: the staff's answer to the Add-or-Replace modal. `true` is the pre-#2125
 * "confirm the replacement" call and stays a replace; `'add'` keeps what the
 * member already has and adds the new plan beside it.
 */
export type ConflictChoice = boolean | 'add';

/** The request-body fields that carry `choice`; `{}` for the first, unasked attempt. */
export function conflictChoiceBody(choice: ConflictChoice): { confirm?: true; on_conflict?: 'add' } {
  if (choice === 'add') return { on_conflict: 'add' };
  return choice ? { confirm: true } : {};
}

/** One live assignment standing in the way, as the 409 body reports it. */
export interface ConflictingAssignment {
  /** `user_memberships.id` — the row a confirmed call cancels. */
  id: number;
  owner_member_id: number;
  owner_member_name: string | null;
  /** The member being assigned, whom this assignment already covers. */
  blocked_member_id: number;
  blocked_member_name: string | null;
  membership_plan_id: number | null;
  membership_plan_name: string | null;
  status: string;
  /** `YYYY-MM-DD`, as the API reads it from SQL. */
  starts_at: string;
  ends_at: string | null;
}

export interface ActivePlanConflict {
  /** The plan the dialog names as the current one — the 409's `current_plan`. */
  current: ConflictingAssignment;
  /** Every assignment a confirmed call would cancel, `current` included. */
  conflicts: ConflictingAssignment[];
  /** The server's own sentence, kept as the fallback for anything unworded. */
  message: string;
}

function asAssignment(value: any): ConflictingAssignment | null {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.id !== 'number' || typeof value.starts_at !== 'string') return null;
  return value as ConflictingAssignment;
}

/**
 * The conflict an `apiFetch` rejection carries, or `null` for every other
 * failure — a 400 on the dates, a 404, a lost connection — which stays the
 * caller's own error line. Checked by *shape* rather than by status alone: a
 * 409 is also how `/close` reports unused value and how a duplicate key is
 * reported, and showing a replacement dialog for either would be wrong.
 */
export function activePlanConflict(err: any): ActivePlanConflict | null {
  const body = err?.body;
  if (err?.status !== 409 || !body || body.error !== ACTIVE_PLAN_EXISTS) return null;
  const current = asAssignment(body.current_plan);
  if (!current) return null;
  const listed: ConflictingAssignment[] = Array.isArray(body.conflicts)
    ? body.conflicts
      .map((row: unknown) => asAssignment(row))
      .filter((a: ConflictingAssignment | null): a is ConflictingAssignment => a !== null)
    : [];
  // `conflicts` always contains `current_plan`, but a body that somehow omits
  // it must not produce a dialog listing nothing at all.
  const conflicts = listed.some((a) => a.id === current.id) ? listed : [current, ...listed];
  return {
    current,
    conflicts,
    message: typeof body.message === 'string' ? body.message : '',
  };
}

/**
 * Whether this assignment is somebody else's plan that merely *covers* the
 * member being assigned — a family plan (#956 Q4). It is the one thing about a
 * conflict the admin cannot infer from the plan's name: confirming cancels a
 * plan the other members it covers are also on, so the dialog says so.
 */
export function isSharedPlan(assignment: ConflictingAssignment): boolean {
  return assignment.owner_member_id !== assignment.blocked_member_id;
}

/**
 * `DD/MM/YYYY` from the plain `YYYY-MM-DD` the API returns, without going
 * through `Date`: parsing a bare date as UTC midnight and formatting it locally
 * shows the previous day west of Greenwich. Same shape as the `fmtDate` helpers
 * the Member and Assigned Plan cards already use.
 */
export function formatConflictDate(date: string | null): string {
  if (!date) return '—';
  const [y, m, d] = date.slice(0, 10).split('-');
  if (!y || !m || !d) return date;
  return `${d}/${m}/${y}`;
}

/**
 * The heading and body keys the dialog resolves, in the `common` namespace.
 *
 * Plural because one assignment path is a *set* — the Plans page assigns
 * several members at once and stage 1 answers all-or-nothing, so the dialog
 * has to say how many plans Continue cancels rather than naming one. The count
 * is the number of assignments being cancelled, which is what the admin is
 * weighing.
 */
export function conflictWording(conflict: ActivePlanConflict): {
  titleKey: string;
  bodyKey: string;
  count: number;
} {
  const count = conflict.conflicts.length;
  if (count <= 1) return { titleKey: 'replace_plan_title', bodyKey: 'replace_plan_body', count };
  // #2125: a member may hold several plans, so "more than one conflict" no longer means "more than
  // one member". Several members is the Plans page's bulk assign; several plans of one member is the
  // Add-or-Replace choice for somebody who already holds a few.
  const members = new Set(conflict.conflicts.map((c) => c.blocked_member_id));
  return members.size > 1
    ? { titleKey: 'replace_plan_title_many', bodyKey: 'replace_plan_body_many', count }
    : { titleKey: 'replace_plan_title_plans', bodyKey: 'replace_plan_body_plans', count };
}
