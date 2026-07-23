import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { handleDupEntry, insertAndFetch } from '../infra/db-helpers';
import { recordAudit } from '../infra/audit';

type CatalogTable = 'dishes' | 'sides' | 'sauces';

const auditJoin = (t: string) =>
  `LEFT JOIN gym_memberships gm_c ON gm_c.id = ${t}.created_by_membership_id
   LEFT JOIN gym_memberships gm_m ON gm_m.id = ${t}.modified_by_membership_id
   LEFT JOIN gym_memberships gm_d ON gm_d.id = ${t}.deleted_by_membership_id`;

const auditCols = (t: string) =>
  `${t}.*, gm_c.name AS created_by_name, gm_m.name AS modified_by_name, gm_d.name AS deleted_by_name`;

function makeCatalogRouter(table: CatalogTable, entityType: string): Router {
  const r = Router();

  r.get('/', async (req, res, next) => {
    const { gymId } = getTenantContext(req);
    const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
    try {
      const where: string[] = [`${table}.gym_id = ?`, `${table}.status != 'deleted'`];
      const params: any[] = [gymId];
      if (name) { where.push(`${table}.name LIKE ?`); params.push(`%${name}%`); }
      const { rows } = await db.query(
        `SELECT ${auditCols(table)}
         FROM ${table}
         ${auditJoin(table)}
         WHERE ${where.join(' AND ')}
         ORDER BY ${table}.name ASC`,
        params,
      );
      res.json(rows);
    } catch (err) { next(err); }
  });

  r.get('/:id', async (req, res, next) => {
    const { gymId } = getTenantContext(req);
    try {
      const { rows } = await db.query(
        `SELECT ${auditCols(table)}
         FROM ${table}
         ${auditJoin(table)}
         WHERE ${table}.id = ? AND ${table}.gym_id = ?`,
        [req.params.id, gymId],
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  });

  r.post('/', requireModuleWrite('NUTRITION'), async (req, res, next) => {
    const { gymId, gymMembershipId } = getTenantContext(req);
    const { name, description, calories, protein, carbohydrates, fat } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    try {
      const row = await insertAndFetch(
        `INSERT INTO ${table} (gym_id, name, description, calories, protein, carbohydrates, fat, status, created_by_membership_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        [gymId, name.trim(), description ?? null, calories ?? null, protein ?? null, carbohydrates ?? null, fat ?? null, gymMembershipId],
        `SELECT ${auditCols(table)} FROM ${table} ${auditJoin(table)} WHERE ${table}.id = ?`,
        (id) => [id],
      );
      recordAudit(req, { action: 'create', entityType, entityId: row.id, next: row });
      res.status(201).json(row);
    } catch (err: any) {
      handleDupEntry(err, res, next, `A ${entityType} with this name already exists.`);
    }
  });

  r.put('/:id', requireModuleWrite('NUTRITION'), async (req, res, next) => {
    const { gymId, gymMembershipId } = getTenantContext(req);
    const { name, description, calories, protein, carbohydrates, fat, status } = req.body;
    if (name !== undefined && !name?.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    const updates: string[] = [];
    const params: any[] = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name.trim()); }
    if ('description' in req.body) { updates.push('description = ?'); params.push(description ?? null); }
    if ('calories' in req.body) { updates.push('calories = ?'); params.push(calories ?? null); }
    if ('protein' in req.body) { updates.push('protein = ?'); params.push(protein ?? null); }
    if ('carbohydrates' in req.body) { updates.push('carbohydrates = ?'); params.push(carbohydrates ?? null); }
    if ('fat' in req.body) { updates.push('fat = ?'); params.push(fat ?? null); }
    if (status !== undefined) { updates.push('status = ?'); params.push(status); }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    updates.push('modified_at = UTC_TIMESTAMP()', 'modified_by_membership_id = ?');
    params.push(gymMembershipId, req.params.id, gymId);
    try {
      const { rowCount } = await db.query(
        `UPDATE ${table} SET ${updates.join(', ')} WHERE id = ? AND gym_id = ? AND status != 'deleted'`,
        params,
      );
      if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
      const { rows } = await db.query(
        `SELECT ${auditCols(table)} FROM ${table} ${auditJoin(table)} WHERE ${table}.id = ?`,
        [req.params.id],
      );
      recordAudit(req, { action: 'update', entityType, entityId: req.params.id, next: rows[0] });
      res.json(rows[0]);
    } catch (err: any) {
      handleDupEntry(err, res, next, `A ${entityType} with this name already exists.`);
    }
  });

  r.delete('/:id', requireModuleWrite('NUTRITION'), async (req, res, next) => {
    const { gymId, gymMembershipId } = getTenantContext(req);
    try {
      const { rowCount } = await db.query(
        `UPDATE ${table}
         SET status = 'deleted', deleted_at = UTC_TIMESTAMP(), deleted_by_membership_id = ?
         WHERE id = ? AND gym_id = ? AND status != 'deleted'`,
        [gymMembershipId, req.params.id, gymId],
      );
      if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
      recordAudit(req, { action: 'delete', entityType, entityId: req.params.id });
      res.status(204).send();
    } catch (err) { next(err); }
  });

  r.post('/:id/duplicate', requireModuleWrite('NUTRITION'), async (req, res, next) => {
    const { gymId, gymMembershipId } = getTenantContext(req);
    try {
      const { rows: src } = await db.query(
        `SELECT * FROM ${table} WHERE id = ? AND gym_id = ? AND status != 'deleted'`,
        [req.params.id, gymId],
      );
      if (src.length === 0) return res.status(404).json({ error: 'Not found' });
      const s = src[0];
      const row = await insertAndFetch(
        `INSERT INTO ${table} (gym_id, name, description, calories, protein, carbohydrates, fat, status, created_by_membership_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        [gymId, `${s.name} (copy)`, s.description ?? null, s.calories ?? null, s.protein ?? null, s.carbohydrates ?? null, s.fat ?? null, gymMembershipId],
        `SELECT ${auditCols(table)} FROM ${table} ${auditJoin(table)} WHERE ${table}.id = ?`,
        (id) => [id],
      );
      recordAudit(req, { action: 'create', entityType, entityId: row.id, next: row });
      res.status(201).json(row);
    } catch (err: any) {
      handleDupEntry(err, res, next, `A ${entityType} with this name already exists.`);
    }
  });

  return r;
}

export const dishesRouter = makeCatalogRouter('dishes', 'dish');
export const sidesRouter = makeCatalogRouter('sides', 'side');
export const saucesRouter = makeCatalogRouter('sauces', 'sauce');
