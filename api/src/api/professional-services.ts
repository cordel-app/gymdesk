import { Router } from 'express';
import { resolveRequestActor } from '../domain/auditActor';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { handleDupEntry } from '../infra/db-helpers';
import { parseMaxCapacity } from '../domain/baseProfessionalServices';

export const professionalServicesRouter = Router();

const SELECT = `
  SELECT
    ps.id,
    ps.gym_id,
    ps.name,
    ps.description,
    ps.is_system,
    ps.system_key,
    ps.max_capacity,
    ps.base_professional_service_id,
    ps.deleted_at,
    ps.created_at,
    ps.created_by,
    ps.modified_at,
    ps.modified_by,
    ps.deleted_by,
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

// ─── GET /base — Base Professional Services available to import (#2004) ─────
// Registered before `/:id`. Reads the platform's `gym_id IS NULL` rows with this
// gym's import state; it writes nothing.

professionalServicesRouter.get('/base', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  try {
    const params: unknown[] = [gymId];
    let sql = `SELECT b.id, b.name, b.description, b.max_capacity,
                      c.id AS imported_professional_service_id
                 FROM professional_services b
                 LEFT JOIN professional_services c
                   ON c.base_professional_service_id = b.id AND c.gym_id = ? AND c.deleted_at IS NULL
                WHERE b.gym_id IS NULL AND b.deleted_at IS NULL`;
    if (q) { sql += ' AND (b.name LIKE ? OR b.description LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
    sql += ' ORDER BY b.name ASC';
    const { rows } = await db.query(sql, params);
    res.json(rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      max_capacity: r.max_capacity,
      imported: r.imported_professional_service_id !== null,
      imported_professional_service_id: r.imported_professional_service_id,
    })));
  } catch (err) { next(err); }
});

// ─── POST /import — Import Base Professional Services (#2004) ────────────────
// Creates gym-owned copies (name, description, max capacity). Never updates a
// service the gym already has and never touches the Base row; a Base service the
// gym already imported, or whose name the gym already uses, is reported skipped.

professionalServicesRouter.post('/import', requireRole('admin'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const ids = req.body?.base_professional_service_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200
    || !ids.every((v: unknown) => Number.isInteger(v) && (v as number) > 0)) {
    return res.status(400).json({ error: 'base_professional_service_ids must be a non-empty array of positive integers' });
  }
  try {
    const imported: number[] = [];
    const skipped: number[] = [];
    for (const baseId of [...new Set<number>(ids)]) {
      const { rows } = await db.query(
        `SELECT id, name, description, max_capacity FROM professional_services
          WHERE id = ? AND gym_id IS NULL AND deleted_at IS NULL`,
        [baseId],
      );
      if (rows.length === 0) return res.status(404).json({ error: `Base professional service ${baseId} not found` });
      const base = rows[0];
      // No UNIQUE (gym_id, name) exists on this table, so the name check is explicit.
      const { rows: taken } = await db.query(
        'SELECT id FROM professional_services WHERE gym_id = ? AND deleted_at IS NULL AND name = ? LIMIT 1',
        [gymId, base.name],
      );
      if (taken.length > 0) { skipped.push(base.id); continue; }
      try {
        const { insertId } = await db.transaction(async (tx) => {
          const { insertId: serviceId } = await tx.query(
            `INSERT INTO professional_services
               (gym_id, name, description, is_system, system_key, max_capacity, base_professional_service_id, created_by)
             VALUES (?, ?, ?, 0, NULL, ?, ?, ?)`,
            [gymId, base.name, base.description, base.max_capacity, base.id, actor],
          );
          await tx.query(
            `INSERT INTO gym_professional_services (gym_id, professional_service_id, status, created_by)
             VALUES (?, ?, 'active', ?)`,
            [gymId, serviceId, actor],
          );
          return { insertId: serviceId };
        });
        imported.push(base.id);
        recordAudit(req, {
          action: 'create',
          entityType: 'professional_service',
          entityId: String(insertId),
          entityName: base.name,
          next: { base_professional_service_id: base.id },
        });
      } catch (err: any) {
        if (err?.code === 'ER_DUP_ENTRY') skipped.push(base.id); else throw err;
      }
    }
    res.json({ imported, skipped });
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
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { name, description } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const capacity = parseMaxCapacity(req.body.max_capacity === undefined ? null : req.body.max_capacity);
  if ('error' in capacity) return res.status(400).json({ error: capacity.error });

  try {
    const { insertId } = await db.transaction(async (tx) => {
      const { insertId: serviceId } = await tx.query(
        `INSERT INTO professional_services
           (gym_id, name, description, is_system, system_key, max_capacity, created_by)
         VALUES (?, ?, ?, 0, NULL, ?, ?)`,
        [gymId, name.trim(), description?.trim() || null, capacity.value, actor],
      );
      await tx.query(
        `INSERT INTO gym_professional_services (gym_id, professional_service_id, status, created_by)
         VALUES (?, ?, 'active', ?)`,
        [gymId, serviceId, actor],
      );
      return { insertId: serviceId };
    });

    const { rows } = await db.query(`${SELECT} WHERE ps.id = ?`, [gymId, insertId]);
    recordAudit(req, {
      action: 'create',
      entityType: 'professional_service',
      entityId: String(insertId),
      entityName: name.trim(),
      next: { name: name.trim(), description: description ?? null, max_capacity: capacity.value },
    });
    res.status(201).json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A professional service with this name already exists.');
  }
});

// ─── PUT /:id — edit a custom Professional Service ───────────────────────────

professionalServicesRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { name, description } = req.body;

  if (name !== undefined && !name?.trim()) return res.status(400).json({ error: 'name is required' });
  // Absent keeps the stored value; null/'' clears it; anything else must be a positive integer.
  const capacityGiven = req.body.max_capacity !== undefined;
  const capacity = capacityGiven ? parseMaxCapacity(req.body.max_capacity) : { value: null };
  if ('error' in capacity) return res.status(400).json({ error: capacity.error });

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
         max_capacity            = IF(?, ?, max_capacity),
         modified_at             = UTC_TIMESTAMP(),
         modified_by             = ?
       WHERE id = ? AND gym_id = ? AND is_system = 0 AND deleted_at IS NULL`,
      [name?.trim() ?? null, description ?? null, capacityGiven ? 1 : 0, capacity.value, actor, req.params.id, gymId],
    );

    const { rows } = await db.query(`${SELECT} WHERE ps.id = ? AND ps.gym_id = ?`, [gymId, req.params.id, gymId]);
    recordAudit(req, {
      action: 'update',
      entityType: 'professional_service',
      entityId: String(req.params.id),
      entityName: rows[0]?.name,
      next: { name, description, ...(capacityGiven ? { max_capacity: capacity.value } : {}) },
    });
    res.json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A professional service with this name already exists.');
  }
});

