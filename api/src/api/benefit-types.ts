import { Router } from 'express';
import { db } from '../infra/db';

/**
 * Global lookup table (no gym_id). Auth required (registered under
 * tenantContext) but any gym role can read — the vocabulary is public.
 */
export const benefitTypesRouter = Router();

benefitTypesRouter.get('/', async (_req, res) => {
  const { rows } = await db.query('SELECT id, code, active FROM benefit_types ORDER BY id ASC');
  res.json(rows);
});
