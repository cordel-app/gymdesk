import { DEFAULT_SERVICE_BOOKING_TYPE, parseServiceBookingType, type ServiceBookingType } from '../domain/serviceBookingType';
import { Router } from 'express';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { PLATFORM_STORAGE_ROOT } from '../infra/storage';
import {
  isMemberImageRefusal, memberImageBodyParser, memberImageUploadRateLimit, parseMemberImageRequest,
} from './member-image-storage';
import {
  PROFESSIONAL_SERVICE_IMAGE_COLUMNS,
  clearProfessionalServiceImage,
  migrateProfessionalServiceImageOnRename,
  storeProfessionalServiceImage,
} from './professional-service-image-storage';
import { attachTranslations, deleteTranslations, writeTranslations } from './professional-service-translations';
import { recordAudit } from '../infra/audit';
import { resolvePlatformActor } from '../domain/auditActor';
import { getRequestLocale as resolveLocale } from '../infra/locale';
import {
  BasePsTranslations,
  parseBaseDescription,
  parseBaseName,
  parsePsTranslations,
  parseMaxCapacity,
  parseMinParticipants,
  minParticipantsError,
} from '../domain/baseProfessionalServices';

/**
 * #1817 — Cordel → Base Professional Services. The platform-side writer of the
 * `gym_id IS NULL` rows of `professional_services`, so every route is
 * `requireSuperadmin`. `max_capacity` is stored and reported and nothing more:
 * no booking, availability or capacity rule reads it. Delete is soft and is
 * refused while anything still references the service.
 */
export const platformProfessionalServicesRouter = Router();

const BASE_WHERE = 'ps.gym_id IS NULL AND ps.deleted_at IS NULL';

interface Row {
  id: number;
  name: string;
  description: string | null;
  is_system: number;
  system_key: string | null;
  max_capacity: number | null;
  min_participants: number | null;
  booking_type: ServiceBookingType;
  image_url: string | null;
  image_thumbnail_url: string | null;
  created_at: string;
  created_by: string | null;
  modified_at: string | null;
  modified_by: string | null;
}

const shape = attachTranslations;

async function loadOne(id: unknown, locale: string) {
  const { rows } = await db.query<Row>(
    `SELECT ps.id, ps.name, ps.description, ps.is_system, ps.system_key, ps.max_capacity, ps.min_participants, ps.booking_type, ps.image_url, ps.image_thumbnail_url,
            ps.created_at, ps.created_by, ps.modified_at, ps.modified_by
       FROM professional_services ps WHERE ps.id = ? AND ${BASE_WHERE}`,
    [id],
  );
  return rows[0] ? (await shape(rows, locale))[0] : null;
}

platformProfessionalServicesRouter.get('/', requireSuperadmin, async (req, res, next) => {
  try {
    const params: unknown[] = [];
    let where = BASE_WHERE;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      where += ` AND (ps.name LIKE ? OR ps.description LIKE ? OR EXISTS (
        SELECT 1 FROM professional_service_translations t
         WHERE t.professional_service_id = ps.id AND (t.name LIKE ? OR t.description LIKE ?)))`;
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const { rows } = await db.query<Row>(
      `SELECT ps.id, ps.name, ps.description, ps.is_system, ps.system_key, ps.max_capacity, ps.min_participants, ps.booking_type, ps.image_url, ps.image_thumbnail_url,
              ps.created_at, ps.created_by, ps.modified_at, ps.modified_by
         FROM professional_services ps WHERE ${where} ORDER BY ps.name ASC`,
      params,
    );
    res.json(await shape(rows, resolveLocale(req)));
  } catch (err) { next(err); }
});

platformProfessionalServicesRouter.get('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const row = await loadOne(req.params.id, resolveLocale(req));
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) { next(err); }
});

