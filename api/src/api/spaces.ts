import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { resolveCenterId } from '../infra/centerContext';
import { recordAudit } from '../infra/audit';
import { gymFetchOne, handleDupEntry, insertAndFetch } from '../infra/db-helpers';

const STATUSES = ['active', 'inactive', 'under_maintenance'] as const;

const SELECT = `
  SELECT s.*, c.name AS center_name
  FROM spaces s
  LEFT JOIN centers c ON c.id = s.center_id
`;

export const spacesRouter = Router();

spacesRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { status, center_id, search, sort } = req.query as Record<string, string | undefined>;
  if (status && !STATUSES.includes(status as any)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }

  const where: string[] = ['s.gym_id = ?', 's.deleted_at IS NULL'];
  const params: any[] = [gymId];

  if (status) { where.push('s.status = ?'); params.push(status); }
  if (center_id) { where.push('s.center_id = ?'); params.push(center_id); }
  if (search) {
    where.push('(s.name LIKE ? OR s.description LIKE ? OR c.name LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  const ORDER_MAP: Record<string, string> = {
    name: 's.name ASC',
    center: 'c.name ASC',
    capacity: 's.capacity ASC',
    created: 's.created_at DESC',
    status: 's.status ASC',
  };
  const orderBy = ORDER_MAP[sort ?? ''] ?? 's.name ASC';

  const { rows } = await db.query(
    `${SELECT} WHERE ${where.join(' AND ')} ORDER BY ${orderBy}`,
    params,
  );
  res.json(rows);
});

spacesRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `${SELECT} WHERE s.id = ? AND s.gym_id = ?`,
    [req.params.id, gymId],
  );
  if (!rows[0]) return res.status(404).json({ error: 'Space not found' });
  res.json(rows[0]);
});

spacesRouter.get('/:id/activity-types', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const space = await gymFetchOne('spaces', req.params.id, gymId, { softDelete: true });
  if (!space) return res.status(404).json({ error: 'Space not found' });
  const { rows } = await db.query(
    `SELECT at.id, at.name, at.status
     FROM space_activity_types sat
     JOIN activity_types at ON at.id = sat.activity_type_id
     WHERE sat.space_id = ? AND sat.gym_id = ?
     ORDER BY at.name ASC`,
    [req.params.id, gymId],
  );
  res.json(rows);
});

spacesRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, description, capacity, status, center_id, notes, opening_time, closing_time } = req.body;
  if (!name || capacity == null) return res.status(400).json({ error: 'name and capacity are required' });
  const cap = parseInt(capacity, 10);
  if (isNaN(cap) || cap <= 0) return res.status(400).json({ error: 'capacity must be a positive integer' });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  try {
    const resolvedCenterId = await resolveCenterId(gymId, req, center_id);
    const row = await insertAndFetch(
      `INSERT INTO spaces
        (name, description, capacity, status, gym_id, center_id, notes, opening_time, closing_time,
         created_by_membership_id, modified_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name.trim(), description ?? null, cap, status ?? 'active', gymId, resolvedCenterId,
        notes ?? null, opening_time ?? null, closing_time ?? null,
        gymMembershipId, gymMembershipId,
      ],
      `${SELECT} WHERE s.id = ?`,
      (id) => [id],
    );
    recordAudit(req, { action: 'create', entityType: 'space', entityId: String(row.id) });
    res.status(201).json(row);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    handleDupEntry(err, res, next, 'A space with this name already exists.');
  }
});

spacesRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, description, capacity, status, center_id, notes, opening_time, closing_time } = req.body;
  const cap = capacity != null ? parseInt(capacity, 10) : null;
  if (cap !== null && (isNaN(cap) || cap <= 0)) return res.status(400).json({ error: 'capacity must be a positive integer' });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  try {
    const { rowCount } = await db.query(
      `UPDATE spaces SET
        name         = COALESCE(?, name),
        description  = IF(?, ?, description),
        capacity     = COALESCE(?, capacity),
        status       = COALESCE(?, status),
        center_id    = IF(?, ?, center_id),
        notes        = IF(?, ?, notes),
        opening_time = IF(?, ?, opening_time),
        closing_time = IF(?, ?, closing_time),
        modified_at  = UTC_TIMESTAMP(),
        modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [
        name?.trim() ?? null,
        'description' in req.body ? 1 : 0, description ?? null,
        cap,
        status ?? null,
        'center_id' in req.body ? 1 : 0, center_id ?? null,
        'notes' in req.body ? 1 : 0, notes ?? null,
        'opening_time' in req.body ? 1 : 0, opening_time ?? null,
        'closing_time' in req.body ? 1 : 0, closing_time ?? null,
        gymMembershipId,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Space not found' });
    const { rows } = await db.query(`${SELECT} WHERE s.id = ? AND s.gym_id = ?`, [req.params.id, gymId]);
    recordAudit(req, { action: 'update', entityType: 'space', entityId: req.params.id });
    res.json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A space with this name already exists.');
  }
});

