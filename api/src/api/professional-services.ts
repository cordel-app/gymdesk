import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { handleDupEntry } from '../infra/db-helpers';

export const professionalServicesRouter = Router();

const SELECT = `
  SELECT
    ps.id,
    ps.gym_id,
    ps.name,
    ps.description,
    ps.is_system,
    ps.system_key,
    ps.deleted_at,
    ps.created_at,
    ps.created_by_membership_id,
    ps.updated_at,
    ps.updated_by_membership_id,
    gps.status
  FROM professional_services ps
  JOIN gym_professional_services gps ON gps.professional_service_id = ps.id AND gps.gym_id = ?
`;

const VALID_STATUSES = ['active', 'inactive'] as const;

// ─── GET / ────────────────────────────────────────────────────────────────────

professionalServicesRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : null;
  if (status && !VALID_STATUSES.includes(status as any)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }
  try {
    const params: unknown[] = [gymId];
    let sql = `${SELECT} WHERE (ps.gym_id IS NULL OR ps.gym_id = ?) AND ps.deleted_at IS NULL`;
    params.push(gymId);
    if (status) { sql += ' AND gps.status = ?'; params.push(status); }
    if (search) { sql += ' AND (ps.name LIKE ? OR ps.description LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY ps.is_system DESC, ps.name ASC';
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────

professionalServicesRouter.get('/:id', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `${SELECT} WHERE ps.id = ? AND (ps.gym_id IS NULL OR ps.gym_id = ?) AND ps.deleted_at IS NULL`,
      [gymId, req.params.id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ─── POST / — create a custom Professional Service ───────────────────────────

professionalServicesRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, description } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

  try {
    const { insertId } = await db.transaction(async (tx) => {
      const { insertId: serviceId } = await tx.query(
        `INSERT INTO professional_services
           (gym_id, name, description, is_system, system_key, created_by_membership_id)
         VALUES (?, ?, ?, 0, NULL, ?)`,
        [gymId, name.trim(), description?.trim() || null, gymMembershipId],
      );
      await tx.query(
        `INSERT INTO gym_professional_services (gym_id, professional_service_id, status, created_by_membership_id)
         VALUES (?, ?, 'active', ?)`,
        [gymId, serviceId, gymMembershipId],
      );
      return { insertId: serviceId };
    });

    const { rows } = await db.query(`${SELECT} WHERE ps.id = ?`, [gymId, insertId]);
    recordAudit(req, {
      action: 'create',
      entityType: 'professional_service',
      entityId: String(insertId),
      entityName: name.trim(),
      next: { name: name.trim(), description: description ?? null },
    });
    res.status(201).json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A professional service with this name already exists.');
  }
});

// ─── PUT /:id — edit a custom Professional Service ───────────────────────────

professionalServicesRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, description } = req.body;

  if (name !== undefined && !name?.trim()) return res.status(400).json({ error: 'name is required' });

  try {
    const { rows: existing } = await db.query(
      'SELECT id, is_system, gym_id FROM professional_services WHERE id = ? AND deleted_at IS NULL',
      [req.params.id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
    if (existing[0].is_system) return res.status(403).json({ error: 'System Professional Services cannot be edited.' });
    if (existing[0].gym_id !== gymId) return res.status(404).json({ error: 'Not found' });

    await db.query(
      `UPDATE professional_services SET
         name                    = COALESCE(?, name),
         description             = COALESCE(?, description),
         updated_at              = UTC_TIMESTAMP(),
         updated_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND is_system = 0 AND deleted_at IS NULL`,
      [name?.trim() ?? null, description ?? null, gymMembershipId, req.params.id, gymId],
    );

    const { rows } = await db.query(`${SELECT} WHERE ps.id = ? AND ps.gym_id = ?`, [gymId, req.params.id, gymId]);
    recordAudit(req, {
      action: 'update',
      entityType: 'professional_service',
      entityId: String(req.params.id),
      entityName: rows[0]?.name,
      next: { name, description },
    });
    res.json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A professional service with this name already exists.');
  }
});

// ─── POST /:id/activate ───────────────────────────────────────────────────────

