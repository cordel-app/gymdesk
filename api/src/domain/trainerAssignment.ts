import { db } from '../infra/db';

/**
 * #986: who may be assigned as a trainer in a gym is one question with one
 * answer, and this module is the only place that answers it — a **Staff record
 * whose `employment_status` is `active`**, whatever their profile.
 *
 * Until this ticket the answer was a *role* on the login row: `GET /trainers`
 * returned `gym_memberships` with `role IN ('trainer_performance',
 * 'trainer_perf_nutrition')`, i.e. only the staff whose HR profile is
 * *Personal Trainer* or *Personal Trainer & Nutritionist* (`PROFILE_ROLE_MAP`,
 * `api/src/infra/permissions.ts`). A gym whose staff are Gym Managers, Front
 * Desk or Nutritionists therefore saw an **empty** Default Trainer dropdown
 * even though every one of them is actively employed — which is the defect
 * #986 reports. Employment status is now the only condition: no role, no
 * center, no Professional Service, no "already assigned elsewhere".
 *
 * Two deliberate non-conditions, because `staff` carries two status columns:
 * `employment_status` (`active` | `inactive`, migration 067) is the one that
 * decides, and `current_status` (`available`, `on_vacation`, `suspended`, …)
 * is **not** a filter — a trainer on holiday is still employed, and the ticket
 * says only employment status may decide eligibility.
 *
 * The one structural condition left is the login row itself: every table that
 * stores a trainer (`activity_types.default_trainer_membership_id`,
 * `calendar_events.trainer_membership_id`, `trainer_availability`) keys to
 * `gym_memberships.id`, so a Staff record with no `gym_membership_id` has no
 * id to be stored under and cannot be offered. That is not a second rule: an
 * active staff member is granted a login on creation and healed on their next
 * save (`api/src/api/staff.ts`), so the excluded set is the records whose
 * grant errored, which the Staff card already reports under App access.
 *
 * Deactivating a staff member revokes that login and **deletes** the
 * `gym_memberships` row, and every FK above is `ON DELETE SET NULL`, so an
 * assignment pointing at them is cleared by the database rather than by this
 * module. What survives is the other direction — a membership that is *not* an
 * active staff member's but is already stored on a row (a legacy coach login, a
 * record saved while its grant was failing). `trainerWriteNeedsLookup()` is
 * why: the value a row already holds is not a new selection, so an edit that
 * does not touch the trainer never 400s on it, and the admin renders it as a
 * *disabled* option so it still reads correctly (the #980 stage 1 pattern).
 */

/** The FROM + WHERE every assignable-trainer read shares. Takes one `gym_id` parameter. */
export const ASSIGNABLE_TRAINERS_FROM = `
  FROM staff s
  JOIN gym_memberships gm ON gm.id = s.gym_membership_id AND gm.gym_id = s.gym_id
  WHERE s.gym_id = ?
    AND s.deleted_at IS NULL
    AND s.employment_status = 'active'
`;

/**
 * #986 §5: first name, then last name, alphabetically — the staff record's own
 * names rather than `gym_memberships.name`, which is a snapshot of them.
 */
export const ASSIGNABLE_TRAINERS_ORDER = ' ORDER BY s.first_name ASC, s.last_name ASC, s.id ASC';

/** `SELECT <columns>` over the shared scope, ordered per §5. */
export function assignableTrainersSql(columns: string): string {
  return `SELECT ${columns} ${ASSIGNABLE_TRAINERS_FROM} ${ASSIGNABLE_TRAINERS_ORDER}`;
}

/** Parse a request body value into a membership id, `null` (explicit clear), or an error. */
export function parseTrainerMembershipId(value: unknown): { id: number | null } | { error: string } {
  if (value === null || value === undefined || value === '') return { id: null };
  const id = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return { error: 'default_trainer_membership_id must be a positive integer' };
  }
  return { id };
}

/**
 * Whether a write has to look the trainer up at all. Pure, and the reason #986
 * §3 holds: clearing the field is always allowed, and a value identical to the
 * one the row already stores is not a *new* selection — so editing an activity's
 * capacity never fails because the trainer assigned to it last year has since
 * left. Anything else is a selection and must be assignable today.
 */
export function trainerWriteNeedsLookup(next: number | null, current: number | null): boolean {
  if (next === null) return false;
  return next !== current;
}

/** Is this membership an active staff member of this gym, i.e. assignable as a trainer? */
export async function isAssignableTrainer(gymId: string, membershipId: number): Promise<boolean> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT gm.id ${ASSIGNABLE_TRAINERS_FROM} AND gm.id = ? LIMIT 1`,
    [gymId, membershipId],
  );
  return rows.length > 0;
}

/**
 * Returns an error message when the trainer may not be assigned, or `null`
 * when the write is allowed (a clear, an unchanged value, or an active staff
 * member of this gym). `current` is the value the row already holds — pass
 * `null` on create.
 */
export async function validateTrainerMembershipId(
  gymId: string,
  next: number | null,
  current: number | null,
): Promise<string | null> {
  if (!trainerWriteNeedsLookup(next, current)) return null;
  return (await isAssignableTrainer(gymId, next as number))
    ? null
    : 'Trainer not found, or not an active staff member of this gym';
}
