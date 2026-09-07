import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { insertAndFetch } from '../infra/db-helpers';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const operatingHoursRouter = Router();

// ---------------------------------------------------------------------------
// Weekly hours — bulk "set the whole week" endpoint (same delete-all +
// reinsert shape as PUT /spaces/:id/activity-types), since the admin UI edits
// the full weekly grid at once rather than one shift at a time.
// ---------------------------------------------------------------------------

interface WeeklyShiftInput {
  weekday: number;
  start_time: string;
  end_time: string;
}

function validateWeeklyShifts(shifts: any): string | null {
  if (!Array.isArray(shifts)) return 'shifts must be an array';
  for (const s of shifts) {
    if (typeof s !== 'object' || s == null) return 'each shift must be an object';
    const weekday = Number(s.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return 'each shift.weekday must be 0-6 (0=Sun…6=Sat)';
    if (!s.start_time || !TIME_RE.test(s.start_time)) return 'each shift.start_time is required (HH:MM, 24-hour)';
    if (!s.end_time || !TIME_RE.test(s.end_time)) return 'each shift.end_time is required (HH:MM, 24-hour)';
    if (s.start_time >= s.end_time) return 'each shift.end_time must be after shift.start_time';
  }
  return null;
}

operatingHoursRouter.get('/weekly', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `SELECT id, weekday, start_time, end_time
     FROM gym_operating_hours
     WHERE gym_id = ? AND deleted_at IS NULL
     ORDER BY weekday ASC, start_time ASC`,
    [gymId],
  );
  res.json(rows);
});

operatingHoursRouter.put('/weekly', requireModuleWrite('ORGANIZATION'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const shifts: WeeklyShiftInput[] = Array.isArray(req.body.shifts) ? req.body.shifts : [];
  const err = validateWeeklyShifts(shifts);
  if (err) return res.status(400).json({ error: err });

  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE gym_operating_hours SET deleted_at = UTC_TIMESTAMP(), deleted_by_membership_id = ?
       WHERE gym_id = ? AND deleted_at IS NULL`,
      [gymMembershipId, gymId],
    );
    if (shifts.length > 0) {
      const values = shifts.map(() => '(?, ?, ?, ?, ?)').join(', ');
      const params = shifts.flatMap((s) => [gymId, s.weekday, s.start_time, s.end_time, gymMembershipId]);
      await tx.query(
        `INSERT INTO gym_operating_hours (gym_id, weekday, start_time, end_time, created_by_membership_id)
         VALUES ${values}`,
        params,
      );
    }
  });

  recordAudit(req, { action: 'update', entityType: 'gym_operating_hours', entityId: gymId });

  const { rows } = await db.query(
    `SELECT id, weekday, start_time, end_time
     FROM gym_operating_hours
     WHERE gym_id = ? AND deleted_at IS NULL
     ORDER BY weekday ASC, start_time ASC`,
    [gymId],
  );
  res.json(rows);
});

// ---------------------------------------------------------------------------
// Holidays — one-row-at-a-time CRUD (inline row pattern, per docs/feature-patterns.md).
// ---------------------------------------------------------------------------

const HOLIDAY_SELECT = `
  SELECT h.*, gm_c.name AS created_by_name, gm_m.name AS modified_by_name
  FROM gym_holiday_hours h
  LEFT JOIN gym_memberships gm_c ON gm_c.id = h.created_by_membership_id
  LEFT JOIN gym_memberships gm_m ON gm_m.id = h.modified_by_membership_id
`;

function validateHoliday(body: any): string | null {
  const { date_start, date_end, is_closed, start_time, end_time } = body;
  if (!date_start || !DATE_RE.test(date_start)) return 'date_start is required (YYYY-MM-DD)';
  if (!date_end || !DATE_RE.test(date_end)) return 'date_end is required (YYYY-MM-DD)';
  if (date_end < date_start) return 'date_end must not be before date_start';

  const closed = is_closed === true || is_closed === 1 || is_closed === '1';
  if (closed) {
    if (start_time || end_time) return 'start_time/end_time must not be set when is_closed is true';
  } else {
    if (!start_time || !TIME_RE.test(start_time)) return 'start_time is required (HH:MM, 24-hour) when is_closed is false';
    if (!end_time || !TIME_RE.test(end_time)) return 'end_time is required (HH:MM, 24-hour) when is_closed is false';
    if (start_time >= end_time) return 'end_time must be after start_time';
  }
  return null;
}

operatingHoursRouter.get('/holidays', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `${HOLIDAY_SELECT} WHERE h.gym_id = ? AND h.deleted_at IS NULL ORDER BY h.date_start ASC`,
    [gymId],
  );
  res.json(rows);
});

operatingHoursRouter.post('/holidays', requireModuleWrite('ORGANIZATION'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const err = validateHoliday(req.body);
  if (err) return res.status(400).json({ error: err });

  const { date_start, date_end, start_time, end_time, is_closed, annual_renewal, label } = req.body;
  const closed = is_closed === true || is_closed === 1 || is_closed === '1';
  const renewal = annual_renewal === true || annual_renewal === 1 || annual_renewal === '1';

  const row = await insertAndFetch(
    `INSERT INTO gym_holiday_hours
      (gym_id, date_start, date_end, start_time, end_time, is_closed, annual_renewal, label, created_by_membership_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [gymId, date_start, date_end, closed ? null : start_time, closed ? null : end_time, closed ? 1 : 0, renewal ? 1 : 0, label?.trim() || null, gymMembershipId],
    `${HOLIDAY_SELECT} WHERE h.id = ?`,
    (id) => [id],
  );
  recordAudit(req, { action: 'create', entityType: 'gym_holiday_hours', entityId: String(row.id) });
  res.status(201).json(row);
});

operatingHoursRouter.put('/holidays/:id', requireModuleWrite('ORGANIZATION'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const err = validateHoliday(req.body);
  if (err) return res.status(400).json({ error: err });

  const { date_start, date_end, start_time, end_time, is_closed, annual_renewal, label } = req.body;
  const closed = is_closed === true || is_closed === 1 || is_closed === '1';
  const renewal = annual_renewal === true || annual_renewal === 1 || annual_renewal === '1';

  const { rowCount } = await db.query(
    `UPDATE gym_holiday_hours SET
       date_start     = ?,
       date_end       = ?,
       start_time     = ?,
       end_time       = ?,
       is_closed      = ?,
       annual_renewal = ?,
       label          = ?,
       modified_at    = UTC_TIMESTAMP(),
       modified_by_membership_id = ?
     WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [
      date_start, date_end,
      closed ? null : start_time, closed ? null : end_time,
      closed ? 1 : 0, renewal ? 1 : 0,
      label?.trim() || null,
      gymMembershipId,
      req.params.id, gymId,
    ],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Holiday not found' });

  const { rows } = await db.query(`${HOLIDAY_SELECT} WHERE h.id = ? AND h.gym_id = ?`, [req.params.id, gymId]);
  recordAudit(req, { action: 'update', entityType: 'gym_holiday_hours', entityId: req.params.id });
  res.json(rows[0]);
});

operatingHoursRouter.delete('/holidays/:id', requireModuleWrite('ORGANIZATION'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { rowCount } = await db.query(
    `UPDATE gym_holiday_hours SET deleted_at = UTC_TIMESTAMP(), deleted_by_membership_id = ?
     WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [gymMembershipId, req.params.id, gymId],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Holiday not found' });
  recordAudit(req, { action: 'soft_delete', entityType: 'gym_holiday_hours', entityId: req.params.id });
  res.status(204).send();
});
