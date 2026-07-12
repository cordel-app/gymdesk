import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

/**
 * P6.3: read-only admin-scoped view over audit_logs. Server-side pagination
 * with combinable filters on entity_type, actor_user_id, and date range.
 */
export const auditLogsRouter = Router();

auditLogsRouter.get('/', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { entity_type, actor_user_id, from, to } = req.query as Record<string, string | undefined>;

  const where: string[] = ['gym_id = ?'];
  const params: any[] = [gymId];
  if (entity_type)   { where.push('entity_type = ?'); params.push(entity_type); }
  if (actor_user_id) { where.push('actor_user_id = ?'); params.push(actor_user_id); }
  if (from) { where.push('created_at >= ?'); params.push(from.length === 10 ? `${from} 00:00:00` : from); }
  if (to)   { where.push('created_at <= ?'); params.push(to.length === 10 ? `${to} 23:59:59` : to); }

  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? 50), 10) || 50, 1), 200);
  const offset = Math.max(parseInt(String(req.query.offset ?? 0), 10) || 0, 0);
  const whereSql = where.join(' AND ');

  const { rows: countRows } = await db.query(`SELECT COUNT(*) AS total FROM audit_logs WHERE ${whereSql}`, params);
  const { rows } = await db.query(
    `SELECT * FROM audit_logs WHERE ${whereSql}
     ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  res.json({ items: rows, total: Number(countRows[0].total), limit, offset });
});