// ─── POST /:id/activate ───────────────────────────────────────────────────────

professionalServicesRouter.post('/:id/activate', requireRole('admin'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  try {
    const { rowCount } = await db.query(
      `UPDATE gym_professional_services gps
       JOIN professional_services ps ON ps.id = gps.professional_service_id
       SET gps.status = 'active', gps.modified_at = UTC_TIMESTAMP(), gps.modified_by = ?
       WHERE gps.professional_service_id = ? AND gps.gym_id = ?
         AND (ps.gym_id IS NULL OR ps.gym_id = ?) AND ps.deleted_at IS NULL`,
      [actor, req.params.id, gymId, gymId],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Not found' });
    const { rows } = await db.query(`${SELECT} WHERE ps.id = ?`, [gymId, req.params.id]);
    recordAudit(req, { action: 'activate', entityType: 'professional_service', entityId: String(req.params.id), entityName: rows[0]?.name });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ─── POST /:id/deactivate ─────────────────────────────────────────────────────

professionalServicesRouter.post('/:id/deactivate', requireRole('admin'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  try {
    const { rowCount } = await db.query(
      `UPDATE gym_professional_services gps
       JOIN professional_services ps ON ps.id = gps.professional_service_id
       SET gps.status = 'inactive', gps.modified_at = UTC_TIMESTAMP(), gps.modified_by = ?
       WHERE gps.professional_service_id = ? AND gps.gym_id = ?
         AND (ps.gym_id IS NULL OR ps.gym_id = ?) AND ps.deleted_at IS NULL`,
      [actor, req.params.id, gymId, gymId],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Not found' });
    const { rows } = await db.query(`${SELECT} WHERE ps.id = ?`, [gymId, req.params.id]);
    recordAudit(req, { action: 'deactivate', entityType: 'professional_service', entityId: String(req.params.id), entityName: rows[0]?.name });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ─── POST /:id/duplicate ──────────────────────────────────────────────────────

professionalServicesRouter.post('/:id/duplicate', requireRole('admin'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  try {
    const { rows: source } = await db.query(
      `SELECT id, name, description, max_capacity FROM professional_services
       WHERE id = ? AND (gym_id IS NULL OR gym_id = ?) AND deleted_at IS NULL`,
      [req.params.id, gymId],
    );
    if (source.length === 0) return res.status(404).json({ error: 'Not found' });
    const src = source[0];
    const newName = `${src.name} - Copy`;

    const { insertId } = await db.transaction(async (tx) => {
      const { insertId: serviceId } = await tx.query(
        `INSERT INTO professional_services
           (gym_id, name, description, is_system, system_key, max_capacity, created_by)
         VALUES (?, ?, ?, 0, NULL, ?, ?)`,
        [gymId, newName, src.description, src.max_capacity, actor],
      );
      await tx.query(
        `INSERT INTO gym_professional_services (gym_id, professional_service_id, status, created_by)
         VALUES (?, ?, 'active', ?)`,
        [gymId, serviceId, actor],
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
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  try {
    const { rows: existing } = await db.query(
      'SELECT id, is_system, gym_id, name FROM professional_services WHERE id = ? AND deleted_at IS NULL',
      [req.params.id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
    if (existing[0].is_system) return res.status(403).json({ error: 'System Professional Services cannot be deleted.' });
    if (existing[0].gym_id !== gymId) return res.status(404).json({ error: 'Not found' });

    await db.query(
      `UPDATE professional_services SET deleted_at = UTC_TIMESTAMP(), deleted_by = ?,
         base_professional_service_id = NULL,
         modified_at = UTC_TIMESTAMP(), modified_by = ?
       WHERE id = ? AND gym_id = ? AND is_system = 0 AND deleted_at IS NULL`,
      [actor, actor, req.params.id, gymId],
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
