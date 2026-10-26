import { Router, type Request, type Response } from 'express';
import { resolveRequestActor } from '../domain/auditActor';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { handleDupEntry } from '../infra/db-helpers';
import { parseMaxCapacity, parsePsTranslations } from '../domain/baseProfessionalServices';
import { getRequestLocale } from '../infra/locale';
import { attachTranslations, copyTranslations, deleteTranslations, writeTranslations } from './professional-service-translations';
import {
  gymStorageFolderPrefix, isMemberImageRefusal, memberImageBodyParser, memberImageUploadRateLimit,
  parseMemberImageRequest, STORAGE_NOT_INITIALIZED,
} from './member-image-storage';
import {
  PROFESSIONAL_SERVICE_IMAGE_COLUMNS,
  clearProfessionalServiceImage,
  copyBaseProfessionalServiceImage,
  migrateProfessionalServiceImageOnRename,
  storeProfessionalServiceImage,
} from './professional-service-image-storage';

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
    ps.image_url,
    ps.image_thumbnail_url,
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

/** One row (or none) shaped with its translations and the request locale's display values (#2110). */
async function shapeOne(req: Request, row: any) {
  return row ? (await attachTranslations([row], getRequestLocale(req)))[0] : row;
}

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
    if (search) {
      sql += ` AND (ps.name LIKE ? OR ps.description LIKE ? OR EXISTS (
        SELECT 1 FROM professional_service_translations t
         WHERE t.professional_service_id = ps.id AND (t.name LIKE ? OR t.description LIKE ?)))`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    sql += ' ORDER BY ps.is_system DESC, ps.name ASC';
    const { rows } = await db.query(sql, params);
    res.json(await attachTranslations(rows, getRequestLocale(req)));
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
    const prefix = await gymStorageFolderPrefix(gymId);
    for (const baseId of [...new Set<number>(ids)]) {
      const { rows } = await db.query(
        `SELECT id, name, description, max_capacity, image_url, image_thumbnail_url FROM professional_services
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
          await copyTranslations(tx, base.id, serviceId);
          return { insertId: serviceId };
        });
        imported.push(base.id);
        // The image is copied after the row exists (its key carries the new id); a
        // failed copy costs the image alone, never the import.
        await copyBaseProfessionalServiceImage({ gymId, prefix, base, service: { id: insertId, name: base.name } });
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
    res.json(await shapeOne(req, rows[0]));
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
  // #2110: a gym's own service carries the same per-locale name/description as a
  // Base one; a locale left out or blank simply falls back to the base text.
  let translations: Record<string, { name: string; description: string | null }> = {};
  if (req.body.translations !== undefined) {
    const p = parsePsTranslations(req.body.translations, { requireAll: false });
    if ('error' in p) return res.status(400).json({ error: p.error });
    translations = p.value;
  }

  try {
    const { insertId } = await db.transaction(async (tx) => {
      const { insertId: serviceId } = await tx.query(
        `INSERT INTO professional_services
           (gym_id, name, description, is_system, system_key, max_capacity, created_by)
         VALUES (?, ?, ?, 0, NULL, ?, ?)`,
        [gymId, name.trim(), description?.trim() || null, capacity.value, actor],
      );
      await writeTranslations(tx, serviceId, translations);
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
    res.status(201).json(await shapeOne(req, rows[0]));
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
  // Absent keeps the stored translations; a locale given blank clears it (#2110).
  let translations: Record<string, { name: string; description: string | null }> | null = null;
  let clearedLocales: string[] = [];
  if (req.body.translations !== undefined) {
    const p = parsePsTranslations(req.body.translations, { requireAll: false });
    if ('error' in p) return res.status(400).json({ error: p.error });
    translations = p.value;
    clearedLocales = Object.keys(req.body.translations).filter((l) => !(l in p.value));
  }

  try {
    const { rows: existing } = await db.query(
      'SELECT id, is_system, gym_id FROM professional_services WHERE id = ? AND deleted_at IS NULL',
      [req.params.id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
    if (existing[0].is_system) return res.status(403).json({ error: 'System Professional Services cannot be edited.' });
    if (existing[0].gym_id !== gymId) return res.status(404).json({ error: 'Not found' });

    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE professional_services SET
           name                    = COALESCE(?, name),
           description             = COALESCE(?, description),
           max_capacity            = IF(?, ?, max_capacity),
           modified_at             = UTC_TIMESTAMP(),
           modified_by             = ?
         WHERE id = ? AND gym_id = ? AND is_system = 0 AND deleted_at IS NULL`,
        [name?.trim() ?? null, description ?? null, capacityGiven ? 1 : 0, capacity.value, actor, req.params.id, gymId],
      );
      if (translations) {
        await writeTranslations(tx, existing[0].id, translations);
        await deleteTranslations(tx, existing[0].id, clearedLocales);
      }
    });

    // #2010: the image key carries the service's name, so a rename moves it.
    {
      const { rows: imgRows } = await db.query(
        `SELECT ${PROFESSIONAL_SERVICE_IMAGE_COLUMNS} FROM professional_services WHERE id = ? AND gym_id = ?`,
        [req.params.id, gymId],
      );
      if (imgRows[0]?.image_url) {
        await migrateProfessionalServiceImageOnRename({ gymId, prefix: await gymStorageFolderPrefix(gymId) }, imgRows[0]);
      }
    }

    const { rows } = await db.query(`${SELECT} WHERE ps.id = ? AND ps.gym_id = ?`, [gymId, req.params.id, gymId]);
    recordAudit(req, {
      action: 'update',
      entityType: 'professional_service',
      entityId: String(req.params.id),
      entityName: rows[0]?.name,
      next: {
        name, description,
        ...(capacityGiven ? { max_capacity: capacity.value } : {}),
        ...(translations ? { translations } : {}),
      },
    });
    res.json(await shapeOne(req, rows[0]));
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
    res.json(await shapeOne(req, rows[0]));
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
    res.json(await shapeOne(req, rows[0]));
  } catch (err) { next(err); }
});

