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
import { RUNNING_ASSIGNMENT_STATUSES_SQL } from '../domain/assignmentStatus';
import { themeHomeImageUrl } from '../domain/themeHomeImage';
import { effectiveImageUrlSql } from '../domain/effectiveExerciseImage';
import { isCurrentAssignmentSnapshotSql } from '../domain/planAssignments';
import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext } from '../infra/tenantContext';
import { latestEnrollmentStatusSql } from '../domain/memberEnrollment';
import { isAwaitingAction, deriveBillingEventStatus } from '../domain/billingEventStatus';
import { resolveMemberProfessionalServices } from '../domain/memberProfessionalServices';
import {
  dayWindow, weekWindow, nowSql, todayInZone, resolveTimeZone, completedWeekWindows,
  attendanceKpis, FOUR_WEEKS, homeAccess, visibleTasks, groupPendingPaymentMembers, PENDING_PAYMENT_MEMBER_LIMIT,
  unpaidMandatoryStatus, UNPAID_MANDATORY_PRODUCT_LIMIT, type UnpaidMandatoryStatus,
  type HomeTask, type OutstandingEventRow, type UtcWindow,
} from '../domain/homeDashboard';
import { memberPaymentStatusSql } from '../domain/memberPaymentStatus';
import { PAYMENT_PROBLEM_STATUSES } from '../domain/memberAccessRights';
import { DEFAULT_GYM_LOCALIZATION } from '../domain/gymLocalization';
import { loadServiceCapacityViews } from './service-capacity';
import { incompleteServiceRows, type IncompleteServiceRow } from '../domain/incompleteClasses';

export const homeDashboardRouter = Router();

const SAMPLE_LIMIT = 5;
/** Bound on members evaluated for task D: each needs a balance read. */
const SERVICE_TASK_MEMBER_CAP = 200;

/**
 * The names of the plans a Member (`m`) owns that are running or paused, newest assignment first.
 * #2125 M6b-8: an assignment is its current plan snapshot, and `assignment_id` (the id of its first
 * snapshot) orders assignments by when they were created.
 */
const MEMBER_PLAN_NAMES_SQL = `(SELECT GROUP_CONCAT(mp.name ORDER BY pa.assignment_id DESC SEPARATOR ', ')
          FROM plan_snapshots pa
          JOIN membership_plans mp ON mp.id = pa.membership_plan_id
         WHERE pa.member_id = m.id AND pa.gym_id = m.gym_id
           AND pa.status NOT IN ('in_cart', 'pending_payment', 'active_cancel_at_period_end', 'to_be_reactivated', 'cancelled', 'superseded')
           AND ${isCurrentAssignmentSnapshotSql('pa')})`;

/**
 * #2171: the gym's exercise of the day for the welcome banner. Candidates are
 * the gym's own active exercises that have an effective image: their own
 * master, else their primary muscle's image (#2171 follow-up; never a goal
 * image), ordered by id; the gym-local day number picks
 * one, so it changes every day, is the same for every load and viewer of that
 * day, and needs no stored state or per-request randomness.
 */
export function welcomeExerciseIndex(count: number, zone: string, now: Date = new Date()): number {
  if (count <= 0) return 0;
  const ymd = now.toLocaleDateString('en-CA', { timeZone: zone }); // YYYY-MM-DD
  const [y, m, d] = ymd.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000) % count;
}

async function loadWelcomeImage(gymId: string, zone: string): Promise<{ id: number; url: string } | null> {
  const { rows } = await db.query<{ id: number; url: string }>(
    `SELECT x.id, x.url FROM (
       SELECT e.id, ${effectiveImageUrlSql('e')} AS url
         FROM exercises e
        WHERE e.gym_id = ? AND e.status = 'active'
     ) x
      WHERE x.url IS NOT NULL
      ORDER BY x.id`,
    [gymId],
  );
  if (!rows.length) return null;
  const r = rows[welcomeExerciseIndex(rows.length, zone)];
  return { id: Number(r.id), url: r.url };
}

