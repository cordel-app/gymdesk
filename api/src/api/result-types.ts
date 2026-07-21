import { Router } from 'express';
import { db } from '../infra/db';

/** #154: Global read-only catalog of result types. No gym_id — same catalog for all gyms. */
export const resultTypesRouter = Router();

resultTypesRouter.get('/', async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id, name, slug FROM result_types ORDER BY id ASC');
    res.json(rows);
  } catch (err) { next(err); }
});
