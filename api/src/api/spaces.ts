import { Router, type Request, type Response } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { resolveCenterId } from '../infra/centerContext';
import { recordAudit } from '../infra/audit';
import { resolveRequestActor } from '../domain/auditActor';
import { gymFetchOne, handleDupEntry, insertAndFetch } from '../infra/db-helpers';
import {
  gymStorageFolderPrefix, isMemberImageRefusal, memberImageBodyParser, memberImageUploadRateLimit,
  parseMemberImageRequest, STORAGE_NOT_INITIALIZED,
} from './member-image-storage';
import {
  SPACE_IMAGE_COLUMNS, clearSpaceImage, migrateSpaceImageOnRename, storeSpaceImage,
} from './space-image-storage';

const STATUSES = ['active', 'inactive', 'under_maintenance'] as const;

const SELECT = `
  SELECT s.*, c.name AS center_name
  FROM spaces s
  LEFT JOIN centers c ON c.id = s.center_id
`;

// #801: a Space carries no Activity Types. `GET`/`PUT /spaces/:id/activity-types`
// and the `space_activity_types` table they served (migration 067 §5, dropped by
// migration 197) are gone — the relation lives on the Activity Type alone, as
// `activity_types.default_space_id`, which the Activity Types router owns. Do
// not reintroduce a Space-side Activity relation here.
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

spacesRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { name, description, capacity, status, center_id, notes, opening_time, closing_time, max_concurrent_groups } = req.body;
  if (!name || capacity == null) return res.status(400).json({ error: 'name and capacity are required' });
  const cap = parseInt(capacity, 10);
  if (isNaN(cap) || cap <= 0) return res.status(400).json({ error: 'capacity must be a positive integer' });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  const maxGroups = max_concurrent_groups != null ? parseInt(max_concurrent_groups, 10) : 1;
  if (isNaN(maxGroups) || maxGroups < 1) return res.status(400).json({ error: 'max_concurrent_groups must be a positive integer' });
  try {
    const resolvedCenterId = await resolveCenterId(gymId, req, center_id);
    const row = await insertAndFetch(
      `INSERT INTO spaces
        (name, description, capacity, status, gym_id, center_id, notes, opening_time, closing_time,
         max_concurrent_groups, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name.trim(), description ?? null, cap, status ?? 'active', gymId, resolvedCenterId,
        notes ?? null, opening_time ?? null, closing_time ?? null,
        maxGroups, actor,
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
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { name, description, capacity, status, center_id, notes, opening_time, closing_time, max_concurrent_groups } = req.body;
  const cap = capacity != null ? parseInt(capacity, 10) : null;
  if (cap !== null && (isNaN(cap) || cap <= 0)) return res.status(400).json({ error: 'capacity must be a positive integer' });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  const maxGroups = max_concurrent_groups != null ? parseInt(max_concurrent_groups, 10) : null;
  if (maxGroups !== null && (isNaN(maxGroups) || maxGroups < 1)) return res.status(400).json({ error: 'max_concurrent_groups must be a positive integer' });
  try {
    const { rowCount } = await db.query(
      `UPDATE spaces SET
        name                 = COALESCE(?, name),
        description          = IF(?, ?, description),
        capacity             = COALESCE(?, capacity),
        status               = COALESCE(?, status),
        center_id            = IF(?, ?, center_id),
        notes                = IF(?, ?, notes),
        opening_time         = IF(?, ?, opening_time),
        closing_time         = IF(?, ?, closing_time),
        max_concurrent_groups = COALESCE(?, max_concurrent_groups),
        modified_at          = UTC_TIMESTAMP(),
        modified_by          = ?
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
        maxGroups,
        actor,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Space not found' });
    // #2260: the image key carries the Space's name, so a rename moves it.
    {
      const { rows: imgRows } = await db.query(
        `SELECT ${SPACE_IMAGE_COLUMNS} FROM spaces WHERE id = ? AND gym_id = ?`, [req.params.id, gymId]);
      if (imgRows[0]?.image_url) {
        await migrateSpaceImageOnRename(gymId, await gymStorageFolderPrefix(gymId), imgRows[0]);
      }
    }
    const { rows } = await db.query(`${SELECT} WHERE s.id = ? AND s.gym_id = ?`, [req.params.id, gymId]);
    recordAudit(req, { action: 'update', entityType: 'space', entityId: req.params.id });
    res.json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A space with this name already exists.');
  }
});

