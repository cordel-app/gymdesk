import { DateTime } from 'luxon';
import { db } from '../infra/db';
import { bookMemberOnSession } from '../api/bookings';

export interface ScheduleRule {
  id: number;
  gym_id: string;
  activity_type_id: number;
  type: 'one_off' | 'weekly' | 'monthly';
  start_date: string; // YYYY-MM-DD
  end_date: string | null;
  weekday: number | null; // 0=Sun … 6=Sat — used by monthly rules
  weekdays: number[] | null; // used by weekly rules (multi-day support)
  ordinal: 'first' | 'second' | 'third' | 'fourth' | 'fifth' | 'last' | null;
  start_time: string; // HH:MM or HH:MM:SS
  end_time: string;
}

/** #482: the subset of a rule's fields that determine its availability window — used to
 * check whether an already-booked occurrence still fits a rule *before* it's saved. */
export interface RuleWindowConfig {
  type: 'one_off' | 'weekly' | 'monthly';
  start_date: string;
  end_date: string | null;
  weekday: number | null;
  weekdays: number[] | null;
  ordinal: 'first' | 'second' | 'third' | 'fourth' | 'fifth' | 'last' | null;
  start_time: string; // HH:MM
  end_time: string; // HH:MM
}

const ORDINAL_MAP: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
};

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): DateTime | null {
  // month is 1-indexed; weekday: 0=Sun…6=Sat (JS convention)
  // Luxon weekday: 1=Mon…7=Sun
  const luxonWd = weekday === 0 ? 7 : weekday;
  let d = DateTime.utc(year, month, 1);
  // Find the first occurrence of luxonWd in this month
  const diff = (luxonWd - d.weekday + 7) % 7;
  d = d.plus({ days: diff });
  // Advance to nth occurrence
  d = d.plus({ weeks: n - 1 });
  if (d.month !== month) return null; // overshot
  return d;
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): DateTime {
  const luxonWd = weekday === 0 ? 7 : weekday;
  const lastDay = DateTime.utc(year, month, 1).endOf('month').startOf('day');
  const diff = (lastDay.weekday - luxonWd + 7) % 7;
  return lastDay.minus({ days: diff });
}

function occurrenceDatesForRule(rule: ScheduleRule): Array<{ date: string }> {
  const startDate = DateTime.fromISO(rule.start_date, { zone: 'utc' });
  const today = DateTime.utc().startOf('day');
  const from = startDate > today ? startDate : today;

  if (rule.type === 'one_off') {
    // start_date is the occurrence date; only include if it's today or future
    if (startDate >= today) return [{ date: rule.start_date }];
    return [];
  }

  if (!rule.end_date) return [];
  const endDate = DateTime.fromISO(rule.end_date, { zone: 'utc' });
  const dates: Array<{ date: string }> = [];

  if (rule.type === 'weekly') {
    if (!rule.weekdays || rule.weekdays.length === 0) return [];
    // Collect occurrences for each selected weekday, then merge + sort
    const allDates = new Set<string>();
    for (const wd of rule.weekdays) {
      // Luxon weekday: 1=Mon…7=Sun; JS/rule convention: 0=Sun…6=Sat
      const luxonWd = wd === 0 ? 7 : wd;
      const daysUntilFirst = (luxonWd - from.weekday + 7) % 7;
      let cur = from.plus({ days: daysUntilFirst });
      while (cur <= endDate) {
        allDates.add(cur.toISODate()!);
        cur = cur.plus({ weeks: 1 });
      }
    }
    return [...allDates].sort().map((date) => ({ date }));
  }

  if (rule.type === 'monthly') {
    if (rule.weekday == null || !rule.ordinal) return [];
    const isLast = rule.ordinal === 'last';
    const n = isLast ? 0 : ORDINAL_MAP[rule.ordinal];
    // Iterate months from from.month to endDate.month
    let year = from.year;
    let month = from.month;
    const endYear = endDate.year;
    const endMonth = endDate.month;

    while (year < endYear || (year === endYear && month <= endMonth)) {
      const occ = isLast
        ? lastWeekdayOfMonth(year, month, rule.weekday)
        : nthWeekdayOfMonth(year, month, rule.weekday, n);

      if (occ && occ >= from && occ <= endDate) {
        dates.push({ date: occ.toISODate()! });
      }

      month++;
      if (month > 12) { month = 1; year++; }
    }
    return dates;
  }

  return [];
}

