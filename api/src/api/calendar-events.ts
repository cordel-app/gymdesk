import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext } from '../infra/tenantContext';
import { requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';

export const calendarEventsRouter = Router();

const STATUSES = ['draft', 'scheduled', 'completed', 'cancelled'] as const;

const SELECT = `
  SELECT
    ce.*,
    at.name   AS activity_type_name,
    at.color  AS activity_type_color,
    sp.name   AS space_name,
    gm.name   AS trainer_name,
    gm2.name  AS created_by_name,
    gm3.name  AS modified_by_name,
    gm4.name  AS deleted_by_name
  FROM calendar_events ce
  LEFT JOIN activity_types  at   ON at.id   = ce.activity_type_id
  LEFT JOIN spaces           sp  ON sp.id   = ce.space_id
  LEFT JOIN gym_memberships gm   ON gm.id   = ce.trainer_membership_id
  LEFT JOIN gym_memberships gm2  ON gm2.id  = ce.created_by_membership_id
  LEFT JOIN gym_memberships gm3  ON gm3.id  = ce.modified_by_membership_id
  LEFT JOIN gym_memberships gm4  ON gm4.id  = ce.deleted_by_membership_id
`;

/** Interval overlap: new event [newStart, newEnd) overlaps existing if newStart < end AND newEnd > start */
async function checkConflict(
  gymId: string,
  field: 'space_id' | 'trainer_membership_id',
  resourceId: number,
  startsAt: string,
  endsAt: string,
  excludeId?: number,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS cnt FROM calendar_events
     WHERE gym_id = ? AND ${field} = ?
       AND status != 'cancelled'
       AND deleted_at IS NULL
       AND id != COALESCE(?, 0)
       AND starts_at < ? AND ends_at > ?`,
    [gymId, resourceId, excludeId ?? null, endsAt, startsAt],
  );
  return rows[0].cnt > 0;
}

calendarEventsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { from, to, space_id, activity_type_id, trainer_membership_id } = req.query;

  const params: any[] = [gymId];
  let sql = `${SELECT} WHERE ce.gym_id = ? AND ce.deleted_at IS NULL`;

  if (from) { sql += ' AND ce.ends_at >= ?'; params.push(from); }
  if (to)   { sql += ' AND ce.starts_at <= ?'; params.push(to); }
  if (space_id)              { sql += ' AND ce.space_id = ?';              params.push(space_id); }
  if (activity_type_id)      { sql += ' AND ce.activity_type_id = ?';      params.push(activity_type_id); }
  if (trainer_membership_id) { sql += ' AND ce.trainer_membership_id = ?'; params.push(trainer_membership_id); }

  sql += ' ORDER BY ce.starts_at ASC';
  const { rows } = await db.query(sql, params);
  res.json(rows);
});

calendarEventsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `${SELECT} WHERE ce.id = ? AND ce.gym_id = ? AND ce.deleted_at IS NULL`,
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Calendar event not found' });
  res.json(rows[0]);
});

calendarEventsRouter.post('/', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const {
    title, activity_type_id, space_id, trainer_membership_id, color,
    starts_at, ends_at, all_day, description, status,
  } = req.body;

  if (!title?.trim())  return res.status(400).json({ error: 'title is required' });
  if (!starts_at)      return res.status(400).json({ error: 'starts_at is required' });
  if (!ends_at)        return res.status(400).json({ error: 'ends_at is required' });
  if (new Date(ends_at) <= new Date(starts_at)) {
    return res.status(400).json({ error: 'ends_at must be after starts_at' });
  }
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }

  if (space_id) {
    const conflict = await checkConflict(gymId, 'space_id', space_id, starts_at, ends_at);
    if (conflict) return res.status(409).json({ error: 'Space is already booked during this time.' });
  }
  if (trainer_membership_id) {
    const conflict = await checkConflict(gymId, 'trainer_membership_id', trainer_membership_id, starts_at, ends_at);
    if (conflict) return res.status(409).json({ error: 'Trainer is already assigned to another event during this time.' });
  }

  try {
    const { insertId } = await db.query(
      `INSERT INTO calendar_events
       (gym_id, title, activity_type_id, space_id, trainer_membership_id, color,
        starts_at, ends_at, all_day, description, status, created_by_membership_id, modified_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, title.trim(), activity_type_id ?? null, space_id ?? null,
       trainer_membership_id ?? null, color ?? null,
       starts_at, ends_at, all_day ? 1 : 0,
       description ?? null, status ?? 'scheduled',
       gymMembershipId ?? null, gymMembershipId ?? null],
    );
    const { rows } = await db.query(`${SELECT} WHERE ce.id = ?`, [insertId]);
    recordAudit(req, { action: 'create', entityType: 'calendar_event', entityId: String(insertId), entityName: title.trim(), next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (e: any) {
    next(e);
  }
});

calendarEventsRouter.put('/:id', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { rows: existing } = await db.query(
    'SELECT * FROM calendar_events WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (existing.length === 0) return res.status(404).json({ error: 'Calendar event not found' });

  const {
    title, activity_type_id, space_id, trainer_membership_id, color,
    starts_at, ends_at, all_day, description, status,
  } = req.body;

  const newStartsAt = starts_at ?? existing[0].starts_at;
  const newEndsAt   = ends_at   ?? existing[0].ends_at;

  if (new Date(newEndsAt) <= new Date(newStartsAt)) {
    return res.status(400).json({ error: 'ends_at must be after starts_at' });
  }
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }

  const resolvedSpaceId   = 'space_id' in req.body ? (space_id ?? null) : existing[0].space_id;
  const resolvedTrainerId = 'trainer_membership_id' in req.body ? (trainer_membership_id ?? null) : existing[0].trainer_membership_id;
  const selfId = Number(req.params.id);

  if (resolvedSpaceId) {
    const conflict = await checkConflict(gymId, 'space_id', resolvedSpaceId, newStartsAt, newEndsAt, selfId);
    if (conflict) return res.status(409).json({ error: 'Space is already booked during this time.' });
  }
  if (resolvedTrainerId) {
    const conflict = await checkConflict(gymId, 'trainer_membership_id', resolvedTrainerId, newStartsAt, newEndsAt, selfId);
    if (conflict) return res.status(409).json({ error: 'Trainer is already assigned to another event during this time.' });
  }

  try {
    await db.query(
      `UPDATE calendar_events SET
        title                  = COALESCE(?, title),
        activity_type_id       = IF(?, ?, activity_type_id),
        space_id               = IF(?, ?, space_id),
        trainer_membership_id  = IF(?, ?, trainer_membership_id),
        color                  = IF(?, ?, color),
        starts_at              = COALESCE(?, starts_at),
        ends_at                = COALESCE(?, ends_at),
        all_day                = COALESCE(?, all_day),
        description            = IF(?, ?, description),
        status                 = COALESCE(?, status),
        modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [
        title?.trim() ?? null,
        'activity_type_id'      in req.body ? 1 : 0, activity_type_id ?? null,
        'space_id'              in req.body ? 1 : 0, space_id ?? null,
        'trainer_membership_id' in req.body ? 1 : 0, trainer_membership_id ?? null,
        'color'                 in req.body ? 1 : 0, color ?? null,
        starts_at ?? null,
        ends_at   ?? null,
        all_day != null ? (all_day ? 1 : 0) : null,
        'description' in req.body ? 1 : 0, description ?? null,
        status ?? null,
        gymMembershipId ?? null,
        req.params.id, gymId,
      ],
    );
    const { rows } = await db.query(`${SELECT} WHERE ce.id = ?`, [req.params.id]);
    recordAudit(req, { action: 'update', entityType: 'calendar_event', entityId: req.params.id, entityName: rows[0].title, next: rows[0] });
    res.json(rows[0]);
  } catch (e: any) {
    next(e);
  }
});

calendarEventsRouter.delete('/:id', requireModuleWrite('TRAINING'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { rows: existing } = await db.query(
    'SELECT title FROM calendar_events WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (existing.length === 0) return res.status(404).json({ error: 'Calendar event not found' });

  await db.query(
    `UPDATE calendar_events SET deleted_at = UTC_TIMESTAMP(), deleted_by_membership_id = ?
     WHERE id = ? AND gym_id = ?`,
    [gymMembershipId ?? null, req.params.id, gymId],
  );
  recordAudit(req, { action: 'delete', entityType: 'calendar_event', entityId: req.params.id, entityName: existing[0].title });
  res.status(204).send();
});