platformProfessionalServicesRouter.post('/', requireSuperadmin, async (req, res, next) => {
  const body = req.body ?? {};
  const name = parseBaseName(body.name);
  if ('error' in name) return res.status(400).json({ error: name.error });
  const description = parseBaseDescription(body.description);
  if ('error' in description) return res.status(400).json({ error: description.error });
  const capacity = parseMaxCapacity(body.max_capacity === undefined ? null : body.max_capacity);
  if ('error' in capacity) return res.status(400).json({ error: capacity.error });
  const minParticipants = parseMinParticipants(body.min_participants === undefined ? null : body.min_participants);
  if ('error' in minParticipants) return res.status(400).json({ error: minParticipants.error });
  const minVsCap = minParticipantsError(minParticipants.value, capacity.value);
  if (minVsCap) return res.status(400).json({ error: minVsCap });
  // #2664: required; a request that does not name it takes the default (no family restriction).
  const bookingType = body.booking_type === undefined
    ? { value: DEFAULT_SERVICE_BOOKING_TYPE }
    : parseServiceBookingType(body.booking_type);
  if ('error' in bookingType) return res.status(400).json({ error: bookingType.error });
  // #2441: English (the base name) is the only required language.
  const translations = body.translations === undefined ? { value: {} } : parsePsTranslations(body.translations, { requireAll: false });
  if ('error' in translations) return res.status(400).json({ error: translations.error });

  const actor = resolvePlatformActor(req.superadminName);
  try {
    const id = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO professional_services
           (gym_id, name, description, is_system, system_key, max_capacity, min_participants, booking_type, created_by)
         VALUES (NULL, ?, ?, 1, NULL, ?, ?, ?, ?)`,
        [name.value, description.value, capacity.value, minParticipants.value, bookingType.value, actor],
      );
      await writeTranslations(tx, insertId, translations.value);
      // A Base service no gym could see would be pointless: give every existing
      // gym the same explicit `active` row gym creation gives a new one.
      await tx.query(
        `INSERT IGNORE INTO gym_professional_services (gym_id, professional_service_id, status, created_at, created_by)
         SELECT id, ?, 'active', UTC_TIMESTAMP(), ? FROM gyms`,
        [insertId, actor],
      );
      return insertId;
    });
    const row = await loadOne(id, resolveLocale(req));
    recordAudit(req, { action: 'create', entityType: 'professional_service', entityId: String(id), entityName: name.value, next: row });
    res.status(201).json(row);
  } catch (err: any) {
    if (err?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A professional service with this name already exists.' });
    next(err);
  }
});

platformProfessionalServicesRouter.put('/:id', requireSuperadmin, async (req, res, next) => {
  const body = req.body ?? {};
  try {
    const locale = resolveLocale(req);
    const existing = await loadOne(req.params.id, locale);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    let name = existing.name;
    if (body.name !== undefined) {
      const p = parseBaseName(body.name);
      if ('error' in p) return res.status(400).json({ error: p.error });
      name = p.value;
    }
    let description = existing.description;
    if (body.description !== undefined) {
      const p = parseBaseDescription(body.description);
      if ('error' in p) return res.status(400).json({ error: p.error });
      description = p.value;
    }
    let capacity = existing.max_capacity;
    if (body.max_capacity !== undefined) {
      const p = parseMaxCapacity(body.max_capacity);
      if ('error' in p) return res.status(400).json({ error: p.error });
      capacity = p.value;
    }
    let minParticipants = existing.min_participants;
    if (body.min_participants !== undefined) {
      const p = parseMinParticipants(body.min_participants);
      if ('error' in p) return res.status(400).json({ error: p.error });
      minParticipants = p.value;
    }
    const minVsCap = minParticipantsError(minParticipants, capacity);
    if (minVsCap) return res.status(400).json({ error: minVsCap });
    let bookingType = existing.booking_type;
    if (body.booking_type !== undefined) {
      const p = parseServiceBookingType(body.booking_type);
      if ('error' in p) return res.status(400).json({ error: p.error });
      bookingType = p.value;
    }
    let translations: BasePsTranslations | null = null;
    let clearedLocales: string[] = [];
    if (body.translations !== undefined) {
      const p = parsePsTranslations(body.translations, { requireAll: false });
      if ('error' in p) return res.status(400).json({ error: p.error });
      translations = p.value;
      clearedLocales = Object.keys(body.translations).filter((l) => !(l in p.value));
    }

    const actor = resolvePlatformActor(req.superadminName);
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE professional_services
            SET name = ?, description = ?, max_capacity = ?, min_participants = ?, booking_type = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
          WHERE id = ? AND gym_id IS NULL AND deleted_at IS NULL`,
        [name, description, capacity, minParticipants, bookingType, actor, existing.id],
      );
      if (translations) await writeTranslations(tx, existing.id, translations);
      await deleteTranslations(tx, existing.id, clearedLocales);
    });
    // #2010: the image key carries the service's name, so a rename moves it.
    if (name !== existing.name && existing.image_url) {
      await migrateProfessionalServiceImageOnRename(
        { gymId: null, prefix: PLATFORM_STORAGE_ROOT },
        { id: existing.id, name, image_url: existing.image_url, image_thumbnail_url: existing.image_thumbnail_url },
      );
    }
    const row = await loadOne(existing.id, locale);
    recordAudit(req, { action: 'update', entityType: 'professional_service', entityId: String(existing.id), entityName: name, previous: existing, next: row });
    res.json(row);
  } catch (err: any) {
    if (err?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A professional service with this name already exists.' });
    next(err);
  }
});

