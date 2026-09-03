import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext } from '../infra/tenantContext';

/**
 * "Trainer" is a coach-role row in gym_memberships (per docs/architecture.md).
 * These routes surface coach memberships for assignment to class types and sessions.
 */
export const trainersRouter = Router();

trainersRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `SELECT gm.id AS gym_membership_id, gm.user_id, gm.name, gm.role, gm.created_at,
            gm.max_concurrent_groups
     FROM gym_memberships gm
     WHERE gm.gym_id = ? AND gm.role IN ('trainer_performance','trainer_perf_nutrition')
     ORDER BY gm.name ASC`,
    [gymId],
  );
  res.json(rows);
});