// Convert a local date + time string to a UTC DATETIME string for MySQL
function toUtcDatetime(dateStr: string, timeStr: string, timezone: string): string {
  const time = timeStr.slice(0, 5); // HH:MM
  const dt = DateTime.fromISO(`${dateStr}T${time}:00`, { zone: timezone });
  return dt.toUTC().toFormat("yyyy-MM-dd HH:mm:ss");
}

function timeToMinutes(time: string): number {
  const [h, m] = time.slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60).toString().padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * #482: slice a `start`–`end` availability window into `durationMinutes`-sized
 * bookable slots, one per full-duration segment. A trailing remainder that
 * doesn't fill a whole slot is dropped rather than stretching the last slot
 * beyond the configured window. When `durationMinutes` is null/invalid
 * (legacy rows created before the column was mandatory), the whole window is
 * returned as a single segment — the pre-#482 behavior.
 */
export function computeSlotSegments(
  start: string,
  end: string,
  durationMinutes: number | null,
): Array<{ start: string; end: string }> {
  const startStr = start.slice(0, 5);
  const endStr = end.slice(0, 5);
  if (durationMinutes == null || !Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    return [{ start: startStr, end: endStr }];
  }

  const startMin = timeToMinutes(startStr);
  const endMin = timeToMinutes(endStr);
  const segments: Array<{ start: string; end: string }> = [];
  let cursor = startMin;
  while (cursor + durationMinutes <= endMin) {
    segments.push({ start: minutesToTime(cursor), end: minutesToTime(cursor + durationMinutes) });
    cursor += durationMinutes;
  }
  return segments;
}

/**
 * #482: does a specific local occurrence (date + local start/end time) still fall
 * within `config`'s availability window? Used to tell whether an already-booked
 * occurrence survives a rule edit unchanged, or is "impacted" (would fall outside
 * the new configuration and therefore needs staff confirmation to cancel).
 */
function occurrenceFitsConfig(
  config: RuleWindowConfig,
  localDate: string,
  localStartTime: string,
  localEndTime: string,
): boolean {
  if (localStartTime < config.start_time.slice(0, 5) || localEndTime > config.end_time.slice(0, 5)) return false;

  if (config.type === 'one_off') {
    return localDate === config.start_date;
  }

  if (!config.end_date || localDate < config.start_date || localDate > config.end_date) return false;

  const d = DateTime.fromISO(localDate, { zone: 'utc' });
  const ruleWeekday = d.weekday % 7; // luxon 1=Mon…7=Sun -> 0=Sun…6=Sat

  if (config.type === 'weekly') {
    return (config.weekdays ?? []).includes(ruleWeekday);
  }

  if (config.type === 'monthly') {
    if (config.weekday == null || ruleWeekday !== config.weekday || !config.ordinal) return false;
    const occ = config.ordinal === 'last'
      ? lastWeekdayOfMonth(d.year, d.month, config.weekday)
      : nthWeekdayOfMonth(d.year, d.month, config.weekday, ORDINAL_MAP[config.ordinal]);
    return occ?.toISODate() === localDate;
  }

  return false;
}

export interface BookedOccurrence {
  id: number;
  starts_at: Date;
  ends_at: Date;
  member_ids: number[];
}

/** #482: every future, non-cancelled occurrence of this rule that has at least one
 * active ('booked') booking, with the ids of the members holding those bookings. */
export async function findBookedFutureOccurrences(ruleId: number): Promise<BookedOccurrence[]> {
  const { rows } = await db.query(
    `SELECT ce.id, ce.starts_at, ce.ends_at, ceb.member_id
     FROM calendar_events ce
     JOIN calendar_event_bookings ceb ON ceb.calendar_event_id = ce.id AND ceb.status = 'booked'
     WHERE ce.schedule_rule_id = ? AND ce.starts_at > UTC_TIMESTAMP() AND ce.deleted_at IS NULL`,
    [ruleId],
  );
  const byEvent = new Map<number, BookedOccurrence>();
  for (const r of rows) {
    let occ = byEvent.get(r.id);
    if (!occ) {
      occ = { id: r.id, starts_at: r.starts_at, ends_at: r.ends_at, member_ids: [] };
      byEvent.set(r.id, occ);
    }
    occ.member_ids.push(r.member_id);
  }
  return [...byEvent.values()];
}

