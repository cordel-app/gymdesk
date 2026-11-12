import { Router, type Request, type Response, type NextFunction } from 'express';
import { db } from '../infra/db';
import { getTenantContext } from '../infra/tenantContext';
import {
  PAST_BOOKING_SQL, PAST_BOOKING_STATUS_FILTERS, PAST_BOOKINGS_PAGE_SIZE, UPCOMING_BOOKING_SQL,
  parsePastBookingsQuery, pastBookingFilterSql, splitMemberBookings,
} from '../domain/memberBookingHistory';

/**
 * #2720 — the Admin Member card's **Bookings** tab, mounted at
 * `/members/:memberId/bookings` behind MEMBERS access and the Calendar flag
 * (the staff `/bookings` router's own gates). Read-only: the rows are the
 * member's `calendar_event_bookings`, split by `splitMemberBookings()`.
 *
 * #2731 — `?scope=upcoming` answers the Upcoming list alone (the tab no longer
 * loads the history until Staff opens *Past Events*), and `GET /past` is the
 * history filtered and paginated in SQL through `PAST_BOOKING_SQL`, the same
 * rule `splitMemberBookings()` applies.
 */
export const memberBookingsRouter = Router({ mergeParams: true });

const BOOKING_COLUMNS = `ceb.id, ceb.status, ceb.waitlist_position, ceb.attendance_status,
              ceb.booked_at AS booked_on, ceb.cancelled_at,
              ceb.calendar_event_id, ceb.professional_service_id,
              ce.starts_at, ce.ends_at, ce.status AS session_status,
              COALESCE(NULLIF(TRIM(ce.title), ''), at.name) AS event_name,
              c.name AS center_name, sp.name AS space_name, tm.name AS trainer_name,
              ps.name AS professional_service_name`;

const BOOKING_FROM = `FROM calendar_event_bookings ceb
       JOIN calendar_events ce ON ce.id = ceb.calendar_event_id AND ce.gym_id = ceb.gym_id
       LEFT JOIN activity_types at ON at.id = ce.activity_type_id
       LEFT JOIN centers c ON c.id = ce.center_id
       LEFT JOIN spaces sp ON sp.id = ce.space_id
       LEFT JOIN gym_memberships tm ON tm.id = ce.trainer_membership_id
       LEFT JOIN professional_services ps ON ps.id = ceb.professional_service_id
       WHERE ceb.gym_id = ? AND ceb.member_id = ? AND ce.deleted_at IS NULL`;

async function resolveMember(req: Request, gymId: string | number): Promise<number | null> {
  const memberId = Number(req.params.memberId);
  if (!Number.isInteger(memberId) || memberId < 1) return null;
  const { rows } = await db.query('SELECT id FROM members WHERE id = ? AND gym_id = ?', [memberId, gymId]);
  return rows.length ? memberId : null;
}

/** Each filter's options: the values that occur in the member's own past bookings. */
async function pastFilterOptions(gymId: string | number, memberId: number) {
  const base = `${BOOKING_FROM} AND ${PAST_BOOKING_SQL}`;
  const opt = (idCol: string, nameCol: string) => db.query(
    `SELECT DISTINCT ${idCol} AS id, ${nameCol} AS name ${base} AND ${idCol} IS NOT NULL ORDER BY name, id`,
    [gymId, memberId],
  ).then((r) => r.rows as { id: number; name: string | null }[]);
  const [activities, centers, trainers, professionalServices] = await Promise.all([
    opt('ce.activity_type_id', 'at.name'),
    opt('ce.center_id', 'c.name'),
    opt('ce.trainer_membership_id', 'tm.name'),
    opt('ceb.professional_service_id', 'ps.name'),
  ]);
  return {
    activities, centers, trainers, professional_services: professionalServices,
    statuses: [...PAST_BOOKING_STATUS_FILTERS],
  };
}

memberBookingsRouter.get('/past', async (req: Request, res: Response, next: NextFunction) => {
  const { gymId } = getTenantContext(req);
  try {
    const memberId = await resolveMember(req, gymId);
    if (memberId == null) return res.status(404).json({ error: 'Member not found' });
    const parsed = parsePastBookingsQuery(req.query as Record<string, unknown>);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const query = parsed.value;
    const filter = pastBookingFilterSql(query);
    const where = `${BOOKING_FROM} AND ${PAST_BOOKING_SQL}${filter.sql}`;
    const params = [gymId, memberId, ...filter.params];

    // LIMIT/OFFSET are validated integers written into the statement: mysql2's
    // execute() refuses a bound LIMIT (CLAUDE.md).
    const offset = (query.page - 1) * PAST_BOOKINGS_PAGE_SIZE;
    const [{ rows }, { rows: countRows }, options] = await Promise.all([
      db.query(
        `SELECT ${BOOKING_COLUMNS} ${where}
         ORDER BY ce.starts_at DESC, ceb.id DESC
         LIMIT ${PAST_BOOKINGS_PAGE_SIZE} OFFSET ${offset}`,
        params,
      ),
      db.query(`SELECT COUNT(*) AS total ${where}`, params),
      pastFilterOptions(gymId, memberId),
    ]);
    res.json({
      rows,
      total: Number((countRows as any[])[0]?.total ?? 0),
      page: query.page,
      page_size: PAST_BOOKINGS_PAGE_SIZE,
      options,
    });
  } catch (err) {
    next(err);
  }
});

memberBookingsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  const { gymId } = getTenantContext(req);
  try {
    const scope = req.query.scope;
    if (scope !== undefined && scope !== 'upcoming') return res.status(400).json({ error: "scope must be 'upcoming'" });
    const memberId = await resolveMember(req, gymId);
    if (memberId == null) return res.status(404).json({ error: 'Member not found' });

    const { rows } = await db.query(
      `SELECT ${BOOKING_COLUMNS},
              (COALESCE(ce.ends_at, ce.starts_at) <= UTC_TIMESTAMP()) AS has_ended
       ${BOOKING_FROM}${scope === 'upcoming' ? ` AND ${UPCOMING_BOOKING_SQL}` : ''}`,
      [gymId, memberId],
    );
    const { upcoming, past } = splitMemberBookings(rows as any[]);
    const shape = (r: any) => {
      const { has_ended: _ended, ...rest } = r;
      return rest;
    };
    if (scope === 'upcoming') return res.json({ upcoming: upcoming.map(shape) });
    res.json({ upcoming: upcoming.map(shape), past: past.map(shape) });
  } catch (err) {
    next(err);
  }
});