// ─── Image (#2010) ────────────────────────────────────────────────────────────
// The only writers of a Base service's `image_url` / `image_thumbnail_url`, under
// `cordel/professional_services/`. Processing and limits are the Member photo's.

async function loadBaseForImage(req: any, res: any) {
  const { rows } = await db.query(
    `SELECT ${PROFESSIONAL_SERVICE_IMAGE_COLUMNS} FROM professional_services ps WHERE ps.id = ? AND ${BASE_WHERE}`,
    [req.params.id],
  );
  if (!rows[0]) { res.status(404).json({ error: 'Not found' }); return null; }
  return { id: rows[0].id, name: rows[0].name, image_url: rows[0].image_url, image_thumbnail_url: rows[0].image_thumbnail_url };
}

platformProfessionalServicesRouter.post('/:id/image', requireSuperadmin, memberImageUploadRateLimit, memberImageBodyParser, async (req, res, next) => {
  try {
    const parsed = await parseMemberImageRequest(req);
    if (isMemberImageRefusal(parsed)) return res.status(parsed.status).json(parsed.body);
    const service = await loadBaseForImage(req, res);
    if (!service) return;
    const stored = await storeProfessionalServiceImage({
      scope: { gymId: null, prefix: PLATFORM_STORAGE_ROOT }, service, images: parsed,
      modifiedBy: resolvePlatformActor(req.superadminName),
    });
    if (isMemberImageRefusal(stored)) return res.status(stored.status).json(stored.body);
    recordAudit(req, {
      action: 'update', entityType: 'professional_service', entityId: String(service.id), entityName: service.name,
      previous: { image_url: service.image_url }, next: { image_url: stored.image_url },
    });
    res.json(await loadOne(service.id, resolveLocale(req)));
  } catch (err) { next(err); }
});

platformProfessionalServicesRouter.delete('/:id/image', requireSuperadmin, async (req, res, next) => {
  try {
    const service = await loadBaseForImage(req, res);
    if (!service) return;
    await clearProfessionalServiceImage({
      scope: { gymId: null, prefix: PLATFORM_STORAGE_ROOT }, service,
      modifiedBy: resolvePlatformActor(req.superadminName),
    });
    recordAudit(req, {
      action: 'update', entityType: 'professional_service', entityId: String(service.id), entityName: service.name,
      previous: { image_url: service.image_url }, next: { image_url: null },
    });
    res.json(await loadOne(service.id, resolveLocale(req)));
  } catch (err) { next(err); }
});

/** Names of the tables still holding a reference to the service (derived from the schema's own FKs). */
async function referencingTables(id: number): Promise<string[]> {
  const { rows: fks } = await db.query<{ t: string; c: string }>(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'professional_services'
        AND REFERENCED_COLUMN_NAME = 'id'
        AND TABLE_NAME NOT IN ('gym_professional_services', 'professional_service_translations')`,
  );
  const used: string[] = [];
  for (const fk of fks) {
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM \`${fk.t}\` WHERE \`${fk.c}\` = ?`, [id],
    );
    if (Number(rows[0]?.n) > 0 && !used.includes(fk.t)) used.push(fk.t);
  }
  return used;
}

platformProfessionalServicesRouter.delete('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const existing = await loadOne(req.params.id, resolveLocale(req));
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const used = await referencingTables(existing.id);
    if (used.length > 0) {
      return res.status(409).json({
        error: 'This professional service is in use and cannot be deleted.',
        code: 'professional_service_in_use',
        referenced_by: used,
      });
    }
    const actor = resolvePlatformActor(req.superadminName);
    await db.query(
      `UPDATE professional_services SET deleted_at = UTC_TIMESTAMP(), deleted_by = ?,
         modified_at = UTC_TIMESTAMP(), modified_by = ?
       WHERE id = ? AND gym_id IS NULL AND deleted_at IS NULL`,
      [actor, actor, existing.id],
    );
    recordAudit(req, { action: 'delete', entityType: 'professional_service', entityId: String(existing.id), entityName: existing.name, previous: existing });
    res.status(204).send();
  } catch (err) { next(err); }
});