/** #2287: the gym's active Theme's Home Image, if it has one (else the exercise fallback). */
async function loadThemeHomeImage(gymId: string): Promise<string | null> {
  const { rows } = await db.query<any>(
    `SELECT t.home_image_object_key, t.modified_at
       FROM gyms g JOIN themes t ON t.id = g.theme_id
      WHERE g.id = ? AND t.deleted_at IS NULL`,
    [gymId],
  );
  return rows[0] ? themeHomeImageUrl(rows[0]) : null;
}

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
    member_id: number | string | null;
  }>(
    `SELECT e.event_type, e.latest_tx_status, e.amount, e.created_at, e.member_id
       FROM (
         SELECT be.event_type, be.amount, be.created_at, be.member_id,
                (SELECT pr.status FROM payment_requests pr
                  WHERE pr.billing_event_id = be.id
                  ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1) AS latest_tx_status
           FROM billing_events be
          WHERE be.gym_id = ?
            AND be.event_type NOT IN ('product_purchase', 'card_verification')
            AND be.is_scheduled = 0
            AND be.cancelled_at IS NULL
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
  const outstanding: OutstandingEventRow[] = [];
  for (const r of rows) {
    if (isAwaitingAction(r.event_type, r.latest_tx_status)) {
      outstanding.push(r);
      outstandingCount += 1;
      outstandingAmount += Number(r.amount ?? 0);
    }
    const t = new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19);
    if (t >= day.from && t < day.to && deriveBillingEventStatus(r.event_type, r.latest_tx_status) === 'paid') {
      paidOnDay += 1;
    }
  }
  return { outstandingCount, outstandingAmount: Math.round(outstandingAmount * 100) / 100, paidOnDay, outstanding };
}

/**
 * #1466: members with something outstanding, one row each. Eligibility is the
 * same `isAwaitingAction()` set the Outstanding payments card counts; the
 * status shown is the member's own aggregated Payment Status (#1235).
 */
async function loadPendingPaymentMembers(gymId: string, outstanding: OutstandingEventRow[]) {
  const all = groupPendingPaymentMembers(outstanding);
  if (all.length === 0) return { count: 0, members: [] as unknown[] };
  // A soft-deleted member is gone from every screen, so is not counted either.
  const { rows: live } = await db.query<{ id: number }>(
    `SELECT id FROM members WHERE gym_id = ? AND deleted_at IS NULL AND id IN (${all.map(() => '?').join(',')})`,
    [gymId, ...all.map((g) => g.member_id)],
  );
  const liveIds = new Set(live.map((r) => Number(r.id)));
  const groups = all.filter((g) => liveIds.has(g.member_id));
  const top = groups.slice(0, PENDING_PAYMENT_MEMBER_LIMIT);
  if (top.length === 0) return { count: 0, members: [] as unknown[] };
  const { rows } = await db.query<any>(
    `SELECT m.id, m.name,
            ${memberPaymentStatusSql('m')} AS payment_status,
            ${MEMBER_PLAN_NAMES_SQL} AS plan_name
       FROM members m
      WHERE m.gym_id = ? AND m.deleted_at IS NULL AND m.id IN (${top.map(() => '?').join(',')})`,
    [gymId, ...top.map((g) => g.member_id)],
  );
  const byId = new Map(rows.map((r: any) => [Number(r.id), r]));
  const members = top
    .filter((g) => byId.has(g.member_id))
    .map((g) => {
      const r: any = byId.get(g.member_id);
      return {
        member_id: g.member_id, name: r.name, outstanding_amount: g.outstanding_amount,
        plan_name: r.plan_name ?? null, payment_status: r.payment_status ?? 'failed',
      };
    });
  return { count: groups.length, members };
}

/**
 * #3186: "Members without mandatory product" — a Member whose running Membership
 * Plan carries a Mandatory recurring Product (a `plan_periodical_snapshots` line
 * of the assignment's current plan snapshot with `mandatory = 1`, #1184) whose
 * required payment is not made. Read only from what billing already persisted:
 * a Billing Event of a Product Set that links the assignment, with a priced line
 * for that Product, judged by `unpaidMandatoryStatus()`. Nothing is inferred
 * from the Product definition, and nothing is written.
 *
 * Who is listed: the line's own member for an Individual line split per member
 * (#2609), else the plan's beneficiaries, else the owner. One row per Member,
 * Product and Membership Plan, carrying the status of the most recent unpaid
 * event; ordered by the oldest unpaid due date (most overdue first).
 */
async function loadUnpaidMandatoryProducts(gymId: string) {
  const { rows } = await db.query<any>(
    `SELECT pa.id AS snapshot_id, pa.assignment_id, pa.member_id AS owner_id,
            pa.membership_plan_id, mp.name AS plan_name,
            pps.product_id, pps.item_name AS product_name, pps.assigned_member_id,
            be.id AS event_id, be.event_type, be.is_scheduled, be.billing_date, be.created_at,
            (be.cancelled_at IS NOT NULL) AS cancelled,
            (SELECT pr.status FROM payment_requests pr
              WHERE pr.billing_event_id = be.id
              ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1) AS latest_tx_status
       FROM plan_snapshots pa
       JOIN membership_plans mp ON mp.id = pa.membership_plan_id
       JOIN plan_periodical_snapshots pps ON pps.plan_snapshot_id = pa.id AND pps.mandatory = 1
       JOIN billing_events be ON be.gym_id = pa.gym_id AND be.cancelled_at IS NULL
        AND (be.is_scheduled = 0 OR be.billing_date <= UTC_DATE())
        AND EXISTS (SELECT 1 FROM product_set_plan_snapshots bj
                      JOIN plan_snapshots bs ON bs.id = bj.plan_snapshot_id
                     WHERE bj.product_set_id = be.product_set_id AND bs.assignment_id = pa.assignment_id)
       JOIN billing_event_lines bel ON bel.billing_event_id = be.id
        AND bel.product_id = pps.product_id AND bel.amount > 0
      WHERE pa.gym_id = ?
        AND pa.status IN (${RUNNING_ASSIGNMENT_STATUSES_SQL}, 'paused')
        AND ${isCurrentAssignmentSnapshotSql('pa')}
      GROUP BY pa.id, pps.id, be.id`,
    [gymId],
  );
  const today = new Date().toISOString().slice(0, 10);
  type Item = {
    snapshot_id: number; owner_id: number; assigned_member_id: number | null;
    membership_plan_id: number; plan_name: string; product_id: number; product_name: string;
    status: UnpaidMandatoryStatus; latest_key: string; oldest_due: string;
  };
  const items = new Map<string, Item>();
  for (const r of rows) {
    const status = unpaidMandatoryStatus({
      event_type: r.event_type, latest_tx_status: r.latest_tx_status ?? null,
      is_scheduled: r.is_scheduled, billing_date: r.billing_date, cancelled: Number(r.cancelled) === 1,
    }, today);
    if (!status) continue;
    const due = (r.billing_date ?? r.created_at) as Date | string;
    const dueKey = (due instanceof Date ? due.toISOString() : String(due)).slice(0, 10);
    const latestKey = `${dueKey}:${String(r.event_id).padStart(12, '0')}`;
    const key = `${r.snapshot_id}:${r.product_id}:${r.assigned_member_id ?? ''}`;
    const cur = items.get(key);
    if (!cur) {
      items.set(key, {
        snapshot_id: Number(r.snapshot_id), owner_id: Number(r.owner_id),
        assigned_member_id: r.assigned_member_id == null ? null : Number(r.assigned_member_id),
        membership_plan_id: Number(r.membership_plan_id), plan_name: r.plan_name,
        product_id: Number(r.product_id), product_name: r.product_name,
        status, latest_key: latestKey, oldest_due: dueKey,
      });
    } else {
      if (latestKey > cur.latest_key) { cur.latest_key = latestKey; cur.status = status; }
      if (dueKey < cur.oldest_due) cur.oldest_due = dueKey;
    }
  }
  if (items.size === 0) return { count: 0, items: [] as unknown[] };

  const snapshotIds = [...new Set([...items.values()].map((i) => i.snapshot_id))];
  const { rows: bens } = await db.query<{ plan_snapshot_id: number; member_id: number }>(
    `SELECT plan_snapshot_id, member_id FROM plan_snapshot_beneficiaries
      WHERE gym_id = ? AND plan_snapshot_id IN (${snapshotIds.map(() => '?').join(',')})
      ORDER BY member_id`,
    [gymId, ...snapshotIds],
  );
  const bensBySnapshot = new Map<number, number[]>();
  for (const b of bens) {
    const arr = bensBySnapshot.get(Number(b.plan_snapshot_id)) ?? [];
    arr.push(Number(b.member_id));
    bensBySnapshot.set(Number(b.plan_snapshot_id), arr);
  }
  const expanded: Array<Item & { member_id: number }> = [];
  const seen = new Set<string>();
  for (const i of items.values()) {
    const members = i.assigned_member_id != null ? [i.assigned_member_id]
      : (bensBySnapshot.get(i.snapshot_id) ?? [i.owner_id]);
    for (const memberId of members) {
      const k = `${memberId}:${i.product_id}:${i.membership_plan_id}:${i.snapshot_id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      expanded.push({ ...i, member_id: memberId });
    }
  }
  const memberIds = [...new Set(expanded.map((e) => e.member_id))];
  // A soft-deleted member is gone from every screen, so is not listed either.
  const { rows: live } = await db.query<{ id: number; name: string }>(
    `SELECT id, name FROM members
      WHERE gym_id = ? AND deleted_at IS NULL AND id IN (${memberIds.map(() => '?').join(',')})`,
    [gymId, ...memberIds],
  );
  const names = new Map(live.map((m) => [Number(m.id), m.name]));
  const listed = expanded
    .filter((e) => names.has(e.member_id))
    .sort((a, b) => a.oldest_due.localeCompare(b.oldest_due)
      || String(names.get(a.member_id)).localeCompare(String(names.get(b.member_id)))
      || a.product_id - b.product_id);
  return {
    count: listed.length,
    items: listed.slice(0, UNPAID_MANDATORY_PRODUCT_LIMIT).map((e) => ({
      member_id: e.member_id, name: names.get(e.member_id) as string,
      product_id: e.product_id, product_name: e.product_name,
      membership_plan_id: e.membership_plan_id, plan_name: e.plan_name,
      payment_status: e.status,
    })),
  };
}