professionalServicesRouter.post('/:id/activate', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  try {
    const { rowCount } = await db.query(
      `UPDATE gym_professional_services gps
       JOIN professional_services ps ON ps.id = gps.professional_service_id
       SET gps.status = 'active', gps.updated_at = UTC_TIMESTAMP(), gps.updated_by_membership_id = ?
       WHERE gps.professional_service_id = ? AND gps.gym_id = ?
         AND (ps.gym_id IS NULL OR ps.gym_id = ?) AND ps.deleted_at IS NULL`,
      [gymMembershipId, req.params.id, gymId, gymId],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Not found' });
    const { rows } = await db.query(`${SELECT} WHERE ps.id = ?`, [gymId, req.params.id]);
    recordAudit(req, { action: 'activate', entityType: 'professional_service', entityId: String(req.params.id), entityName: rows[0]?.name });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ─── POST /:id/deactivate ─────────────────────────────────────────────────────

professionalServicesRouter.post('/:id/deactivate', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  try {
    const { rowCount } = await db.query(
      `UPDATE gym_professional_services gps
       JOIN professional_services ps ON ps.id = gps.professional_service_id
       SET gps.status = 'inactive', gps.updated_at = UTC_TIMESTAMP(), gps.updated_by_membership_id = ?
       WHERE gps.professional_service_id = ? AND gps.gym_id = ?
         AND (ps.gym_id IS NULL OR ps.gym_id = ?) AND ps.deleted_at IS NULL`,
      [gymMembershipId, req.params.id, gymId, gymId],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Not found' });
    const { rows } = await db.query(`${SELECT} WHERE ps.id = ?`, [gymId, req.params.id]);
    recordAudit(req, { action: 'deactivate', entityType: 'professional_service', entityId: String(req.params.id), entityName: rows[0]?.name });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ─── POST /:id/duplicate ──────────────────────────────────────────────────────

professionalServicesRouter.post('/:id/duplicate', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  try {
    const { rows: source } = await db.query(
      `SELECT id, name, description FROM professional_services
       WHERE id = ? AND (gym_id IS NULL OR gym_id = ?) AND deleted_at IS NULL`,
      [req.params.id, gymId],
    );
    if (source.length === 0) return res.status(404).json({ error: 'Not found' });
    const src = source[0];
    const newName = `${src.name} - Copy`;

    const { insertId } = await db.transaction(async (tx) => {
      const { insertId: serviceId } = await tx.query(
        `INSERT INTO professional_services
           (gym_id, name, description, is_system, system_key, created_by_membership_id)
         VALUES (?, ?, ?, 0, NULL, ?)`,
        [gymId, newName, src.description, gymMembershipId],
      );
      await tx.query(
        `INSERT INTO gym_professional_services (gym_id, professional_service_id, status, created_by_membership_id)
         VALUES (?, ?, 'active', ?)`,
        [gymId, serviceId, gymMembershipId],
      );
      return { insertId: serviceId };
    });

    const { rows } = await db.query(`${SELECT} WHERE ps.id = ?`, [gymId, insertId]);
    recordAudit(req, { action: 'duplicate', entityType: 'professional_service', entityId: String(insertId), entityName: newName });
    res.status(201).json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A professional service with this name already exists.');
  }
});

// ─── DELETE /:id — soft-delete custom Professional Services only ─────────────

professionalServicesRouter.delete('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  try {
    const { rows: existing } = await db.query(
      'SELECT id, is_system, gym_id, name FROM professional_services WHERE id = ? AND deleted_at IS NULL',
      [req.params.id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
    if (existing[0].is_system) return res.status(403).json({ error: 'System Professional Services cannot be deleted.' });
    if (existing[0].gym_id !== gymId) return res.status(404).json({ error: 'Not found' });

    await db.query(
      `UPDATE professional_services SET deleted_at = UTC_TIMESTAMP(), deleted_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND is_system = 0 AND deleted_at IS NULL`,
      [gymMembershipId, req.params.id, gymId],
    );
    recordAudit(req, {
      action: 'delete',
      entityType: 'professional_service',
      entityId: String(req.params.id),
      entityName: existing[0].name,
    });
    res.status(204).send();
  } catch (err) { next(err); }
});
