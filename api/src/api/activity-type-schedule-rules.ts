import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import {
  materializeScheduleRule,
  cancelFutureOccurrences,
  computeSlotSegments,
  findBookedFutureOccurrences,
  partitionBookedFutureOccurrences,
  type RuleWindowConfig,
  type BookedOccurrence,
} from '../domain/scheduleEngine';
import { sendBulkNotification } from '../infra/notifications';
import { DateTime } from 'luxon';

const TYPES = ['one_off', 'weekly', 'monthly'] as const;
const VALID_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]; // 0=Sun…6=Sat
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'last'] as const;

export const activityTypeScheduleRulesRouter = Router({ mergeParams: true });

// All routes share: /activity-types/:activityTypeId/schedule-rules
// mergeParams: true gives us req.params.activityTypeId

async function resolveActivityType(activityTypeId: string, gymId: string) {
  const { rows } = await db.query(
    'SELECT id, name, duration_minutes FROM activity_types WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [activityTypeId, gymId],
  );
  return rows[0] ?? null;
}

/**
 * #482: notify every member holding a booking on an occurrence that a rule
 * edit/delete is about to cancel — one `event_cancelled` notification per
 * occurrence, mirroring the existing class-session cancel flow
 * (`calendar-events.ts`'s `classSessionsRouter.post('/:id/cancel')`).
 */
function notifyImpactedOccurrences(gymId: string, activityTypeName: string, occurrences: BookedOccurrence[], reason: string): void {
  for (const occ of occurrences) {
    sendBulkNotification(gymId, occ.member_ids, 'event_cancelled', 'session', occ.id, {
      title: activityTypeName,
      starts_at: occ.starts_at.toISOString(),
      reason,
    });
  }
}

/**
 * #482: for a weekly availability rule, warn (non-blocking) when the
 * start_time–end_time window doesn't slice evenly into the activity's
 * duration_minutes — either because a trailing remainder is dropped, or
 * because the duration is longer than the window so no slot fits at all.
 */
function computeSlotWarning(
  type: string,
  startTime: string,
  endTime: string,
  durationMinutes: number | null,
): string | null {
  if (type !== 'weekly' || durationMinutes == null) return null;

  const segments = computeSlotSegments(startTime, endTime, durationMinutes);
  const toMinutes = (t: string) => {
    const [h, m] = t.slice(0, 5).split(':').map(Number);
    return h * 60 + m;
  };
  const windowMinutes = toMinutes(endTime) - toMinutes(startTime);

  if (segments.length === 0) {
    return `The activity's duration (${durationMinutes} min) is longer than this availability window (${windowMinutes} min); no bookable slots will be generated. Adjust the start time, end time, or duration.`;
  }

  const remainder = windowMinutes - segments.length * durationMinutes;
  if (remainder > 0) {
    return `This window doesn't divide evenly by the activity's ${durationMinutes}-minute duration: the last ${remainder} minute(s) after ${segments[segments.length - 1].end} won't be used for a bookable slot. Adjust the start time, end time, or duration to use the full window.`;
  }

  return null;
}

async function getGymTimezone(gymId: string): Promise<string> {
  const { rows } = await db.query('SELECT timezone FROM gyms WHERE id = ?', [gymId]);
  return rows[0]?.timezone ?? 'Europe/Madrid';
}

/**
 * #366: validate + normalize the optional `member_ids` field (staff assigns
 * Members to a recurring rule so they're auto-reserved on every generated
 * occurrence). Returns null (all valid) or an error string.
 */
function normalizeMemberIds(body: any): number[] | null | string {
  if (!('member_ids' in body) || body.member_ids == null) return null;
  if (!Array.isArray(body.member_ids)) return 'member_ids must be an array of member ids';
  const ids: number[] = body.member_ids.map(Number);
  if (ids.some((id: number) => !Number.isInteger(id) || id <= 0)) return 'member_ids must contain positive integers';
  return [...new Set(ids)];
}

