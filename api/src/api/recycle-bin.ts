import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { localizedExerciseNameSql } from '../domain/exerciseTranslations';
import { SupportedLocale, getRequestLocale } from '../infra/locale';
import { resolveRequestActor, restoredAuditSet } from '../domain/auditActor';

export const recycleBinRouter = Router();

type EntityType =
  | 'member'
  | 'membership_plan'
  | 'promotion'
  | 'center'
  | 'space'
  | 'product'
  | 'exercise'
  | 'workout_template'
  | 'training_plan_template'
  | 'nutrition_plan_template'
  | 'theme'
  | 'activity_type'
  | 'professional_service';

const VALID_ENTITY_TYPES: EntityType[] = [
  'member',
  'membership_plan',
  'promotion',
  'center',
  'space',
  'product',
  'exercise',
  'workout_template',
  'training_plan_template',
  'nutrition_plan_template',
  'theme',
  'activity_type',
  'professional_service',
];

const SORT_COLUMNS: Record<string, string> = {
  entity_type: 'entity_type',
  name: 'name',
  deleted_at: 'deleted_at',
};

interface UnionBranch {
  sql: string;
  params: unknown[];
}

/**
 * One branch of the union per entity type. Every branch answers the same
 * columns: the entity's name, and the plain-text `deleted_by` / `created_by`
 * snapshots (#1182 stage 2). The converted tables carry those columns
 * themselves; Promotions are stage 3's and still derive them from the old
 * columns, aliased to the same two names.
 */
function branchFor(type: EntityType, gymId: string, locale: SupportedLocale): UnionBranch {
  // The audit text columns are converted to one charset/collation so the union
  // arms (and Promotions' joined names) never mix collations.
  const actors = (alias: string) =>
    `CONVERT(${alias}.deleted_by USING utf8mb4) AS deleted_by, ${alias}.deleted_at,
               ${alias}.created_at, CONVERT(${alias}.created_by USING utf8mb4) AS created_by`;
  switch (type) {
    case 'member':
      return {
        sql: `SELECT 'member' AS entity_type, m.id, m.name, NULL AS description,
               ${actors('m')}
             FROM members m
             WHERE m.gym_id = ? AND m.deleted_at IS NOT NULL`,
        params: [gymId],
      };
    case 'membership_plan':
      return {
        sql: `SELECT 'membership_plan' AS entity_type, mp.id, mp.name, mp.description,
               ${actors('mp')}
             FROM membership_plans mp
             WHERE mp.gym_id = ? AND mp.deleted_at IS NOT NULL`,
        params: [gymId],
      };
    case 'promotion':
      return {
        sql: `SELECT 'promotion' AS entity_type, p.id, p.name, p.description,
               ${actors('p')}
             FROM promotions p
             WHERE p.gym_id = ? AND p.lifecycle_status = 'deleted'`,
        params: [gymId],
      };
    case 'center':
      return {
        sql: `SELECT 'center' AS entity_type, c.id, c.name, NULL AS description,
               ${actors('c')}
             FROM centers c
             WHERE c.gym_id = ? AND c.deleted_at IS NOT NULL`,
        params: [gymId],
      };
    case 'space':
      return {
        sql: `SELECT 'space' AS entity_type, s.id, s.name, s.description,
               ${actors('s')}
             FROM spaces s
             WHERE s.gym_id = ? AND s.deleted_at IS NOT NULL`,
        params: [gymId],
      };
    case 'product':
      return {
        sql: `SELECT 'product' AS entity_type, gc.id, gc.name, gc.description,
               ${actors('gc')}
             FROM products gc
             WHERE gc.gym_id = ? AND gc.is_system = 0 AND gc.deleted_at IS NOT NULL`,
        params: [gymId],
      };
    case 'exercise':
      return {
        // #967: the deleted exercise's name in the caller's language. The
        // Recycle Bin's `name` column is shared by every entity type, so the
        // localized value takes its place here rather than arriving as a second
        // field nothing renders.
        sql: `SELECT 'exercise' AS entity_type, e.id,
               ${localizedExerciseNameSql('e', locale)} AS name, e.description,
               ${actors('e')}
             FROM exercises e
             WHERE e.gym_id = ? AND e.status = 'deleted'`,
        params: [gymId],
      };
    case 'workout_template':
      return {
        sql: `SELECT 'workout_template' AS entity_type, wt.id, wt.name, wt.description,
               ${actors('wt')}
             FROM workout_templates wt
             WHERE wt.gym_id = ? AND wt.status = 'deleted'`,
        params: [gymId],
      };
    case 'training_plan_template':
      return {
        sql: `SELECT 'training_plan_template' AS entity_type, tpt.id, tpt.name, tpt.description,
               ${actors('tpt')}
             FROM training_plan_templates tpt
             WHERE tpt.gym_id = ? AND tpt.status = 'deleted'`,
        params: [gymId],
      };
    case 'nutrition_plan_template':
      return {
        sql: `SELECT 'nutrition_plan_template' AS entity_type, npt.id, npt.name, npt.description,
               ${actors('npt')}
             FROM nutrition_plan_templates npt
             WHERE npt.gym_id = ? AND npt.status = 'deleted'`,
        params: [gymId],
      };
    case 'theme':
      return {
        sql: `SELECT 'theme' AS entity_type, t.id,
               CONVERT(t.name USING utf8mb4) AS name,
               CONVERT(t.description USING utf8mb4) AS description,
               ${actors('t')}
             FROM themes t
             WHERE t.gym_id = ? AND t.status = 'deleted'`,
        params: [gymId],
      };
    case 'activity_type':
      return {
        sql: `SELECT 'activity_type' AS entity_type, at.id, at.name, at.description,
               ${actors('at')}
             FROM activity_types at
             WHERE at.gym_id = ? AND at.deleted_at IS NOT NULL`,
        params: [gymId],
      };
    case 'professional_service':
      return {
        sql: `SELECT 'professional_service' AS entity_type, ps.id, ps.name, ps.description,
               ${actors('ps')}
             FROM professional_services ps
             WHERE ps.gym_id = ? AND ps.is_system = 0 AND ps.deleted_at IS NOT NULL`,
        params: [gymId],
      };
  }
}