/** Task D: members holding plan-included service sessions with none booked ahead. */
async function loadServicesNotScheduled(gymId: string): Promise<HomeTask> {
  const { rows: pairs } = await db.query<{ member_id: number; member_name: string; ps_id: number; ps_name: string }>(
    // #2125 M6b-5: the assignment is its current plan snapshot, whose session lines are the ones the
    // wallet grants from; its members are the owner and that snapshot's beneficiaries.
    `SELECT DISTINCT m.id AS member_id, m.name AS member_name, ps.id AS ps_id, ps.name AS ps_name
       FROM plan_snapshots pa
       JOIN plan_session_snapshots umss ON umss.plan_snapshot_id = pa.id AND umss.gym_id = pa.gym_id
       JOIN product_professional_services pps ON pps.product_id = umss.product_id AND pps.gym_id = pa.gym_id
       JOIN professional_services ps ON ps.id = pps.professional_service_id AND ps.deleted_at IS NULL
       JOIN gym_professional_services gps
         ON gps.professional_service_id = ps.id AND gps.gym_id = pa.gym_id AND gps.status = 'active'
       JOIN members m ON m.gym_id = pa.gym_id AND m.deleted_at IS NULL
        AND (m.id = pa.member_id OR EXISTS (
              SELECT 1 FROM plan_snapshot_beneficiaries pab
               WHERE pab.plan_snapshot_id = pa.id AND pab.gym_id = pa.gym_id AND pab.member_id = m.id))
      WHERE pa.gym_id = ? AND pa.status IN (${RUNNING_ASSIGNMENT_STATUSES_SQL}) AND ${isCurrentAssignmentSnapshotSql('pa')}
        AND pa.starts_at <= UTC_DATE() AND (pa.ends_at IS NULL OR pa.ends_at >= UTC_DATE())
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

/** Upcoming events inspected for incomplete services; bounds the per-service reads. */
const INCOMPLETE_EVENT_SCAN_LIMIT = 200;
const INCOMPLETE_LIST_LIMIT = 20;

/**
 * #1984 stage 3: upcoming sessions where a Professional Service has at least one
 * booking but not all its places. Derived on read from the per-service capacity
 * (`loadServiceCapacityViews()`), so it is never stored and cannot disagree with
 * the Calendar. Cancelled, past and full services are excluded.
 */
async function loadIncompleteClasses(gymId: string, now: string): Promise<{ count: number; items: IncompleteServiceRow[] }> {
  const { rows: events } = await db.query<any>(
    `SELECT ce.id, ce.starts_at, at.name AS name
       FROM calendar_events ce
       JOIN activity_types at ON at.id = ce.activity_type_id
      WHERE ${LIVE_SESSION} AND ce.starts_at > ?
        AND EXISTS (SELECT 1 FROM calendar_event_bookings eb
                     WHERE eb.calendar_event_id = ce.id AND eb.status = 'booked' AND eb.professional_service_id IS NOT NULL)
      ORDER BY ce.starts_at ASC, ce.id ASC
      LIMIT ${INCOMPLETE_EVENT_SCAN_LIMIT}`,
    [gymId, now],
  );
  if (events.length === 0) return { count: 0, items: [] };
  const ids = events.map((e: any) => Number(e.id));
  const views = await loadServiceCapacityViews(db, gymId, ids);
  const { rows: people } = await db.query<any>(
    `SELECT ceb.calendar_event_id AS event_id, ceb.professional_service_id AS service_id, m.name
       FROM calendar_event_bookings ceb
       JOIN members m ON m.id = ceb.member_id AND m.gym_id = ceb.gym_id
      WHERE ceb.gym_id = ? AND ceb.status = 'booked' AND ceb.professional_service_id IS NOT NULL
        AND ceb.calendar_event_id IN (${ids.map(() => '?').join(',')})
      ORDER BY ceb.booked_at ASC, ceb.id ASC`,
    [gymId, ...ids],
  );
  const all = incompleteServiceRows(
    events.map((e: any) => ({ id: Number(e.id), name: e.name, starts_at: iso(e.starts_at) })),
    views,
    people.map((p: any) => ({ event_id: Number(p.event_id), service_id: Number(p.service_id), name: p.name })),
  );
  return { count: all.length, items: all.slice(0, INCOMPLETE_LIST_LIMIT) };
}

/**
 * Top Trainers and the weekly average (#1754): actual attendance only
 * (`attendance_status = 'present'` on a still-booked row of a live session),
 * over the last four complete gym-local weeks. Both are over the same set of
 * members — the active ones — so the numerator and denominator agree.
 */
async function loadAttendanceKpis(gymId: string, today: string, zone: string, activeMembers: number) {
  const weeks = completedWeekWindows(today, zone, FOUR_WEEKS);
  const { rows } = await db.query<{ member_id: number; starts_at: Date | string }>(
    `SELECT ceb.member_id, ce.starts_at
       FROM calendar_event_bookings ceb
       JOIN calendar_events ce ON ce.id = ceb.calendar_event_id AND ce.gym_id = ceb.gym_id
       JOIN members m ON m.id = ceb.member_id AND m.gym_id = ceb.gym_id
      WHERE ceb.gym_id = ? AND ceb.status = 'booked' AND ceb.attendance_status = 'present'
        AND ce.deleted_at IS NULL AND ce.status <> 'cancelled' AND ce.activity_type_id IS NOT NULL
        AND ce.starts_at >= ? AND ce.starts_at < ?
        AND m.deleted_at IS NULL AND ${latestEnrollmentStatusSql('m')} = 'active'`,
    [gymId, weeks[0].from, weeks[weeks.length - 1].to],
  );
  return attendanceKpis(
    rows.map((r) => ({ member_id: Number(r.member_id), at: new Date(r.starts_at).toISOString().replace('T', ' ').slice(0, 19) })),
    weeks,
    activeMembers,
  );
}

/**
 * GET /dashboard/home — always today (#1754: no date navigation).
 */
homeDashboardRouter.get('/home', async (req, res, next) => {
  const { gymId, role, isSuperadmin } = getTenantContext(req);
  try {
    const { zone, firstDay } = await loadGymClock(gymId);
    const today = todayInZone(zone);
    const date = today;
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
      cards.attendance = await loadAttendanceKpis(gymId, today, zone, active);

      const { rows: welcome } = await db.query<{ id: number; name: string; image_url: string | null; image_thumbnail_url: string | null }>(
        `SELECT m.id, m.name, m.image_url, m.image_thumbnail_url FROM members m
          WHERE m.gym_id = ? AND m.deleted_at IS NULL AND m.welcomed_at IS NULL
          ORDER BY m.created_at DESC, m.id DESC`,
        [gymId],
      );
      tasks.push({
        key: 'welcome_new_members',
        count: welcome.length,
        samples: welcome.slice(0, SAMPLE_LIMIT).map((r) => ({
          id: Number(r.id), name: r.name, image_url: r.image_url ?? null, image_thumbnail_url: r.image_thumbnail_url ?? null,
        })),
      });
      // #3104: Access = To be Reviewed is derived (a stored `granted` with a failed/expired
      // Payment Status), so the task counts with the very predicate deriveAccessRights() applies.
      const { rows: review } = await db.query<{ id: number; name: string; image_url: string | null; image_thumbnail_url: string | null }>(
        `SELECT t.id, t.name, t.image_url, t.image_thumbnail_url FROM (
           SELECT m.id, m.name, m.image_url, m.image_thumbnail_url, m.created_at,
                  ${memberPaymentStatusSql('m')} AS payment_status
             FROM members m
            WHERE m.gym_id = ? AND m.deleted_at IS NULL AND m.access_rights = 'granted'
         ) t
         WHERE t.payment_status IN (${PAYMENT_PROBLEM_STATUSES.map((s) => `'${s}'`).join(', ')})
         ORDER BY t.created_at DESC, t.id DESC`,
        [gymId],
      );
      tasks.push({
        key: 'access_to_review',
        count: review.length,
        samples: review.slice(0, SAMPLE_LIMIT).map((r) => ({
          id: Number(r.id), name: r.name, image_url: r.image_url ?? null, image_thumbnail_url: r.image_thumbnail_url ?? null,
        })),
      });
      tasks.push(await loadServicesNotScheduled(gymId));

      const { rows: latest } = await db.query<any>(
        `SELECT m.id, m.name, m.image_url, m.created_at,
                ${MEMBER_PLAN_NAMES_SQL} AS plan_name
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
        `SELECT ce.id, ce.starts_at, ce.ends_at, ce.status, at.name AS name,
                gmt.name AS trainer_name, sp.name AS space_name, ps.name AS service_name, ce.professional_service_id AS service_id, cn.name AS center_name,
                COALESCE(ce.capacity, at.max_capacity) AS capacity,
                (SELECT COUNT(*) FROM calendar_event_bookings b WHERE b.calendar_event_id = ce.id AND b.status = 'booked') AS booked_count,
                (SELECT COUNT(*) FROM calendar_event_bookings b WHERE b.calendar_event_id = ce.id AND b.status = 'waitlisted') AS waitlist_count
           FROM calendar_events ce
           JOIN activity_types at ON at.id = ce.activity_type_id
           LEFT JOIN gym_memberships gmt ON gmt.id = ce.trainer_membership_id
           LEFT JOIN spaces sp ON sp.id = ce.space_id
           LEFT JOIN professional_services ps ON ps.id = ce.professional_service_id
           LEFT JOIN centers cn ON cn.id = ce.center_id
          WHERE ${LIVE_SESSION} AND ce.starts_at >= ? AND ce.starts_at < ?
            AND EXISTS (SELECT 1 FROM calendar_event_bookings eb
                         WHERE eb.calendar_event_id = ce.id AND eb.status = 'booked')
          ORDER BY ce.starts_at ASC, ce.id ASC`,
        [gymId, day.from, day.to],
      );
      // #3096: who is booked (read-only), each with the day they last attended.
      const ids = classes.map((c: any) => Number(c.id));
      const attendeesByEvent = new Map<number, any[]>();
      if (ids.length > 0) {
        const ph = ids.map(() => '?').join(',');
        const { rows: att } = await db.query<any>(
          `SELECT b.calendar_event_id AS event_id, m.id AS member_id, m.name,
                  COALESCE(m.image_thumbnail_url, m.image_url) AS image_url,
                  (SELECT MAX(pe.starts_at)
                     FROM calendar_event_bookings pb
                     JOIN calendar_events pe ON pe.id = pb.calendar_event_id
                    WHERE pb.member_id = m.id AND pb.gym_id = b.gym_id AND pb.status = 'booked'
                      AND pb.attendance_status <> 'absent' AND pe.starts_at < ?
                      AND pe.id <> b.calendar_event_id) AS last_attended
             FROM calendar_event_bookings b
             JOIN members m ON m.id = b.member_id
            WHERE b.gym_id = ? AND b.status = 'booked' AND b.calendar_event_id IN (${ph})
            ORDER BY m.name ASC`,
          [now, gymId, ...ids],
        );
        for (const r of att) {
          const arr = attendeesByEvent.get(Number(r.event_id)) ?? [];
          arr.push({ member_id: Number(r.member_id), name: r.name, image_url: r.image_url ?? null, last_attended: r.last_attended ? iso(r.last_attended) : null });
          attendeesByEvent.set(Number(r.event_id), arr);
        }
      }
      const list = classes.map((c: any) => ({
        id: Number(c.id), name: c.name, starts_at: iso(c.starts_at), ends_at: iso(c.ends_at), status: c.status,
        trainer_name: c.trainer_name ?? null, space_name: c.space_name ?? null,
        service_name: c.service_name ?? null, center_name: c.center_name ?? null, has_service: c.service_id != null,
        attendees: attendeesByEvent.get(Number(c.id)) ?? [],
        capacity: c.capacity == null ? null : Number(c.capacity),
        booked_count: Number(c.booked_count), waitlist_count: Number(c.waitlist_count),
      }));
      out.classes = list;
      const { rows: totalRows } = await db.query<{ c: number | string }>(
        `SELECT COUNT(*) AS c FROM calendar_events ce
          WHERE ${LIVE_SESSION} AND ce.starts_at >= ? AND ce.starts_at < ?`,
        [gymId, day.from, day.to],
      );
      cards.classes_today = {
        count: list.length,
        total: Number(totalRows[0]?.c ?? 0),
        waitlist_total: list.reduce((n: number, c: any) => n + c.waitlist_count, 0),
      };

      out.incomplete_classes = await loadIncompleteClasses(gymId, now);

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
      out.pending_payment_members = await loadPendingPaymentMembers(gymId, p.outstanding);
      out.unpaid_mandatory_products = await loadUnpaidMandatoryProducts(gymId);
    }

    const themeImage = await loadThemeHomeImage(gymId);
    const welcomeImage = themeImage ? null : await loadWelcomeImage(gymId, (await loadGymClock(gymId)).zone);
    out.welcome_image_url = themeImage ?? welcomeImage?.url ?? null;
    out.welcome_exercise_id = welcomeImage?.id ?? null;

    out.cards = cards;
    out.tasks = visibleTasks(tasks);
    res.json(out);
  } catch (err) {
    next(err);
  }
});
