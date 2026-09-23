import { Router } from 'express';
import { DateTime } from 'luxon';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { resolveMemberProfessionalServices } from '../domain/memberProfessionalServices';
import { isActivityTypeEligibleForMember } from './activity-eligibility';
import { bookMemberOnSession } from './bookings';
import {
  SlotIdentity,
  SlotOccurrenceRow,
  WeeklySlotDay,
  parseSlotIdentities,
  planSlotBookings,
  projectWeeklySlots,
  slotIdentityKey,
} from '../domain/personalTrainingSlots';

/**
 * #647 stages 2–3: the Member's recurring Personal Training slots.
 *
 *   GET  /members/:memberId/personal-training-slots             the Mon–Sun grid
 *   PUT  /members/:memberId/personal-training-slots/selections  replace the stored weekly pattern
 *   POST /members/:memberId/personal-training-slots/book        book the window for it
 *
 * The grid answers "which recurring Personal Training slots could this Member
 * take?" over a rolling 2-month window. The eligibility rule is the ticket's:
 * an occurrence counts only when its `calendar_events.professional_service_id`
 * (stage 1, migration 168) is one of the Professional Services the Member
 * holds sessions for — the list `GET /members/:memberId/professional-services`
 * serves, reused here rather than recomputed. On top of that, the Activity
 * Type must be one the Member's plan may book (#481), which is asked through
 * `isActivityTypeEligibleForMember()` so this projection and
 * `bookMemberOnSession` cannot drift apart.
 *
 * Stage 3 adds the two writes. A *selection* is a weekly pattern
 * (`member_recurring_slots`, migration 169), not a list of dates — per the
 * issue thread's Q3 answer — and Book resolves it against the very same
 * projection the grid is drawn from, then puts every free date through
 * `bookMemberOnSession`. Nothing here re-implements a booking rule: capacity,
 * waitlist mode, #481 eligibility and package-credit debiting all happen
 * inside that call, under its `FOR UPDATE` lock, one occurrence at a time.
 *
 * The grouping and the per-date reasons live in
 * `domain/personalTrainingSlots.ts`; this file loads rows, stores selections
 * and drives the booking path.
 */
export const memberPersonalTrainingSlotsRouter = Router({ mergeParams: true });

/** The ticket's window: "the entire next 2 months", counted from now. */
const WINDOW_MONTHS = 2;

/** One stored row of `member_recurring_slots`, as the selection reads return it. */
interface StoredSelection extends SlotIdentity {
  id: number;
}

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

/**
 * The Member's stored weekly patterns.
 *
 * `start_time`/`end_time` come back from MySQL as `HH:MM:SS` strings (mysql2
 * does not map TIME onto a JS type), so they are trimmed to the `HH:MM` the
 * projection groups on — otherwise no selection would ever match a slot.
 */
async function loadSelections(gymId: string, memberId: number): Promise<StoredSelection[]> {
  // `iso_weekday` is named for its base (1=Mon … 7=Sun, luxon's numbering)
  // because the rest of the schema counts weekdays 0=Sun … 6=Sat — see
  // migration 169. The API speaks ISO throughout, so it is aliased back to the
  // `weekday` the grid and the request bodies use.
  const { rows } = await db.query<StoredSelection & { start_time: string; end_time: string }>(
    `SELECT id, iso_weekday AS weekday, start_time, end_time, activity_type_id,
            professional_service_id, center_id
       FROM member_recurring_slots
      WHERE gym_id = ? AND member_id = ?
      ORDER BY iso_weekday ASC, start_time ASC, id ASC`,
    [gymId, memberId],
  );
  return rows.map((r) => ({
    ...r,
    weekday: Number(r.weekday),
    start_time: String(r.start_time).slice(0, 5),
    end_time: String(r.end_time).slice(0, 5),
    center_id: r.center_id == null ? null : Number(r.center_id),
  }));
}

/** Everything the grid needs, in the gym's timezone. Shared by all three routes. */
async function loadProjection(gymId: string, memberId: number, selections: StoredSelection[]) {
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
    timezone,
    from,
    to,
    occurrences,
    eligibleActivityTypeIds,
    selectedKeys: new Set(selections.map(slotIdentityKey)),
  });

  return {
    timezone,
    window: { from: from.toFormat('yyyy-MM-dd'), to: to.toFormat('yyyy-MM-dd'), months: WINDOW_MONTHS },
    services,
    days,
  };
}

