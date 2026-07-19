import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { getCenterContext } from '../infra/centerContext';
import { recordAudit } from '../infra/audit';

const STATUSES = ['active', 'inactive'] as const;

export const centersRouter = Router();

// Tables that reference centers.id — checked before a delete is allowed.
// [table, column, softDeleted] — softDeleted tables are only "dependent" via
// their non-deleted rows; bookings has no soft delete, so every row counts.
const DEPENDENT_TABLES: Array<[string, string, boolean]> = [
  ['member_centers', 'center_id', true],
  ['rooms', 'center_id', true],
  ['class_sessions', 'center_id', true],
  ['bookings', 'center_id', false],
  ['trainer_availability', 'center_id', true],
  ['events', 'center_id', true],
];

async function firstDependentTable(centerId: number, gymId: string): Promise<string | null> {
  for (const [table, column, softDeleted] of DEPENDENT_TABLES) {
    const clause = softDeleted ? 'AND deleted_at IS NULL' : '';
    const { rows } = await db.query(
      `SELECT 1 FROM ${table} WHERE ${column} = ? AND gym_id = ? ${clause} LIMIT 1`,
      [centerId, gymId],
    );
    if (rows.length > 0) return table;
  }
  return null;
}

centersRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { allowedCenterIds } = getCenterContext(req);
  const status = req.query.status as string | undefined;
  if (status && !STATUSES.includes(status as any)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  const where: string[] = ['c.gym_id = ?', 'c.deleted_at IS NULL'];
  const params: any[] = [gymId];
  if (status) { where.push('c.status = ?'); params.push(status); }
  if (allowedCenterIds) {
    if (allowedCenterIds.length === 0) return res.json([]);
    where.push(`c.id IN (${allowedCenterIds.map(() => '?').join(',')})`);
    params.push(...allowedCenterIds);
  }
  const { rows } = await db.query(
    `SELECT c.*,
            cbm.name AS created_by_name,
            mbm.name AS modified_by_name,
            (SELECT COUNT(*)
               FROM member_centers mc
               JOIN members mem ON mem.id = mc.member_id AND mem.deleted_at IS NULL
              WHERE mc.center_id = c.id AND mc.gym_id = c.gym_id AND mc.deleted_at IS NULL
            ) AS active_member_count
       FROM centers c
       LEFT JOIN gym_memberships cbm ON cbm.id = c.created_by_membership_id
       LEFT JOIN gym_memberships mbm ON mbm.id = c.modified_by_membership_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.name ASC`,
    params,
  );
  res.json(rows);
});

centersRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { allowedCenterIds } = getCenterContext(req);
  if (allowedCenterIds && !allowedCenterIds.includes(Number(req.params.id))) {
    return res.status(404).json({ error: 'Center not found' });
  }
  const { rows } = await db.query(
    `SELECT c.*,
            cbm.name AS created_by_name,
            mbm.name AS modified_by_name,
            dbm.name AS deleted_by_name,
            (SELECT COUNT(*)
               FROM member_centers mc
               JOIN members mem ON mem.id = mc.member_id AND mem.deleted_at IS NULL
              WHERE mc.center_id = c.id AND mc.gym_id = c.gym_id AND mc.deleted_at IS NULL
            ) AS active_member_count
       FROM centers c
       LEFT JOIN gym_memberships cbm ON cbm.id = c.created_by_membership_id
       LEFT JOIN gym_memberships mbm ON mbm.id = c.modified_by_membership_id
       LEFT JOIN gym_memberships dbm ON dbm.id = c.deleted_by_membership_id
      WHERE c.id = ? AND c.gym_id = ? AND c.deleted_at IS NULL`,
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Center not found' });
  res.json(rows[0]);
});

centersRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, code, address, phone, email, status } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  try {
    const { insertId } = await db.query(
      `INSERT INTO centers (name, code, address, phone, email, status, gym_id, created_by_membership_id, modified_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name.trim(), code ?? null, address ?? null, phone ?? null, email ?? null, status ?? 'active', gymId, gymMembershipId, gymMembershipId],
    );
    const { rows } = await db.query('SELECT * FROM centers WHERE id = ?', [insertId]);
    recordAudit(req, { action: 'create', entityType: 'center', entityId: insertId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A center with this name already exists.' });
    next(err);
  }
});

centersRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, code, address, phone, email, status } = req.body;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  try {
    const { rowCount } = await db.query(
      `UPDATE centers SET
        name       = COALESCE(?, name),
        code       = IF(?, ?, code),
        address    = IF(?, ?, address),
        phone      = IF(?, ?, phone),
        email      = IF(?, ?, email),
        status     = COALESCE(?, status),
        modified_at = UTC_TIMESTAMP(),
        modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [
        name?.trim() ?? null,
        'code' in req.body ? 1 : 0, code ?? null,
        'address' in req.body ? 1 : 0, address ?? null,
        'phone' in req.body ? 1 : 0, phone ?? null,
        'email' in req.body ? 1 : 0, email ?? null,
        status ?? null,
        gymMembershipId,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Center not found' });
    const { rows } = await db.query('SELECT * FROM centers WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
    recordAudit(req, { action: 'update', entityType: 'center', entityId: req.params.id, next: rows[0] });
    res.json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A center with this name already exists.' });
    next(err);
  }
});

centersRouter.delete('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  try {
    const dependent = await firstDependentTable(Number(req.params.id), gymId);
    if (dependent) {
      return res.status(409).json({ error: `Cannot delete center: it still has ${dependent.replace(/_/g, ' ')}.` });
    }
    const { rowCount } = await db.query(
      `UPDATE centers SET deleted_at = UTC_TIMESTAMP(), modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?, deleted_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [gymMembershipId, gymMembershipId, req.params.id, gymId],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Center not found' });
    recordAudit(req, { action: 'soft_delete', entityType: 'center', entityId: req.params.id });
    res.status(204).send();
  } catch (err) { next(err); }
});
