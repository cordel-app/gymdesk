import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { resolveCenterId } from '../infra/centerContext';
import { recordAudit } from '../infra/audit';

const STATUSES = ['active', 'inactive'] as const;

export const resourcesRouter = Router();

resourcesRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { status, center_id } = req.query as Record<string, string | undefined>;
  if (status && !STATUSES.includes(status as any)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  const where: string[] = ['gym_id = ?', 'deleted_at IS NULL'];
  const params: any[] = [gymId];
  if (status) { where.push('status = ?'); params.push(status); }
  if (center_id) { where.push('center_id = ?'); params.push(center_id); }
  const { rows } = await db.query(
    `SELECT * FROM resources WHERE ${where.join(' AND ')} ORDER BY name ASC`,
    params,
  );
  res.json(rows);
});

resourcesRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM resources WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Resource not found' });
  res.json(rows[0]);
});

resourcesRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, description, quantity, status, center_id } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const qty = quantity != null ? parseInt(quantity, 10) : 1;
  if (isNaN(qty) || qty <= 0) return res.status(400).json({ error: 'quantity must be a positive integer' });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  try {
    const resolvedCenterId = await resolveCenterId(gymId, req, center_id);
    const { insertId } = await db.query(
      `INSERT INTO resources (name, description, quantity, status, gym_id, center_id, modified_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name.trim(), description ?? null, qty, status ?? 'active', gymId, resolvedCenterId, gymMembershipId],
    );
    const { rows } = await db.query('SELECT * FROM resources WHERE id = ?', [insertId]);
    recordAudit(req, { action: 'create', entityType: 'resource', entityId: insertId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A resource with this name already exists in this center.' });
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

resourcesRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, description, quantity, status } = req.body;
  const qty = quantity != null ? parseInt(quantity, 10) : null;
  if (qty !== null && (isNaN(qty) || qty <= 0)) return res.status(400).json({ error: 'quantity must be a positive integer' });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  try {
    const { rowCount } = await db.query(
      `UPDATE resources SET
        name        = COALESCE(?, name),
        description = IF(?, ?, description),
        quantity    = COALESCE(?, quantity),
        status      = COALESCE(?, status),
        modified_at = UTC_TIMESTAMP(),
        modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [
        name?.trim() ?? null,
        'description' in req.body ? 1 : 0, description ?? null,
        qty, status ?? null,
        gymMembershipId,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Resource not found' });
    const { rows } = await db.query('SELECT * FROM resources WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
    res.json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A resource with this name already exists in this center.' });
    next(err);
  }
});

resourcesRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { rowCount } = await db.query(
    `UPDATE resources SET deleted_at = UTC_TIMESTAMP(), modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
     WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [gymMembershipId, req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Resource not found' });
  recordAudit(req, { action: 'soft_delete', entityType: 'resource', entityId: req.params.id });
  res.status(204).send();
});