/**
 * #482: split a rule's currently-booked future occurrences into those that still
 * fit `newConfig`'s availability window (must be preserved as-is — never
 * cancelled/regenerated, so their `calendar_event_id` relationships never break)
 * and those that don't ("impacted" — cancelling them requires explicit staff
 * confirmation, per the design agreed on the issue thread).
 */
export async function partitionBookedFutureOccurrences(
  ruleId: number,
  newConfig: RuleWindowConfig,
  gymTimezone: string,
): Promise<{ preserved: BookedOccurrence[]; impacted: BookedOccurrence[] }> {
  const booked = await findBookedFutureOccurrences(ruleId);
  const preserved: BookedOccurrence[] = [];
  const impacted: BookedOccurrence[] = [];
  for (const occ of booked) {
    const start = DateTime.fromJSDate(occ.starts_at, { zone: 'utc' }).setZone(gymTimezone);
    const end = DateTime.fromJSDate(occ.ends_at, { zone: 'utc' }).setZone(gymTimezone);
    const fits = occurrenceFitsConfig(newConfig, start.toFormat('yyyy-MM-dd'), start.toFormat('HH:mm'), end.toFormat('HH:mm'));
    (fits ? preserved : impacted).push(occ);
  }
  return { preserved, impacted };
}

/**
 * #482: does `a`'s recurrence pattern (weekday-set + date range + time-of-day
 * window) overlap with `b`'s? Used to warn staff that two rules would double-book
 * the same space or trainer, before either rule is materialized into
 * `calendar_events`.
 *
 * This is a structural, weekday-level comparison — not an exact date-by-date
 * expansion — so `monthly` rules are compared by their configured weekday only
 * (ignoring `ordinal`), which can over-warn (e.g. "first Monday" vs "third
 * Monday" of the month) but never under-warns. That's the right tradeoff for a
 * non-blocking warning.
 */
export function rulesOverlap(a: RuleWindowConfig, b: RuleWindowConfig): boolean {
  const aStart = a.start_time.slice(0, 5);
  const aEnd = a.end_time.slice(0, 5);
  const bStart = b.start_time.slice(0, 5);
  const bEnd = b.end_time.slice(0, 5);
  if (aStart >= bEnd || bStart >= aEnd) return false;

  const rangeEnd = (c: RuleWindowConfig) => (c.type === 'one_off' ? c.start_date : (c.end_date ?? '9999-12-31'));
  if (a.start_date > rangeEnd(b) || b.start_date > rangeEnd(a)) return false;

  const weekdaysOf = (c: RuleWindowConfig): number[] => {
    if (c.type === 'weekly') return c.weekdays ?? [];
    if (c.type === 'monthly') return c.weekday != null ? [c.weekday] : [];
    return [DateTime.fromISO(c.start_date, { zone: 'utc' }).weekday % 7]; // one_off
  };
  const aDays = new Set(weekdaysOf(a));
  return weekdaysOf(b).some((d) => aDays.has(d));
}

export interface OverlapCandidate {
  id: number;
  activity_type_id: number;
  activity_type_name: string;
  default_space_id: number | null;
  default_trainer_membership_id: number | null;
  config: RuleWindowConfig;
}

function rowToWindowConfig(row: any): RuleWindowConfig {
  return {
    type: row.type,
    start_date: row.start_date instanceof Date ? row.start_date.toISOString().slice(0, 10) : String(row.start_date).slice(0, 10),
    end_date: row.end_date == null ? null
      : row.end_date instanceof Date ? row.end_date.toISOString().slice(0, 10) : String(row.end_date).slice(0, 10),
    weekday: row.weekday,
    weekdays: row.weekdays == null ? null
      : Array.isArray(row.weekdays) ? row.weekdays.map(Number)
      : ((): number[] => { try { return JSON.parse(row.weekdays).map(Number); } catch { return []; } })(),
    ordinal: row.ordinal,
    start_time: typeof row.start_time === 'string' ? row.start_time.slice(0, 5) : row.start_time,
    end_time: typeof row.end_time === 'string' ? row.end_time.slice(0, 5) : row.end_time,
  };
}

/**
 * #482: every other active schedule rule in this gym whose parent Activity Type
 * resolves to the same space and/or the same trainer as `spaceId`/`trainerMembershipId`
 * (the rule being created/edited). Callers pair this with `rulesOverlap` against
 * each candidate's `config` to decide which ones actually conflict in time.
 */