// GET /recycle-bin
recycleBinRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);

  const entityType = typeof req.query.entity_type === 'string' ? req.query.entity_type : null;
  if (entityType && !VALID_ENTITY_TYPES.includes(entityType as EntityType)) {
    return res.status(400).json({ error: `entity_type must be one of: ${VALID_ENTITY_TYPES.join(', ')}` });
  }

  const q = typeof req.query.q === 'string' ? req.query.q.trim() : null;
  const deletedByName = typeof req.query.deleted_by === 'string' ? req.query.deleted_by.trim() : null;
  const from = typeof req.query.from === 'string' ? req.query.from : null;
  const to = typeof req.query.to === 'string' ? req.query.to : null;
  const sort = typeof req.query.sort === 'string' ? req.query.sort : 'deleted_at';
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
  const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

  const sortCol = SORT_COLUMNS[sort] ?? 'deleted_at';

  const types = entityType ? [entityType as EntityType] : VALID_ENTITY_TYPES;
  const locale = getRequestLocale(req);
  const branches = types.map(t => branchFor(t, gymId, locale));
  const innerSql = branches.map(b => `(${b.sql})`).join('\nUNION ALL\n');
  const innerParams = branches.flatMap(b => b.params);

  const outerWhere: string[] = [];
  const outerParams: unknown[] = [];
  if (q) {
    outerWhere.push('(rb.name LIKE ? OR rb.description LIKE ?)');
    outerParams.push(`%${q}%`, `%${q}%`);
  }
  if (deletedByName) {
    outerWhere.push('rb.deleted_by LIKE ?');
    outerParams.push(`%${deletedByName}%`);
  }
  if (from) {
    outerWhere.push('rb.deleted_at >= ?');
    outerParams.push(from);
  }
  if (to) {
    outerWhere.push('rb.deleted_at <= ?');
    outerParams.push(to);
  }

  const whereClause = outerWhere.length ? `WHERE ${outerWhere.join(' AND ')}` : '';

  const [{ rows: countRows }, { rows: dataRows }] = await Promise.all([
    db.query(
      `SELECT COUNT(*) AS total FROM (${innerSql}) AS rb ${whereClause}`,
      [...innerParams, ...outerParams],
    ),
    db.query(
      // LIMIT/OFFSET must be literals, not `?` parameters: MySQL 8.4 prepared-statement
      // protocol rejects parameterised LIMIT on a derived table (ER_WRONG_ARGUMENTS).
      // limit/offset are already validated integers so direct interpolation is safe.
      `SELECT rb.* FROM (${innerSql}) AS rb ${whereClause} ORDER BY rb.${sortCol} ${dir} LIMIT ${limit} OFFSET ${offset}`,
      [...innerParams, ...outerParams],
    ),
  ]);

  res.json({ items: dataRows, total: (countRows[0] as any).total, limit, offset });
});

// GET /recycle-bin/:entityType/:id — full entity data for the Details view
recycleBinRouter.get('/:entityType/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { entityType, id } = req.params;

  if (!VALID_ENTITY_TYPES.includes(entityType as EntityType)) {
    return res.status(400).json({ error: `entityType must be one of: ${VALID_ENTITY_TYPES.join(', ')}` });
  }

  const row = await fetchDeletedEntity(entityType as EntityType, id, gymId, getRequestLocale(req));
  if (!row) return res.status(404).json({ error: 'Deleted entity not found' });
  res.json(row);
});