async function validateMemberIds(gymId: string, memberIds: number[]): Promise<string | null> {
  if (memberIds.length === 0) return null;
  const { rows } = await db.query(
    `SELECT id FROM members WHERE gym_id = ? AND deleted_at IS NULL AND id IN (${memberIds.map(() => '?').join(',')})`,
    [gymId, ...memberIds],
  );
  if (rows.length !== memberIds.length) return 'One or more member_ids were not found for this gym';
  return null;
}

async function setRuleMembers(gymId: string, ruleId: number, memberIds: number[]): Promise<void> {
  await db.query('DELETE FROM activity_type_schedule_rule_members WHERE schedule_rule_id = ?', [ruleId]);
  if (memberIds.length === 0) return;
  await db.query(
    `INSERT INTO activity_type_schedule_rule_members (gym_id, schedule_rule_id, member_id) VALUES ${memberIds.map(() => '(?,?,?)').join(',')}`,
    memberIds.flatMap((memberId) => [gymId, ruleId, memberId]),
  );
}

async function getRuleMemberIdsByRule(ruleIds: number[]): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>();
  if (ruleIds.length === 0) return map;
  const { rows } = await db.query(
    `SELECT schedule_rule_id, member_id FROM activity_type_schedule_rule_members WHERE schedule_rule_id IN (${ruleIds.map(() => '?').join(',')})`,
    ruleIds,
  );
  for (const r of rows) {
    const arr = map.get(r.schedule_rule_id) ?? [];
    arr.push(r.member_id);
    map.set(r.schedule_rule_id, arr);
  }
  return map;
}

/**
 * Normalise the weekdays for a weekly rule.
 * Accepts either the new `weekdays: number[]` field or the legacy `weekday: number` field
 * and always returns a sorted, deduplicated array. Returns null for non-weekly types.
 */
function resolveWeekdays(body: any): number[] | null {
  if (body.type !== 'weekly') return null;

  // New multi-day field takes precedence
  if (Array.isArray(body.weekdays)) {
    const nums: number[] = body.weekdays.map(Number);
    return [...new Set(nums)].sort((a, b) => a - b);
  }
  // Legacy single-weekday backward compat
  if (body.weekday != null) {
    return [Number(body.weekday)];
  }
  return [];
}

function validateRule(body: any): string | null {
  const { type, start_date, end_date, weekday, ordinal, start_time, end_time } = body;

  if (!type || !TYPES.includes(type)) return `type must be one of: ${TYPES.join(', ')}`;
  if (!start_date || !/^\d{4}-\d{2}-\d{2}$/.test(start_date)) return 'start_date is required (YYYY-MM-DD)';
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!start_time || !TIME_RE.test(start_time)) return 'start_time is required (HH:MM, 24-hour)';
  if (!end_time || !TIME_RE.test(end_time)) return 'end_time is required (HH:MM, 24-hour)';
  if (start_time >= end_time) return 'end_time must be after start_time';

  if (type !== 'one_off') {
    if (!end_date || !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) return 'end_date is required for recurring rules (YYYY-MM-DD)';
    if (end_date < start_date) return 'end_date must not be before start_date';

    // Max 1 year horizon
    const start = DateTime.fromISO(start_date);
    const end = DateTime.fromISO(end_date);
    if (end > start.plus({ years: 1 })) return 'end_date cannot be more than one year after start_date';

    if (type === 'weekly') {
      const weekdays = resolveWeekdays(body);
      if (!weekdays || weekdays.length === 0) return 'weekdays must contain at least one day (0=Sun…6=Sat)';
      if (weekdays.some((d) => !VALID_WEEKDAYS.includes(d))) return 'each weekday must be 0–6 (0=Sun…6=Sat)';
    } else {
      // monthly
      if (weekday == null || !VALID_WEEKDAYS.includes(Number(weekday))) return 'weekday is required for monthly rules (0=Sun…6=Sat)';
    }
  }

  if (type === 'monthly') {
    if (!ordinal || !ORDINALS.includes(ordinal)) return `ordinal is required for monthly rules: ${ORDINALS.join(', ')}`;
  }

  return null;
}