// ─── POST /:id/duplicate ──────────────────────────────────────────────────────

professionalServicesRouter.post('/:id/duplicate', requireRole('admin'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  try {
    const { rows: source } = await db.query(
      `SELECT id, name, description, max_capacity, image_url, image_thumbnail_url FROM professional_services
       WHERE id = ? AND (gym_id IS NULL OR gym_id = ?) AND deleted_at IS NULL`,
      [req.params.id, gymId],
    );
    if (source.length === 0) return res.status(404).json({ error: 'Not found' });
    const src = source[0];
    const newName = `${src.name} - Copy`;

    const { insertId } = await db.transaction(async (tx) => {
      const { insertId: serviceId } = await tx.query(
        `INSERT INTO professional_services
           (gym_id, name, description, is_system, system_key, max_capacity, image_url, image_thumbnail_url, created_by)
         VALUES (?, ?, ?, 0, NULL, ?, ?, ?, ?)`,
        // #2010: the copy inherits the source's image *references*. No object is
        // copied or re-processed, so one object may be referenced by several rows.
        [gymId, newName, src.description, src.max_capacity, src.image_url ?? null, src.image_thumbnail_url ?? null, actor],
      );
      await tx.query(
        `INSERT INTO gym_professional_services (gym_id, professional_service_id, status, created_by)
         VALUES (?, ?, 'active', ?)`,
        [gymId, serviceId, actor],
      );
      await copyTranslations(tx, src.id, serviceId, ' - Copy');
      return { insertId: serviceId };
    });

    const { rows } = await db.query(`${SELECT} WHERE ps.id = ?`, [gymId, insertId]);
    recordAudit(req, { action: 'duplicate', entityType: 'professional_service', entityId: String(insertId), entityName: newName });
    res.status(201).json(await shapeOne(req, rows[0]));
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A professional service with this name already exists.');
  }
});

// ─── Image (#2010) ────────────────────────────────────────────────────────────
// `POST`/`DELETE /:id/image` are the only writers of `professional_services.image_url`
// / `image_thumbnail_url` for a gym's own service (besides Duplicate, which
// inherits the references). Base services are the platform's (`/platform/...`) and
// answer 403 here, as the PUT does. Processing and limits are the Member photo's.

async function loadServiceForImage(req: Request, res: Response, requirePrefix: boolean) {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `SELECT ${PROFESSIONAL_SERVICE_IMAGE_COLUMNS}, is_system, gym_id FROM professional_services WHERE id = ? AND deleted_at IS NULL`,
    [req.params.id],
  );
  const row = rows[0];
  if (row && (row.is_system || row.gym_id === null)) {
    res.status(403).json({ error: 'System Professional Services cannot be edited.' });
    return null;
  }
  if (!row || row.gym_id !== gymId) { res.status(404).json({ error: 'Not found' }); return null; }
  const prefix = await gymStorageFolderPrefix(gymId);
  if (!prefix && requirePrefix) {
    res.status(STORAGE_NOT_INITIALIZED.status).json(STORAGE_NOT_INITIALIZED.body);
    return null;
  }
  return {
    gymId, prefix,
    service: { id: row.id, name: row.name, image_url: row.image_url, image_thumbnail_url: row.image_thumbnail_url },
  };
}

async function readServiceForImageAnswer(gymId: string, id: number | string) {
  const { rows } = await db.query(`${SELECT} WHERE ps.id = ?`, [gymId, id]);
  return rows[0];
}

professionalServicesRouter.post('/:id/image', requireRole('admin'), memberImageUploadRateLimit, memberImageBodyParser, async (req, res, next) => {
  try {
    const parsed = await parseMemberImageRequest(req);
    if (isMemberImageRefusal(parsed)) return res.status(parsed.status).json(parsed.body);
    const context = await loadServiceForImage(req, res, true);
    if (!context) return;
    const { gymId, service } = context;
    const stored = await storeProfessionalServiceImage({
      scope: { gymId, prefix: context.prefix as string }, service, images: parsed,
      modifiedBy: resolveRequestActor(getTenantContext(req)),
    });
    if (isMemberImageRefusal(stored)) return res.status(stored.status).json(stored.body);
    recordAudit(req, {
      action: 'update', entityType: 'professional_service', entityId: String(service.id), entityName: service.name,
      previous: { image_url: service.image_url }, next: { image_url: stored.image_url },
    });
    res.json(await shapeOne(req, await readServiceForImageAnswer(gymId, service.id)));
  } catch (err) { next(err); }
});

professionalServicesRouter.delete('/:id/image', requireRole('admin'), async (req, res, next) => {
  try {
    const context = await loadServiceForImage(req, res, false);
    if (!context) return;
    const { gymId, prefix, service } = context;
    await clearProfessionalServiceImage({
      scope: { gymId, prefix }, service, modifiedBy: resolveRequestActor(getTenantContext(req)),
    });
    recordAudit(req, {
      action: 'update', entityType: 'professional_service', entityId: String(service.id), entityName: service.name,
      previous: { image_url: service.image_url }, next: { image_url: null },
    });
    res.json(await shapeOne(req, await readServiceForImageAnswer(gymId, service.id)));
  } catch (err) { next(err); }
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
