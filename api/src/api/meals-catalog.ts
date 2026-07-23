import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { handleDupEntry, insertAndFetch } from '../infra/db-helpers';
import { recordAudit } from '../infra/audit';

type CatalogTable = 'dishes' | 'sides' | 'sauces';

function makeCatalogRouter(table: CatalogTable, entityType: string): Router {
  const r = Router();

  r.get('/', async (req, res, next) => {
    const { gymId } = getTenantContext(req);
    const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
    try {
      const where: string[] = ['gym_id = ?'];
      const params: any[] = [gymId];
      if (name) { where.push('name LIKE ?'); params.push(`%${name}%`); }
      const { rows } = await db.query(
        `SELECT * FROM ${table} WHERE ${where.join(' AND ')} ORDER BY name ASC`,
        params,
      );
      res.json(rows);
    } catch (err) { next(err); }
  });

  r.get('/:id', async (req, res, next) => {
    const { gymId } = getTenantContext(req);
    try {
      const { rows } = await db.query(
        `SELECT * FROM ${table} WHERE id = ? AND gym_id = ?`,
        [req.params.id, gymId],
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  });

  r.post('/', requireModuleWrite('NUTRITION'), async (req, res, next) => {
    const { gymId } = getTenantContext(req);
    const { name, description, calories, protein, carbohydrates, fat } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    try {
      const row = await insertAndFetch(
        `INSERT INTO ${table} (gym_id, name, description, calories, protein, carbohydrates, fat) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [gymId, name.trim(), description ?? null, calories ?? null, protein ?? null, carbohydrates ?? null, fat ?? null],
        `SELECT * FROM ${table} WHERE id = ?`,
        (id) => [id],
      );
      recordAudit(req, { action: 'create', entityType, entityId: row.id, next: row });
      res.status(201).json(row);
    } catch (err: any) {
      handleDupEntry(err, res, next, `A ${entityType} with this name already exists.`);
    }
  });

  r.put('/:id', requireModuleWrite('NUTRITION'), async (req, res, next) => {
    const { gymId } = getTenantContext(req);
    const { name, description, calories, protein, carbohydrates, fat } = req.body;
    if (name !== undefined && !name?.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    const updates: string[] = [];
    const params: any[] = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name.trim()); }
    if ('description' in req.body) { updates.push('description = ?'); params.push(description ?? null); }
    if ('calories' in req.body) { updates.push('calories = ?'); params.push(calories ?? null); }
    if ('protein' in req.body) { updates.push('protein = ?'); params.push(protein ?? null); }
    if ('carbohydrates' in req.body) { updates.push('carbohydrates = ?'); params.push(carbohydrates ?? null); }
    if ('fat' in req.body) { updates.push('fat = ?'); params.push(fat ?? null); }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    updates.push('modified_at = UTC_TIMESTAMP()');
    params.push(req.params.id, gymId);
    try {
      const { rowCount } = await db.query(
        `UPDATE ${table} SET ${updates.join(', ')} WHERE id = ? AND gym_id = ?`,
        params,
      );
      if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
      const { rows } = await db.query(`SELECT * FROM ${table} WHERE id = ?`, [req.params.id]);
      recordAudit(req, { action: 'update', entityType, entityId: req.params.id, next: rows[0] });
      res.json(rows[0]);
    } catch (err: any) {
      handleDupEntry(err, res, next, `A ${entityType} with this name already exists.`);
    }
  });

  r.delete('/:id', requireModuleWrite('NUTRITION'), async (req, res, next) => {
    const { gymId } = getTenantContext(req);
    try {
      // Guard against use in nutrition plan templates (FK may not be enforced in all envs)
      if (table === 'dishes') {
        const { rows: used } = await db.query(
          'SELECT 1 FROM nutrition_plan_template_meal_dishes WHERE dish_id = ? AND gym_id = ? LIMIT 1',
          [req.params.id, gymId],
        );
        if (used.length > 0) {
          return res.status(409).json({ error: 'Cannot delete: this dish is used in one or more nutrition plan templates.' });
        }
      }
      const { rowCount } = await db.query(
        `DELETE FROM ${table} WHERE id = ? AND gym_id = ?`,
        [req.params.id, gymId],
      );
      if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
      recordAudit(req, { action: 'delete', entityType, entityId: req.params.id });
      res.status(204).send();
    } catch (err: any) {
      if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.errno === 1451) {
        return res.status(409).json({ error: `Cannot delete: this ${entityType} is used in one or more nutrition plan templates.` });
      }
      next(err);
    }
  });

  return r;
}

export const dishesRouter = makeCatalogRouter('dishes', 'dish');
export const sidesRouter = makeCatalogRouter('sides', 'side');
export const saucesRouter = makeCatalogRouter('sauces', 'sauce');