function fmtDate(v: any): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string') return v.slice(0, 10);
  return v;
}

function parseWeekdays(raw: any): number[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw.map(Number);
  if (typeof raw === 'string') {
    try { return JSON.parse(raw).map(Number); } catch { return null; }
  }
  return null;
}

function formatRule(row: any) {
  if (!row) return row;
  return {
    ...row,
    weekdays: parseWeekdays(row.weekdays),
    start_date: fmtDate(row.start_date),
    end_date: row.end_date != null ? fmtDate(row.end_date) : null,
    start_time: typeof row.start_time === 'string' ? row.start_time.slice(0, 5) : row.start_time,
    end_time: typeof row.end_time === 'string' ? row.end_time.slice(0, 5) : row.end_time,
  };
}

// GET /activity-types/:activityTypeId/schedule-rules
activityTypeScheduleRulesRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const activityTypeId = (req.params as any).activityTypeId as string;
  if (!(await resolveActivityType(activityTypeId, gymId))) {
    return res.status(404).json({ error: 'Activity type not found' });
  }
  const { rows } = await db.query(
    'SELECT * FROM activity_type_schedule_rules WHERE activity_type_id = ? AND gym_id = ? ORDER BY created_at ASC',
    [activityTypeId, gymId],
  );
  const memberIdsByRule = await getRuleMemberIdsByRule(rows.map((r: any) => r.id));
  res.json(rows.map((r: any) => ({ ...formatRule(r), member_ids: memberIdsByRule.get(r.id) ?? [] })));
});

