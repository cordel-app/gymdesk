import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { handleDupEntry } from '../infra/db-helpers';

export const specialitiesRouter = Router();

const STATUSES = ['active', 'inactive'] as const;

async function getCallerMembershipId(req: any): Promise<number | null> {
  const userId = req.auth?.userId;
  if (!userId) return null;
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT id FROM gym_memberships WHERE gym_id = ? AND user_id = ? LIMIT 1',
    [gymId, userId],
  );
  return rows.length > 0 ? rows[0].id : null;
}

const SELECT_WITH_NAMES = `
  SELECT s.*,
    cbm.name AS created_by_name,
    mbm.name AS modified_by_name,
    dbm.name AS deleted_by_name
  FROM specialities s
  LEFT JOIN gym_memberships cbm ON cbm.id = s.created_by_membership_id
  LEFT JOIN gym_memberships mbm ON mbm.id = s.modified_by_membership_id
  LEFT JOIN gym_memberships dbm ON dbm.id = s.deleted_by_membership_id
`;

specialitiesRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `${SELECT_WITH_NAMES} WHERE s.gym_id = ? AND s.deleted_at IS NULL ORDER BY s.name ASC`,
    [gymId],
  );
  res.json(rows);
});

specialitiesRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `${SELECT_WITH_NAMES} WHERE s.id = ? AND s.gym_id = ?`,
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Speciality not found' });
  res.json(rows[0]);
});

specialitiesRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, description, status } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  const callerMemberId = await getCallerMembershipId(req);
  try {
    const { insertId } = await db.query(
      'INSERT INTO specialities (gym_id, name, description, status, created_by_membership_id) VALUES (?, ?, ?, ?, ?)',
      [gymId, name.trim(), description ?? null, status ?? 'active', callerMemberId],
    );
    const { rows } = await db.query(`${SELECT_WITH_NAMES} WHERE s.id = ?`, [insertId]);
    res.status(201).json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A speciality with this name already exists.');
  }
});

specialitiesRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, description, status } = req.body;
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  const callerMemberId = await getCallerMembershipId(req);
  try {
    const { rowCount } = await db.query(
      `UPDATE specialities SET
        name                    = COALESCE(?, name),
        description             = IF(?, ?, description),
        status                  = COALESCE(?, status),
        modified_at             = NOW(),
        modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [
        name?.trim() ?? null,
        'description' in req.body ? 1 : 0, description ?? null,
        status ?? null,
        callerMemberId,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Speciality not found' });
    const { rows } = await db.query(`${SELECT_WITH_NAMES} WHERE s.id = ?`, [req.params.id]);
    res.json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A speciality with this name already exists.');
  }
});

specialitiesRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const callerMemberId = await getCallerMembershipId(req);
  const { rowCount } = await db.query(
    'UPDATE specialities SET deleted_at = NOW(), deleted_by_membership_id = ? WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [callerMemberId, req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Speciality not found' });
  res.status(204).send();
});

specialitiesRouter.post('/:id/duplicate', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { rows: origRows } = await db.query(
    'SELECT * FROM specialities WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (origRows.length === 0) return res.status(404).json({ error: 'Speciality not found' });
  const orig = origRows[0];
  const callerMemberId = await getCallerMembershipId(req);
  try {
    const { insertId } = await db.query(
      'INSERT INTO specialities (gym_id, name, description, status, created_by_membership_id) VALUES (?, ?, ?, ?, ?)',
      [gymId, `${orig.name} (Copy)`, orig.description ?? null, orig.status, callerMemberId],
    );
    const { rows } = await db.query(`${SELECT_WITH_NAMES} WHERE s.id = ?`, [insertId]);
    res.status(201).json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A speciality with this name already exists.');
  }
});
