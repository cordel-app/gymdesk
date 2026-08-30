import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';

export const recycleBinRouter = Router();

type EntityType =
  | 'membership_plan'
  | 'promotion'
  | 'center'
  | 'space'
  | 'sellable_item'
  | 'exercise'
  | 'workout_template'
  | 'training_plan_template'
  | 'nutrition_plan_template'
  | 'theme';

const VALID_ENTITY_TYPES: EntityType[] = [
  'membership_plan',
  'promotion',
  'center',
  'space',
  'sellable_item',
  'exercise',
  'workout_template',
  'training_plan_template',
  'nutrition_plan_template',
  'theme',
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

function branchFor(type: EntityType, gymId: string): UnionBranch {
  switch (type) {
    case 'membership_plan':
      return {
        sql: `SELECT 'membership_plan' AS entity_type, mp.id, mp.name, mp.description,
               COALESCE(mp.deleted_by_name, gm_d.name) AS deleted_by_name, mp.deleted_at,
               mp.created_at, gm_c.name AS created_by_name
             FROM membership_plans mp
             LEFT JOIN gym_memberships gm_d ON gm_d.id = mp.deleted_by
             LEFT JOIN gym_memberships gm_c ON gm_c.id = mp.created_by
             WHERE mp.gym_id = ? AND mp.deleted_at IS NOT NULL`,
        params: [gymId],
      };
    case 'promotion':
      return {
        sql: `SELECT 'promotion' AS entity_type, p.id, p.name, p.description,
               COALESCE(p.deleted_by_name, gm_d.name) AS deleted_by_name, p.deleted_at,
               p.created_at, gm_c.name AS created_by_name
             FROM promotions p
             LEFT JOIN gym_memberships gm_d ON gm_d.id = p.deleted_by_membership_id
             LEFT JOIN gym_memberships gm_c ON gm_c.id = p.created_by_membership_id
             WHERE p.gym_id = ? AND p.lifecycle_status = 'deleted'`,
        params: [gymId],
      };
    case 'center':
      return {
        sql: `SELECT 'center' AS entity_type, c.id, c.name, NULL AS description,
               COALESCE(c.deleted_by_name, gm_d.name) AS deleted_by_name, c.deleted_at,
               c.created_at, gm_c.name AS created_by_name
             FROM centers c
             LEFT JOIN gym_memberships gm_d ON gm_d.id = c.deleted_by_membership_id
             LEFT JOIN gym_memberships gm_c ON gm_c.id = c.created_by_membership_id
             WHERE c.gym_id = ? AND c.deleted_at IS NOT NULL`,
        params: [gymId],
      };
    case 'space':
      return {
        sql: `SELECT 'space' AS entity_type, s.id, s.name, s.description,
               COALESCE(s.deleted_by_name, gm_d.name) AS deleted_by_name, s.deleted_at,
               s.created_at, gm_c.name AS created_by_name
             FROM spaces s
             LEFT JOIN gym_memberships gm_d ON gm_d.id = s.deleted_by_membership_id
             LEFT JOIN gym_memberships gm_c ON gm_c.id = s.created_by_membership_id
             WHERE s.gym_id = ? AND s.deleted_at IS NOT NULL`,
        params: [gymId],
      };
    case 'sellable_item':
      return {
        sql: `SELECT 'sellable_item' AS entity_type, gc.id, gc.name, gc.description,
               COALESCE(gc.deleted_by_name, gm_d.name) AS deleted_by_name, gc.deleted_at,
               gc.created_at, gm_c.name AS created_by_name
             FROM gym_charges gc
             LEFT JOIN gym_memberships gm_d ON gm_d.id = gc.deleted_by_membership_id
             LEFT JOIN gym_memberships gm_c ON gm_c.id = gc.created_by_membership_id
             WHERE gc.gym_id = ? AND gc.is_system = 0 AND gc.deleted_at IS NOT NULL`,
        params: [gymId],
      };
    case 'exercise':
      return {
        sql: `SELECT 'exercise' AS entity_type, e.id, e.name, e.description,
               COALESCE(e.deleted_by_name, gm_d.name) AS deleted_by_name, e.deleted_at,
               e.created_at, gm_c.name AS created_by_name
             FROM exercises e
             LEFT JOIN gym_memberships gm_d ON gm_d.id = e.deleted_by
             LEFT JOIN gym_memberships gm_c ON gm_c.id = e.created_by
             WHERE e.gym_id = ? AND e.status = 'deleted'`,
        params: [gymId],
      };
    case 'workout_template':
      return {
        sql: `SELECT 'workout_template' AS entity_type, wt.id, wt.name, wt.description,
               COALESCE(wt.deleted_by_name, gm_d.name) AS deleted_by_name, wt.deleted_at,
               wt.created_at, gm_c.name AS created_by_name
             FROM workout_templates wt
             LEFT JOIN gym_memberships gm_d ON gm_d.id = wt.deleted_by_membership_id
             LEFT JOIN gym_memberships gm_c ON gm_c.id = wt.created_by_membership_id
             WHERE wt.gym_id = ? AND wt.status = 'deleted'`,
        params: [gymId],
      };
    case 'training_plan_template':
      return {
        sql: `SELECT 'training_plan_template' AS entity_type, tpt.id, tpt.name, tpt.description,
               COALESCE(tpt.deleted_by_name, gm_d.name) AS deleted_by_name, tpt.deleted_at,
               tpt.created_at, gm_c.name AS created_by_name
             FROM training_plan_templates tpt
             LEFT JOIN gym_memberships gm_d ON gm_d.id = tpt.deleted_by_membership_id
             LEFT JOIN gym_memberships gm_c ON gm_c.id = tpt.created_by_membership_id
             WHERE tpt.gym_id = ? AND tpt.status = 'deleted'`,
        params: [gymId],
      };
    case 'nutrition_plan_template':
      return {
        sql: `SELECT 'nutrition_plan_template' AS entity_type, npt.id, npt.name, npt.description,
               COALESCE(npt.deleted_by_name, gm_d.name) AS deleted_by_name, npt.deleted_at,
               npt.created_at, gm_c.name AS created_by_name
             FROM nutrition_plan_templates npt
             LEFT JOIN gym_memberships gm_d ON gm_d.id = npt.deleted_by_membership_id
             LEFT JOIN gym_memberships gm_c ON gm_c.id = npt.created_by_membership_id
             WHERE npt.gym_id = ? AND npt.status = 'deleted'`,
        params: [gymId],
      };
    case 'theme':
      return {
        sql: `SELECT 'theme' AS entity_type, t.id,
               CONVERT(t.name USING utf8mb4) AS name,
               CONVERT(t.description USING utf8mb4) AS description,
               CONVERT(t.deleted_by_name USING utf8mb4) AS deleted_by_name, t.deleted_at,
               t.created_at, NULL AS created_by_name
             FROM themes t
             WHERE t.gym_id = ? AND t.status = 'deleted'`,
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
  const deletedByName = typeof req.query.deleted_by_name === 'string' ? req.query.deleted_by_name.trim() : null;
  const from = typeof req.query.from === 'string' ? req.query.from : null;
  const to = typeof req.query.to === 'string' ? req.query.to : null;
  const sort = typeof req.query.sort === 'string' ? req.query.sort : 'deleted_at';
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
  const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

  const sortCol = SORT_COLUMNS[sort] ?? 'deleted_at';

  const types = entityType ? [entityType as EntityType] : VALID_ENTITY_TYPES;
  const branches = types.map(t => branchFor(t, gymId));
  const innerSql = branches.map(b => `(${b.sql})`).join('\nUNION ALL\n');
  const innerParams = branches.flatMap(b => b.params);

  const outerWhere: string[] = [];
  const outerParams: unknown[] = [];
  if (q) {
    outerWhere.push('(rb.name LIKE ? OR rb.description LIKE ?)');
    outerParams.push(`%${q}%`, `%${q}%`);
  }
  if (deletedByName) {
    outerWhere.push('rb.deleted_by_name LIKE ?');
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

  const row = await fetchDeletedEntity(entityType as EntityType, id, gymId);
  if (!row) return res.status(404).json({ error: 'Deleted entity not found' });
  res.json(row);
});

async function fetchDeletedEntity(type: EntityType, id: string, gymId: string): Promise<Record<string, unknown> | null> {
  let sql: string;
  switch (type) {
    case 'membership_plan':
      sql = `SELECT mp.id, mp.name, mp.description, mp.lifecycle_status, mp.enrollment_status,
                    mp.created_at, mp.modified_at, mp.deleted_at,
                    gm_c.name AS created_by_name, gm_m.name AS modified_by_name,
                    COALESCE(mp.deleted_by_name, gm_d.name) AS deleted_by_name
             FROM membership_plans mp
             LEFT JOIN gym_memberships gm_c ON gm_c.id = mp.created_by
             LEFT JOIN gym_memberships gm_m ON gm_m.id = mp.modified_by
             LEFT JOIN gym_memberships gm_d ON gm_d.id = mp.deleted_by
             WHERE mp.id = ? AND mp.gym_id = ? AND mp.deleted_at IS NOT NULL`;
      break;
    case 'promotion':
      sql = `SELECT p.id, p.name, p.description, p.lifecycle_status, p.starts_at, p.ends_at,
                    p.stackable, p.created_at, p.deleted_at,
                    gm_c.name AS created_by_name,
                    COALESCE(p.deleted_by_name, gm_d.name) AS deleted_by_name
             FROM promotions p
             LEFT JOIN gym_memberships gm_c ON gm_c.id = p.created_by_membership_id
             LEFT JOIN gym_memberships gm_d ON gm_d.id = p.deleted_by_membership_id
             WHERE p.id = ? AND p.gym_id = ? AND p.lifecycle_status = 'deleted'`;
      break;
    case 'center':
      sql = `SELECT c.id, c.name, c.code, c.phone, c.email, c.address_line_1, c.address_line_2,
                    c.city, c.country, c.status, c.created_at, c.modified_at, c.deleted_at,
                    gm_c.name AS created_by_name, gm_m.name AS modified_by_name,
                    COALESCE(c.deleted_by_name, gm_d.name) AS deleted_by_name
             FROM centers c
             LEFT JOIN gym_memberships gm_c ON gm_c.id = c.created_by_membership_id
             LEFT JOIN gym_memberships gm_m ON gm_m.id = c.modified_by_membership_id
             LEFT JOIN gym_memberships gm_d ON gm_d.id = c.deleted_by_membership_id
             WHERE c.id = ? AND c.gym_id = ? AND c.deleted_at IS NOT NULL`;
      break;
    case 'space':
      sql = `SELECT s.id, s.name, s.description, s.capacity, s.status, s.notes,
                    s.opening_time, s.closing_time, s.created_at, s.modified_at, s.deleted_at,
                    gm_c.name AS created_by_name, gm_m.name AS modified_by_name,
                    COALESCE(s.deleted_by_name, gm_d.name) AS deleted_by_name
             FROM spaces s
             LEFT JOIN gym_memberships gm_c ON gm_c.id = s.created_by_membership_id
             LEFT JOIN gym_memberships gm_m ON gm_m.id = s.modified_by_membership_id
             LEFT JOIN gym_memberships gm_d ON gm_d.id = s.deleted_by_membership_id
             WHERE s.id = ? AND s.gym_id = ? AND s.deleted_at IS NOT NULL`;
      break;
    case 'sellable_item':
      sql = `SELECT gc.id, gc.name, gc.description, gc.type, gc.units, gc.amount,
                    gc.billing_frequency, gc.status, gc.notes, gc.package_information, gc.validity_days,
                    gc.created_at, gc.modified_at, gc.deleted_at,
                    gm_c.name AS created_by_name, gm_m.name AS modified_by_name,
                    COALESCE(gc.deleted_by_name, gm_d.name) AS deleted_by_name
             FROM gym_charges gc
             LEFT JOIN gym_memberships gm_c ON gm_c.id = gc.created_by_membership_id
             LEFT JOIN gym_memberships gm_m ON gm_m.id = gc.modified_by_membership_id
             LEFT JOIN gym_memberships gm_d ON gm_d.id = gc.deleted_by_membership_id
             WHERE gc.id = ? AND gc.gym_id = ? AND gc.is_system = 0 AND gc.deleted_at IS NOT NULL`;
      break;
    case 'exercise':
      sql = `SELECT e.id, e.name, e.description, e.video_url, e.image_url, e.status,
                    e.created_at, e.modified_at, e.deleted_at,
                    gm_c.name AS created_by_name, gm_m.name AS modified_by_name,
                    COALESCE(e.deleted_by_name, gm_d.name) AS deleted_by_name
             FROM exercises e
             LEFT JOIN gym_memberships gm_c ON gm_c.id = e.created_by
             LEFT JOIN gym_memberships gm_m ON gm_m.id = e.modified_by
             LEFT JOIN gym_memberships gm_d ON gm_d.id = e.deleted_by
             WHERE e.id = ? AND e.gym_id = ? AND e.status = 'deleted'`;
      break;
    case 'workout_template':
      sql = `SELECT wt.id, wt.name, wt.description, wt.notes, wt.status,
                    wt.created_at, wt.modified_at, wt.deleted_at,
                    gm_c.name AS created_by_name, gm_m.name AS modified_by_name,
                    COALESCE(wt.deleted_by_name, gm_d.name) AS deleted_by_name
             FROM workout_templates wt
             LEFT JOIN gym_memberships gm_c ON gm_c.id = wt.created_by_membership_id
             LEFT JOIN gym_memberships gm_m ON gm_m.id = wt.modified_by_membership_id
             LEFT JOIN gym_memberships gm_d ON gm_d.id = wt.deleted_by_membership_id
             WHERE wt.id = ? AND wt.gym_id = ? AND wt.status = 'deleted'`;
      break;
    case 'training_plan_template':
      sql = `SELECT tpt.id, tpt.name, tpt.description, tpt.status,
                    tpt.created_at, tpt.modified_at, tpt.deleted_at,
                    gm_c.name AS created_by_name, gm_m.name AS modified_by_name,
                    COALESCE(tpt.deleted_by_name, gm_d.name) AS deleted_by_name
             FROM training_plan_templates tpt
             LEFT JOIN gym_memberships gm_c ON gm_c.id = tpt.created_by_membership_id
             LEFT JOIN gym_memberships gm_m ON gm_m.id = tpt.modified_by_membership_id
             LEFT JOIN gym_memberships gm_d ON gm_d.id = tpt.deleted_by_membership_id
             WHERE tpt.id = ? AND tpt.gym_id = ? AND tpt.status = 'deleted'`;
      break;
    case 'nutrition_plan_template':
      sql = `SELECT npt.id, npt.name, npt.description, npt.status,
                    npt.created_at, npt.modified_at, npt.deleted_at,
                    gm_c.name AS created_by_name, gm_m.name AS modified_by_name,
                    COALESCE(npt.deleted_by_name, gm_d.name) AS deleted_by_name
             FROM nutrition_plan_templates npt
             LEFT JOIN gym_memberships gm_c ON gm_c.id = npt.created_by_membership_id
             LEFT JOIN gym_memberships gm_m ON gm_m.id = npt.modified_by_membership_id
             LEFT JOIN gym_memberships gm_d ON gm_d.id = npt.deleted_by_membership_id
             WHERE npt.id = ? AND npt.gym_id = ? AND npt.status = 'deleted'`;
      break;
    case 'theme':
      sql = `SELECT t.id, t.name, t.description, t.status, t.created_at, t.modified_at, t.deleted_at,
                    t.deleted_by_name
             FROM themes t
             WHERE t.id = ? AND t.gym_id = ? AND t.status = 'deleted'`;
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

  let sql: string;
  let checkDeletedCondition: string;
  switch (type) {
    case 'membership_plan':
      sql = `UPDATE membership_plans SET deleted_at = NULL, deleted_by = NULL, lifecycle_status = 'active' WHERE id = ? AND gym_id = ? AND deleted_at IS NOT NULL`;
      checkDeletedCondition = 'deleted_at IS NOT NULL';
      break;
    case 'promotion':
      sql = `UPDATE promotions SET lifecycle_status = 'active', deleted_at = NULL, deleted_by_membership_id = NULL WHERE id = ? AND gym_id = ? AND lifecycle_status = 'deleted'`;
      checkDeletedCondition = "lifecycle_status = 'deleted'";
      break;
    case 'center':
      sql = `UPDATE centers SET deleted_at = NULL, deleted_by_membership_id = NULL WHERE id = ? AND gym_id = ? AND deleted_at IS NOT NULL`;
      checkDeletedCondition = 'deleted_at IS NOT NULL';
      break;
    case 'space':
      sql = `UPDATE spaces SET deleted_at = NULL, deleted_by_membership_id = NULL WHERE id = ? AND gym_id = ? AND deleted_at IS NOT NULL`;
      checkDeletedCondition = 'deleted_at IS NOT NULL';
      break;
    case 'sellable_item':
      sql = `UPDATE gym_charges SET deleted_at = NULL, deleted_by_membership_id = NULL, deleted_by_name = NULL, status = 'active' WHERE id = ? AND gym_id = ? AND is_system = 0 AND deleted_at IS NOT NULL`;
      checkDeletedCondition = 'deleted_at IS NOT NULL';
      break;
    case 'exercise':
      sql = `UPDATE exercises SET status = 'active', deleted_at = NULL, deleted_by = NULL WHERE id = ? AND gym_id = ? AND status = 'deleted'`;
      checkDeletedCondition = "status = 'deleted'";
      break;
    case 'workout_template':
      sql = `UPDATE workout_templates SET status = 'active', deleted_at = NULL, deleted_by_membership_id = NULL WHERE id = ? AND gym_id = ? AND status = 'deleted'`;
      checkDeletedCondition = "status = 'deleted'";
      break;
    case 'training_plan_template':
      sql = `UPDATE training_plan_templates SET status = 'active', deleted_at = NULL, deleted_by_membership_id = NULL WHERE id = ? AND gym_id = ? AND status = 'deleted'`;
      checkDeletedCondition = "status = 'deleted'";
      break;
    case 'nutrition_plan_template':
      sql = `UPDATE nutrition_plan_templates SET status = 'active', deleted_at = NULL, deleted_by_membership_id = NULL WHERE id = ? AND gym_id = ? AND status = 'deleted'`;
      checkDeletedCondition = "status = 'deleted'";
      break;
    case 'theme':
      sql = `UPDATE themes SET status = 'active', deleted_at = NULL WHERE id = ? AND gym_id = ? AND status = 'deleted'`;
      checkDeletedCondition = "status = 'deleted'";
      break;
  }

  const { rowCount } = await db.query(sql, [id, gymId]);
  if (rowCount === 0) return res.status(404).json({ error: 'Deleted entity not found' });

  recordAudit(req, { action: 'restore', entityType: type, entityId: Number(id) });

  res.status(204).send();
});