// POST /activity-types/:activityTypeId/schedule-rules
activityTypeScheduleRulesRouter.post('/', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const activityTypeId = (req.params as any).activityTypeId as string;
  const activityType = await resolveActivityType(activityTypeId, gymId);
  if (!activityType) {
    return res.status(404).json({ error: 'Activity type not found' });
  }

  const err = validateRule(req.body); if (err) return res.status(400).json({ error: err });

  const memberIds = normalizeMemberIds(req.body);
  if (typeof memberIds === 'string') return res.status(400).json({ error: memberIds });
  if (memberIds) {
    const memberErr = await validateMemberIds(gymId, memberIds);
    if (memberErr) return res.status(400).json({ error: memberErr });
  }

  const { type, start_date, end_date, weekday, ordinal, start_time, end_time } = req.body;
  const weekdays = resolveWeekdays(req.body);

  const { insertId } = await db.query(
    `INSERT INTO activity_type_schedule_rules
     (gym_id, activity_type_id, type, start_date, end_date, weekday, weekdays, ordinal, start_time, end_time)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      gymId, activityTypeId, type,
      start_date,
      type === 'one_off' ? null : end_date,
      type === 'monthly' ? Number(weekday) : null,
      type === 'weekly' ? JSON.stringify(weekdays) : null,
      type === 'monthly' ? ordinal : null,
      start_time.slice(0, 5),
      end_time.slice(0, 5),
    ],
  );

  if (memberIds && memberIds.length > 0) {
    await setRuleMembers(gymId, insertId, memberIds);
  }

  const gymTimezone = await getGymTimezone(gymId);
  await materializeScheduleRule(insertId, gymTimezone);

  const { rows } = await db.query('SELECT * FROM activity_type_schedule_rules WHERE id = ?', [insertId]);
  const slot_warning = computeSlotWarning(type, start_time, end_time, activityType.duration_minutes);
  res.status(201).json({ ...formatRule(rows[0]), member_ids: memberIds ?? [], slot_warning });
});

// PUT /activity-types/:activityTypeId/schedule-rules/:ruleId
activityTypeScheduleRulesRouter.put('/:ruleId', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const activityTypeId = (req.params as any).activityTypeId as string;
  const { ruleId } = req.params;
  const activityType = await resolveActivityType(activityTypeId, gymId);
  if (!activityType) {
    return res.status(404).json({ error: 'Activity type not found' });
  }

  const { rows: existing } = await db.query(
    'SELECT * FROM activity_type_schedule_rules WHERE id = ? AND activity_type_id = ? AND gym_id = ?',
    [ruleId, activityTypeId, gymId],
  );
  if (existing.length === 0) return res.status(404).json({ error: 'Schedule rule not found' });

  const err = validateRule(req.body); if (err) return res.status(400).json({ error: err });

  const memberIds = normalizeMemberIds(req.body);
  if (typeof memberIds === 'string') return res.status(400).json({ error: memberIds });
  if (memberIds) {
    const memberErr = await validateMemberIds(gymId, memberIds);
    if (memberErr) return res.status(400).json({ error: memberErr });
  }

  const { type, start_date, end_date, weekday, ordinal, start_time, end_time } = req.body;
  const weekdays = resolveWeekdays(req.body);

  const newConfig: RuleWindowConfig = {
    type,
    start_date,
    end_date: type === 'one_off' ? null : end_date,
    weekday: type === 'monthly' ? Number(weekday) : null,
    weekdays: type === 'weekly' ? weekdays : null,
    ordinal: type === 'monthly' ? ordinal : null,
    start_time: start_time.slice(0, 5),
    end_time: end_time.slice(0, 5),
  };

  const gymTimezone = await getGymTimezone(gymId);

  // #482: the booked-occurrence protection below is about *availability* changes
  // (day/time), not about staff reassigning which members are auto-booked to an
  // unchanged window (#366) — that's an intentional swap, not a side effect of
  // narrowing/moving the window, so it keeps the pre-#482 unconditional
  // cancel-and-regenerate behavior when the window itself didn't change.
  const existingRule = existing[0];
  const existingConfig: RuleWindowConfig = {
    type: existingRule.type,
    start_date: fmtDate(existingRule.start_date)!,
    end_date: existingRule.end_date != null ? fmtDate(existingRule.end_date) : null,
    weekday: existingRule.weekday,
    weekdays: parseWeekdays(existingRule.weekdays),
    ordinal: existingRule.ordinal,
    start_time: typeof existingRule.start_time === 'string' ? existingRule.start_time.slice(0, 5) : existingRule.start_time,
    end_time: typeof existingRule.end_time === 'string' ? existingRule.end_time.slice(0, 5) : existingRule.end_time,
  };
  const windowUnchanged = existingConfig.type === newConfig.type
    && existingConfig.start_date === newConfig.start_date
    && existingConfig.end_date === newConfig.end_date
    && existingConfig.weekday === newConfig.weekday
    && JSON.stringify(existingConfig.weekdays) === JSON.stringify(newConfig.weekdays)
    && existingConfig.ordinal === newConfig.ordinal
    && existingConfig.start_time === newConfig.start_time
    && existingConfig.end_time === newConfig.end_time;

  // #482: never silently cancel an already-booked future occurrence. One that no
  // longer fits the new window needs explicit staff confirmation before this
  // edit touches anything; one that still fits is always preserved untouched.
  const { preserved, impacted } = windowUnchanged
    ? { preserved: [] as BookedOccurrence[], impacted: [] as BookedOccurrence[] }
    : await partitionBookedFutureOccurrences(Number(ruleId), newConfig, gymTimezone);
  if (impacted.length > 0 && req.body.confirm_cancel_booked !== true) {
    const memberCount = new Set(impacted.flatMap((o) => o.member_ids)).size;
    return res.status(409).json({
      error: 'booked_occurrences_impacted',
      message: `This change would cancel ${impacted.length} already-booked occurrence(s) affecting ${memberCount} member(s). Resend with confirm_cancel_booked: true to proceed — affected members will be notified.`,
      impacted_occurrences: impacted.map((o) => ({ id: o.id, starts_at: o.starts_at, ends_at: o.ends_at, member_count: o.member_ids.length })),
      member_count: memberCount,
    });
  }

  await db.query(
    `UPDATE activity_type_schedule_rules SET
       type = ?, start_date = ?, end_date = ?, weekday = ?, weekdays = ?, ordinal = ?,
       start_time = ?, end_time = ?
     WHERE id = ?`,
    [
      type,
      start_date,
      newConfig.end_date,
      newConfig.weekday,
      type === 'weekly' ? JSON.stringify(weekdays) : null,
      newConfig.ordinal,
      newConfig.start_time,
      newConfig.end_time,
      ruleId,
    ],
  );

  // `member_ids` omitted from the request body leaves the current assignment untouched.
  if (memberIds) await setRuleMembers(gymId, Number(ruleId), memberIds);

  // Cancel future events for this rule — preserving booked occurrences that still
  // fit the new window — then regenerate. Re-materialization re-books the
  // (possibly updated) assigned Members on the new occurrences and skips slots
  // that already exist as preserved rows.
  await cancelFutureOccurrences(Number(ruleId), { preserveIds: preserved.map((o) => o.id) });
  await materializeScheduleRule(Number(ruleId), gymTimezone);

  if (impacted.length > 0) {
    notifyImpactedOccurrences(gymId, activityType.name, impacted, 'The availability schedule for this activity was changed');
  }

  const { rows } = await db.query('SELECT * FROM activity_type_schedule_rules WHERE id = ?', [ruleId]);
  const currentMemberIds = memberIds ?? (await getRuleMemberIdsByRule([Number(ruleId)])).get(Number(ruleId)) ?? [];
  const slot_warning = computeSlotWarning(type, start_time, end_time, activityType.duration_minutes);
  res.json({ ...formatRule(rows[0]), member_ids: currentMemberIds, slot_warning });
});

// DELETE /activity-types/:activityTypeId/schedule-rules/:ruleId
activityTypeScheduleRulesRouter.delete('/:ruleId', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const activityTypeId = (req.params as any).activityTypeId as string;
  const { ruleId } = req.params;
  const activityType = await resolveActivityType(activityTypeId, gymId);
  if (!activityType) {
    return res.status(404).json({ error: 'Activity type not found' });
  }

  const { rows: existing } = await db.query(
    'SELECT id FROM activity_type_schedule_rules WHERE id = ? AND activity_type_id = ? AND gym_id = ?',
    [ruleId, activityTypeId, gymId],
  );
  if (existing.length === 0) return res.status(404).json({ error: 'Schedule rule not found' });

  // #482: deleting the rule removes its whole availability window, so every
  // still-booked future occurrence is by definition impacted — same
  // confirm-then-notify guard as the PUT edit path.
  const booked = await findBookedFutureOccurrences(Number(ruleId));
  if (booked.length > 0 && req.query.confirm_cancel_booked !== 'true') {
    const memberCount = new Set(booked.flatMap((o) => o.member_ids)).size;
    return res.status(409).json({
      error: 'booked_occurrences_impacted',
      message: `Deleting this availability would cancel ${booked.length} already-booked occurrence(s) affecting ${memberCount} member(s). Resend with ?confirm_cancel_booked=true to proceed — affected members will be notified.`,
      impacted_occurrences: booked.map((o) => ({ id: o.id, starts_at: o.starts_at, ends_at: o.ends_at, member_count: o.member_ids.length })),
      member_count: memberCount,
    });
  }

  // Cancel future calendar events first (preserve past)
  await cancelFutureOccurrences(Number(ruleId));

  await db.query('DELETE FROM activity_type_schedule_rules WHERE id = ?', [ruleId]);

  if (booked.length > 0) {
    notifyImpactedOccurrences(gymId, activityType.name, booked, 'The availability schedule for this activity was removed');
  }

  res.status(204).send();
});
