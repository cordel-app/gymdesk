import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext } from '../infra/tenantContext';
import { assignableTrainersSql } from '../domain/trainerAssignment';

/**
 * #986: a "trainer" is anyone who may be assigned to deliver an activity, and
 * that is an **active Staff record** — not a coach role on a login row, which
 * is what this route filtered on until now and why the Default Trainer dropdown
 * came back empty for a gym whose staff are Front Desk or Gym Managers. The
 * rule, and the ordering, live in `domain/trainerAssignment.ts`; this route is
 * one projection of it and the Activity Type / calendar writers validate
 * against the same one, so the picker and the validator cannot disagree.
 */
export const trainersRouter = Router();

trainersRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    assignableTrainersSql(`
      gm.id AS gym_membership_id, gm.user_id, gm.role, gm.created_at,
      gm.max_concurrent_groups,
      s.id AS staff_id, s.profile, s.employment_status,
      CONCAT(s.first_name, ' ', s.last_name) AS name
    `),
    [gymId],
  );
  res.json(rows);
});