export async function findOverlappingRules(
  gymId: string,
  excludeRuleId: number | null,
  spaceId: number | null,
  trainerMembershipId: number | null,
): Promise<OverlapCandidate[]> {
  if (spaceId == null && trainerMembershipId == null) return [];

  const conditions: string[] = [];
  const params: any[] = [];
  if (spaceId != null) { conditions.push('at.default_space_id = ?'); params.push(spaceId); }
  if (trainerMembershipId != null) { conditions.push('at.default_trainer_membership_id = ?'); params.push(trainerMembershipId); }

  const { rows } = await db.query(
    `SELECT r.id, r.activity_type_id, at.name AS activity_type_name,
            at.default_space_id, at.default_trainer_membership_id,
            r.type, r.start_date, r.end_date, r.weekday, r.weekdays, r.ordinal, r.start_time, r.end_time
     FROM activity_type_schedule_rules r
     JOIN activity_types at ON at.id = r.activity_type_id AND at.deleted_at IS NULL
     WHERE r.gym_id = ? AND (${conditions.join(' OR ')}) AND r.id != COALESCE(?, 0)`,
    [gymId, ...params, excludeRuleId],
  );

  return rows.map((row: any): OverlapCandidate => ({
    id: row.id,
    activity_type_id: row.activity_type_id,
    activity_type_name: row.activity_type_name,
    default_space_id: row.default_space_id,
    default_trainer_membership_id: row.default_trainer_membership_id,
    config: rowToWindowConfig(row),
  }));
}

export async function materializeScheduleRule(ruleId: number, gymTimezone: string): Promise<void> {
  const { rows: ruleRows } = await db.query(
    `SELECT r.*, at.name AS activity_type_name,
            at.default_space_id, at.default_trainer_membership_id, at.color, at.max_capacity,
            at.default_center_id, at.gym_id, at.duration_minutes
     FROM activity_type_schedule_rules r
     JOIN activity_types at ON at.id = r.activity_type_id
     WHERE r.id = ?`,
    [ruleId],
  );
  if (ruleRows.length === 0) return;

  const raw = ruleRows[0];
  const rule = {
    ...raw,
    start_date: raw.start_date instanceof Date ? raw.start_date.toISOString().slice(0, 10) : String(raw.start_date).slice(0, 10),
    end_date: raw.end_date instanceof Date ? raw.end_date.toISOString().slice(0, 10) : (raw.end_date ? String(raw.end_date).slice(0, 10) : null),
    start_time: typeof raw.start_time === 'string' ? raw.start_time.slice(0, 5) : raw.start_time,
    end_time: typeof raw.end_time === 'string' ? raw.end_time.slice(0, 5) : raw.end_time,
    weekdays: raw.weekdays == null ? null
      : Array.isArray(raw.weekdays) ? raw.weekdays.map(Number)
      : ((): number[] => { try { return JSON.parse(raw.weekdays).map(Number); } catch { return []; } })(),
  } as ScheduleRule & {
    activity_type_name: string;
    default_space_id: number | null;
    default_trainer_membership_id: number | null;
    default_center_id: number | null;
    color: string | null;
    max_capacity: number;
    gym_id: string;
    duration_minutes: number | null;
  };

  const occurrences = occurrenceDatesForRule(rule);
  if (occurrences.length === 0) return;

  const nowStr = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss');
  const rows = occurrences.flatMap(({ date }) => {
    // #482: weekly rules slice their availability window into duration_minutes-sized
    // bookable slots (e.g. Personal Training availability); other rule types keep the
    // existing one-event-per-occurrence behavior.
    const segments = rule.type === 'weekly'
      ? computeSlotSegments(rule.start_time, rule.end_time, rule.duration_minutes)
      : [{ start: rule.start_time, end: rule.end_time }];

    return segments.map((seg) => ({
      gym_id: rule.gym_id,
      center_id: rule.default_center_id ?? null,
      kind: 'session',
      title: rule.activity_type_name,
      activity_type_id: rule.activity_type_id,
      space_id: rule.default_space_id ?? null,
      trainer_membership_id: rule.default_trainer_membership_id ?? null,
      color: rule.color ?? null,
      capacity: rule.max_capacity,
      starts_at: toUtcDatetime(date, seg.start, gymTimezone),
      ends_at: toUtcDatetime(date, seg.end, gymTimezone),
      all_day: 0,
      status: 'scheduled',
      schedule_rule_id: rule.id,
      created_at: nowStr,
      updated_at: nowStr,
    }));
  });
  if (rows.length === 0) return;

  // #482: skip re-generating a slot that already exists as a non-cancelled row for
  // this rule — namely a booked occurrence preserved across a rule edit (see
  // `partitionBookedFutureOccurrences`) — so re-materialization never inserts a
  // duplicate/overlapping calendar_events row at the same time.
  const { rows: existingRows } = await db.query(
    'SELECT starts_at FROM calendar_events WHERE schedule_rule_id = ? AND deleted_at IS NULL',
    [rule.id],
  );
  const existingStarts = new Set(existingRows.map((r: any) => new Date(r.starts_at).getTime()));
  const newRows = rows.filter((r) => !existingStarts.has(new Date(`${r.starts_at.replace(' ', 'T')}Z`).getTime()));
  if (newRows.length === 0) return;

  // Bulk insert in chunks to stay under MySQL max_allowed_packet
  const CHUNK = 200;
  for (let i = 0; i < newRows.length; i += CHUNK) {
    const chunk = newRows.slice(i, i + CHUNK);
    await db.query(
      `INSERT INTO calendar_events
         (gym_id, center_id, kind, title, activity_type_id, space_id, trainer_membership_id, color,
          capacity, starts_at, ends_at, all_day, status, schedule_rule_id, created_at, updated_at)
       VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}`,
      chunk.flatMap((r) => [
        r.gym_id, r.center_id, r.kind, r.title, r.activity_type_id, r.space_id,
        r.trainer_membership_id, r.color, r.capacity,
        r.starts_at, r.ends_at, r.all_day, r.status, r.schedule_rule_id, r.created_at, r.updated_at,
      ]),
    );
  }

  await bookAssignedMembersOnNewOccurrences(rule.id, rule.gym_id, newRows.map((r) => r.starts_at));
}

