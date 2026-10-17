import { Request, Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { resolveRequestActor } from '../domain/auditActor';
import {
  gymStorageFolderPrefix, isMemberImageRefusal, memberImageBodyParser, memberImageUploadRateLimit,
  parseMemberImageRequest, STORAGE_NOT_INITIALIZED,
} from './member-image-storage';
import {
  clearPromotionImage, migratePromotionImageOnRename, PROMOTION_IMAGE_COLUMNS, storePromotionImage,
} from './promotion-image-storage';
import { insertAndFetch } from '../infra/db-helpers';
import { computePromotionTimeline, validatePayBeforehandMonths } from '../domain/promotionTimeline';
import { PromotionBenefitAction } from '../domain/promotionBenefits';
import { PROMOTION_LIFECYCLE_STATUSES } from '../domain/promotionLifecycle';
import {
  DEFAULT_PROMOTION_TARGET,
  describePromotionTargets,
  isPromotionTarget,
} from '../domain/promotionTarget';

const MEMBERSHIP_FEE_ACTIONS: PromotionBenefitAction[] = ['no_benefit', 'waive', 'percentage_discount', 'fixed_discount', 'fixed_price'];

// #900: `expired` joined the set. It is declared once in
// `domain/promotionLifecycle.ts` beside the rule that writes it, so the filter
// below, the write validation and the sweep cannot disagree about what a
// Promotion's status may be. `deleted` is still absent on purpose — it is
// reached only through DELETE and restored only through the Recycle Bin.
const LIFECYCLE_STATUSES = PROMOTION_LIFECYCLE_STATUSES;

const SORT_COLUMNS: Record<string, string> = {
  name: 'p.name',
  created_at: 'p.created_at',
  starts_at: 'p.starts_at',
  ends_at: 'p.ends_at',
  lifecycle_status: 'p.lifecycle_status',
};

export const promotionsRouter = Router();

promotionsRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { active_on } = req.query as Record<string, string | undefined>;
  const lifecycleStatus = typeof req.query.lifecycle_status === 'string' ? req.query.lifecycle_status : null;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  // #1182: created_by is the plain-text actor snapshot, so the filter is its exact text.
  const createdBy = typeof req.query.created_by === 'string' && req.query.created_by !== ''
    ? req.query.created_by : null;
  // #628: narrows the list to the Promotions targeting one Membership Plan, so
  // the inline Assign-Plan editor can offer exactly the Promotions the apply
  // path (`promotion_membership_plans` check in membership-promotions.ts) will
  // accept for the plan being assigned, instead of listing every active promo
  // and surfacing the mismatch as a 400 after the fact.
  const membershipPlanId = req.query.membership_plan_id == null || req.query.membership_plan_id === ''
    ? null : Number(req.query.membership_plan_id);
  if (membershipPlanId !== null && (!Number.isInteger(membershipPlanId) || membershipPlanId <= 0)) {
    return res.status(400).json({ error: 'membership_plan_id must be a membership plan id' });
  }
  const sortKey = typeof req.query.sort === 'string' && req.query.sort in SORT_COLUMNS
    ? req.query.sort : 'starts_at';
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';

  const where: string[] = ['p.gym_id = ?', "p.lifecycle_status != 'deleted'"];
  const params: any[] = [gymId];

  if (lifecycleStatus) {
    if (!LIFECYCLE_STATUSES.includes(lifecycleStatus as any)) {
      return res.status(400).json({ error: `lifecycle_status must be one of: ${LIFECYCLE_STATUSES.join(', ')}` });
    }
    where.push('p.lifecycle_status = ?'); params.push(lifecycleStatus);
  }
  if (active_on) {
    where.push('p.starts_at <= ? AND p.ends_at >= ?');
    params.push(active_on, active_on);
  }
  if (q) {
    where.push('(p.name LIKE ? OR p.description LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (createdBy !== null) {
    where.push('p.created_by = ?'); params.push(createdBy);
  }
  if (membershipPlanId !== null) {
    where.push(`EXISTS (
      SELECT 1 FROM promotion_membership_plans pmp
      WHERE pmp.promotion_id = p.id AND pmp.membership_plan_id = ? AND pmp.gym_id = ?
    )`);
    params.push(membershipPlanId, gymId);
  }

  try {
    const { rows } = await db.query(
      `SELECT p.id, p.gym_id, p.name, p.description, p.starts_at, p.ends_at,
              p.stackable, p.only_applicable_for_new_members,
              p.applies_to,
              p.lifecycle_status, p.created_at, p.deleted_at,
              p.free_months, p.paid_months, p.bonus_months, p.pay_beforehand_months,
              p.created_by, p.modified_at, p.modified_by,
              p.image_url, p.image_thumbnail_url,
              IF(mfb.enabled = 1, mfb.action, NULL) AS fee_benefit_action,
              IF(mfb.enabled = 1, mfb.value, NULL) AS fee_benefit_value,
              IF(mfb.enabled = 1, mfb.duration_months, NULL) AS fee_benefit_duration_months
       FROM promotions p
       LEFT JOIN promotion_membership_fee_benefits mfb
         ON mfb.promotion_id = p.id AND mfb.gym_id = p.gym_id
       WHERE ${where.join(' AND ')}
       ORDER BY ${SORT_COLUMNS[sortKey]} ${dir}`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

promotionsRouter.get('/created-by-options', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT p.created_by AS name
       FROM promotions p
       WHERE p.gym_id = ? AND p.created_by IS NOT NULL AND p.lifecycle_status != 'deleted'
       ORDER BY p.created_by ASC`,
      [gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

function parseNonNegativeInt(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

// Non-persisted forecast preview — computed from whatever config values are
// passed in, so the frontend can preview unsaved edits without duplicating
// the Free/Pay/Prepaid/Bonus/Regular classification logic itself.
promotionsRouter.get('/timeline', async (req, res) => {
  const free = parseNonNegativeInt(req.query.free_months);
  const paid = parseNonNegativeInt(req.query.paid_months);
  const payBeforehand = parseNonNegativeInt(req.query.pay_beforehand_months);
  const bonus = parseNonNegativeInt(req.query.bonus_months);
  if (free === null || paid === null || payBeforehand === null || bonus === null) {
    return res.status(400).json({
      error: 'free_months, paid_months, pay_beforehand_months and bonus_months must be non-negative integers',
    });
  }
  const err = validatePayBeforehandMonths(paid, payBeforehand);
  if (err) return res.status(400).json({ error: err });

  const mfAction = typeof req.query.membership_fee_action === 'string' ? req.query.membership_fee_action : 'no_benefit';
  if (!MEMBERSHIP_FEE_ACTIONS.includes(mfAction as PromotionBenefitAction)) {
    return res.status(400).json({ error: `membership_fee_action must be one of: ${MEMBERSHIP_FEE_ACTIONS.join(', ')}` });
  }
  const mfEnabled = req.query.membership_fee_enabled === '1' || req.query.membership_fee_enabled === 'true';

  let mfValue: number | null = null;
  if (typeof req.query.membership_fee_value === 'string' && req.query.membership_fee_value !== '') {
    mfValue = Number(req.query.membership_fee_value);
    if (!Number.isFinite(mfValue)) return res.status(400).json({ error: 'membership_fee_value must be a number' });
  }

  let mfDurationMonths: number | null = null;
  if (typeof req.query.membership_fee_duration_months === 'string' && req.query.membership_fee_duration_months !== '') {
    const n = Number(req.query.membership_fee_duration_months);
    if (!Number.isInteger(n) || n < 1) {
      return res.status(400).json({ error: 'membership_fee_duration_months must be a positive integer' });
    }
    mfDurationMonths = n;
  }

  const anchorDate = typeof req.query.anchor_date === 'string' ? req.query.anchor_date : undefined;
  const result = computePromotionTimeline(
    {
      freeMonths: free, paidMonths: paid, payBeforehandMonths: payBeforehand, bonusMonths: bonus,
      membershipFeeAction: mfAction as PromotionBenefitAction,
      membershipFeeValue: mfValue,
      membershipFeeEnabled: mfEnabled,
      membershipFeeDurationMonths: mfDurationMonths,
    },
    anchorDate,
  );
  res.json(result);
});

promotionsRouter.get('/:id', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `SELECT p.*
       FROM promotions p
       WHERE p.id = ? AND p.gym_id = ?`,
      [req.params.id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Promotion not found' });

    res.json(rows[0]);
  } catch (err) { next(err); }
});

function validateBody(body: any) {
  if (body.starts_at && body.ends_at && new Date(body.starts_at) > new Date(body.ends_at)) {
    return 'ends_at must be on or after starts_at';
  }
  if (body.lifecycle_status && !LIFECYCLE_STATUSES.includes(body.lifecycle_status)) {
    return `lifecycle_status must be one of: ${LIFECYCLE_STATUSES.join(', ')}`;
  }
  // #926: an absent `applies_to` means the default (every client that predates
  // the column), but a value that is present has to be one of the two — the
  // CHECK would otherwise answer with a 500 from the database.
  if (body.applies_to != null && !isPromotionTarget(body.applies_to)) {
    return `applies_to must be one of: ${describePromotionTargets()}`;
  }
  return null;
}

promotionsRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { name, description, starts_at, ends_at, stackable, only_applicable_for_new_members,
          applies_to, lifecycle_status, free_months, paid_months, bonus_months, pay_beforehand_months } = req.body;
  if (!name?.trim() || !starts_at || !ends_at) {
    return res.status(400).json({ error: 'name, starts_at and ends_at are required' });
  }
  const err = validateBody(req.body); if (err) return res.status(400).json({ error: err });
  const pbErr = validatePayBeforehandMonths(paid_months ?? 0, pay_beforehand_months ?? 0);
  if (pbErr) return res.status(400).json({ error: pbErr });
  try {
    const row = await insertAndFetch(
      `INSERT INTO promotions
         (gym_id, name, description, starts_at, ends_at, stackable, only_applicable_for_new_members,
          applies_to, lifecycle_status, created_by, free_months, paid_months, bonus_months,
          pay_beforehand_months)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        gymId, name.trim(), description ?? null,
        new Date(starts_at), new Date(ends_at),
        stackable ? 1 : 0,
        // #633: defaults to true when the caller omits it (or sends null) — an
        // API client that predates the flag creates promotions restricted to
        // new members, the same value the migration backfilled onto existing rows.
        (only_applicable_for_new_members ?? true) ? 1 : 0,
        // #926: omitted means a Membership Plan Promotion — what every
        // Promotion was before the column existed, and the column's own DEFAULT.
        applies_to ?? DEFAULT_PROMOTION_TARGET,
        lifecycle_status ?? 'active',
        actor,
        free_months ?? null,
        paid_months ?? null,
        bonus_months ?? null,
        pay_beforehand_months ?? 0,
      ],
      'SELECT * FROM promotions WHERE id = ?',
      (id) => [id],
    );
    recordAudit(req, { action: 'create', entityType: 'promotion', entityId: row.id, entityName: row.name, next: row });
    res.status(201).json(row);
  } catch (e) { next(e); }
});

promotionsRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const err = validateBody(req.body); if (err) return res.status(400).json({ error: err });
  const { name, description, starts_at, ends_at, stackable, only_applicable_for_new_members,
          applies_to, lifecycle_status, free_months, paid_months, bonus_months, pay_beforehand_months } = req.body;
  try {
    const { rows: existingRows } = await db.query(
      "SELECT paid_months, pay_beforehand_months FROM promotions WHERE id = ? AND gym_id = ? AND lifecycle_status != 'deleted'",
      [req.params.id, gymId],
    );
    if (existingRows.length === 0) return res.status(404).json({ error: 'Promotion not found' });
    const effectivePaidMonths = 'paid_months' in req.body ? (paid_months ?? 0) : (existingRows[0].paid_months ?? 0);
    const effectivePayBeforehandMonths = 'pay_beforehand_months' in req.body
      ? (pay_beforehand_months ?? 0) : (existingRows[0].pay_beforehand_months ?? 0);
    const pbErr = validatePayBeforehandMonths(effectivePaidMonths, effectivePayBeforehandMonths);
    if (pbErr) return res.status(400).json({ error: pbErr });

    const { rowCount } = await db.query(
      `UPDATE promotions SET
        name                  = COALESCE(?, name),
        description           = IF(?, ?, description),
        starts_at             = COALESCE(?, starts_at),
        ends_at               = COALESCE(?, ends_at),
        stackable             = IF(?, ?, stackable),
        only_applicable_for_new_members = IF(?, ?, only_applicable_for_new_members),
        -- #926: keyed on whether the request supplied the field, not on the
        -- value, so a client that never names the target cannot move it.
        -- Switching it writes this column and nothing else: the Membership Fee
        -- Benefit row and the promotion_membership_plans rows stay exactly as
        -- stored (§4), so switching back shows what was there before.
        applies_to            = IF(?, ?, applies_to),
        lifecycle_status      = COALESCE(?, lifecycle_status),
        free_months           = IF(?, ?, free_months),
        paid_months           = IF(?, ?, paid_months),
        bonus_months          = IF(?, ?, bonus_months),
        pay_beforehand_months = IF(?, ?, pay_beforehand_months),
        modified_at           = UTC_TIMESTAMP(),
        modified_by           = ?
       WHERE id = ? AND gym_id = ? AND lifecycle_status != 'deleted'`,
      [
        name?.trim() ?? null,
        'description' in req.body ? 1 : 0, description ?? null,
        starts_at ? new Date(starts_at) : null,
        ends_at ? new Date(ends_at) : null,
        'stackable' in req.body ? 1 : 0, stackable ? 1 : 0,
        'only_applicable_for_new_members' in req.body ? 1 : 0, only_applicable_for_new_members ? 1 : 0,
        // Keyed on the value rather than on `'applies_to' in req.body` like its
        // siblings, deliberately: the column is NOT NULL, so an explicit
        // `applies_to: null` can only mean "not supplied" — reading it as
        // "supplied" would write the default and silently re-target a Product
        // Item Promotion as a Membership Plan one.
        applies_to != null ? 1 : 0, applies_to ?? DEFAULT_PROMOTION_TARGET,
        lifecycle_status ?? null,
        'free_months' in req.body ? 1 : 0, free_months ?? null,
        'paid_months' in req.body ? 1 : 0, paid_months ?? null,
        'bonus_months' in req.body ? 1 : 0, bonus_months ?? null,
        'pay_beforehand_months' in req.body ? 1 : 0, pay_beforehand_months ?? 0,
        actor,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Promotion not found' });
    let { rows } = await db.query('SELECT * FROM promotions WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
    // #1711: the image key carries the promotion's name, so a rename moves it.
    if (rows[0]?.image_url) {
      const migrated = await migratePromotionImageOnRename(gymId, await gymStorageFolderPrefix(gymId), {
        id: rows[0].id, name: rows[0].name, image_url: rows[0].image_url,
        image_thumbnail_url: rows[0].image_thumbnail_url,
      });
      if (migrated) {
        rows = (await db.query('SELECT * FROM promotions WHERE id = ? AND gym_id = ?', [req.params.id, gymId])).rows;
      }
    }
    recordAudit(req, { action: 'update', entityType: 'promotion', entityId: req.params.id, entityName: rows[0].name, next: rows[0] });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// ─── Image (#1711) ─────────────────────────────────────────────────────────────
// `POST`/`DELETE /:id/image` are the only writers of `promotions.image_url` /
// `image_thumbnail_url`. They touch nothing else of the promotion (eligibility,
// benefits, pricing, status). Processing and limits are the Member photo's.

async function loadPromotionForImage(req: Request, res: any, requirePrefix: boolean) {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `SELECT ${PROMOTION_IMAGE_COLUMNS} FROM promotions WHERE id = ? AND gym_id = ? AND lifecycle_status != 'deleted'`,
    [req.params.id, gymId],
  );
  const row = rows[0];
  if (!row) { res.status(404).json({ error: 'Promotion not found' }); return null; }
  const folderPrefix = await gymStorageFolderPrefix(gymId);
  if (!folderPrefix && requirePrefix) {
    res.status(STORAGE_NOT_INITIALIZED.status).json(STORAGE_NOT_INITIALIZED.body);
    return null;
  }
  return {
    gymId, folderPrefix,
    promotion: { id: row.id, name: row.name, image_url: row.image_url, image_thumbnail_url: row.image_thumbnail_url },
  };
}

async function readPromotionForImageAnswer(gymId: string, id: number | string) {
  const { rows } = await db.query('SELECT * FROM promotions WHERE id = ? AND gym_id = ?', [id, gymId]);
  return rows[0];
}

promotionsRouter.post('/:id/image', requireRole('admin'), memberImageUploadRateLimit, memberImageBodyParser, async (req, res, next) => {
  try {
    const parsed = await parseMemberImageRequest(req);
    if (isMemberImageRefusal(parsed)) return res.status(parsed.status).json(parsed.body);
    const context = await loadPromotionForImage(req, res, true);
    if (!context) return;
    const { gymId, promotion } = context;
    const stored = await storePromotionImage({
      gymId, folderPrefix: context.folderPrefix as string, promotion, images: parsed,
      modifiedBy: resolveRequestActor(getTenantContext(req)),
    });
    if (isMemberImageRefusal(stored)) return res.status(stored.status).json(stored.body);
    recordAudit(req, {
      action: 'update', entityType: 'promotion', entityId: promotion.id, entityName: promotion.name,
      previous: { image_url: promotion.image_url }, next: { image_url: stored.image_url },
    });
    res.json(await readPromotionForImageAnswer(gymId, promotion.id));
  } catch (err) { next(err); }
});

promotionsRouter.delete('/:id/image', requireRole('admin'), async (req, res, next) => {
  try {
    const context = await loadPromotionForImage(req, res, false);
    if (!context) return;
    const { gymId, folderPrefix, promotion } = context;
    await clearPromotionImage({ gymId, folderPrefix, promotion, modifiedBy: resolveRequestActor(getTenantContext(req)) });
    recordAudit(req, {
      action: 'update', entityType: 'promotion', entityId: promotion.id, entityName: promotion.name,
      previous: { image_url: promotion.image_url }, next: { image_url: null },
    });
    res.json(await readPromotionForImageAnswer(gymId, promotion.id));
  } catch (err) { next(err); }
});

promotionsRouter.delete('/:id', requireRole('admin'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  try {
    const { rows: existing } = await db.query(
      "SELECT name FROM promotions WHERE id = ? AND gym_id = ? AND lifecycle_status != 'deleted'",
      [req.params.id, gymId],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Promotion not found' });
    await db.query(
      `UPDATE promotions
         SET lifecycle_status = 'deleted', deleted_at = UTC_TIMESTAMP(), deleted_by = ?
       WHERE id = ? AND gym_id = ?`,
      [actor, req.params.id, gymId],
    );
    recordAudit(req, { action: 'delete', entityType: 'promotion', entityId: req.params.id, entityName: existing[0].name });
    res.status(204).send();
  } catch (e) { next(e); }
});

promotionsRouter.post('/:id/duplicate', requireRole('admin'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId, gymMembershipId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { rows: srcRows } = await db.query(
    "SELECT * FROM promotions WHERE id = ? AND gym_id = ? AND lifecycle_status != 'deleted'",
    [req.params.id, gymId],
  );
  if (srcRows.length === 0) return res.status(404).json({ error: 'Promotion not found' });
  const src = srcRows[0];

  let copyName = `${src.name} (Copy)`;
  const { rows: existing } = await db.query(
    'SELECT name FROM promotions WHERE gym_id = ? AND name LIKE ?',
    [gymId, `${src.name} (Copy%`],
  );
  if (existing.length > 0) copyName = `${src.name} (Copy ${existing.length + 1})`;

  try {
    let newId: number;
    await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO promotions
           (gym_id, name, description, starts_at, ends_at, stackable, only_applicable_for_new_members,
            applies_to, lifecycle_status, created_by, free_months, paid_months, bonus_months,
            pay_beforehand_months)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          gymId, copyName, src.description, src.starts_at, src.ends_at,
          src.stackable, src.only_applicable_for_new_members,
          // #926: Duplicate is a copy, not a re-configuration — the target
          // comes along with the Membership Fee Benefit and the Suitable
          // Membership Plans rows below it.
          src.applies_to,
          src.lifecycle_status, actor,
          src.free_months, src.paid_months, src.bonus_months, src.pay_beforehand_months,
        ],
      );
      newId = insertId;

      // #635 stage 5: the Membership Fee Benefit is a singleton row of its own
      // (migration 179) — the copy that used to walk `promotion_charge_benefits`
      // and `promotion_period_benefits`, both dropped by that migration, is
      // this one insert.
      // #814 (migration 199): the benefit is `duration_months` + `enabled` +
      // `action`/`value` and nothing else — the recurrence triplet it used to
      // copy alongside them is gone.
      const { rows: mfs } = await tx.query(
        `SELECT duration_months, enabled, action, value
         FROM promotion_membership_fee_benefits WHERE promotion_id = ? AND gym_id = ?`,
        [src.id, gymId],
      );
      for (const mf of mfs) {
        await tx.query(
          `INSERT INTO promotion_membership_fee_benefits
             (gym_id, promotion_id, duration_months, enabled, action, value)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [gymId, newId, mf.duration_months, mf.enabled, mf.action, mf.value],
        );
      }

      const { rows: plans } = await tx.query(
        'SELECT * FROM promotion_membership_plans WHERE promotion_id = ? AND gym_id = ?',
        [src.id, gymId],
      );
      for (const plan of plans) {
        await tx.query(
          'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
          [gymId, newId, plan.membership_plan_id],
        );
      }

      // #550 stage 2: the three Product-keyed tables (migration 155)
      // that replace the "quantity granted" half of Period/Included Benefits
      // above — copied the same way so duplicating a promotion never drops
      // benefits configured through the new session/one-off/periodical
      // endpoints.
      // #896 stage 2: the `(action, value)` pricing treatment is copied verbatim
      // beside the quantity. Duplicate is a copy, not a re-configuration — a
      // copy that dropped the pair would silently turn a waived grant into a
      // charged one. #959's Requirement travels the same way and for the same
      // reason: the copy must not make an optional item mandatory.
      for (const table of ['promotion_session', 'promotion_oneoff', 'promotion_periodical']) {
        const { rows: sibs } = await tx.query(
          `SELECT product_id, quantity, \`action\`, \`value\`, requirement FROM ${table}
            WHERE promotion_id = ? AND gym_id = ?`,
          [src.id, gymId],
        );
        for (const sib of sibs) {
          await tx.query(
            `INSERT INTO ${table}
               (gym_id, promotion_id, product_id, quantity, \`action\`, \`value\`,
                requirement, created_by_membership_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [gymId, newId, sib.product_id, sib.quantity, sib.action, sib.value,
             sib.requirement, gymMembershipId ?? null],
          );
        }
      }
    });

    const { rows } = await db.query('SELECT * FROM promotions WHERE id = ?', [newId!]);
    recordAudit(req, { action: 'create', entityType: 'promotion', entityId: newId!, entityName: copyName, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});
