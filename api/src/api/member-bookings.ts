import { Router, type Request, type Response, type NextFunction } from 'express';
import { db } from '../infra/db';
import { getTenantContext } from '../infra/tenantContext';
import { splitMemberBookings } from '../domain/memberBookingHistory';

/**
 * #2720 — the Admin Member card's **Bookings** tab, mounted at
 * `/members/:memberId/bookings` behind MEMBERS access and the Calendar flag
 * (the staff `/bookings` router's own gates). Read-only: the rows are the
 * member's `calendar_event_bookings`, split by `splitMemberBookings()`.
 */
export const memberBookingsRouter = Router({ mergeParams: true });

memberBookingsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  const { gymId } = getTenantContext(req);
  try {
    const memberId = Number(req.params.memberId);
    if (!Number.isInteger(memberId) || memberId < 1) return res.status(404).json({ error: 'Member not found' });
    const { rows: member } = await db.query('SELECT id FROM members WHERE id = ? AND gym_id = ?', [memberId, gymId]);
    if (member.length === 0) return res.status(404).json({ error: 'Member not found' });

    const { rows } = await db.query(
      `SELECT ceb.id, ceb.status, ceb.waitlist_position, ceb.attendance_status,
              ceb.booked_at AS booked_on, ceb.cancelled_at,
              ceb.calendar_event_id,
              ce.starts_at, ce.ends_at, ce.status AS session_status,
              COALESCE(NULLIF(TRIM(ce.title), ''), at.name) AS event_name,
              c.name AS center_name, sp.name AS space_name, tm.name AS trainer_name,
              ps.name AS professional_service_name,
              (COALESCE(ce.ends_at, ce.starts_at) <= UTC_TIMESTAMP()) AS has_ended
       FROM calendar_event_bookings ceb
       JOIN calendar_events ce ON ce.id = ceb.calendar_event_id AND ce.gym_id = ceb.gym_id
       LEFT JOIN activity_types at ON at.id = ce.activity_type_id
       LEFT JOIN centers c ON c.id = ce.center_id
       LEFT JOIN spaces sp ON sp.id = ce.space_id
       LEFT JOIN gym_memberships tm ON tm.id = ce.trainer_membership_id
       LEFT JOIN professional_services ps ON ps.id = ceb.professional_service_id
       WHERE ceb.gym_id = ? AND ceb.member_id = ? AND ce.deleted_at IS NULL`,
      [gymId, memberId],
    );
    const { upcoming, past } = splitMemberBookings(rows as any[]);
    const shape = (r: any) => {
      const { has_ended: _ended, ...rest } = r;
      return rest;
    };
    res.json({ upcoming: upcoming.map(shape), past: past.map(shape) });
  } catch (err) {
    next(err);
  }
});
