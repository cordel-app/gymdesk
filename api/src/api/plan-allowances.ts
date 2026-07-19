import { registerBookingAccessHook } from './bookings';
import { getPackageIntent } from './package-credits';

/**
 * Booking-time enforcement via plan_allowances.
 * Replaces the old class_type_user_memberships check in plan-class-types.ts.
 *
 * Rules:
 *   1. If no plan_allowances row exists for (plan, activity_type) → reject.
 *   2. allowance_type='unlimited' → allow.
 *   3. allowance_type='session_count' → count bookings in the current recurrence
 *      window; reject if the count >= session_count.
 *
 * Center validation is also applied here: if membership_plan_centers rows exist
 * for the plan, the booking's center must be in that set.
 */
registerBookingAccessHook(async (tx, gymId, memberId, activityTypeId, centerId) => {
  // Resolve the member's active membership plan
  const { rows: memberships } = await tx.query(
    `SELECT um.membership_plan_id FROM user_memberships um
     WHERE um.gym_id = ? AND um.member_id = ? AND um.status = 'active'
     LIMIT 1`,
    [gymId, memberId],
  );
  if (memberships.length === 0) return; // No membership — other guards handle

  const planId = memberships[0].membership_plan_id;

  // Center validation: if the plan has center restrictions, check the booking center
  if (centerId) {
    const { rows: planCenters } = await tx.query(
      'SELECT COUNT(*) AS n FROM membership_plan_centers WHERE membership_plan_id = ? AND gym_id = ?',
      [planId, gymId],
    );
    if (Number(planCenters[0].n) > 0) {
      const { rows: allowed } = await tx.query(
        'SELECT 1 FROM membership_plan_centers WHERE membership_plan_id = ? AND center_id = ? AND gym_id = ?',
        [planId, centerId, gymId],
      );
      if (allowed.length === 0) {
        throw Object.assign(
          new Error('Your membership plan does not cover this center.'),
          { status: 403, code: 'center_not_covered' },
        );
      }
    }
  }

  // Check plan_allowances for this activity type
  const { rows: allowances } = await tx.query(
    `SELECT * FROM plan_allowances
     WHERE membership_plan_id = ? AND activity_type_id = ? AND gym_id = ?
     LIMIT 1`,
    [planId, activityTypeId, gymId],
  );

  if (allowances.length === 0) {
    // Activity type is not covered — check class packages before rejecting
    if (getPackageIntent(tx)) return;
    throw Object.assign(
      new Error('This activity type is not included in your membership plan.'),
      { status: 403, code: 'plan_required' },
    );
  }

  const allowance = allowances[0];
  if (allowance.allowance_type === 'unlimited') return;

  // session_count: count bookings in the current recurrence window
  if (allowance.allowance_type === 'session_count') {
    const interval = allowance.recurrence_interval ?? 1;
    const unit = allowance.recurrence_unit ?? 'month';

    const windowStart = await tx.query(
      `SELECT DATE_SUB(NOW(), INTERVAL ? ${unit.toUpperCase()}) AS ws`,
      [interval],
    );
    const ws = windowStart.rows[0].ws;

    const { rows: usageRows } = await tx.query(
      `SELECT COUNT(*) AS n FROM bookings b
       JOIN class_sessions cs ON cs.id = b.class_session_id
       WHERE b.gym_id = ? AND b.member_id = ?
         AND cs.activity_type_id = ?
         AND b.status NOT IN ('cancelled')
         AND b.created_at >= ?`,
      [gymId, memberId, activityTypeId, ws],
    );

    if (Number(usageRows[0].n) >= allowance.session_count) {
      if (getPackageIntent(tx)) return;
      throw Object.assign(
        new Error('You have used all your sessions for this activity type in the current period.'),
        { status: 403, code: 'allowance_exhausted' },
      );
    }
  }
});
