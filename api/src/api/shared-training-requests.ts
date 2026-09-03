/**
 * #323 + #324: Shared-training request management for trainers and admins.
 *
 * The shared_training_requests table was created by 115_member_calendar.js (#324).
 * #323 adds max_concurrent_groups capacity enforcement to the approval workflow.
 *
 * GET  /shared-training-requests             list requests
 * GET  /shared-training-requests/:id         single request
 * POST /shared-training-requests             staff creates request on behalf of a member
 * POST /shared-training-requests/:id/approve approve → books member, marks approved
 * POST /shared-training-requests/:id/reject  reject → marks rejected, notifies member
 */
import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { sendNotification } from '../infra/notifications';

export const sharedTrainingRequestsRouter = Router();

const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;

const SELECT = `
  SELECT str.id, str.gym_id, str.class_session_id, str.requesting_member_id,
         str.activity_type_id, str.status, str.reviewed_by_membership_id,
         str.reviewed_at, str.created_at, str.notes,
         m.name AS requesting_member_name,
         at.name AS activity_type_name,
         at.is_shareable,
         cs.starts_at, cs.ends_at, cs.allows_shared_booking,
         sp.name AS space_name,
         tm.name AS trainer_name,
         gm_res.name AS resolved_by_name
  FROM shared_training_requests str
  JOIN members m ON m.id = str.requesting_member_id
  JOIN activity_types at ON at.id = str.activity_type_id
  JOIN class_sessions cs ON cs.id = str.class_session_id
  LEFT JOIN spaces sp ON sp.id = cs.space_id
  LEFT JOIN gym_memberships tm ON tm.id = cs.trainer_membership_id
  LEFT JOIN gym_memberships gm_res ON gm_res.id = str.reviewed_by_membership_id
`;

