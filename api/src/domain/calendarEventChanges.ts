/**
 * #980 stage 1 — what changed about an occurrence, and nothing else.
 *
 * `PUT /class-sessions/:id` is a partial write: every field is `IF(? , ?, col)`
 * or `COALESCE(?, col)`, so a request that names three fields leaves the rest
 * exactly as they were. §11 asks for an audit row carrying *previous → new*
 * per changed field, which is a different question from "what did the request
 * send": a staff member who re-picks the trainer already on the event changed
 * nothing, and an audit row saying `John Smith → John Smith` is noise in the
 * one log a gym reads to find out who moved a class.
 *
 * So the diff is taken between the row as it was and the row as it is, over a
 * declared field list, and `null` means *do not write an audit row at all*.
 * It is pure on purpose — the comparison rules below are the whole of the
 * decision and are asserted directly rather than through a route.
 */

/**
 * The occurrence columns `PUT /class-sessions/:id` can write. A field added to
 * that route is added here too, or it changes silently.
 *
 * `modified_by_membership_id` is deliberately absent: it is who made the
 * change, which the audit row already records as its actor, and it moves on
 * every write so including it would make every diff non-empty.
 */
export const SESSION_AUDITED_FIELDS = [
  'activity_type_id',
  'trainer_membership_id',
  'space_id',
  'starts_at',
  'ends_at',
  'capacity',
  'allows_shared_booking',
  'professional_service_id',
  // #980 stage 2 — the occurrence's own Waitlist setting. `NULL` is a value
  // here rather than an absence: it means "follow the Activity Type", so
  // `null → disabled` is as real a change as `open → disabled` and reads as
  // one in the log.
  'waitlist_mode',
  // #980 stage 3 — the occurrence's effective Eligible Professional Services,
  // as the list of names (its own list when it overrides the Activity Type's,
  // the Activity Type's otherwise), so `inherited → own` and `[PT] → []`
  // (restricted → any member) both read as the change they are.
  'eligible_professional_service_names',
] as const;

export interface FieldChanges {
  previous: Record<string, unknown>;
  next: Record<string, unknown>;
}

/**
 * Normalize a column value for comparison only — never for storage.
 *
 * mysql2 hands back a `Date` for DATETIME, a number for INT and 0/1 for
 * TINYINT, and the same row read twice can differ in type without differing in
 * value (a `capacity` of `4` compared against `'4'` from a re-read is the
 * shape that produces a phantom change). `undefined` and `null` are both
 * "unset", because a column absent from one of the two reads must not read as
 * a change to NULL.
 */
function comparable(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * The fields of `after` that differ from `before`, as the `previous`/`next`
 * pair `recordAudit` takes — or `null` when nothing in `fields` moved.
 *
 * Values are reported **as they are stored**, not as `comparable()` sees them:
 * the audit log's own FK enrichment turns `space_id` into `{ id, name }`, so a
 * stringified id would lose the name the gym reads.
 */
export function diffAuditedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly string[] = SESSION_AUDITED_FIELDS,
): FieldChanges | null {
  const previous: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};

  for (const field of fields) {
    if (comparable(before[field]) === comparable(after[field])) continue;
    previous[field] = before[field] ?? null;
    next[field] = after[field] ?? null;
  }

  return Object.keys(next).length === 0 ? null : { previous, next };
}
