/**
 * #324: Shared-training request management for trainers and admins.
 *
 * GET  /shared-training-requests         list pending requests (trainer-scoped or all)
 * POST /shared-training-requests/:id/approve   approve → creates booking, marks approved
 * POST /shared-training-requests/:id/reject    reject → marks rejected, notifies member
 */
import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { sendNotification } from '../infra/notifications';

export const sharedTrainingRequestsRouter = Router();

// Maximum extra groups allowed when sharing is enabled (V1 fixed rule).
const MAX_SHARED_GROUPS = 1;

const SELECT = `
  SELECT str.id, str.gym_id, str.class_session_id, str.requesting_member_id,
         str.activity_type_id, str.status, str.reviewed_by_membership_id,
         str.reviewed_at, str.created_at,
         m.name AS requesting_member_name,
         at.name AS activity_type_name,
         cs.starts_at, cs.ends_at,
         sp.name AS space_name,
         tm.name AS trainer_name
  FROM shared_training_requests str
  JOIN members m ON m.id = str.requesting_member_id
  JOIN activity_types at ON at.id = str.activity_type_id
  JOIN class_sessions cs ON cs.id = str.class_session_id
  LEFT JOIN spaces sp ON sp.id = cs.space_id
  LEFT JOIN gym_memberships tm ON tm.id = cs.trainer_membership_id
`;

sharedTrainingRequestsRouter.get('/', async (req, res, next) => {
  const { gymId, role, gymMembershipId } = getTenantContext(req);
  const { status } = req.query as Record<string, string | undefined>;

  const { class_session_id } = req.query as Record<string, string | undefined>;

  try {
    const where: string[] = ['str.gym_id = ?'];
    const params: any[] = [gymId];

    // Trainers only see requests for sessions where they are the trainer.
    if (role === 'trainer_performance' || role === 'trainer_perf_nutrition') {
      where.push('cs.trainer_membership_id = ?');
      params.push(gymMembershipId);
    }

    if (status) {
      where.push('str.status = ?');
      params.push(status);
    }
    if (class_session_id) {
      where.push('str.class_session_id = ?');
      params.push(class_session_id);
    }

    const { rows } = await db.query(
      `${SELECT} WHERE ${where.join(' AND ')} ORDER BY str.created_at DESC`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

sharedTrainingRequestsRouter.post('/:id/approve', requireModuleWrite('TRAINING'), async (req, res, next) => {
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
                COALESCE(cs.max_capacity_override, at.max_capacity) AS effective_capacity,
                at.is_shareable,
                (SELECT COUNT(*) FROM bookings b WHERE b.class_session_id = cs.id AND b.status = 'booked') AS booked_count
         FROM class_sessions cs
         JOIN activity_types at ON at.id = cs.activity_type_id
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

      const extraBooked = Math.max(0, Number(session.booked_count) - Number(session.effective_capacity));
      if (extraBooked >= MAX_SHARED_GROUPS) {
        throw Object.assign(new Error('Maximum shared groups already reached for this session'), { status: 409 });
      }

      await tx.query(
        `UPDATE shared_training_requests
         SET status = 'approved', reviewed_by_membership_id = ?, reviewed_at = UTC_TIMESTAMP()
         WHERE id = ?`,
        [gymMembershipId, req.params.id],
      );

      // Insert the booking directly — explicit trainer approval intentionally
      // exceeds normal capacity (second group), so access hooks don't apply.
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

    const { rows } = await db.query(
      `${SELECT} WHERE str.id = ? AND str.gym_id = ?`,
      [req.params.id, gymId],
    );
    res.json(rows[0]);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

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

    const { rows } = await db.query(
      `${SELECT} WHERE str.id = ? AND str.gym_id = ?`,
      [req.params.id, gymId],
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});
