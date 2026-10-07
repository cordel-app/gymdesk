import { Tx } from '../infra/db';
import { loadRequiredServices } from './activity-eligibility';
import { loadMemberProfessionalServiceGrants } from '../domain/memberProfessionalServices';
import { ConsumptionReason, chooseSpendGrant } from '../domain/serviceConsumption';

/**
 * #1189 stage 3: the SQL half of the Professional Service consumption ledger.
 * `domain/serviceConsumption.ts` decides when a session is spent and which
 * grant pays; this file reads the booking, writes the ledger row and, for a
 * purchased package, moves its live counter in the same transaction.
 */

export interface SpendResult {
  spent: boolean;
  /** Why nothing was spent: already spent for this booking, or no required service / no balance. */
  skipped?: 'already_spent' | 'not_applicable' | 'no_balance';
}

/**
 * Spend one session for a booking, at most once. Idempotent per booking
 * (`psc_one_per_booking`): a second call — a corrected attendance roll, a
 * cancel after an attendance mark — is a no-op that keeps the first reason.
 */
export async function spendSessionForBooking(
  tx: Tx,
  gymId: string,
  bookingId: number,
  reason: ConsumptionReason,
  actor: string | null,
): Promise<SpendResult> {
  const { rows: existing } = await tx.query(
    'SELECT id FROM professional_service_consumptions WHERE calendar_event_booking_id = ? FOR UPDATE',
    [bookingId],
  );
  if (existing.length > 0) return { spent: false, skipped: 'already_spent' };

  const { rows: bRows } = await tx.query(
    `SELECT ceb.member_id, ceb.calendar_event_id, ce.activity_type_id
       FROM calendar_event_bookings ceb
       JOIN calendar_events ce ON ce.id = ceb.calendar_event_id
      WHERE ceb.id = ? AND ceb.gym_id = ?`,
    [bookingId, gymId],
  );
  if (bRows.length === 0) return { spent: false, skipped: 'not_applicable' };
  const { member_id: memberId, calendar_event_id: eventId, activity_type_id: activityTypeId } = bRows[0];

  const required = await loadRequiredServices(tx, gymId, activityTypeId, eventId);
  if (required.length === 0) return { spent: false, skipped: 'not_applicable' };

  const grants = await loadMemberProfessionalServiceGrants(gymId, memberId);
  const grant = chooseSpendGrant(grants, required.map((s) => s.id));
  if (!grant) return { spent: false, skipped: 'no_balance' };

  await tx.query(
    `INSERT INTO professional_service_consumptions
       (gym_id, member_id, calendar_event_booking_id, calendar_event_id, professional_service_id,
        source_kind, source_reference_id, product_id, reason, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [gymId, memberId, bookingId, eventId, grant.professional_service_id,
      grant.kind, grant.reference_id, grant.product_id, reason, actor],
  );

  if (grant.kind === 'class_package') {
    await tx.query(
      "UPDATE user_class_packages SET sessions_remaining = sessions_remaining - 1, status = IF(sessions_remaining - 1 = 0, 'consumed', status) WHERE id = ? AND gym_id = ?",
      [grant.reference_id, gymId],
    );
    await tx.query(
      'INSERT INTO class_package_transactions (gym_id, user_class_package_id, booking_id, calendar_event_booking_id, amount, reason) VALUES (?, ?, NULL, ?, -1, ?)',
      [gymId, grant.reference_id, bookingId, `Session spent (${reason})`],
    );
  }
  return { spent: true };
}

/**
 * Return the session a booking spent — the staff's explicit "return class"
 * choice. The ledger row stays (stamped `returned_at`) as the record, and a
 * purchased package gets its credit back. A no-op when nothing was spent or it
 * was already returned.
 */
export async function returnSessionForBooking(
  tx: Tx,
  gymId: string,
  bookingId: number,
  actor: string | null,
): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT id, source_kind, source_reference_id FROM professional_service_consumptions
      WHERE calendar_event_booking_id = ? AND gym_id = ? AND returned_at IS NULL FOR UPDATE`,
    [bookingId, gymId],
  );
  if (rows.length === 0) return false;
  await tx.query(
    'UPDATE professional_service_consumptions SET returned_at = UTC_TIMESTAMP(), returned_by = ? WHERE id = ?',
    [actor, rows[0].id],
  );
  if (rows[0].source_kind === 'class_package') {
    await tx.query(
      "UPDATE user_class_packages SET sessions_remaining = sessions_remaining + 1, status = IF(status = 'consumed', 'active', status) WHERE id = ? AND gym_id = ?",
      [rows[0].source_reference_id, gymId],
    );
    await tx.query(
      'INSERT INTO class_package_transactions (gym_id, user_class_package_id, booking_id, calendar_event_booking_id, amount, reason) VALUES (?, ?, NULL, ?, 1, ?)',
      [gymId, rows[0].source_reference_id, bookingId, 'Session returned'],
    );
  }
  return true;
}
