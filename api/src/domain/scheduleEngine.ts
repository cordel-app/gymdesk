import { DateTime } from 'luxon';
import { db } from '../infra/db';

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

export async function materializeScheduleRule(ruleId: number, gymTimezone: string): Promise<void> {
  const { rows: ruleRows } = await db.query(
    `SELECT r.*, at.name AS activity_type_name,
            at.default_space_id, at.default_trainer_membership_id, at.color, at.max_capacity,
            at.gym_id
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
    color: string | null;
    max_capacity: number;
    gym_id: string;
  };

  const occurrences = occurrenceDatesForRule(rule);
  if (occurrences.length === 0) return;

  const nowStr = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss');
  const rows = occurrences.map(({ date }) => ({
    gym_id: rule.gym_id,
    title: rule.activity_type_name,
    activity_type_id: rule.activity_type_id,
    space_id: rule.default_space_id ?? null,
    trainer_membership_id: rule.default_trainer_membership_id ?? null,
    color: rule.color ?? null,
    starts_at: toUtcDatetime(date, rule.start_time, gymTimezone),
    ends_at: toUtcDatetime(date, rule.end_time, gymTimezone),
    all_day: 0,
    status: 'scheduled',
    schedule_rule_id: rule.id,
    created_at: nowStr,
    updated_at: nowStr,
  }));

  // Bulk insert in chunks to stay under MySQL max_allowed_packet
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await db.query(
      `INSERT INTO calendar_events
         (gym_id, title, activity_type_id, space_id, trainer_membership_id, color,
          starts_at, ends_at, all_day, status, schedule_rule_id, created_at, updated_at)
       VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}`,
      chunk.flatMap((r) => [
        r.gym_id, r.title, r.activity_type_id, r.space_id, r.trainer_membership_id, r.color,
        r.starts_at, r.ends_at, r.all_day, r.status, r.schedule_rule_id, r.created_at, r.updated_at,
      ]),
    );
  }
}

export async function cancelFutureOccurrences(ruleId: number): Promise<void> {
  await db.query(
    `UPDATE calendar_events
     SET status = 'cancelled', deleted_at = UTC_TIMESTAMP()
     WHERE schedule_rule_id = ? AND starts_at > UTC_TIMESTAMP() AND deleted_at IS NULL`,
    [ruleId],
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
