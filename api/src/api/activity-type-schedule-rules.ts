import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { materializeScheduleRule, cancelFutureOccurrences } from '../domain/scheduleEngine';
import { DateTime } from 'luxon';

const TYPES = ['one_off', 'weekly', 'monthly'] as const;
const VALID_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]; // 0=Sun…6=Sat
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'last'] as const;

export const activityTypeScheduleRulesRouter = Router({ mergeParams: true });

// All routes share: /activity-types/:activityTypeId/schedule-rules
// mergeParams: true gives us req.params.activityTypeId

async function resolveActivityType(activityTypeId: string, gymId: string) {
  const { rows } = await db.query(
    'SELECT id FROM activity_types WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [activityTypeId, gymId],
  );
  return rows[0] ?? null;
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
  if (!(await resolveActivityType(activityTypeId, gymId))) {
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
  res.status(201).json({ ...formatRule(rows[0]), member_ids: memberIds ?? [] });
});

// PUT /activity-types/:activityTypeId/schedule-rules/:ruleId
activityTypeScheduleRulesRouter.put('/:ruleId', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const activityTypeId = (req.params as any).activityTypeId as string;
  const { ruleId } = req.params;
  if (!(await resolveActivityType(activityTypeId, gymId))) {
    return res.status(404).json({ error: 'Activity type not found' });
  }

  const { rows: existing } = await db.query(
    'SELECT id FROM activity_type_schedule_rules WHERE id = ? AND activity_type_id = ? AND gym_id = ?',
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

  await db.query(
    `UPDATE activity_type_schedule_rules SET
       type = ?, start_date = ?, end_date = ?, weekday = ?, weekdays = ?, ordinal = ?,
       start_time = ?, end_time = ?
     WHERE id = ?`,
    [
      type,
      start_date,
      type === 'one_off' ? null : end_date,
      type === 'monthly' ? Number(weekday) : null,
      type === 'weekly' ? JSON.stringify(weekdays) : null,
      type === 'monthly' ? ordinal : null,
      start_time.slice(0, 5),
      end_time.slice(0, 5),
      ruleId,
    ],
  );

  // `member_ids` omitted from the request body leaves the current assignment untouched.
  if (memberIds) await setRuleMembers(gymId, Number(ruleId), memberIds);

  // Cancel future events for this rule, then regenerate — re-materialization
  // re-books the (possibly updated) assigned Members on the new occurrences.
  await cancelFutureOccurrences(Number(ruleId));
  const gymTimezone = await getGymTimezone(gymId);
  await materializeScheduleRule(Number(ruleId), gymTimezone);

  const { rows } = await db.query('SELECT * FROM activity_type_schedule_rules WHERE id = ?', [ruleId]);
  const currentMemberIds = memberIds ?? (await getRuleMemberIdsByRule([Number(ruleId)])).get(Number(ruleId)) ?? [];
  res.json({ ...formatRule(rows[0]), member_ids: currentMemberIds });
});

// DELETE /activity-types/:activityTypeId/schedule-rules/:ruleId
activityTypeScheduleRulesRouter.delete('/:ruleId', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const activityTypeId = (req.params as any).activityTypeId as string;
  const { ruleId } = req.params;
  if (!(await resolveActivityType(activityTypeId, gymId))) {
    return res.status(404).json({ error: 'Activity type not found' });
  }

  const { rows: existing } = await db.query(
    'SELECT id FROM activity_type_schedule_rules WHERE id = ? AND activity_type_id = ? AND gym_id = ?',
    [ruleId, activityTypeId, gymId],
  );
  if (existing.length === 0) return res.status(404).json({ error: 'Schedule rule not found' });

  // Cancel future calendar events first (preserve past)
  await cancelFutureOccurrences(Number(ruleId));

  await db.query('DELETE FROM activity_type_schedule_rules WHERE id = ?', [ruleId]);
  res.status(204).send();
});