/**
 * A stored selection as the API reports it: its identity, plus whether the
 * grid still offers it.
 *
 * `matched: false` is the §5 case — the Member no longer holds the
 * Professional Service, or their plan stopped being eligible for the Activity
 * Type. The row is kept (the entitlement may come back, and deleting it would
 * silently lose the Member's choice) but nothing new is booked for it.
 */
function describeSelections(selections: StoredSelection[], days: WeeklySlotDay[]) {
  const offered = new Set<string>();
  for (const day of days) for (const slot of day.slots) offered.add(slotIdentityKey(slot));
  return selections.map((s) => ({ ...s, matched: offered.has(slotIdentityKey(s)) }));
}

/** 404s a member that is not this gym's, or is soft-deleted. */
async function findMember(gymId: string, memberId: number): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [memberId, gymId],
  );
  return rows.length > 0;
}

function parseMemberId(req: { params: unknown }): number | null {
  const memberId = parseInt((req.params as { memberId: string }).memberId, 10);
  return Number.isInteger(memberId) && memberId > 0 ? memberId : null;
}

memberPersonalTrainingSlotsRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const memberId = parseMemberId(req);
  if (memberId === null) return res.status(400).json({ error: 'memberId must be a positive integer' });

  try {
    if (!(await findMember(gymId, memberId))) return res.status(404).json({ error: 'Member not found' });

    const selections = await loadSelections(gymId, memberId);
    const { timezone, window, services, days } = await loadProjection(gymId, memberId, selections);

    res.json({
      timezone,
      window,
      // Echoed so the view can say which services made a slot eligible, and
      // explain an empty grid ("this Member holds no session services").
      professional_services: services.map((s) => ({
        professional_service_id: s.professional_service_id,
        name: s.name,
        sessions: s.sessions,
      })),
      selections: describeSelections(selections, days),
      days,
    });
  } catch (err) { next(err); }
});

/**
 * Replace the Member's stored weekly pattern (§2).
 *
 * A full replace, not a patch: the grid hands back every box that is ticked,
 * which makes select and deselect the same request and leaves no room for a
 * half-applied change. Rows that survive the replace keep their `id` and
 * `created_at`, so re-sending an unchanged selection is a no-op rather than a
 * churn of delete/insert.
 *
 * Every submitted identity must be a slot the grid currently offers — a
 * selection the projection would not produce could never be booked, and
 * storing it would be an invitation to invent occurrences. Deselecting never
 * touches `calendar_event_bookings`: §5 keeps existing bookings under the
 * normal cancellation rules.
 */
memberPersonalTrainingSlotsRouter.put('/selections', requireModuleWrite('MEMBERS'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const memberId = parseMemberId(req);
  if (memberId === null) return res.status(400).json({ error: 'memberId must be a positive integer' });

  const parsed = parseSlotIdentities((req.body ?? {}).slots);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });

  try {
    if (!(await findMember(gymId, memberId))) return res.status(404).json({ error: 'Member not found' });

    const current = await loadSelections(gymId, memberId);
    const { days } = await loadProjection(gymId, memberId, current);

    const offered = new Map<string, true>();
    for (const day of days) for (const slot of day.slots) offered.set(slotIdentityKey(slot), true);
    const unknown = parsed.slots.find((s) => !offered.has(slotIdentityKey(s)));
    if (unknown) {
      return res.status(400).json({
        error: 'This slot is not available for the member in the current window',
        code: 'slot_not_available',
        slot: unknown,
      });
    }

    await replaceSelections(gymId, memberId, parsed.slots, current, gymMembershipId);

    const stored = await loadSelections(gymId, memberId);
    recordAudit(req, {
      action: 'update_recurring_slots',
      entityType: 'member',
      entityId: memberId,
      previous: { slots: current.map(slotIdentityKey) },
      next: { slots: stored.map(slotIdentityKey) },
    });
    res.json({ selections: describeSelections(stored, days) });
  } catch (err) { next(err); }
});

/**
 * Store the submitted set and remove the rest, in one transaction.
 *
 * Keeping the unchanged rows (rather than deleting everything and re-inserting)
 * is what makes `created_at` mean "since when has the Member had this slot",
 * which stage 4's job and any future audit of the pattern will want.
 */
