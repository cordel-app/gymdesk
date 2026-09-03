import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { bookMemberOnSession } from './bookings';

const STATUSES = ['pending', 'approved', 'rejected'] as const;

const SELECT = `
  SELECT str.*,
         at_host.name  AS host_activity_name,
         at_host.shareable AS host_activity_shareable,
         at_req.name   AS requested_activity_name,
         at_req.shareable AS requested_activity_shareable,
         sp.name       AS space_name,
         gm_t.name     AS trainer_name,
         m.name        AS requesting_member_name,
         m.email       AS requesting_member_email,
         cs.starts_at  AS session_starts_at,
         cs.ends_at    AS session_ends_at,
         gm_res.name   AS resolved_by_name
  FROM shared_training_requests str
  JOIN class_sessions cs         ON cs.id  = str.host_session_id
  JOIN activity_types at_host    ON at_host.id = cs.activity_type_id
  JOIN activity_types at_req     ON at_req.id  = str.requested_activity_type_id
  LEFT JOIN spaces sp            ON sp.id  = cs.space_id
  LEFT JOIN gym_memberships gm_t ON gm_t.id = cs.trainer_membership_id
  JOIN members m                 ON m.id   = str.requesting_member_id
  LEFT JOIN gym_memberships gm_res ON gm_res.id = str.resolved_by_membership_id
`;

export const sharedTrainingRequestsRouter = Router();

sharedTrainingRequestsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { status, host_session_id } = req.query as Record<string, string | undefined>;
  if (status && !STATUSES.includes(status as any)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  const where: string[] = ['str.gym_id = ?'];
  const params: any[] = [gymId];
  if (status)          { where.push('str.status = ?');          params.push(status); }
  if (host_session_id) { where.push('str.host_session_id = ?'); params.push(host_session_id); }
  const { rows } = await db.query(
    `${SELECT} WHERE ${where.join(' AND ')} ORDER BY str.created_at DESC`,
    params,
  );
  res.json(rows);
});

sharedTrainingRequestsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(`${SELECT} WHERE str.id = ? AND str.gym_id = ?`, [req.params.id, gymId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Request not found' });
  res.json(rows[0]);
});