sharedTrainingRequestsRouter.get('/', async (req, res, next) => {
  const { gymId, role, gymMembershipId } = getTenantContext(req);
  const { status, class_session_id } = req.query as Record<string, string | undefined>;

  if (status && !STATUSES.includes(status as any)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }

  try {
    const where: string[] = ['str.gym_id = ?'];
    const params: any[] = [gymId];

    if (role === 'trainer_performance' || role === 'trainer_perf_nutrition') {
      where.push('cs.trainer_membership_id = ?');
      params.push(gymMembershipId);
    }
    if (status)           { where.push('str.status = ?');           params.push(status); }
    if (class_session_id) { where.push('str.class_session_id = ?'); params.push(class_session_id); }

    const { rows } = await db.query(
      `${SELECT} WHERE ${where.join(' AND ')} ORDER BY str.created_at DESC`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

sharedTrainingRequestsRouter.get('/:id', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(`${SELECT} WHERE str.id = ? AND str.gym_id = ?`, [req.params.id, gymId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/** Staff creates a shared training request on behalf of a member. */
sharedTrainingRequestsRouter.post('/', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { class_session_id, requesting_member_id, notes } = req.body;
  if (!class_session_id || !requesting_member_id) {
    return res.status(400).json({ error: 'class_session_id and requesting_member_id are required' });
  }

  try {
    const validationErr = await validateRequest(gymId, Number(class_session_id), Number(requesting_member_id));
    if (validationErr) return res.status(validationErr.status).json({ error: validationErr.message, code: validationErr.code });

    const { rows: sessionRows } = await db.query<{ activity_type_id: number }>(
      'SELECT activity_type_id FROM class_sessions WHERE id = ? AND gym_id = ?',
      [class_session_id, gymId],
    );

    const { insertId } = await db.query(
      `INSERT INTO shared_training_requests
         (gym_id, class_session_id, requesting_member_id, activity_type_id, status, notes, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, UTC_TIMESTAMP())`,
      [gymId, class_session_id, requesting_member_id, sessionRows[0].activity_type_id, notes ?? null],
    );
    const { rows } = await db.query(`${SELECT} WHERE str.id = ?`, [insertId]);
    recordAudit(req, { action: 'create', entityType: 'shared_training_request', entityId: insertId });
    res.status(201).json(rows[0]);
  } catch (e: any) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A request already exists for this member and session', code: 'duplicate_request' });
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

/** Approve: book the requesting member and enforce concurrent-group capacity. */
sharedTrainingRequestsRouter.post('/:id/approve',
  requireRole('admin', 'trainer_performance', 'trainer_perf_nutrition'),
  async (req, res, next) => {
    const { gymId, gymMembershipId } = getTenantContext(req);

    try {
      let notifyMemberId: number | null = null;
      let notifySessionId: number | null = null;

      await db.transaction(async (tx) => {
        const { rows: reqRows } = await tx.query(
          `SELECT str.id, str.status, str.requesting_member_id, str.class_session_id,
                  str.activity_type_id, str.gym_id
           FROM shared_training_requests str
           WHERE str.id = ? AND str.gym_id = ?
           FOR UPDATE`,
          [req.params.id, gymId],
        );
        if (reqRows.length === 0) throw Object.assign(new Error('Request not found'), { status: 404 });
        const strReq = reqRows[0];
        if (strReq.status !== 'pending') {
          throw Object.assign(new Error(`Request is already ${strReq.status}`), { status: 409 });
        }

        const { rows: sessionRows } = await tx.query(
          `SELECT cs.id, cs.status, cs.allows_shared_booking, cs.center_id,
                  cs.trainer_membership_id, cs.space_id, cs.starts_at, cs.ends_at,
                  COALESCE(cs.max_capacity_override, at.max_capacity) AS effective_capacity,
                  at.is_shareable,
                  COALESCE(gm.max_concurrent_groups, 1) AS trainer_max,
                  COALESCE(sp.max_concurrent_groups, 1) AS space_max,
                  (SELECT COUNT(*) FROM bookings b WHERE b.class_session_id = cs.id AND b.status = 'booked') AS booked_count
           FROM class_sessions cs
           JOIN activity_types at ON at.id = cs.activity_type_id
           LEFT JOIN gym_memberships gm ON gm.id = cs.trainer_membership_id
           LEFT JOIN spaces sp ON sp.id = cs.space_id
           WHERE cs.id = ? AND cs.gym_id = ? AND cs.deleted_at IS NULL
           FOR UPDATE`,
          [strReq.class_session_id, gymId],
        );
        if (sessionRows.length === 0) throw Object.assign(new Error('Session not found'), { status: 404 });
        const session = sessionRows[0];

        if (session.status !== 'scheduled') {
          throw Object.assign(new Error('Session is no longer scheduled'), { status: 409 });
        }
        if (!Number(session.is_shareable)) {
          throw Object.assign(new Error('Activity type is not shareable'), { status: 409 });
        }
        if (!Number(session.allows_shared_booking)) {
          throw Object.assign(new Error('Shared booking is no longer enabled for this session'), { status: 409 });
        }

        // Check concurrent-group capacity (trainer and space limits from #323).
        const effectiveMax = Math.min(Number(session.trainer_max), Number(session.space_max));
        const extraBooked = Math.max(0, Number(session.booked_count) - Number(session.effective_capacity));
        if (extraBooked >= effectiveMax) {
          throw Object.assign(
            new Error('Slot capacity has been reached since the request was created'),
            { status: 409, code: 'slot_fully_occupied' },
          );
        }

        await tx.query(
          `UPDATE shared_training_requests
           SET status = 'approved', reviewed_by_membership_id = ?, reviewed_at = UTC_TIMESTAMP()
           WHERE id = ?`,
          [gymMembershipId, req.params.id],
        );

        // Book the member directly — trainer approval intentionally overrides normal capacity.
        await tx.query(
          `INSERT INTO bookings (gym_id, center_id, member_id, class_session_id, status, booked_at)
           VALUES (?, ?, ?, ?, 'booked', UTC_TIMESTAMP())`,
          [gymId, session.center_id, strReq.requesting_member_id, strReq.class_session_id],
        );

        notifyMemberId = strReq.requesting_member_id;
        notifySessionId = strReq.class_session_id;
      });

      if (notifyMemberId !== null && notifySessionId !== null) {
        sendNotification(gymId, notifyMemberId, 'shared_training_approved', 'session', notifySessionId, { title: '' });
      }

      recordAudit(req, { action: 'approve', entityType: 'shared_training_request', entityId: Number(req.params.id) });
      const { rows } = await db.query(`${SELECT} WHERE str.id = ? AND str.gym_id = ?`, [req.params.id, gymId]);
      res.json(rows[0]);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
      next(err);
    }
  },
);

sharedTrainingRequestsRouter.post('/:id/reject', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);

  try {
    const { rows: reqRows } = await db.query(
      `SELECT id, status, requesting_member_id, class_session_id FROM shared_training_requests
       WHERE id = ? AND gym_id = ?`,
      [req.params.id, gymId],
    );
    if (reqRows.length === 0) return res.status(404).json({ error: 'Request not found' });
    if (reqRows[0].status !== 'pending') {
      return res.status(409).json({ error: `Request is already ${reqRows[0].status}` });
    }

    await db.query(
      `UPDATE shared_training_requests
       SET status = 'rejected', reviewed_by_membership_id = ?, reviewed_at = UTC_TIMESTAMP()
       WHERE id = ? AND gym_id = ?`,
      [gymMembershipId, req.params.id, gymId],
    );

    sendNotification(gymId, reqRows[0].requesting_member_id, 'shared_training_rejected', 'session',
      reqRows[0].class_session_id, { title: '' });

    recordAudit(req, { action: 'reject', entityType: 'shared_training_request', entityId: Number(req.params.id) });
    const { rows } = await db.query(`${SELECT} WHERE str.id = ? AND str.gym_id = ?`, [req.params.id, gymId]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/** Shared validation used by the member self-service endpoint in me.ts. */
export async function validateRequest(
  gymId: string,
  classSessionId: number,
  requestingMemberId: number,
): Promise<{ status: number; message: string; code?: string } | null> {
  const { rows: sessionRows } = await db.query(
    `SELECT cs.id, cs.status, cs.allows_shared_booking, at.is_shareable
     FROM class_sessions cs
     JOIN activity_types at ON at.id = cs.activity_type_id
     WHERE cs.id = ? AND cs.gym_id = ? AND cs.deleted_at IS NULL`,
    [classSessionId, gymId],
  );
  if (sessionRows.length === 0) return { status: 404, message: 'Session not found' };
  const session = sessionRows[0];
  if (session.status !== 'scheduled') return { status: 409, message: 'Session is not scheduled', code: 'not_scheduled' };
  if (!Number(session.is_shareable)) return { status: 409, message: 'Activity type is not shareable', code: 'not_shareable' };
  if (!Number(session.allows_shared_booking)) return { status: 409, message: 'Shared booking is not enabled for this session', code: 'sharing_not_allowed' };

  const { rows: dupRows } = await db.query(
    `SELECT id FROM shared_training_requests
     WHERE gym_id = ? AND class_session_id = ? AND requesting_member_id = ? AND status IN ('pending','approved')`,
    [gymId, classSessionId, requestingMemberId],
  );
  if (dupRows.length > 0) return { status: 409, message: 'A request already exists for this session', code: 'duplicate_request' };

  return null;
}