async function fetchDeletedEntity(type: EntityType, id: string, gymId: string, locale: SupportedLocale): Promise<Record<string, unknown> | null> {
  let sql: string;
  switch (type) {
    case 'member':
      sql = `SELECT m.id, m.name, m.email, m.phone,
                    m.created_at, m.created_by, m.modified_at, m.modified_by, m.deleted_at, m.deleted_by
             FROM members m
             WHERE m.id = ? AND m.gym_id = ? AND m.deleted_at IS NOT NULL`;
      break;
    case 'membership_plan':
      sql = `SELECT mp.id, mp.name, mp.description, mp.lifecycle_status, mp.enrollment_status,
                    mp.created_at, mp.created_by, mp.modified_at, mp.modified_by, mp.deleted_at, mp.deleted_by
             FROM membership_plans mp
             WHERE mp.id = ? AND mp.gym_id = ? AND mp.deleted_at IS NOT NULL`;
      break;
    case 'promotion':
      sql = `SELECT p.id, p.name, p.description, p.lifecycle_status, p.starts_at, p.ends_at,
                    p.stackable, p.created_at, p.created_by, p.modified_at, p.modified_by,
                    p.deleted_at, p.deleted_by
             FROM promotions p
             WHERE p.id = ? AND p.gym_id = ? AND p.lifecycle_status = 'deleted'`;
      break;
    case 'center':
      sql = `SELECT c.id, c.name, c.code, c.phone, c.email, c.address_line_1, c.address_line_2,
                    c.city, c.country, c.status, c.created_at, c.created_by, c.modified_at, c.modified_by,
                    c.deleted_at, c.deleted_by
             FROM centers c
             WHERE c.id = ? AND c.gym_id = ? AND c.deleted_at IS NOT NULL`;
      break;
    case 'space':
      sql = `SELECT s.id, s.name, s.description, s.capacity, s.status, s.notes,
                    s.opening_time, s.closing_time, s.created_at, s.created_by, s.modified_at, s.modified_by,
                    s.deleted_at, s.deleted_by
             FROM spaces s
             WHERE s.id = ? AND s.gym_id = ? AND s.deleted_at IS NOT NULL`;
      break;
    case 'product':
      sql = `SELECT gc.id, gc.name, gc.description, gc.type, gc.units, gc.amount,
                    gc.billing_frequency, gc.status, gc.notes, gc.package_information, gc.validity_days,
                    gc.created_at, gc.created_by, gc.modified_at, gc.modified_by, gc.deleted_at, gc.deleted_by
             FROM products gc
             WHERE gc.id = ? AND gc.gym_id = ? AND gc.is_system = 0 AND gc.deleted_at IS NOT NULL`;
      break;
    case 'exercise':
      sql = `SELECT e.id, ${localizedExerciseNameSql('e', locale)} AS name,
                    e.description, e.video_url, e.image_url, e.status,
                    e.created_at, e.created_by, e.modified_at, e.modified_by, e.deleted_at, e.deleted_by
             FROM exercises e
             WHERE e.id = ? AND e.gym_id = ? AND e.status = 'deleted'`;
      break;
    case 'workout_template':
      sql = `SELECT wt.id, wt.name, wt.description, wt.notes, wt.status,
                    wt.created_at, wt.created_by, wt.modified_at, wt.modified_by, wt.deleted_at, wt.deleted_by
             FROM workout_templates wt
             WHERE wt.id = ? AND wt.gym_id = ? AND wt.status = 'deleted'`;
      break;
    case 'training_plan_template':
      sql = `SELECT tpt.id, tpt.name, tpt.description, tpt.status,
                    tpt.created_at, tpt.created_by, tpt.modified_at, tpt.modified_by, tpt.deleted_at, tpt.deleted_by
             FROM training_plan_templates tpt
             WHERE tpt.id = ? AND tpt.gym_id = ? AND tpt.status = 'deleted'`;
      break;
    case 'nutrition_plan_template':
      sql = `SELECT npt.id, npt.name, npt.description, npt.status,
                    npt.created_at, npt.created_by, npt.modified_at, npt.modified_by, npt.deleted_at, npt.deleted_by
             FROM nutrition_plan_templates npt
             WHERE npt.id = ? AND npt.gym_id = ? AND npt.status = 'deleted'`;
      break;
    case 'theme':
      sql = `SELECT t.id, t.name, t.description, t.status, t.created_at, t.created_by, t.modified_at, t.modified_by,
                    t.deleted_at, t.deleted_by
             FROM themes t
             WHERE t.id = ? AND t.gym_id = ? AND t.status = 'deleted'`;
      break;
    case 'activity_type':
      sql = `SELECT at.id, at.name, at.description, at.status, at.duration_minutes,
                    at.max_capacity, at.intensity_level, at.color,
                    at.created_at, at.created_by, at.modified_at, at.modified_by, at.deleted_at, at.deleted_by
             FROM activity_types at
             WHERE at.id = ? AND at.gym_id = ? AND at.deleted_at IS NOT NULL`;
      break;
    case 'professional_service':
      sql = `SELECT ps.id, ps.name, ps.description, ps.is_system, ps.system_key,
                    ps.created_at, ps.created_by, ps.modified_at, ps.modified_by, ps.deleted_at, ps.deleted_by
             FROM professional_services ps
             WHERE ps.id = ? AND ps.gym_id = ? AND ps.is_system = 0 AND ps.deleted_at IS NOT NULL`;
      break;
  }

  const { rows } = await db.query(sql, [id, gymId]);
  return (rows[0] as Record<string, unknown>) ?? null;
}