spacesRouter.put('/:id/activity-types', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const spaceId = String(req.params.id);
  const space = await gymFetchOne('spaces', spaceId, gymId, { softDelete: true });
  if (!space) return res.status(404).json({ error: 'Space not found' });

  const ids: number[] = Array.isArray(req.body.activity_type_ids) ? req.body.activity_type_ids : [];

  await db.query('DELETE FROM space_activity_types WHERE space_id = ? AND gym_id = ?', [spaceId, gymId]);
  if (ids.length > 0) {
    const values = ids.map(() => '(?, ?, ?)').join(', ');
    const params = ids.flatMap((id) => [spaceId, id, gymId]);
    await db.query(`INSERT INTO space_activity_types (space_id, activity_type_id, gym_id) VALUES ${values}`, params);
  }
  res.status(204).send();
});

spacesRouter.post('/:id/duplicate', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const spaceId = String(req.params.id);
  const original = await gymFetchOne('spaces', spaceId, gymId, { softDelete: true });
  if (!original) return res.status(404).json({ error: 'Space not found' });

  try {
    const row = await insertAndFetch(
      `INSERT INTO spaces
        (name, description, capacity, status, gym_id, center_id, notes, opening_time, closing_time,
         created_by_membership_id, modified_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `${original.name} (Copy)`, original.description, original.capacity,
        'active', gymId, original.center_id,
        original.notes, original.opening_time, original.closing_time,
        gymMembershipId, gymMembershipId,
      ],
      `${SELECT} WHERE s.id = ?`,
      (id) => [id],
    );

    // Copy activity type assignments
    const { rows: ats } = await db.query(
      'SELECT activity_type_id FROM space_activity_types WHERE space_id = ? AND gym_id = ?',
      [req.params.id, gymId],
    );
    if (ats.length > 0) {
      const values = ats.map(() => '(?, ?, ?)').join(', ');
      const params = ats.flatMap((a: any) => [row.id, a.activity_type_id, gymId]);
      await db.query(`INSERT INTO space_activity_types (space_id, activity_type_id, gym_id) VALUES ${values}`, params);
    }

    recordAudit(req, { action: 'create', entityType: 'space', entityId: String(row.id) });
    res.status(201).json(row);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A space with this name already exists.');
  }
});

spacesRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { rowCount } = await db.query(
    `UPDATE spaces SET
       status = 'deleted',
       deleted_at = UTC_TIMESTAMP(),
       modified_at = UTC_TIMESTAMP(),
       modified_by_membership_id = ?,
       deleted_by_membership_id = ?
     WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [gymMembershipId, gymMembershipId, req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Space not found' });
  recordAudit(req, { action: 'soft_delete', entityType: 'space', entityId: req.params.id });
  res.status(204).send();
});
