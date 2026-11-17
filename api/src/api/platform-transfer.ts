import express, { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { apiRateLimitKey } from '../domain/apiRateLimit';
import {
  StorageOperationError,
  describeStorageError,
  getStorageObject,
  isStorageConfigured,
  storageKeyFromObjectUrl,
} from '../infra/storage';
import {
  TRANSFER_ENTITY_TYPES,
  TRANSFER_IMAGE_RATE_LIMIT_WINDOW_MS,
  TransferAction,
  isTransferableObjectKey,
  BASE_PAYMENT_METHOD_TRANSFER_FIELDS,
  BASE_PROFESSIONAL_SERVICE_TRANSFER_FIELDS,
  BASE_NUTRITION_GOAL_TRANSFER_FIELDS,
  BASE_FOOD_TRANSFER_FIELDS,
  parseLookupSlugs,
  BASE_PERSONAL_GOAL_TRANSFER_FIELDS,
  isValidGoalSlug,
  PAYMENT_PROVIDER_TRANSFER_FIELDS,
  isValidEntitySlug,
  isValidMuscleSlug,
  muscleSexFromSlot,
  parseSlugTransferRecord,
  parseMuscleTransferRecord,
  transferImageRateLimitMax,
} from '../domain/entityTransfer';
import { muscleImageMaxBytes } from '../domain/muscleImages';
import { muscleTranslationsExpr, withMuscleTranslations } from '../domain/muscleTranslations';
import {
  MuscleRow,
  createMuscle,
  readMuscle,
  storeMuscleImage,
  updateMuscleContent,
} from './platform-muscles';
import { logger } from '../lib/logger';
import { ProviderRow, createPaymentProvider, loadProvider, shapeProvider, updatePaymentProvider } from './payment-providers';
import {
  createBasePaymentMethod,
  loadAllBasePaymentMethods,
  loadBasePaymentMethod,
  storeBasePaymentMethodImage,
  updateBasePaymentMethod,
} from './platform-base-payment-methods';
import { memberImageBodyParser } from './member-image-storage';
import {
  createBaseProfessionalService,
  loadBaseProfessionalService,
  storeBaseProfessionalServiceImage,
  updateBaseProfessionalService,
} from './platform-professional-services';
import { attachTranslations } from './professional-service-translations';
import {
  createBasePersonalGoal,
  loadBasePersonalGoal,
  storeBasePersonalGoalImage,
  updateBasePersonalGoal,
} from './platform-base-personal-goals';
import {
  createBaseNutritionGoal,
  loadBaseNutritionGoal,
  storeBaseNutritionGoalImage,
  updateBaseNutritionGoal,
} from './platform-base-nutrition-goals';
import { BASE_LOCALE } from '../infra/locale';
import { loadCategoriesMap, loadQualitiesMap, loadTranslationsMap, BASE_FOOD_TABLES } from '../domain/nutritionLibrary';
import { loadDescriptionTranslationsMap } from '../domain/nutritionDescriptionTranslations';
import {
  createBaseFood,
  loadBaseFood,
  storeBaseFoodImage,
  updateBaseFood,
} from './platform-base-nutrition-library';
import { nutritionImageBodyParser } from './nutrition-image-storage';

/**
 * #2952 — Cordel → Export / Import, the API half (superadmin only). The Admin
 * builds and reads the ZIP itself, one entity at a time, so it can show progress
 * and keep going past a failed entity; these routes are what it calls:
 *
 *  - `GET /types` — the entity types that can be moved (the Admin's checkboxes).
 *  - `GET /<type>` — every entity of a type as an export record: `slug`, the
 *    entity's own content and the stored URL of each image.
 *  - `GET /object?url=` — the bytes of one exported image, read back through the
 *    API (a platform object only), so the archive carries the files themselves.
 *  - `POST /<type>` — one imported entity, upserted by `slug`: created through the
 *    entity's own creator when no row carries the slug, otherwise its content
 *    written through the entity's own updater. Relationships are never touched.
 *  - `POST /<type>/:slug/image/:slot` — one imported image, processed and stored
 *    by the entity's own image writer exactly as an editor upload is.
 */
export const platformTransferRouter = Router();

platformTransferRouter.get('/types', requireSuperadmin, (_req, res) => {
  res.json({ types: TRANSFER_ENTITY_TYPES });
});

platformTransferRouter.get('/object', requireSuperadmin, async (req, res, next) => {
  try {
    const url = typeof req.query.url === 'string' ? req.query.url : '';
    const key = storageKeyFromObjectUrl(url);
    if (!isTransferableObjectKey(key)) return res.status(404).json({ error: 'Object not found' });
    if (!isStorageConfigured()) return res.status(503).json({ error: 'Cloudflare storage has not been configured for this deployment' });
    try {
      const object = await getStorageObject(key);
      res.setHeader('Content-Type', object.contentType ?? 'application/octet-stream');
      res.send(object.body);
    } catch (err: any) {
      const details = err instanceof StorageOperationError ? err.details : describeStorageError(err, { operation: 'getStorageObject', key });
      logger.warn({ err, details }, 'Export could not read a stored object');
      return res.status(502).json({ error: `Failed to read image: ${details.message}`, details });
    }
  } catch (err) { next(err); }
});

// ── Muscles ─────────────────────────────────────────────────────────────────

platformTransferRouter.get('/muscles', requireSuperadmin, async (_req, res, next) => {
  try {
    const { rows } = await db.query<any>(
      `SELECT m.*, ${muscleTranslationsExpr('m')} FROM muscles m ORDER BY m.slug ASC`,
    );
    res.json({
      type: 'muscles',
      entities: rows.map((raw: any) => {
        const m = withMuscleTranslations(raw);
        return {
          slug: m.slug,
          data: { name: m.name, translations: m.translations ?? {} },
          images: { male: m.image_male_url ?? null, female: m.image_female_url ?? null },
        };
      }),
    });
  } catch (err) { next(err); }
});

platformTransferRouter.post('/muscles', requireSuperadmin, async (req, res, next) => {
  try {
    const parsed = parseMuscleTransferRecord(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const { slug, name, translations } = parsed.record;
    const existing = await db.query<MuscleRow>('SELECT * FROM muscles WHERE slug = ?', [slug]);
    const muscle = existing.rows[0];
    let action: TransferAction;
    let result;
    if (muscle) {
      action = 'updated';
      result = await updateMuscleContent(req, muscle, { name, translations });
    } else {
      action = 'created';
      result = await createMuscle(req, { slug, name, translations });
    }
    if (!result.ok) return res.status(result.status).json(result.body);
    res.status(action === 'created' ? 201 : 200).json({ action, entity: await readMuscle(result.id) });
  } catch (err) { next(err); }
});

/**
 * The import uploads many images in one run, so it has a budget of its own,
 * keyed on the signed-in person exactly as every upload limiter is (#1395).
 * Each image is still decoded and re-encoded by the entity's own processor.
 */
const transferImageLimiter = rateLimit({
  windowMs: TRANSFER_IMAGE_RATE_LIMIT_WINDOW_MS,
  limit: transferImageRateLimitMax(),
  keyGenerator: (req) => apiRateLimitKey(req.headers.authorization, ipKeyGenerator(req.ip ?? '')),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many image uploads. Please try again later.' }),
}) as unknown as express.RequestHandler;

const transferImageBodyParser = express.raw({
  type: (req) => (req.headers['content-type'] ?? '').startsWith('image/'),
  limit: muscleImageMaxBytes() + 64 * 1024,
});

platformTransferRouter.post(
  '/muscles/:slug/image/:slot',
  requireSuperadmin,
  transferImageLimiter,
  transferImageBodyParser,
  async (req, res, next) => {
    try {
      const sex = muscleSexFromSlot(String(req.params.slot));
      if (!sex) return res.status(400).json({ error: 'slot must be "male" or "female"' });
      if (!isValidMuscleSlug(req.params.slug)) return res.status(404).json({ error: 'Muscle not found' });
      const mime = req.headers['content-type']?.split(';')[0]?.trim() ?? '';
      if (!mime.startsWith('image/')) {
        return res.status(415).json({ error: 'Unsupported content type. Send the picture as an image/* body' });
      }
      // `req.body` is whatever a parser left there, and a request can make that a
      // string or an array — both carry a `length`, so only a Buffer is image bytes.
      const raw: unknown = req.body;
      if (typeof raw === 'string' || Array.isArray(raw) || !Buffer.isBuffer(raw)) {
        return res.status(400).json({ error: 'Request body must be raw image bytes' });
      }
      const original: Buffer = raw;
      const { rows } = await db.query<MuscleRow>('SELECT * FROM muscles WHERE slug = ?', [req.params.slug]);
      if (!rows[0]) return res.status(404).json({ error: 'Muscle not found' });
      const result = await storeMuscleImage(req, rows[0], sex, original);
      if (!result.ok) return res.status(result.status).json(result.body);
      res.json({ entity: await readMuscle(result.id) });
    } catch (err) { next(err); }
  },
);

/**
 * A row found by an imported slug that was soft-deleted is not restored: an
 * import updates what exists and creates what does not, and the slug of a
 * deleted row is still taken (#2951), so the entity is reported as failed.
 */
const DELETED_REFUSAL = { error: 'An entity with this slug was deleted; restore it before importing' };

// ── Payment Providers (stage 2) ─────────────────────────────────────────────

platformTransferRouter.get('/payment_providers', requireSuperadmin, async (_req, res, next) => {
  try {
    const { rows } = await db.query<ProviderRow>(
      'SELECT * FROM payment_providers WHERE deleted_at IS NULL ORDER BY slug ASC',
    );
    res.json({
      type: 'payment_providers',
      entities: rows.map((p) => ({
        slug: p.slug,
        data: { name: p.name, provider_key: p.provider_key, description: p.description, status: p.status },
        images: {},
      })),
    });
  } catch (err) { next(err); }
});

platformTransferRouter.post('/payment_providers', requireSuperadmin, async (req, res, next) => {
  try {
    const parsed = parseSlugTransferRecord(req.body, PAYMENT_PROVIDER_TRANSFER_FIELDS);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const { slug, input } = parsed.record;
    const { rows } = await db.query<ProviderRow>('SELECT id, deleted_at FROM payment_providers WHERE slug = ?', [slug]);
    const found = rows[0];
    if (found?.deleted_at) return res.status(409).json(DELETED_REFUSAL);
    let action: TransferAction;
    let result;
    if (found) {
      action = 'updated';
      const existing = await loadProvider(found.id);
      result = await updatePaymentProvider(req, existing!, input);
    } else {
      action = 'created';
      result = await createPaymentProvider(req, input, { slug });
    }
    if (!result.ok) return res.status(result.status).json(result.body);
    const row = await loadProvider(result.id);
    res.status(action === 'created' ? 201 : 200).json({ action, entity: shapeProvider(row!) });
  } catch (err) { next(err); }
});

// ── Base Payment Methods (stage 2) ──────────────────────────────────────────

platformTransferRouter.get('/base_payment_methods', requireSuperadmin, async (_req, res, next) => {
  try {
    const rows = await loadAllBasePaymentMethods(BASE_LOCALE);
    res.json({
      type: 'base_payment_methods',
      entities: rows.filter((m) => !m.deleted_at).map((m) => ({
        slug: m.slug,
        data: { code: m.code, status: m.status, translations: m.translations },
        images: { image: m.image_url ?? null },
      })),
    });
  } catch (err) { next(err); }
});

async function findBasePaymentMethodBySlug(slug: string) {
  const { rows } = await db.query<{ id: number; deleted_at: string | null }>(
    'SELECT id, deleted_at FROM base_payment_methods WHERE slug = ?', [slug],
  );
  return rows[0] ?? null;
}

platformTransferRouter.post('/base_payment_methods', requireSuperadmin, async (req, res, next) => {
  try {
    const parsed = parseSlugTransferRecord(req.body, BASE_PAYMENT_METHOD_TRANSFER_FIELDS);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const { slug, input } = parsed.record;
    const found = await findBasePaymentMethodBySlug(slug);
    if (found?.deleted_at) return res.status(409).json(DELETED_REFUSAL);
    let action: TransferAction;
    let result;
    if (found) {
      action = 'updated';
      const existing = await loadBasePaymentMethod(found.id, BASE_LOCALE);
      // The code is the method's stable identifier (#1663): an update never
      // writes it, and an archive naming another code for this slug is refused.
      result = await updateBasePaymentMethod(req, existing!, input);
    } else {
      action = 'created';
      result = await createBasePaymentMethod(req, input, { slug });
    }
    if (!result.ok) return res.status(result.status).json(result.body);
    res.status(action === 'created' ? 201 : 200)
      .json({ action, entity: await loadBasePaymentMethod(result.id, BASE_LOCALE) });
  } catch (err) { next(err); }
});

platformTransferRouter.post(
  '/base_payment_methods/:slug/image/:slot',
  requireSuperadmin,
  transferImageLimiter,
  memberImageBodyParser,
  async (req, res, next) => {
    try {
      if (req.params.slot !== 'image') return res.status(400).json({ error: 'slot must be "image"' });
      if (!isValidEntitySlug(req.params.slug)) return res.status(404).json({ error: 'Payment method not found' });
      const found = await findBasePaymentMethodBySlug(req.params.slug);
      if (!found || found.deleted_at) return res.status(404).json({ error: 'Payment method not found' });
      const existing = await loadBasePaymentMethod(found.id, BASE_LOCALE);
      const result = await storeBasePaymentMethodImage(req, existing!);
      if (!result.ok) return res.status(result.status).json(result.body);
      res.json({ entity: await loadBasePaymentMethod(found.id, BASE_LOCALE) });
    } catch (err) { next(err); }
  },
);

// ── Base Professional Services (stage 3) ────────────────────────────────────

platformTransferRouter.get('/base_professional_services', requireSuperadmin, async (_req, res, next) => {
  try {
    const { rows } = await db.query<any>(
      `SELECT id, slug, name, description, max_capacity, min_participants, booking_type, image_url
         FROM professional_services
        WHERE gym_id IS NULL AND deleted_at IS NULL
        ORDER BY slug ASC`,
    );
    const shaped = await attachTranslations(rows, BASE_LOCALE);
    res.json({
      type: 'base_professional_services',
      entities: shaped.map((s) => ({
        slug: s.slug,
        data: {
          name: s.name,
          description: s.description,
          max_capacity: s.max_capacity,
          min_participants: s.min_participants,
          booking_type: s.booking_type,
          translations: s.translations,
        },
        images: { image: s.image_url ?? null },
      })),
    });
  } catch (err) { next(err); }
});

/** The Base catalogue is one slug scope (`gym_id IS NULL`, #2951 stage 4), deleted rows included. */
async function findBaseProfessionalServiceBySlug(slug: string) {
  const { rows } = await db.query<{ id: number; deleted_at: string | null }>(
    'SELECT id, deleted_at FROM professional_services WHERE gym_id IS NULL AND slug = ?', [slug],
  );
  return rows[0] ?? null;
}

platformTransferRouter.post('/base_professional_services', requireSuperadmin, async (req, res, next) => {
  try {
    const parsed = parseSlugTransferRecord(req.body, BASE_PROFESSIONAL_SERVICE_TRANSFER_FIELDS);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const { slug, input } = parsed.record;
    const found = await findBaseProfessionalServiceBySlug(slug);
    if (found?.deleted_at) return res.status(409).json(DELETED_REFUSAL);
    let action: TransferAction;
    let result;
    if (found) {
      action = 'updated';
      const existing = await loadBaseProfessionalService(found.id, BASE_LOCALE);
      result = await updateBaseProfessionalService(req, existing!, input);
    } else {
      action = 'created';
      result = await createBaseProfessionalService(req, input, { slug });
    }
    if (!result.ok) return res.status(result.status).json(result.body);
    res.status(action === 'created' ? 201 : 200)
      .json({ action, entity: await loadBaseProfessionalService(result.id, BASE_LOCALE) });
  } catch (err) { next(err); }
});

platformTransferRouter.post(
  '/base_professional_services/:slug/image/:slot',
  requireSuperadmin,
  transferImageLimiter,
  memberImageBodyParser,
  async (req, res, next) => {
    try {
      if (req.params.slot !== 'image') return res.status(400).json({ error: 'slot must be "image"' });
      if (!isValidEntitySlug(req.params.slug)) return res.status(404).json({ error: 'Professional service not found' });
      const found = await findBaseProfessionalServiceBySlug(req.params.slug);
      if (!found || found.deleted_at) return res.status(404).json({ error: 'Professional service not found' });
      const existing = await loadBaseProfessionalService(found.id, BASE_LOCALE);
      const result = await storeBaseProfessionalServiceImage(req, existing!);
      if (!result.ok) return res.status(result.status).json(result.body);
      res.json({ entity: await loadBaseProfessionalService(found.id, BASE_LOCALE) });
    } catch (err) { next(err); }
  },
);

// ── Base Goals (stage 4) ────────────────────────────────────────────────────

type GoalWriteResult = { ok: true; id: number } | { ok: false; status: number; body: Record<string, unknown> };

interface BaseGoalTransfer {
  type: 'base_personal_goals' | 'base_nutrition_goals';
  table: 'base_personal_goals' | 'base_nutrition_goals';
  fields: readonly string[];
  /** The archive's `data` for one goal as the reads answer it. */
  data: (goal: any) => Record<string, unknown>;
  load: (id: number) => Promise<any>;
  create: (req: any, body: Record<string, any>, opts: { slug: string }) => Promise<GoalWriteResult>;
  update: (req: any, id: number, body: Record<string, any>) => Promise<GoalWriteResult>;
  storeImage: (req: any, goal: { id: number; name: string; image_url: string | null; image_thumbnail_url: string | null })
    => Promise<GoalWriteResult>;
}

/**
 * A goal's translations as an archive carries them: `{ <locale>: { name, description } }`,
 * the shape the goal writers take back (absent keeps, `{}` clears).
 */
function goalTranslationsForArchive(translations: unknown): Record<string, { name: string; description: string | null }> {
  const out: Record<string, { name: string; description: string | null }> = {};
  if (!translations || typeof translations !== 'object') return out;
  for (const [locale, entry] of Object.entries(translations as Record<string, any>)) {
    if (entry && typeof entry.name === 'string') out[locale] = { name: entry.name, description: entry.description ?? null };
  }
  return out;
}

const BASE_GOAL_TRANSFERS: BaseGoalTransfer[] = [
  {
    type: 'base_personal_goals',
    table: 'base_personal_goals',
    fields: BASE_PERSONAL_GOAL_TRANSFER_FIELDS,
    data: (g) => ({
      name: g.name,
      description: g.description ?? null,
      target_value: g.target_value ?? null,
      target_unit: g.target_unit ?? null,
      target_type: g.target_type ?? 'absolute',
      translations: goalTranslationsForArchive(g.translations),
    }),
    load: (id) => loadBasePersonalGoal(id),
    create: createBasePersonalGoal,
    update: updateBasePersonalGoal,
    storeImage: storeBasePersonalGoalImage,
  },
  {
    type: 'base_nutrition_goals',
    table: 'base_nutrition_goals',
    fields: BASE_NUTRITION_GOAL_TRANSFER_FIELDS,
    data: (g) => ({
      name: g.name,
      description: g.description ?? null,
      translations: goalTranslationsForArchive(g.translations),
    }),
    load: (id) => loadBaseNutritionGoal(id),
    create: createBaseNutritionGoal,
    update: updateBaseNutritionGoal,
    storeImage: storeBaseNutritionGoalImage,
  },
];

/**
 * A Base goal's slug is unique among the Base goals of its kind, deleted rows
 * included (#2951 stage 3); a live row is preferred should an older deleted one
 * share it.
 */
async function findBaseGoalBySlug(table: BaseGoalTransfer['table'], slug: string) {
  const { rows } = await db.query<{ id: number; deleted_at: string | null }>(
    `SELECT id, deleted_at FROM ${table} WHERE slug = ? ORDER BY deleted_at IS NULL DESC, id ASC LIMIT 1`, [slug],
  );
  return rows[0] ?? null;
}

for (const goal of BASE_GOAL_TRANSFERS) {
  platformTransferRouter.get(`/${goal.type}`, requireSuperadmin, async (_req, res, next) => {
    try {
      const { rows } = await db.query<{ id: number }>(
        `SELECT id FROM ${goal.table} WHERE deleted_at IS NULL ORDER BY slug ASC`,
      );
      const entities = [];
      for (const { id } of rows) {
        const g = await goal.load(id);
        if (!g) continue;
        entities.push({ slug: g.slug, data: goal.data(g), images: { image: g.image_url ?? null } });
      }
      res.json({ type: goal.type, entities });
    } catch (err) { next(err); }
  });

  platformTransferRouter.post(`/${goal.type}`, requireSuperadmin, async (req, res, next) => {
    try {
      const parsed = parseSlugTransferRecord(req.body, goal.fields, { goalSlug: true });
      if ('error' in parsed) return res.status(400).json({ error: parsed.error });
      const { slug, input } = parsed.record;
      const found = await findBaseGoalBySlug(goal.table, slug);
      if (found?.deleted_at) return res.status(409).json(DELETED_REFUSAL);
      let action: TransferAction;
      let result: GoalWriteResult;
      if (found) {
        action = 'updated';
        result = await goal.update(req, found.id, input);
      } else {
        action = 'created';
        result = await goal.create(req, input, { slug });
      }
      if (!result.ok) return res.status(result.status).json(result.body);
      res.status(action === 'created' ? 201 : 200).json({ action, entity: await goal.load(result.id) });
    } catch (err) { next(err); }
  });

  platformTransferRouter.post(
    `/${goal.type}/:slug/image/:slot`,
    requireSuperadmin,
    transferImageLimiter,
    memberImageBodyParser,
    async (req, res, next) => {
      try {
        if (req.params.slot !== 'image') return res.status(400).json({ error: 'slot must be "image"' });
        if (!isValidGoalSlug(req.params.slug)) return res.status(404).json({ error: 'Goal not found' });
        const found = await findBaseGoalBySlug(goal.table, req.params.slug);
        if (!found || found.deleted_at) return res.status(404).json({ error: 'Goal not found' });
        const existing = await goal.load(found.id);
        const result = await goal.storeImage(req, {
          id: existing.id, name: existing.name,
          image_url: existing.image_url ?? null, image_thumbnail_url: existing.image_thumbnail_url ?? null,
        });
        if (!result.ok) return res.status(result.status).json(result.body);
        res.json({ entity: await goal.load(found.id) });
      } catch (err) { next(err); }
    },
  );
}

// ── Base Nutrition Library (stage 5) ────────────────────────────────────────

platformTransferRouter.get('/base_nutrition_library', requireSuperadmin, async (_req, res, next) => {
  try {
    const { rows } = await db.query<{ id: number; slug: string; name: string; description: string | null; image_url: string | null }>(
      `SELECT id, slug, name, description, image_url
         FROM base_nutrition_library_items
        WHERE deleted_at IS NULL
        ORDER BY slug ASC`,
    );
    const ids = rows.map((r) => r.id);
    const [categories, qualities, translations, descriptions] = await Promise.all([
      loadCategoriesMap(ids, BASE_FOOD_TABLES), loadQualitiesMap(ids, BASE_FOOD_TABLES),
      loadTranslationsMap(ids, BASE_FOOD_TABLES), loadDescriptionTranslationsMap(ids, BASE_FOOD_TABLES),
    ]);
    res.json({
      type: 'base_nutrition_library',
      entities: rows.map((f) => ({
        slug: f.slug,
        data: {
          name: f.name,
          description: f.description ?? null,
          translations: translations[f.id] ?? {},
          description_translations: descriptions[f.id] ?? {},
          category_slugs: (categories[f.id] ?? []).map((c) => c.slug),
          quality_slugs: (qualities[f.id] ?? []).map((q) => q.slug),
        },
        images: { image: f.image_url ?? null },
      })),
    });
  } catch (err) { next(err); }
});

/** A food's slug is unique among the Base foods, deleted rows included (#2951 stage 5). */
async function findBaseFoodBySlug(slug: string) {
  const { rows } = await db.query<{ id: number; deleted_at: string | null }>(
    'SELECT id, deleted_at FROM base_nutrition_library_items WHERE slug = ?', [slug],
  );
  return rows[0] ?? null;
}

/** Resolves lookup slugs to ids; `{ error }` names the first slug no row carries. */
async function lookupIdsBySlug(
  table: 'nutrition_library_categories' | 'nutritional_qualities',
  slugs: string[],
  field: string,
): Promise<{ ids: number[] } | { error: string }> {
  if (slugs.length === 0) return { ids: [] };
  const { rows } = await db.query<{ id: number; slug: string }>(
    `SELECT id, slug FROM ${table} WHERE slug IN (${slugs.map(() => '?').join(',')})`, slugs,
  );
  const bySlug = new Map(rows.map((r) => [r.slug, r.id]));
  const missing = slugs.find((s) => !bySlug.has(s));
  if (missing) return { error: `${field} names an unknown slug: ${missing}` };
  return { ids: slugs.map((s) => bySlug.get(s)!) };
}

platformTransferRouter.post('/base_nutrition_library', requireSuperadmin, async (req, res, next) => {
  try {
    const parsed = parseSlugTransferRecord(req.body, BASE_FOOD_TRANSFER_FIELDS);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const { slug, input } = parsed.record;
    const categories = parseLookupSlugs(req.body.category_slugs, 'category_slugs');
    if ('error' in categories) return res.status(400).json({ error: categories.error });
    const qualities = parseLookupSlugs(req.body.quality_slugs, 'quality_slugs');
    if ('error' in qualities) return res.status(400).json({ error: qualities.error });
    const found = await findBaseFoodBySlug(slug);
    if (found?.deleted_at) return res.status(409).json(DELETED_REFUSAL);
    let action: TransferAction;
    let result;
    if (found) {
      // An update writes the food's own content; its categories and qualities are
      // relationships and are left exactly as they are.
      action = 'updated';
      result = await updateBaseFood(req, found.id, input);
    } else {
      action = 'created';
      const categoryIds = await lookupIdsBySlug('nutrition_library_categories', categories.slugs ?? [], 'category_slugs');
      if ('error' in categoryIds) return res.status(400).json({ error: categoryIds.error });
      const qualityIds = await lookupIdsBySlug('nutritional_qualities', qualities.slugs ?? [], 'quality_slugs');
      if ('error' in qualityIds) return res.status(400).json({ error: qualityIds.error });
      result = await createBaseFood(req, { ...input, category_ids: categoryIds.ids, quality_ids: qualityIds.ids }, { slug });
    }
    if (!result.ok) return res.status(result.status).json(result.body);
    res.status(action === 'created' ? 201 : 200)
      .json({ action, entity: await loadBaseFood(result.id, BASE_LOCALE) });
  } catch (err) { next(err); }
});

platformTransferRouter.post(
  '/base_nutrition_library/:slug/image/:slot',
  requireSuperadmin,
  transferImageLimiter,
  nutritionImageBodyParser,
  async (req, res, next) => {
    try {
      if (req.params.slot !== 'image') return res.status(400).json({ error: 'slot must be "image"' });
      if (!isValidEntitySlug(req.params.slug)) return res.status(404).json({ error: 'Food not found' });
      const found = await findBaseFoodBySlug(req.params.slug);
      if (!found || found.deleted_at) return res.status(404).json({ error: 'Food not found' });
      const result = await storeBaseFoodImage(req, found.id);
      if (!result.ok) return res.status(result.status).json(result.body);
      res.json({ entity: await loadBaseFood(found.id, BASE_LOCALE) });
    } catch (err) { next(err); }
  },
);
