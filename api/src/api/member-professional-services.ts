import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext } from '../infra/tenantContext';
import { resolveMemberProfessionalServices } from '../domain/memberProfessionalServices';

/**
 * #647 stage 1: read-only view of the Member side of the Professional
 * Service link — which services the Member holds sessions for, how many, and
 * where those sessions come from.
 *
 * Stage 2's weekly availability projection filters candidate slots by
 * intersecting this list with `calendar_events.professional_service_id`
 * (migration 168), so it is deliberately a standalone endpoint rather than a
 * field bolted onto the Member payload: the list is derived from packages,
 * promotions and assignment services, none of which the Member row knows
 * about.
 *
 * Mounted at /members/:memberId/professional-services (mergeParams: true),
 * like member-centers.ts.
 */
export const memberProfessionalServicesRouter = Router({ mergeParams: true });

memberProfessionalServicesRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const memberId = parseInt((req.params as { memberId: string }).memberId, 10);
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return res.status(400).json({ error: 'memberId must be a positive integer' });
  }
  try {
    const { rows: memberRows } = await db.query(
      'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [memberId, gymId],
    );
    if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

    res.json(await resolveMemberProfessionalServices(gymId, memberId));
  } catch (err) { next(err); }
});
