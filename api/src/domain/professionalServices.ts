import { db } from '../infra/db';

/**
 * #647 stage 1: gym-scoped validation for the `professional_service_id`
 * attribute added to `activity_types` and `calendar_events` (migration 168).
 *
 * A Professional Service (#484) is assignable when it is visible to the gym
 * — a global system row (`gym_id IS NULL`) or one the gym owns — is not
 * soft-deleted, and is currently *enabled* for the gym, which is the
 * `gym_professional_services.status` flag rather than anything on
 * `professional_services` itself. `GET /professional-services` applies the
 * same visibility rule, so the admin picker and this validator agree on the
 * set of selectable services.
 *
 * This deliberately does not reuse `validateProfessionalServiceIds()` from
 * `sellableItemProfessionalServices.ts`: that one validates a *set* of links
 * on a Sellable Item and, by design (#546 requirement 14), accepts services
 * that are merely visible, including ones the gym has switched off. An
 * Activity Type or calendar event whose service is disabled would silently
 * stop matching any Member entitlement, so the stricter rule belongs here.
 */

/** Parse a request body value into an id, `null` (explicit clear), or an error. */
export function parseProfessionalServiceId(value: unknown): { id: number | null } | { error: string } {
  if (value === null || value === undefined || value === '') return { id: null };
  const id = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return { error: 'professional_service_id must be a positive integer' };
  }
  return { id };
}

/**
 * Returns an error message when the id is not assignable for this gym, or
 * `null` when it is (including when `id` is `null`, which clears the field).
 */
export async function validateProfessionalServiceId(gymId: string, id: number | null): Promise<string | null> {
  if (id === null) return null;
  const { rows } = await db.query<{ id: number }>(
    `SELECT ps.id
     FROM professional_services ps
     JOIN gym_professional_services gps
       ON gps.professional_service_id = ps.id AND gps.gym_id = ?
     WHERE ps.id = ? AND (ps.gym_id IS NULL OR ps.gym_id = ?)
       AND ps.deleted_at IS NULL AND gps.status = 'active'`,
    [gymId, id, gymId],
  );
  return rows.length > 0 ? null : 'Professional service not found, or not active for this gym';
}