/**
 * #366: for every Member assigned to this recurring rule (staff selection at
 * rule creation/edit), reserve them on the occurrences just materialized —
 * same reservation mechanism (force=true) staff use for a manual add, so
 * capacity is never a hard block here either. Idempotent: bookMemberOnSession
 * is called once per fresh occurrence, and each occurrence is a brand-new
 * calendar_events row with no existing bookings.
 */
async function bookAssignedMembersOnNewOccurrences(ruleId: number, gymId: string, startsAtValues: string[]): Promise<void> {
  if (startsAtValues.length === 0) return;

  const { rows: memberRows } = await db.query(
    'SELECT member_id FROM activity_type_schedule_rule_members WHERE schedule_rule_id = ?',
    [ruleId],
  );
  if (memberRows.length === 0) return;

  const { rows: eventRows } = await db.query(
    `SELECT id FROM calendar_events
     WHERE schedule_rule_id = ? AND starts_at IN (${startsAtValues.map(() => '?').join(',')})`,
    [ruleId, ...startsAtValues],
  );

  for (const ev of eventRows) {
    for (const m of memberRows) {
      try {
        await bookMemberOnSession(gymId, m.member_id, ev.id, true);
      } catch {
        // Best-effort: a booking that can't be created for one member on one
        // occurrence (e.g. it was cancelled concurrently) must not block the
        // rest of the assigned Members or occurrences.
      }
    }
  }
}

export async function cancelFutureOccurrences(
  ruleId: number,
  options?: { preserveIds?: number[] },
): Promise<void> {
  const preserveIds = options?.preserveIds ?? [];
  const preserveClause = preserveIds.length > 0
    ? ` AND id NOT IN (${preserveIds.map(() => '?').join(',')})`
    : '';
  await db.query(
    `UPDATE calendar_events
     SET status = 'cancelled', deleted_at = UTC_TIMESTAMP()
     WHERE schedule_rule_id = ? AND starts_at > UTC_TIMESTAMP() AND deleted_at IS NULL${preserveClause}`,
    [ruleId, ...preserveIds],
  );
}

export async function cancelFutureOccurrencesByActivityType(activityTypeId: number): Promise<void> {
  await db.query(
    `UPDATE calendar_events ce
     JOIN activity_type_schedule_rules r ON r.id = ce.schedule_rule_id
     SET ce.status = 'cancelled', ce.deleted_at = UTC_TIMESTAMP()
     WHERE r.activity_type_id = ? AND ce.starts_at > UTC_TIMESTAMP() AND ce.deleted_at IS NULL`,
    [activityTypeId],
  );
}
