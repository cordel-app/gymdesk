/**
 * #1367: Home dashboard — one read, tenant-scoped, for the four summary cards,
 * the six conditional tasks, Today's Classes and Latest Members.
 *
 * Nothing here writes and nothing re-decides a business rule: active members is
 * `latestEnrollmentStatusSql()` (#809), a failed payment is `isAwaitingAction()`
 * (#779), a professional-service balance is `resolveMemberProfessionalServices()`
 * (#1189). Each section is gated by the module its own management screen is
 * behind (`homeAccess()`), so Home never shows data a role cannot open.
 *
 * Mounted with auth + tenantContext only (any staff role may open Home); the
 * response simply omits what the caller may not read.
 */
import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext } from '../infra/tenantContext';
import { latestEnrollmentStatusSql } from '../domain/memberEnrollment';
import { isAwaitingAction, deriveBillingEventStatus } from '../domain/billingEventStatus';
import { resolveMemberProfessionalServices } from '../domain/memberProfessionalServices';
import {
  dayWindow, weekWindow, nowSql, todayInZone, parseDashboardDate, resolveTimeZone,
  homeAccess, visibleTasks, type HomeTask, type UtcWindow,
} from '../domain/homeDashboard';
import { DEFAULT_GYM_LOCALIZATION } from '../domain/gymLocalization';

export const homeDashboardRouter = Router();

const SAMPLE_LIMIT = 5;
/** Bound on members evaluated for task D: each needs a balance read. */
const SERVICE_TASK_MEMBER_CAP = 200;

const iso = (v: Date | string) => new Date(v).toISOString();

async function loadGymClock(gymId: string): Promise<{ zone: string; firstDay: number }> {
  const { rows } = await db.query<{ time_zone: string | null; first_day_of_week: number | null }>(
    'SELECT time_zone, first_day_of_week FROM gyms WHERE id = ?',
    [gymId],
  );
  return {
    zone: resolveTimeZone(rows[0]?.time_zone),
    firstDay: rows[0]?.first_day_of_week ?? DEFAULT_GYM_LOCALIZATION.first_day_of_week,
  };
}

async function countMembers(gymId: string, w: UtcWindow | null, activeOnly: boolean): Promise<number> {
  const params: any[] = [gymId];
  let createdClause = '';
  if (w) { createdClause = 'AND m.created_at >= ? AND m.created_at < ?'; params.push(w.from, w.to); }
  const { rows } = await db.query<{ c: number | string }>(
    `SELECT COUNT(*) AS c
       FROM members m
      WHERE m.gym_id = ? AND m.deleted_at IS NULL ${createdClause}
        ${activeOnly ? `AND ${latestEnrollmentStatusSql('m')} = 'active'` : ''}`,
    params,
  );
  return Number(rows[0].c);
}

/** Sessions (events with an Activity Type) of the gym that are still on the calendar. */
const LIVE_SESSION = `ce.gym_id = ? AND ce.deleted_at IS NULL AND ce.status <> 'cancelled'
                      AND ce.activity_type_id IS NOT NULL`;

async function loadPayments(gymId: string, day: UtcWindow) {
  const { rows } = await db.query<{
    event_type: string; latest_tx_status: string | null; amount: number | string | null; created_at: Date | string;
  }>(
    `SELECT e.event_type, e.latest_tx_status, e.amount, e.created_at
       FROM (
         SELECT be.event_type, be.amount, be.created_at,
                (SELECT pr.status FROM payment_requests pr
                  WHERE pr.billing_event_id = be.id
                  ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1) AS latest_tx_status
           FROM billing_events be
          WHERE be.gym_id = ?
            AND be.event_type NOT IN ('product_purchase', 'card_verification')
            AND be.is_scheduled = 0
            AND (be.event_type = 'failed_billing'
                 OR EXISTS (SELECT 1 FROM payment_requests pf
                             WHERE pf.billing_event_id = be.id AND pf.status IN ('failed', 'expired'))
                 OR (be.created_at >= ? AND be.created_at < ?))
       ) e`,
    [gymId, day.from, day.to],
  );
  let outstandingCount = 0;
  let outstandingAmount = 0;
  let paidOnDay = 0;
  for (const r of rows) {
    if (isAwaitingAction(r.event_type, r.latest_tx_status)) {
      outstandingCount += 1;
      outstandingAmount += Number(r.amount ?? 0);
    }
    const t = new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19);
    if (t >= day.from && t < day.to && deriveBillingEventStatus(r.event_type, r.latest_tx_status) === 'paid') {
      paidOnDay += 1;
    }
  }
  return { outstandingCount, outstandingAmount: Math.round(outstandingAmount * 100) / 100, paidOnDay };
}