// POST /recycle-bin/:entityType/:id/recover
recycleBinRouter.post('/:entityType/:id/recover', requireModuleWrite('SYSTEM'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { entityType, id } = req.params;

  if (!VALID_ENTITY_TYPES.includes(entityType as EntityType)) {
    return res.status(400).json({ error: `entityType must be one of: ${VALID_ENTITY_TYPES.join(', ')}` });
  }

  const type = entityType as EntityType;

  // #1182 stage 2: a restore is a modification, recorded as one, and clears the
  // deleted pair.
  const actor = resolveRequestActor(getTenantContext(req));
  const restored = restoredAuditSet(actor);

  let sql: string;
  let params: unknown[] = [...restored.params, id, gymId];
  switch (type) {
    case 'member':
      sql = `UPDATE members SET deleted_at = NULL, deleted_by = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ? AND gym_id = ? AND deleted_at IS NOT NULL`;
      break;
    case 'membership_plan':
      sql = `UPDATE membership_plans SET deleted_at = NULL, deleted_by = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?, lifecycle_status = 'active' WHERE id = ? AND gym_id = ? AND deleted_at IS NOT NULL`;
      break;
    case 'promotion':
      sql = `UPDATE promotions SET deleted_at = NULL, deleted_by = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?, lifecycle_status = 'active' WHERE id = ? AND gym_id = ? AND lifecycle_status = 'deleted'`;
      break;
    case 'center':
      sql = `UPDATE centers SET deleted_at = NULL, deleted_by = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ? AND gym_id = ? AND deleted_at IS NOT NULL`;
      break;
    case 'space':
      sql = `UPDATE spaces SET deleted_at = NULL, deleted_by = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ? AND gym_id = ? AND deleted_at IS NOT NULL`;
      break;
    case 'product':
      sql = `UPDATE products SET deleted_at = NULL, deleted_by = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?, status = 'active' WHERE id = ? AND gym_id = ? AND is_system = 0 AND deleted_at IS NOT NULL`;
      break;
    case 'exercise':
      sql = `UPDATE exercises SET deleted_at = NULL, deleted_by = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?, status = 'active' WHERE id = ? AND gym_id = ? AND status = 'deleted'`;
      break;
    case 'workout_template':
      sql = `UPDATE workout_templates SET deleted_at = NULL, deleted_by = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?, status = 'active' WHERE id = ? AND gym_id = ? AND status = 'deleted'`;
      break;
    case 'training_plan_template':
      sql = `UPDATE training_plan_templates SET deleted_at = NULL, deleted_by = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?, status = 'active' WHERE id = ? AND gym_id = ? AND status = 'deleted'`;
      break;
    case 'nutrition_plan_template':
      sql = `UPDATE nutrition_plan_templates SET deleted_at = NULL, deleted_by = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?, status = 'active' WHERE id = ? AND gym_id = ? AND status = 'deleted'`;
      break;
    case 'theme':
      sql = `UPDATE themes SET deleted_at = NULL, deleted_by = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?, status = 'active' WHERE id = ? AND gym_id = ? AND status = 'deleted'`;
      break;
    case 'activity_type':
      sql = `UPDATE activity_types SET deleted_at = NULL, deleted_by = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?, status = 'active' WHERE id = ? AND gym_id = ? AND deleted_at IS NOT NULL`;
      break;
    case 'professional_service':
      sql = `UPDATE professional_services SET deleted_at = NULL, deleted_by = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ? AND gym_id = ? AND is_system = 0 AND deleted_at IS NOT NULL`;
      break;
  }

  const { rowCount } = await db.query(sql, params);
  if (rowCount === 0) return res.status(404).json({ error: 'Deleted entity not found' });

  recordAudit(req, { action: 'restore', entityType: type, entityId: Number(id) });

  res.status(204).send();
});
