import { Router } from 'express';
import { db } from '../infra/db';

/** Global lookup, gym-scoped only by the tenantContext requirement — no gym_id. */
export const actionTypesRouter = Router();

actionTypesRouter.get('/', async (_req, res) => {
  const { rows } = await db.query('SELECT id, code, active FROM action_types ORDER BY id ASC');
  res.json(rows);
});
