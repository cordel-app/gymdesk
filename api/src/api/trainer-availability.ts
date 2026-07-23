import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { resolveCenterId } from '../infra/centerContext';
import { recordAudit } from '../infra/audit';
import { gymFetchOne, insertAndFetch } from '../infra/db-helpers';

const STATUSES = ['active', 'inactive'] as const;

export const trainerAvailabilityRouter = Router();

function validateShape(body: any): string | null {
  const isRecurring = body.is_recurring !== false && body.is_recurring !== 0;
  if (isRecurring) {
    if (body.weekday == null || body.weekday < 0 || body.weekday > 6) return 'weekday (0-6) is required for recurring availability';
    if (body.specific_date) return 'specific_date must not be set for recurring availability';
  } else {
    if (!body.specific_date) return 'specific_date is required for one-off availability';
    if (body.weekday != null) return 'weekday must not be set for one-off availability';
  }
  if (!body.starts_time || !body.ends_time) return 'starts_time and ends_time are required';
  if (body.starts_time >= body.ends_time) return 'ends_time must be after starts_time';
  return null;
}

trainerAvailabilityRouter.get('/', async (req, res) => {
  const { gymId, role, gymMembershipId } = getTenantContext(req);
  const { center_id, trainer_membership_id, status } = req.query as Record<string, string | undefined>;
  const where: string[] = ['gym_id = ?', 'deleted_at IS NULL'];
  const params: any[] = [gymId];
  if (center_id) { where.push('center_id = ?'); params.push(center_id); }
  if (status && STATUSES.includes(status as any)) { where.push('status = ?'); params.push(status); }
  // Coaches only see their own availability by default; explicit filter still respected for admin/staff.
  if (trainer_membership_id) {
    where.push('trainer_membership_id = ?');
    params.push(trainer_membership_id);
  }
  const { rows } = await db.query(
    `SELECT * FROM trainer_availability WHERE ${where.join(' AND ')} ORDER BY is_recurring DESC, weekday ASC, specific_date ASC, starts_time ASC`,
    params,
  );
  res.json(rows);
});

trainerAvailabilityRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const row = await gymFetchOne('trainer_availability', req.params.id, gymId, { softDelete: true });
  if (!row) return res.status(404).json({ error: 'Availability window not found' });
  res.json(row);
});

trainerAvailabilityRouter.post('/', requireModuleWrite('ORGANIZATION'), async (req, res, next) => {
  const { gymId, role, gymMembershipId } = getTenantContext(req);
  const { trainer_membership_id, is_recurring, weekday, specific_date, starts_time, ends_time, notes, status, center_id } = req.body;

  if (!trainer_membership_id) return res.status(400).json({ error: 'trainer_membership_id is required' });
  const trainerId = Number(trainer_membership_id);

  const shapeError = validateShape(req.body);
  if (shapeError) return res.status(400).json({ error: shapeError });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });

  const { rows: trainerRows } = await db.query(
    "SELECT id FROM gym_memberships WHERE id = ? AND gym_id = ? AND role IN ('trainer_performance','trainer_perf_nutrition')",
    [trainerId, gymId],
  );
  if (trainerRows.length === 0) return res.status(404).json({ error: 'Trainer not found' });

  const isRecurring = is_recurring !== false && is_recurring !== 0;
  try {
    const resolvedCenterId = await resolveCenterId(gymId, req, center_id);
    const row = await insertAndFetch(
      `INSERT INTO trainer_availability
       (gym_id, center_id, trainer_membership_id, is_recurring, weekday, specific_date, starts_time, ends_time, notes, status, modified_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, resolvedCenterId, trainerId, isRecurring, isRecurring ? weekday : null, isRecurring ? null : specific_date,
       starts_time, ends_time, notes ?? null, status ?? 'active', gymMembershipId],
      'SELECT * FROM trainer_availability WHERE id = ?',
      (id) => [id],
    );
    recordAudit(req, { action: 'create', entityType: 'trainer_availability', entityId: row.id, next: row });
    res.status(201).json(row);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

trainerAvailabilityRouter.put('/:id', requireModuleWrite('ORGANIZATION'), async (req, res, next) => {
  const { gymId, role, gymMembershipId } = getTenantContext(req);
  const { rows: existingRows } = await db.query(
    'SELECT * FROM trainer_availability WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (existingRows.length === 0) return res.status(404).json({ error: 'Availability window not found' });
  const existing = existingRows[0];
  const merged = { ...existing, ...req.body };
  const shapeError = validateShape(merged);
  if (shapeError) return res.status(400).json({ error: shapeError });
  const { status } = req.body;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });

  const isRecurring = merged.is_recurring !== false && merged.is_recurring !== 0;
  const { rowCount } = await db.query(
    `UPDATE trainer_availability SET
      is_recurring   = ?,
      weekday        = ?,
      specific_date  = ?,
      starts_time    = ?,
      ends_time      = ?,
      notes          = IF(?, ?, notes),
      status         = COALESCE(?, status),
      modified_at    = UTC_TIMESTAMP(),
      modified_by_membership_id = ?
     WHERE id = ? AND gym_id = ?`,
    [
      isRecurring, isRecurring ? merged.weekday : null, isRecurring ? null : merged.specific_date,
      merged.starts_time, merged.ends_time,
      'notes' in req.body ? 1 : 0, req.body.notes ?? null,
      status ?? null,
      gymMembershipId,
      req.params.id, gymId,
    ],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Availability window not found' });
  const { rows } = await db.query('SELECT * FROM trainer_availability WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
  res.json(rows[0]);
});

trainerAvailabilityRouter.delete('/:id', requireModuleWrite('ORGANIZATION'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { rowCount } = await db.query(
    `UPDATE trainer_availability SET deleted_at = UTC_TIMESTAMP(), modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
     WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [gymMembershipId, req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Availability window not found' });
  recordAudit(req, { action: 'soft_delete', entityType: 'trainer_availability', entityId: req.params.id });
  res.status(204).send();
});
