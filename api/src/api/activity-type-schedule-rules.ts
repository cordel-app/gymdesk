import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { materializeScheduleRule, cancelFutureOccurrences } from '../domain/scheduleEngine';
import { DateTime } from 'luxon';

const TYPES = ['one_off', 'weekly', 'monthly'] as const;
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]; // 0=Sun…6=Sat
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

function validateRule(body: any): string | null {
  const { type, start_date, end_date, weekday, ordinal, start_time, end_time } = body;

  if (!type || !TYPES.includes(type)) return `type must be one of: ${TYPES.join(', ')}`;
  if (!start_date || !/^\d{4}-\d{2}-\d{2}$/.test(start_date)) return 'start_date is required (YYYY-MM-DD)';
  if (!start_time || !/^\d{2}:\d{2}/.test(start_time)) return 'start_time is required (HH:MM)';
  if (!end_time || !/^\d{2}:\d{2}/.test(end_time)) return 'end_time is required (HH:MM)';
  if (start_time >= end_time) return 'end_time must be after start_time';

  if (type !== 'one_off') {
    if (!end_date || !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) return 'end_date is required for recurring rules (YYYY-MM-DD)';
    if (end_date < start_date) return 'end_date must not be before start_date';

    // Max 1 year horizon
    const start = DateTime.fromISO(start_date);
    const end = DateTime.fromISO(end_date);
    if (end > start.plus({ years: 1 })) return 'end_date cannot be more than one year after start_date';

    if (weekday == null || !WEEKDAYS.includes(Number(weekday))) return 'weekday is required for recurring rules (0=Sun…6=Sat)';
  }

  if (type === 'monthly') {
    if (!ordinal || !ORDINALS.includes(ordinal)) return `ordinal is required for monthly rules: ${ORDINALS.join(', ')}`;
  }

  return null;
}

function formatRule(row: any) {
  if (!row) return row;
  return {
    ...row,
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
  res.json(rows.map(formatRule));
});

// POST /activity-types/:activityTypeId/schedule-rules
activityTypeScheduleRulesRouter.post('/', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const activityTypeId = (req.params as any).activityTypeId as string;
  if (!(await resolveActivityType(activityTypeId, gymId))) {
    return res.status(404).json({ error: 'Activity type not found' });
  }

  const err = validateRule(req.body); if (err) return res.status(400).json({ error: err });

  const { type, start_date, end_date, weekday, ordinal, start_time, end_time } = req.body;

  const { insertId } = await db.query(
    `INSERT INTO activity_type_schedule_rules
     (gym_id, activity_type_id, type, start_date, end_date, weekday, ordinal, start_time, end_time)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      gymId, activityTypeId, type,
      start_date,
      type === 'one_off' ? null : end_date,
      type !== 'one_off' ? Number(weekday) : null,
      type === 'monthly' ? ordinal : null,
      start_time.slice(0, 5),
      end_time.slice(0, 5),
    ],
  );

  const gymTimezone = await getGymTimezone(gymId);
  await materializeScheduleRule(insertId, gymTimezone);

  const { rows } = await db.query('SELECT * FROM activity_type_schedule_rules WHERE id = ?', [insertId]);
  res.status(201).json(formatRule(rows[0]));
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

  const { type, start_date, end_date, weekday, ordinal, start_time, end_time } = req.body;

  await db.query(
    `UPDATE activity_type_schedule_rules SET
       type = ?, start_date = ?, end_date = ?, weekday = ?, ordinal = ?,
       start_time = ?, end_time = ?
     WHERE id = ?`,
    [
      type,
      start_date,
      type === 'one_off' ? null : end_date,
      type !== 'one_off' ? Number(weekday) : null,
      type === 'monthly' ? ordinal : null,
      start_time.slice(0, 5),
      end_time.slice(0, 5),
      ruleId,
    ],
  );

  // Cancel future events for this rule, then regenerate
  await cancelFutureOccurrences(Number(ruleId));
  const gymTimezone = await getGymTimezone(gymId);
  await materializeScheduleRule(Number(ruleId), gymTimezone);

  const { rows } = await db.query('SELECT * FROM activity_type_schedule_rules WHERE id = ?', [ruleId]);
  res.json(formatRule(rows[0]));
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