async function replaceSelections(
  gymId: string,
  memberId: number,
  wanted: SlotIdentity[],
  current: StoredSelection[],
  gymMembershipId: number | null | undefined,
): Promise<void> {
  const wantedKeys = new Set(wanted.map(slotIdentityKey));
  const currentKeys = new Set(current.map(slotIdentityKey));
  const toDelete = current.filter((s) => !wantedKeys.has(slotIdentityKey(s))).map((s) => s.id);
  const toInsert = wanted.filter((s) => !currentKeys.has(slotIdentityKey(s)));
  if (toDelete.length === 0 && toInsert.length === 0) return;

  try {
    await db.transaction(async (tx: Tx) => {
      if (toDelete.length > 0) {
        await tx.query(
          `DELETE FROM member_recurring_slots
            WHERE gym_id = ? AND member_id = ? AND id IN (${toDelete.map(() => '?').join(',')})`,
          [gymId, memberId, ...toDelete],
        );
      }
      for (const s of toInsert) {
        await tx.query(
          `INSERT INTO member_recurring_slots
             (gym_id, member_id, iso_weekday, start_time, end_time, activity_type_id,
              professional_service_id, center_id, created_by_membership_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            gymId, memberId, s.weekday, `${s.start_time}:00`, `${s.end_time}:00`,
            s.activity_type_id, s.professional_service_id, s.center_id, gymMembershipId ?? null,
          ],
        );
      }
    });
  } catch (err) {
    // `mrs_selection_unique` firing means a concurrent request stored the very
    // row this one wanted, so the caller's intent already holds. The caller
    // re-reads the stored set either way, so it still reports the truth rather
    // than a 500. Anything else is a real failure.
    const e = err as { code?: string; errno?: number };
    if (e.code !== 'ER_DUP_ENTRY' && e.errno !== 1062) throw err;
  }
}

/** One occurrence's outcome in the Book report. */
interface BookingResult {
  date: string;
  calendar_event_id: number | null;
  outcome: 'booked' | 'skipped' | 'failed';
  /** Why it was skipped (a projection status) or why it failed (an error code). */
  reason?: string;
  booking_id?: number;
}

/**
 * Book the window for the Member's selected slots (§3).
 *
 * `slots` in the body is optional: sending it replaces the stored pattern
 * first (the grid's "tick boxes, press Book" flow is one request), omitting it
 * books whatever is already stored (the same entry point stage 4's nightly job
 * will use).
 *
 * Each occurrence goes through `bookMemberOnSession` in its own transaction,
 * so one rejected date cannot roll back the others and the report can say
 * exactly which ones landed — §3's "clearly handle/report any occurrences that
 * could not be booked". That call re-reads the occurrence `FOR UPDATE` and
 * re-runs every access hook, which is the revalidation §3 asks for: the plan
 * built from the projection is only a shortlist.
 *
 * A date that has filled up since the projection is *not* silently
 * waitlisted. `bookMemberOnSession` falls back to the waitlist when a session
 * is full and its waitlist is open, but §3 says not to create a booking for a
 * slot that has become unavailable — so a waitlisted result is rolled back
 * (by throwing out of the transaction) and reported as `full`. Staff can still
 * waitlist the Member deliberately through `POST /bookings`.
 */
memberPersonalTrainingSlotsRouter.post('/book', requireModuleWrite('MEMBERS'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const memberId = parseMemberId(req);
  if (memberId === null) return res.status(400).json({ error: 'memberId must be a positive integer' });

  const body = (req.body ?? {}) as { slots?: unknown };
  const parsed = body.slots === undefined ? null : parseSlotIdentities(body.slots);
  if (parsed && 'error' in parsed) return res.status(400).json({ error: parsed.error });

  try {
    if (!(await findMember(gymId, memberId))) return res.status(404).json({ error: 'Member not found' });

    let selections = await loadSelections(gymId, memberId);
    let projection = await loadProjection(gymId, memberId, selections);

    if (parsed) {
      const offered = new Set<string>();
      for (const day of projection.days) for (const slot of day.slots) offered.add(slotIdentityKey(slot));
      const unknown = parsed.slots.find((s) => !offered.has(slotIdentityKey(s)));
      if (unknown) {
        return res.status(400).json({
          error: 'This slot is not available for the member in the current window',
          code: 'slot_not_available',
          slot: unknown,
        });
      }
      await replaceSelections(gymId, memberId, parsed.slots, selections, gymMembershipId);
      selections = await loadSelections(gymId, memberId);
      // Re-project so `selected` and the plan reflect the set just stored.
      projection = await loadProjection(gymId, memberId, selections);
    }

    const plans = planSlotBookings(projection.days, selections);
    const slotReports = [];
    let created = 0;
    let skipped = 0;
    let failed = 0;

    for (const plan of plans) {
      const results: BookingResult[] = plan.skip.map((s) => ({
        date: s.date,
        calendar_event_id: s.calendar_event_id,
        outcome: 'skipped' as const,
        reason: s.reason,
      }));
      skipped += plan.skip.length;

      for (const occurrence of plan.book) {
        const result = await bookOccurrence(gymId, memberId, occurrence);
        if (result.outcome === 'booked') created += 1;
        else if (result.outcome === 'skipped') skipped += 1;
        else failed += 1;
        results.push(result);
      }

      results.sort((a, b) => a.date.localeCompare(b.date));
      slotReports.push({
        ...plan.selection,
        matched: plan.slot !== null,
        professional_service_name: plan.slot?.professional_service_name ?? null,
        activity_type_name: plan.slot?.activity_type_name ?? null,
        results,
      });
    }

    recordAudit(req, {
      action: 'book_recurring_slots',
      entityType: 'member',
      entityId: String(memberId),
      next: { created, skipped, failed, window: projection.window },
    });

    res.json({
      window: projection.window,
      created,
      skipped,
      failed,
      selections: describeSelections(selections, projection.days),
      slots: slotReports,
    });
  } catch (err) { next(err); }
});

/**
 * Put one occurrence through the booking path, translating its outcome into a
 * report line. Never throws: a failure on one date must not abort the rest.
 */
async function bookOccurrence(
  gymId: string,
  memberId: number,
  occurrence: { date: string; calendar_event_id: number },
): Promise<BookingResult> {
  try {
    const booking = await db.transaction(async (tx) => {
      const result = await bookMemberOnSession(
        gymId, memberId, occurrence.calendar_event_id, false, false, tx,
      );
      if (result.status !== 'booked') {
        // Rolls the waitlist row back — see the route comment above.
        throw Object.assign(new Error('Session filled up before it could be booked'), {
          code: 'full', rolledBack: true,
        });
      }
      return result;
    });
    return {
      date: occurrence.date,
      calendar_event_id: occurrence.calendar_event_id,
      outcome: 'booked',
      booking_id: booking.id,
    };
  } catch (err) {
    const e = err as { code?: string; errno?: number; message?: string; status?: number };
    // The unique index (migration 132) is the last line of defence against
    // §3's "do not create duplicate bookings": the projection already skips
    // dates the Member holds, so this only fires on a concurrent double-click.
    if (e.code === 'ER_DUP_ENTRY' || e.errno === 1062) {
      return {
        date: occurrence.date,
        calendar_event_id: occurrence.calendar_event_id,
        outcome: 'skipped',
        reason: 'already_booked',
      };
    }
    // A capacity or waitlist rejection is the slot going unavailable between
    // the projection and the INSERT — reported, not an error.
    if (e.code === 'full' || e.code === 'session_full_waitlist_not_open') {
      return {
        date: occurrence.date,
        calendar_event_id: occurrence.calendar_event_id,
        outcome: 'skipped',
        reason: 'full',
      };
    }
    // The occurrence was cancelled (400) or deleted (404) between the
    // projection and the booking — the same "silently ignore it" family as a
    // festivity, so it is a skip with the status the grid would now show.
    if (e.status === 400 || e.status === 404) {
      return {
        date: occurrence.date,
        calendar_event_id: occurrence.calendar_event_id,
        outcome: 'skipped',
        reason: e.status === 404 ? 'no_occurrence' : 'not_scheduled',
      };
    }
    return {
      date: occurrence.date,
      calendar_event_id: occurrence.calendar_event_id,
      outcome: 'failed',
      reason: e.code ?? e.message ?? 'booking_failed',
    };
  }
}
