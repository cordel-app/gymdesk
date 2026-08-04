import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { handleDupEntry, insertAndFetch } from '../infra/db-helpers';

const STATUSES = ['active', 'inactive'] as const;

const SELECT = `
  SELECT cp.*,
         gm_c.name AS created_by_name,
         gm_m.name AS modified_by_name,
         gm_d.name AS deleted_by_name
  FROM class_packages cp
  LEFT JOIN gym_memberships gm_c ON gm_c.id = cp.created_by_membership_id
  LEFT JOIN gym_memberships gm_m ON gm_m.id = cp.modified_by_membership_id
  LEFT JOIN gym_memberships gm_d ON gm_d.id = cp.deleted_by_membership_id
`;

export const classPackagesRouter = Router();

classPackagesRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const status = req.query.status as string | undefined;
  if (status && !STATUSES.includes(status as any)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  const where: string[] = ['cp.gym_id = ?', 'cp.deleted_at IS NULL'];
  const params: any[] = [gymId];
  if (status) { where.push('cp.status = ?'); params.push(status); }
  const { rows } = await db.query(
    `${SELECT} WHERE ${where.join(' AND ')} ORDER BY cp.name ASC`,
    params,
  );
  res.json(rows);
});

classPackagesRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `${SELECT} WHERE cp.id = ? AND cp.gym_id = ?`,
    [req.params.id, gymId],
  );
  if (!rows[0]) return res.status(404).json({ error: 'Class package not found' });
  res.json(rows[0]);
});

function validate(body: any) {
  const sessions = body.number_of_sessions != null ? parseInt(body.number_of_sessions, 10) : null;
  const validity = body.validity_days != null ? parseInt(body.validity_days, 10) : null;
  const price = body.price != null ? parseFloat(body.price) : null;
  if (sessions !== null && (isNaN(sessions) || sessions <= 0)) return 'number_of_sessions must be a positive integer';
  if (validity !== null && (isNaN(validity) || validity < 0)) return 'validity_days must be a non-negative integer';
  if (price !== null && (isNaN(price) || price < 0)) return 'price must be a non-negative number';
  if (body.status && !STATUSES.includes(body.status)) return `status must be one of: ${STATUSES.join(', ')}`;
  return null;
}

classPackagesRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, description, number_of_sessions, price, validity_days, status, notes } = req.body;
  if (!name?.trim() || number_of_sessions == null) {
    return res.status(400).json({ error: 'name and number_of_sessions are required' });
  }
  const err = validate(req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const row = await insertAndFetch(
      `INSERT INTO class_packages
        (gym_id, name, description, number_of_sessions, price, validity_days, status, notes,
         created_by_membership_id, modified_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        gymId,
        name.trim(),
        description?.trim() || null,
        parseInt(number_of_sessions, 10),
        price != null ? parseFloat(price) : 0,
        validity_days != null ? parseInt(validity_days, 10) : 0,
        status ?? 'active',
        notes?.trim() || null,
        gymMembershipId,
        gymMembershipId,
      ],
      `${SELECT} WHERE cp.id = ?`,
      (id) => [id],
    );
    res.status(201).json(row);
  } catch (e: any) {
    handleDupEntry(e, res, next, 'A class package with this name already exists.');
  }
});

classPackagesRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const err = validate(req.body);
  if (err) return res.status(400).json({ error: err });
  const { name, description, number_of_sessions, price, validity_days, status, notes } = req.body;
  try {
    const { rowCount } = await db.query(
      `UPDATE class_packages SET
        name               = COALESCE(?, name),
        description        = IF(?, ?, description),
        number_of_sessions = COALESCE(?, number_of_sessions),
        price              = COALESCE(?, price),
        validity_days      = COALESCE(?, validity_days),
        status             = COALESCE(?, status),
        notes              = IF(?, ?, notes),
        modified_at        = UTC_TIMESTAMP(),
        modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [
        name?.trim() ?? null,
        'description' in req.body ? 1 : 0, description?.trim() ?? null,
        number_of_sessions != null ? parseInt(number_of_sessions, 10) : null,
        price != null ? parseFloat(price) : null,
        validity_days != null ? parseInt(validity_days, 10) : null,
        status ?? null,
        'notes' in req.body ? 1 : 0, notes?.trim() ?? null,
        gymMembershipId,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Class package not found' });
    const { rows } = await db.query(`${SELECT} WHERE cp.id = ? AND cp.gym_id = ?`, [req.params.id, gymId]);
    res.json(rows[0]);
  } catch (e: any) {
    handleDupEntry(e, res, next, 'A class package with this name already exists.');
  }
});

classPackagesRouter.post('/:id/duplicate', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { rows: origRows } = await db.query(
    `${SELECT} WHERE cp.id = ? AND cp.gym_id = ? AND cp.deleted_at IS NULL`,
    [req.params.id, gymId],
  );
  const original = origRows[0];
  if (!original) return res.status(404).json({ error: 'Class package not found' });
  try {
    const row = await insertAndFetch(
      `INSERT INTO class_packages
        (gym_id, name, description, number_of_sessions, price, validity_days, status,
         created_by_membership_id, modified_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        gymId,
        `${original.name} (Copy)`,
        original.description,
        original.number_of_sessions,
        original.price,
        original.validity_days,
        'active',
        gymMembershipId,
        gymMembershipId,
      ],
      `${SELECT} WHERE cp.id = ?`,
      (id) => [id],
    );
    res.status(201).json(row);
  } catch (e: any) {
    handleDupEntry(e, res, next, 'A class package with this name already exists.');
  }
});

classPackagesRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { rowCount } = await db.query(
    `UPDATE class_packages
     SET deleted_at = UTC_TIMESTAMP(), deleted_by_membership_id = ?
     WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [gymMembershipId, req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Class package not found' });
  res.status(204).send();
});