/** Task D: members holding plan-included service sessions with none booked ahead. */
async function loadServicesNotScheduled(gymId: string): Promise<HomeTask> {
  const { rows: pairs } = await db.query<{ member_id: number; member_name: string; ps_id: number; ps_name: string }>(
    `SELECT DISTINCT mm.member_id, m.name AS member_name, ps.id AS ps_id, ps.name AS ps_name
       FROM user_memberships um
       JOIN user_membership_session umss ON umss.user_membership_id = um.id AND umss.gym_id = um.gym_id
       JOIN product_professional_services pps ON pps.product_id = umss.product_id AND pps.gym_id = um.gym_id
       JOIN professional_services ps ON ps.id = pps.professional_service_id AND ps.deleted_at IS NULL
       JOIN gym_professional_services gps
         ON gps.professional_service_id = ps.id AND gps.gym_id = um.gym_id AND gps.status = 'active'
       JOIN (SELECT id AS um_id, member_id FROM user_memberships
             UNION
             SELECT user_membership_id, member_id FROM user_membership_members) mm ON mm.um_id = um.id
       JOIN members m ON m.id = mm.member_id AND m.gym_id = um.gym_id AND m.deleted_at IS NULL
      WHERE um.gym_id = ? AND um.status = 'active'
        AND um.starts_at <= UTC_DATE() AND (um.ends_at IS NULL OR um.ends_at >= UTC_DATE())
      ORDER BY m.name ASC
      LIMIT ${SERVICE_TASK_MEMBER_CAP * 4}`,
    [gymId],
  );
  const memberIds = [...new Set(pairs.map((p) => Number(p.member_id)))].slice(0, SERVICE_TASK_MEMBER_CAP);
  const task: HomeTask = { key: 'services_not_scheduled', count: 0, samples: [] };
  if (memberIds.length === 0) return task;

  const { rows: future } = await db.query<{ member_id: number; professional_service_id: number }>(
    `SELECT DISTINCT ceb.member_id, ce.professional_service_id
       FROM calendar_event_bookings ceb
       JOIN calendar_events ce ON ce.id = ceb.calendar_event_id AND ce.gym_id = ceb.gym_id
      WHERE ceb.gym_id = ? AND ceb.status = 'booked' AND ceb.member_id IN (${memberIds.map(() => '?').join(',')})
        AND ce.deleted_at IS NULL AND ce.status <> 'cancelled'
        AND ce.starts_at > UTC_TIMESTAMP() AND ce.professional_service_id IS NOT NULL`,
    [gymId, ...memberIds],
  );
  const booked = new Set(future.map((f) => `${f.member_id}:${f.professional_service_id}`));

  const flagged = new Map<number, { name: string; service: string }>();
  for (const memberId of memberIds) {
    const balances = await resolveMemberProfessionalServices(gymId, memberId);
    const sessions = new Map(balances.map((b) => [Number(b.professional_service_id), Number(b.sessions)]));
    for (const p of pairs.filter((x) => Number(x.member_id) === memberId)) {
      if ((sessions.get(Number(p.ps_id)) ?? 0) > 0 && !booked.has(`${memberId}:${p.ps_id}`)) {
        if (!flagged.has(memberId)) flagged.set(memberId, { name: p.member_name, service: p.ps_name });
      }
    }
  }
  task.count = flagged.size;
  task.samples = [...flagged.entries()].slice(0, SAMPLE_LIMIT).map(([id, v]) => ({ id, name: v.name, detail: v.service }));
  return task;
}

/**
 * GET /dashboard/home?date=YYYY-MM-DD
 */
