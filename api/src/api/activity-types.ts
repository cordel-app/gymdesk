import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { handleDupEntry } from '../infra/db-helpers';
import {
  materializeScheduleRule,
  cancelFutureOccurrencesByActivityType,
} from '../domain/scheduleEngine';

const STATUSES = ['active', 'inactive'] as const;

const SELECT = `
  SELECT at.*,
    sp.name   AS default_space_name,
    ctr.name  AS default_center_name,
    gm.name   AS default_trainer_name,
    cb.name   AS created_by_name,
    mb.name   AS modified_by_name,
    db2.name  AS deleted_by_name
  FROM activity_types at
  LEFT JOIN spaces          sp   ON sp.id  = at.default_space_id
  LEFT JOIN centers         ctr  ON ctr.id = at.default_center_id
  LEFT JOIN gym_memberships gm   ON gm.id  = at.default_trainer_membership_id
  LEFT JOIN gym_memberships cb   ON cb.id  = at.created_by_membership_id
  LEFT JOIN gym_memberships mb   ON mb.id  = at.modified_by_membership_id
  LEFT JOIN gym_memberships db2  ON db2.id = at.deleted_by_membership_id
`;

export const activityTypesRouter = Router();

activityTypesRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const status = req.query.status as string | undefined;
  if (status && !STATUSES.includes(status as any)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  const params: any[] = [gymId];
  let sql = `${SELECT} WHERE at.gym_id = ? AND at.deleted_at IS NULL`;
  if (status) { sql += ' AND at.status = ?'; params.push(status); }
  sql += ' ORDER BY at.name ASC';
  const { rows } = await db.query(sql, params);
  res.json(rows);
});

activityTypesRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `${SELECT} WHERE at.id = ? AND at.gym_id = ? AND at.deleted_at IS NULL`,
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Activity type not found' });
  // Attach schedule rules
  const { rows: rules } = await db.query(
    'SELECT * FROM activity_type_schedule_rules WHERE activity_type_id = ? AND gym_id = ? ORDER BY created_at ASC',
    [req.params.id, gymId],
  );
  res.json({ ...rows[0], schedule_rules: rules });
});

function validate(body: any) {
  const duration = body.duration_minutes != null ? parseInt(body.duration_minutes, 10) : null;
  const capacity = body.max_capacity != null ? parseInt(body.max_capacity, 10) : null;
  const intensity = body.intensity_level != null && body.intensity_level !== '' ? parseInt(body.intensity_level, 10) : null;
  if (duration !== null && (isNaN(duration) || duration <= 0)) return 'duration_minutes must be a positive integer';
  if (capacity !== null && (isNaN(capacity) || capacity <= 0)) return 'max_capacity must be a positive integer';
  if (intensity !== null && (isNaN(intensity) || intensity < 1 || intensity > 5)) return 'intensity_level must be between 1 and 5';
  if (body.status && !STATUSES.includes(body.status)) return `status must be one of: ${STATUSES.join(', ')}`;
  return null;
}

async function validateCenter(gymId: string, centerId: number | null): Promise<boolean> {
  if (!centerId) return true;
  const { rows } = await db.query(
    'SELECT id FROM centers WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [centerId, gymId],
  );
  return rows.length > 0;
}

async function validateSpace(gymId: string, spaceId: number | null, centerId: number | null): Promise<string | null> {
  if (!spaceId) return null;
  const { rows } = await db.query(
    'SELECT id, center_id FROM spaces WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [spaceId, gymId],
  );
  if (rows.length === 0) return 'Space not found';
  if (centerId && rows[0].center_id !== centerId) return 'Space does not belong to the selected center';
  return null;
}

activityTypesRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, description, duration_minutes, intensity_level, max_capacity, status,
          default_space_id, default_trainer_membership_id, default_center_id, color } = req.body;
  if (!name?.trim() || duration_minutes == null || max_capacity == null) {
    return res.status(400).json({ error: 'name, duration_minutes and max_capacity are required' });
  }
  const err = validate(req.body); if (err) return res.status(400).json({ error: err });

  const centerId = default_center_id ? parseInt(default_center_id, 10) : null;
  const spaceId = default_space_id ? parseInt(default_space_id, 10) : null;
  if (!(await validateCenter(gymId, centerId))) return res.status(404).json({ error: 'Center not found' });
  const spaceErr = await validateSpace(gymId, spaceId, centerId);
  if (spaceErr) return res.status(400).json({ error: spaceErr });

  try {
    const { insertId } = await db.query(
      `INSERT INTO activity_types
       (gym_id, name, description, duration_minutes, intensity_level, max_capacity, status,
        default_space_id, default_trainer_membership_id, default_center_id, color,
        created_by_membership_id, modified_at, modified_by_membership_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(),?)`,
      [gymId, name.trim(), description ?? null,
       parseInt(duration_minutes, 10),
       intensity_level != null && intensity_level !== '' ? parseInt(intensity_level, 10) : null,
       parseInt(max_capacity, 10),
       status ?? 'active',
       spaceId, default_trainer_membership_id ?? null, centerId, color ?? null,
       gymMembershipId ?? null, gymMembershipId ?? null],
    );
    const { rows } = await db.query(`${SELECT} WHERE at.id = ?`, [insertId]);
    const row = { ...rows[0], schedule_rules: [] };
    recordAudit(req, { action: 'create', entityType: 'activity_type', entityId: row.id, entityName: row.name, next: row });
    res.status(201).json(row);
  } catch (e: any) {
    handleDupEntry(e, res, next, 'An activity type with this name already exists.');
  }
});

activityTypesRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const err = validate(req.body); if (err) return res.status(400).json({ error: err });
  const { name, description, duration_minutes, intensity_level, max_capacity, status,
          default_space_id, default_trainer_membership_id, default_center_id, color } = req.body;

  const centerId = 'default_center_id' in req.body
    ? (default_center_id ? parseInt(default_center_id, 10) : null)
    : undefined;
  const spaceId = 'default_space_id' in req.body
    ? (default_space_id ? parseInt(default_space_id, 10) : null)
    : undefined;

  if (centerId !== undefined && !(await validateCenter(gymId, centerId))) {
    return res.status(404).json({ error: 'Center not found' });
  }
  if (spaceId !== undefined) {
    // Resolve effective centerId for cross-validation
    let effectiveCenterId: number | null | undefined = centerId;
    if (effectiveCenterId === undefined && centerId === undefined) {
      // centerId not being changed; fetch current
      const { rows: cur } = await db.query('SELECT default_center_id FROM activity_types WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
      effectiveCenterId = cur[0]?.default_center_id ?? null;
    }
    const spaceErr = await validateSpace(gymId, spaceId, effectiveCenterId ?? null);
    if (spaceErr) return res.status(400).json({ error: spaceErr });
  }

  try {
    const { rowCount } = await db.query(
      `UPDATE activity_types SET
        name                           = COALESCE(?, name),
        description                    = IF(?, ?, description),
        duration_minutes               = COALESCE(?, duration_minutes),
        intensity_level                = IF(?, ?, intensity_level),
        max_capacity                   = COALESCE(?, max_capacity),
        status                         = COALESCE(?, status),
        default_space_id               = IF(?, ?, default_space_id),
        default_trainer_membership_id  = IF(?, ?, default_trainer_membership_id),
        default_center_id              = IF(?, ?, default_center_id),
        color                          = IF(?, ?, color),
        modified_at                    = UTC_TIMESTAMP(),
        modified_by_membership_id      = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [
        name?.trim() ?? null,
        'description' in req.body ? 1 : 0, description ?? null,
        duration_minutes != null ? parseInt(duration_minutes, 10) : null,
        'intensity_level' in req.body ? 1 : 0, intensity_level != null && intensity_level !== '' ? parseInt(intensity_level, 10) : null,
        max_capacity != null ? parseInt(max_capacity, 10) : null,
        status ?? null,
        'default_space_id' in req.body ? 1 : 0, spaceId ?? null,
        'default_trainer_membership_id' in req.body ? 1 : 0, default_trainer_membership_id ?? null,
        'default_center_id' in req.body ? 1 : 0, centerId ?? null,
        'color' in req.body ? 1 : 0, color ?? null,
        gymMembershipId ?? null,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Activity type not found' });
    const { rows } = await db.query(`${SELECT} WHERE at.id = ? AND at.gym_id = ?`, [req.params.id, gymId]);
    const { rows: rules } = await db.query(
      'SELECT * FROM activity_type_schedule_rules WHERE activity_type_id = ? ORDER BY created_at ASC',
      [req.params.id],
    );
    const row = { ...rows[0], schedule_rules: rules };
    recordAudit(req, { action: 'update', entityType: 'activity_type', entityId: req.params.id, entityName: rows[0].name, next: rows[0] });
    res.json(row);
  } catch (e: any) {
    handleDupEntry(e, res, next, 'An activity type with this name already exists.');
  }
});

activityTypesRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { rows: existing } = await db.query(
    'SELECT name FROM activity_types WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (existing.length === 0) return res.status(404).json({ error: 'Activity type not found' });

  // Cancel future calendar events from schedule rules (preserve past ones)
  await cancelFutureOccurrencesByActivityType(parseInt(req.params.id, 10));

  await db.query(
    'UPDATE activity_types SET deleted_at = UTC_TIMESTAMP(), deleted_by_membership_id = ? WHERE id = ? AND gym_id = ?',
    [gymMembershipId ?? null, req.params.id, gymId],
  );
  recordAudit(req, { action: 'delete', entityType: 'activity_type', entityId: req.params.id, entityName: existing[0].name });
  res.status(204).send();
});

activityTypesRouter.post('/:id/duplicate', requireRole('admin'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { rows: existing } = await db.query(`${SELECT} WHERE at.id = ? AND at.gym_id = ? AND at.deleted_at IS NULL`, [req.params.id, gymId]);
  if (existing.length === 0) return res.status(404).json({ error: 'Activity type not found' });
  const src = existing[0];

  const { rows: gym } = await db.query('SELECT timezone FROM gyms WHERE id = ?', [gymId]);
  const gymTimezone = gym[0]?.timezone ?? 'Europe/Madrid';

  const newId = await db.transaction(async (tx) => {
    const { insertId } = await tx.query(
      `INSERT INTO activity_types
       (gym_id, name, description, duration_minutes, intensity_level, max_capacity, status,
        default_space_id, default_trainer_membership_id, default_center_id, color,
        created_by_membership_id, modified_at, modified_by_membership_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(),?)`,
      [gymId, `${src.name} (copy)`, src.description, src.duration_minutes,
       src.intensity_level, src.max_capacity, 'active',
       src.default_space_id, src.default_trainer_membership_id, src.default_center_id, src.color,
       gymMembershipId ?? null, gymMembershipId ?? null],
    );

    const { rows: srcRules } = await tx.query(
      'SELECT * FROM activity_type_schedule_rules WHERE activity_type_id = ? AND gym_id = ?',
      [req.params.id, gymId],
    );

    for (const rule of srcRules) {
      await tx.query(
        `INSERT INTO activity_type_schedule_rules
         (gym_id, activity_type_id, type, start_date, end_date, weekday, ordinal, start_time, end_time)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [gymId, insertId, rule.type, rule.start_date, rule.end_date,
         rule.weekday, rule.ordinal, rule.start_time, rule.end_time],
      );
    }

    return insertId;
  });

  // Materialize calendar events for each duplicated rule
  const { rows: newRules } = await db.query(
    'SELECT id FROM activity_type_schedule_rules WHERE activity_type_id = ?',
    [newId],
  );
  for (const rule of newRules) {
    await materializeScheduleRule(rule.id, gymTimezone);
  }

  const { rows } = await db.query(`${SELECT} WHERE at.id = ?`, [newId]);
  const { rows: rules } = await db.query(
    'SELECT * FROM activity_type_schedule_rules WHERE activity_type_id = ? ORDER BY created_at ASC',
    [newId],
  );
  recordAudit(req, { action: 'create', entityType: 'activity_type', entityId: newId, entityName: rows[0].name });
  res.status(201).json({ ...rows[0], schedule_rules: rules });
});

activityTypesRouter.post('/:id/restore', requireRole('admin'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { rows: existing } = await db.query(
    'SELECT name FROM activity_types WHERE id = ? AND gym_id = ? AND deleted_at IS NOT NULL',
    [req.params.id, gymId],
  );
  if (existing.length === 0) return res.status(404).json({ error: 'Deleted activity type not found' });
  await db.query(
    `UPDATE activity_types
     SET deleted_at = NULL, deleted_by_membership_id = NULL,
         status = 'active', modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
     WHERE id = ? AND gym_id = ?`,
    [gymMembershipId ?? null, req.params.id, gymId],
  );
  recordAudit(req, { action: 'restore', entityType: 'activity_type', entityId: req.params.id, entityName: existing[0].name });
  res.status(204).send();
});