/** Staff creates a shared training request on behalf of a member. */
sharedTrainingRequestsRouter.post('/', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { host_session_id, requested_activity_type_id, requesting_member_id, notes } = req.body;
  if (!host_session_id || !requested_activity_type_id || !requesting_member_id) {
    return res.status(400).json({ error: 'host_session_id, requested_activity_type_id, and requesting_member_id are required' });
  }

  try {
    await validateAndInsertRequest(gymId, { host_session_id, requested_activity_type_id, requesting_member_id, notes, gymMembershipId });
    const { rows } = await db.query(
      `${SELECT} WHERE str.gym_id = ? ORDER BY str.id DESC LIMIT 1`,
      [gymId],
    );
    recordAudit(req, { action: 'create', entityType: 'shared_training_request', entityId: rows[0].id });
    res.status(201).json(rows[0]);
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

/** Approve: create a concurrent session + book the requesting member atomically. */
sharedTrainingRequestsRouter.post('/:id/approve',
  requireRole('admin', 'trainer_performance', 'trainer_perf_nutrition'),
  async (req, res, next) => {
    const { gymId, gymMembershipId } = getTenantContext(req);

    try {
      const { rows: reqRows } = await db.query(
        `SELECT str.*, cs.activity_type_id AS host_activity_type_id,
                cs.trainer_membership_id, cs.space_id, cs.starts_at, cs.ends_at,
                cs.center_id, at_host.shareable AS host_shareable,
                at_req.shareable AS req_shareable,
                COALESCE(gm.max_concurrent_groups, 1) AS trainer_max,
                COALESCE(sp.max_concurrent_groups, 1) AS space_max
         FROM shared_training_requests str
         JOIN class_sessions cs        ON cs.id = str.host_session_id
         JOIN activity_types at_host   ON at_host.id = cs.activity_type_id
         JOIN activity_types at_req    ON at_req.id  = str.requested_activity_type_id
         LEFT JOIN gym_memberships gm  ON gm.id = cs.trainer_membership_id
         LEFT JOIN spaces sp           ON sp.id  = cs.space_id
         WHERE str.id = ? AND str.gym_id = ?`,
        [req.params.id, gymId],
      );
      if (reqRows.length === 0) return res.status(404).json({ error: 'Request not found' });
      const request = reqRows[0];

      if (request.status !== 'pending') {
        return res.status(409).json({ error: `Request is already ${request.status}` });
      }
      if (!request.host_shareable) {
        return res.status(409).json({ error: 'Host activity is not eligible for shared training', code: 'host_not_shareable' });
      }
      if (!request.req_shareable) {
        return res.status(409).json({ error: 'Requested activity is not eligible for shared training', code: 'activity_not_shareable' });
      }

      const result = await db.transaction(async (tx) => {
        // Lock concurrent sessions at the slot to prevent race conditions.
        const { rows: concurrent } = await tx.query(
          `SELECT cs.id FROM class_sessions cs
           WHERE cs.gym_id = ? AND cs.trainer_membership_id = ? AND cs.space_id = ?
             AND cs.starts_at = ? AND cs.ends_at = ?
             AND cs.status <> 'cancelled' AND cs.deleted_at IS NULL
           FOR UPDATE`,
          [gymId, request.trainer_membership_id, request.space_id, request.starts_at, request.ends_at],
        );

        const effectiveMax = Math.min(Number(request.trainer_max), Number(request.space_max));
        if (concurrent.length >= effectiveMax) {
          throw Object.assign(new Error('Slot capacity has been reached since the request was created'), {
            status: 409, code: 'slot_fully_occupied',
          });
        }

        // Create the new concurrent session.
        const { insertId: newSessionId } = await tx.query(
          `INSERT INTO class_sessions
           (gym_id, center_id, activity_type_id, trainer_membership_id, space_id,
            starts_at, ends_at, created_by, modified_by_membership_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [gymId, request.center_id, request.requested_activity_type_id,
           request.trainer_membership_id, request.space_id,
           request.starts_at, request.ends_at,
           request.requesting_member_id, gymMembershipId],
        );

        // Authorize sharing on the host session (idempotent).
        await tx.query(
          'UPDATE class_sessions SET sharing_authorized = 1 WHERE id = ? AND gym_id = ?',
          [request.host_session_id, gymId],
        );

        // Book the requesting member into the new session atomically.
        await bookMemberOnSession(gymId, request.requesting_member_id, newSessionId, false, false, tx);

        // Stamp the request as approved.
        await tx.query(
          `UPDATE shared_training_requests
           SET status = 'approved', resolved_class_session_id = ?, resolved_by_membership_id = ?, resolved_at = UTC_TIMESTAMP()
           WHERE id = ? AND gym_id = ?`,
          [newSessionId, gymMembershipId, req.params.id, gymId],
        );

        return newSessionId;
      });

      recordAudit(req, {
        action: 'approve',
        entityType: 'shared_training_request',
        entityId: req.params.id,
        next: { resolved_class_session_id: result },
      });

      const { rows } = await db.query(`${SELECT} WHERE str.id = ? AND str.gym_id = ?`, [req.params.id, gymId]);
      res.json(rows[0]);
    } catch (e: any) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      next(e);
    }
  },
);

/** Reject: mark request as rejected; no session created, no capacity consumed. */
sharedTrainingRequestsRouter.post('/:id/reject',
  requireRole('admin', 'trainer_performance', 'trainer_perf_nutrition'),
  async (req, res, next) => {
    const { gymId, gymMembershipId } = getTenantContext(req);
    try {
      const { rows: reqRows } = await db.query(
        "SELECT id, status FROM shared_training_requests WHERE id = ? AND gym_id = ?",
        [req.params.id, gymId],
      );
      if (reqRows.length === 0) return res.status(404).json({ error: 'Request not found' });
      if (reqRows[0].status !== 'pending') {
        return res.status(409).json({ error: `Request is already ${reqRows[0].status}` });
      }

      await db.query(
        `UPDATE shared_training_requests
         SET status = 'rejected', resolved_by_membership_id = ?, resolved_at = UTC_TIMESTAMP()
         WHERE id = ? AND gym_id = ?`,
        [gymMembershipId, req.params.id, gymId],
      );

      recordAudit(req, { action: 'reject', entityType: 'shared_training_request', entityId: req.params.id });
      const { rows } = await db.query(`${SELECT} WHERE str.id = ? AND str.gym_id = ?`, [req.params.id, gymId]);
      res.json(rows[0]);
    } catch (e) { next(e); }
  },
);

/** Shared validation + insert logic reused by staff and member endpoints. */
async function validateAndInsertRequest(gymId: string, {
  host_session_id, requested_activity_type_id, requesting_member_id, notes, gymMembershipId,
}: {
  host_session_id: number;
  requested_activity_type_id: number;
  requesting_member_id: number;
  notes?: string;
  gymMembershipId?: number | null;
}) {
  const { rows: sessionRows } = await db.query(
    `SELECT cs.id, cs.trainer_membership_id, cs.space_id, cs.starts_at, cs.ends_at,
            at.shareable AS host_shareable,
            COALESCE(gm.max_concurrent_groups, 1) AS trainer_max,
            COALESCE(sp.max_concurrent_groups, 1) AS space_max
     FROM class_sessions cs
     JOIN activity_types at ON at.id = cs.activity_type_id
     LEFT JOIN gym_memberships gm ON gm.id = cs.trainer_membership_id
     LEFT JOIN spaces sp ON sp.id = cs.space_id
     WHERE cs.id = ? AND cs.gym_id = ? AND cs.deleted_at IS NULL`,
    [host_session_id, gymId],
  );
  if (sessionRows.length === 0) throw Object.assign(new Error('Host session not found'), { status: 404 });
  const session = sessionRows[0];

  if (!session.host_shareable) throw Object.assign(new Error('Host activity is not eligible for shared training'), { status: 409, code: 'host_not_shareable' });

  const { rows: atRows } = await db.query(
    'SELECT shareable FROM activity_types WHERE id = ? AND gym_id = ?',
    [requested_activity_type_id, gymId],
  );
  if (atRows.length === 0) throw Object.assign(new Error('Requested activity type not found'), { status: 404 });
  if (!atRows[0].shareable) throw Object.assign(new Error('Requested activity is not eligible for shared training'), { status: 409, code: 'activity_not_shareable' });

  const { rows: memberRows } = await db.query(
    'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [requesting_member_id, gymId],
  );
  if (memberRows.length === 0) throw Object.assign(new Error('Member not found'), { status: 404 });

  if (session.trainer_membership_id && session.space_id) {
    const { rows: concurrent } = await db.query(
      `SELECT COUNT(*) AS cnt FROM class_sessions cs
       WHERE cs.gym_id = ? AND cs.trainer_membership_id = ? AND cs.space_id = ?
         AND cs.starts_at = ? AND cs.ends_at = ?
         AND cs.status <> 'cancelled' AND cs.deleted_at IS NULL`,
      [gymId, session.trainer_membership_id, session.space_id, session.starts_at, session.ends_at],
    );
    const effectiveMax = Math.min(Number(session.trainer_max), Number(session.space_max));
    if (Number(concurrent[0].cnt) >= effectiveMax) {
      throw Object.assign(new Error('Slot is fully occupied'), { status: 409, code: 'slot_fully_occupied' });
    }
  }

  const { rows: dupRows } = await db.query(
    `SELECT id FROM shared_training_requests
     WHERE gym_id = ? AND host_session_id = ? AND requested_activity_type_id = ?
       AND requesting_member_id = ? AND status = 'pending'`,
    [gymId, host_session_id, requested_activity_type_id, requesting_member_id],
  );
  if (dupRows.length > 0) throw Object.assign(new Error('A pending request already exists for this slot and member'), { status: 409, code: 'duplicate_request' });

  await db.query(
    `INSERT INTO shared_training_requests
     (gym_id, host_session_id, requested_activity_type_id, requesting_member_id, notes)
     VALUES (?, ?, ?, ?, ?)`,
    [gymId, host_session_id, requested_activity_type_id, requesting_member_id, notes ?? null],
  );
}

export { validateAndInsertRequest };