homeDashboardRouter.get('/home', async (req, res, next) => {
  const { gymId, role, isSuperadmin } = getTenantContext(req);
  try {
    const { zone, firstDay } = await loadGymClock(gymId);
    const today = todayInZone(zone);
    const requested = req.query.date === undefined ? today : parseDashboardDate(req.query.date);
    if (!requested) return res.status(400).json({ error: 'date must be a valid YYYY-MM-DD' });
    const date = requested;
    const day = dayWindow(date, zone);
    const week = weekWindow(today, zone, firstDay);
    const now = nowSql();
    const access = homeAccess(role, isSuperadmin);

    const out: Record<string, unknown> = { date, today, time_zone: zone, access };
    const tasks: HomeTask[] = [];
    const cards: Record<string, unknown> = {};

    if (access.members) {
      const [active, joinedThisWeek, newOnDay] = await Promise.all([
        countMembers(gymId, null, true),
        // The only reliably historical figure: members who joined this week and are active now.
        countMembers(gymId, week, true),
        countMembers(gymId, day, false),
      ]);
      cards.active_members = { count: active, joined_this_week: joinedThisWeek };
      cards.new_members = { count: newOnDay };

      const { rows: welcome } = await db.query<{ id: number; name: string }>(
        `SELECT m.id, m.name FROM members m
          WHERE m.gym_id = ? AND m.deleted_at IS NULL AND m.welcomed_at IS NULL
          ORDER BY m.created_at DESC, m.id DESC`,
        [gymId],
      );
      tasks.push({
        key: 'welcome_new_members',
        count: welcome.length,
        samples: welcome.slice(0, SAMPLE_LIMIT).map((r) => ({ id: Number(r.id), name: r.name })),
      });
      tasks.push(await loadServicesNotScheduled(gymId));

      const { rows: latest } = await db.query<any>(
        `SELECT m.id, m.name, m.image_url, m.created_at,
                (SELECT mp.name FROM user_memberships um
                   JOIN membership_plans mp ON mp.id = um.membership_plan_id
                  WHERE um.member_id = m.id AND um.gym_id = m.gym_id
                    AND um.status NOT IN ('draft', 'pending_payment', 'cancelled')
                  ORDER BY um.created_at DESC, um.id DESC LIMIT 1) AS plan_name
           FROM members m
          WHERE m.gym_id = ? AND m.deleted_at IS NULL
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 5`,
        [gymId],
      );
      out.latest_members = latest.map((r: any) => ({
        id: Number(r.id), name: r.name, image_url: r.image_url ?? null,
        created_at: iso(r.created_at), plan_name: r.plan_name ?? null,
      }));
    }

    if (access.classes) {
      const { rows: classes } = await db.query<any>(
        `SELECT ce.id, ce.starts_at, at.name AS name,
                COALESCE(ce.capacity, at.max_capacity) AS capacity,
                (SELECT COUNT(*) FROM calendar_event_bookings b WHERE b.calendar_event_id = ce.id AND b.status = 'booked') AS booked_count,
                (SELECT COUNT(*) FROM calendar_event_bookings b WHERE b.calendar_event_id = ce.id AND b.status = 'waitlisted') AS waitlist_count
           FROM calendar_events ce
           JOIN activity_types at ON at.id = ce.activity_type_id
          WHERE ${LIVE_SESSION} AND ce.starts_at >= ? AND ce.starts_at < ?
          ORDER BY ce.starts_at ASC, ce.id ASC`,
        [gymId, day.from, day.to],
      );
      const list = classes.map((c: any) => ({
        id: Number(c.id), name: c.name, starts_at: iso(c.starts_at),
        capacity: c.capacity == null ? null : Number(c.capacity),
        booked_count: Number(c.booked_count), waitlist_count: Number(c.waitlist_count),
      }));
      out.classes = list;
      cards.classes_today = {
        count: list.length,
        waitlist_total: list.reduce((n: number, c: any) => n + c.waitlist_count, 0),
      };

      const weekParams = [gymId, now, week.from, week.to];
      const weekScope = `${LIVE_SESSION} AND ce.ends_at > ? AND ce.starts_at >= ? AND ce.starts_at < ?`;
      const [{ rows: noSpace }, { rows: noTrainer }, { rows: waitEvents }] = await Promise.all([
        db.query<{ c: number | string }>(`SELECT COUNT(*) AS c FROM calendar_events ce WHERE ${weekScope} AND ce.space_id IS NULL`, [gymId, now, week.from, week.to]),
        db.query<{ c: number | string }>(`SELECT COUNT(*) AS c FROM calendar_events ce WHERE ${weekScope} AND ce.trainer_membership_id IS NULL`, weekParams),
        db.query<{ events: number | string; people: number | string | null }>(
          `SELECT COUNT(*) AS events, SUM(w.n) AS people
             FROM calendar_events ce
             JOIN (SELECT calendar_event_id, COUNT(*) AS n FROM calendar_event_bookings
                    WHERE gym_id = ? AND status = 'waitlisted' GROUP BY calendar_event_id) w
               ON w.calendar_event_id = ce.id
            WHERE ${LIVE_SESSION} AND ce.starts_at > ?`,
          [gymId, gymId, now],
        ),
      ]);
      tasks.push({ key: 'events_without_space', count: Number(noSpace[0].c) });
      tasks.push({ key: 'events_without_trainer', count: Number(noTrainer[0].c) });
      tasks.push({ key: 'events_with_waitlist', count: Number(waitEvents[0].events), secondary: Number(waitEvents[0].people ?? 0) });
    }

    if (access.payments) {
      const p = await loadPayments(gymId, day);
      cards.outstanding_payments = { count: p.outstandingCount, amount: p.outstandingAmount, paid_count: p.paidOnDay, currency: 'EUR' };
      tasks.push({ key: 'payments_with_issues', count: p.outstandingCount });
    }

    out.cards = cards;
    out.tasks = visibleTasks(tasks);
    res.json(out);
  } catch (err) {
    next(err);
  }
});