// ─── Image (#2260) ────────────────────────────────────────────────────────────
// `POST`/`DELETE /:id/image` are the only writers of `spaces.image_url` /
// `image_thumbnail_url`. Processing and limits are the Member photo's.

async function loadSpaceForImage(req: Request, res: Response, requirePrefix: boolean) {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `SELECT ${SPACE_IMAGE_COLUMNS} FROM spaces WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [req.params.id, gymId],
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Space not found' }); return null; }
  const prefix = await gymStorageFolderPrefix(gymId);
  if (!prefix && requirePrefix) {
    res.status(STORAGE_NOT_INITIALIZED.status).json(STORAGE_NOT_INITIALIZED.body);
    return null;
  }
  return { gymId, prefix, space: rows[0] };
}

async function readSpaceForImageAnswer(gymId: string, id: number | string) {
  const { rows } = await db.query(`${SELECT} WHERE s.id = ? AND s.gym_id = ?`, [id, gymId]);
  return rows[0];
}

spacesRouter.post('/:id/image', requireRole('admin'), memberImageUploadRateLimit, memberImageBodyParser, async (req, res, next) => {
  try {
    const parsed = await parseMemberImageRequest(req);
    if (isMemberImageRefusal(parsed)) return res.status(parsed.status).json(parsed.body);
    const context = await loadSpaceForImage(req, res, true);
    if (!context) return;
    const { gymId, space } = context;
    const stored = await storeSpaceImage({
      gymId, prefix: context.prefix as string, space, images: parsed,
      modifiedBy: resolveRequestActor(getTenantContext(req)),
    });
    if (isMemberImageRefusal(stored)) return res.status(stored.status).json(stored.body);
    recordAudit(req, {
      action: 'update', entityType: 'space', entityId: String(space.id), entityName: space.name,
      previous: { image_url: space.image_url }, next: { image_url: stored.image_url },
    });
    res.json(await readSpaceForImageAnswer(gymId, space.id));
  } catch (err) { next(err); }
});

spacesRouter.delete('/:id/image', requireRole('admin'), async (req, res, next) => {
  try {
    const context = await loadSpaceForImage(req, res, false);
    if (!context) return;
    const { gymId, prefix, space } = context;
    await clearSpaceImage({ gymId, prefix, space, modifiedBy: resolveRequestActor(getTenantContext(req)) });
    recordAudit(req, {
      action: 'update', entityType: 'space', entityId: String(space.id), entityName: space.name,
      previous: { image_url: space.image_url }, next: { image_url: null },
    });
    res.json(await readSpaceForImageAnswer(gymId, space.id));
  } catch (err) { next(err); }
});

spacesRouter.post('/:id/duplicate', requireRole('admin'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const spaceId = String(req.params.id);
  const original = await gymFetchOne('spaces', spaceId, gymId, { softDelete: true });
  if (!original) return res.status(404).json({ error: 'Space not found' });

  try {
    const row = await insertAndFetch(
      `INSERT INTO spaces
        (name, description, capacity, status, gym_id, center_id, notes, opening_time, closing_time,
         created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `${original.name} (Copy)`, original.description, original.capacity,
        'active', gymId, original.center_id,
        original.notes, original.opening_time, original.closing_time,
        actor,
      ],
      `${SELECT} WHERE s.id = ?`,
      (id) => [id],
    );

    recordAudit(req, { action: 'create', entityType: 'space', entityId: String(row.id) });
    res.status(201).json(row);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A space with this name already exists.');
  }
});

spacesRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { rowCount } = await db.query(
    `UPDATE spaces SET
       status = 'deleted',
       deleted_at = UTC_TIMESTAMP(),
       deleted_by = ?,
       modified_at = UTC_TIMESTAMP(),
       modified_by = ?
     WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [actor, actor, req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Space not found' });
  recordAudit(req, { action: 'soft_delete', entityType: 'space', entityId: req.params.id });
  res.status(204).send();
});
