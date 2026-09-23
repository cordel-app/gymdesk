import { Router } from 'express';
import { DateTime } from 'luxon';
import { db } from '../infra/db';
import { getTenantContext } from '../infra/tenantContext';
import { resolveMemberProfessionalServices } from '../domain/memberProfessionalServices';
import { isActivityTypeEligibleForMember } from './activity-eligibility';
import {
  SlotOccurrenceRow,
  WeeklySlotDay,
  projectWeeklySlots,
} from '../domain/personalTrainingSlots';

/**
 * #647 stage 2: read-only weekly availability projection —
 * `GET /members/:memberId/personal-training-slots`.
 *
 * Answers "which recurring Personal Training slots could this Member take?"
 * for the Mon–Sun grid in the Member profile. Display only: nothing here
 * writes, and no selection is persisted (stage 3) and no booking is created
 * (stages 3 and 4).
 *
 * The eligibility rule is the ticket's: an occurrence counts only when its
 * `calendar_events.professional_service_id` (stage 1, migration 168) is one
 * of the Professional Services the Member holds sessions for — the list
 * `GET /members/:memberId/professional-services` serves, reused here rather
 * than recomputed. On top of that, the Activity Type must be one the Member's
 * plan may book (#481), which is asked through
 * `isActivityTypeEligibleForMember()` so this projection and
 * `bookMemberOnSession` cannot drift apart.
 *
 * The grouping and the per-date reasons live in
 * `domain/personalTrainingSlots.ts`; this file only loads rows and hands them
 * over.
 */
export const memberPersonalTrainingSlotsRouter = Router({ mergeParams: true });

/** The ticket's window: "the entire next 2 months", counted from now. */
const WINDOW_MONTHS = 2;

/**
 * Candidate occurrences: every future `calendar_events` row in the window
 * whose Professional Service the Member holds.
 *
 * The INNER JOIN to `activity_types` is also the "this is a bookable session,
 * not a plain calendar entry" filter (`activity_type_id IS NOT NULL`), the
 * same partition `calendar-events.ts` relies on — `bookMemberOnSession` joins
 * `activity_types` too, so an occurrence without one could never be booked.
 *
 * Cancelled and completed occurrences are loaded on purpose: the projection
 * reports them as unavailable dates of an otherwise real slot, which is what
 * makes "7 of 9 dates" possible instead of a silently shorter list.
 *
 * Centers are read but not filtered on: the same activity at the same local
 * time in two centers is two slots the Member picks between (the center is
 * part of the projection's slot key), and which centers a Member may attend is
 * a booking-path question this read does not pre-empt.
 */
async function loadCandidateOccurrences(
  gymId: string,
  memberId: number,
  serviceIds: number[],
  fromUtc: string,
  toUtc: string,
): Promise<SlotOccurrenceRow[]> {
  if (serviceIds.length === 0) return [];
  const marks = serviceIds.map(() => '?').join(',');
  const { rows } = await db.query<SlotOccurrenceRow>(
    `SELECT ce.id                        AS calendar_event_id,
            ce.starts_at,
            ce.ends_at,
            ce.status,
            ce.activity_type_id,
            at.name                      AS activity_type_name,
            ce.professional_service_id,
            ps.name                      AS professional_service_name,
            ce.center_id,
            c.name                       AS center_name,
            COALESCE(ce.capacity, at.max_capacity) AS effective_capacity,
            (SELECT COUNT(*) FROM calendar_event_bookings ceb
              WHERE ceb.calendar_event_id = ce.id AND ceb.status = 'booked') AS booked_count,
            EXISTS (SELECT 1 FROM calendar_event_bookings ceb2
                     WHERE ceb2.calendar_event_id = ce.id AND ceb2.member_id = ?
                       AND ceb2.status IN ('booked', 'waitlisted')) AS member_booked
     FROM calendar_events ce
     JOIN activity_types at ON at.id = ce.activity_type_id
     JOIN professional_services ps ON ps.id = ce.professional_service_id
     LEFT JOIN centers c ON c.id = ce.center_id
     WHERE ce.gym_id = ?
       AND ce.deleted_at IS NULL
       AND ce.professional_service_id IN (${marks})
       AND ce.starts_at >= ? AND ce.starts_at < ?
     ORDER BY ce.starts_at ASC`,
    [memberId, gymId, ...serviceIds, fromUtc, toUtc],
  );
  return rows;
}

memberPersonalTrainingSlotsRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const memberId = parseInt((req.params as { memberId: string }).memberId, 10);
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return res.status(400).json({ error: 'memberId must be a positive integer' });
  }

  try {
    const { rows: memberRows } = await db.query(
      'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [memberId, gymId],
    );
    if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

    // The grid is drawn in gym-local time — the same conversion
    // `materializeScheduleRule` used to write the occurrences.
    const { rows: gymRows } = await db.query<{ timezone: string }>(
      'SELECT timezone FROM gyms WHERE id = ?',
      [gymId],
    );
    const timezone = gymRows[0]?.timezone ?? 'Europe/Madrid';

    const from = DateTime.utc().setZone(timezone);
    const to = from.plus({ months: WINDOW_MONTHS });

    const services = await resolveMemberProfessionalServices(gymId, memberId);
    const occurrences = await loadCandidateOccurrences(
      gymId,
      memberId,
      services.map((s) => s.professional_service_id),
      from.toUTC().toFormat('yyyy-MM-dd HH:mm:ss'),
      to.toUTC().toFormat('yyyy-MM-dd HH:mm:ss'),
    );

    // One eligibility question per distinct Activity Type, not per occurrence:
    // #481 eligibility is a (member, activity type) fact, and a 2-month window
    // of a weekly rule is ~9 rows of the same type.
    const activityTypeIds = [...new Set(occurrences.map((o) => o.activity_type_id))];
    const eligibility = await Promise.all(
      activityTypeIds.map((id) => isActivityTypeEligibleForMember(db, gymId, memberId, id)),
    );
    const eligibleActivityTypeIds = new Set(activityTypeIds.filter((_, i) => eligibility[i]));

    const days: WeeklySlotDay[] = projectWeeklySlots({
      timezone, from, to, occurrences, eligibleActivityTypeIds,
    });

    res.json({
      timezone,
      window: {
        from: from.toFormat('yyyy-MM-dd'),
        to: to.toFormat('yyyy-MM-dd'),
        months: WINDOW_MONTHS,
      },
      // Echoed so the view can say which services made a slot eligible, and
      // explain an empty grid ("this Member holds no session services").
      professional_services: services.map((s) => ({
        professional_service_id: s.professional_service_id,
        name: s.name,
        sessions: s.sessions,
      })),
      days,
    });
  } catch (err) { next(err); }
});
