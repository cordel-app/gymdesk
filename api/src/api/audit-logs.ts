import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { AUDIT_ENTITY_REGISTRY, AUDIT_ACTIONS } from '../infra/audit-registry';

/**
 * P6.3 / #69: read-only admin-scoped view over audit_logs.
 * Server-side pagination with filters on entity_type, entity_name, actor,
 * action, source, and date range.
 *
 * #66: scope=all (platform superadmins only) lifts the tenant gym filter and
 * returns rows across every gym, each joined with its gym name. An optional
 * gym_id param lets the platform view narrow back down to a single gym.
 */
export const auditLogsRouter = Router();

auditLogsRouter.get('/meta', requireRole('admin'), (_req, res) => {
  const entityTypes = Object.entries(AUDIT_ENTITY_REGISTRY).map(([key, meta]) => ({
    value: key,
    label: meta.label,
  }));
  res.json({ entityTypes, actions: AUDIT_ACTIONS });
});

auditLogsRouter.get('/', requireRole('admin'), async (req, res) => {
  const ctx = getTenantContext(req);
  const {
    scope, gym_id: gymIdFilter,
    entity_type, entity_name,
    actor, actor_user_id,
    action, source,
    from, to,
  } = req.query as Record<string, string | undefined>;

  const platformScope = scope === 'all';
  if (platformScope && !ctx.isSuperadmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const where: string[] = [];
  const params: any[] = [];

  if (platformScope) {
    if (gymIdFilter) { where.push('a.gym_id = ?'); params.push(gymIdFilter); }
  } else {
    where.push('a.gym_id = ?'); params.push(ctx.gymId);
  }

  if (entity_type)  { where.push('a.entity_type = ?');                            params.push(entity_type); }
  if (entity_name)  { where.push('a.entity_name LIKE ?');                         params.push(`%${entity_name}%`); }
  // actor searches stored name (historical) or falls back to matching the Clerk ID exactly
  if (actor)        { where.push('(a.actor_name LIKE ? OR a.actor_user_id = ?)'); params.push(`%${actor}%`, actor); }
  if (actor_user_id){ where.push('a.actor_user_id = ?');                          params.push(actor_user_id); }
  if (action)       { where.push('a.action = ?');                                 params.push(action); }
  if (source)       { where.push('a.source = ?');                                 params.push(source); }
  if (from) { where.push('a.created_at >= ?'); params.push(from.length === 10 ? `${from} 00:00:00` : from); }
  if (to)   { where.push('a.created_at <= ?'); params.push(to.length === 10   ? `${to} 23:59:59`  : to); }

  const limit  = Math.min(Math.max(parseInt(String(req.query.limit  ?? 50), 10) || 50, 1), 200);
  const offset = Math.max(parseInt(String(req.query.offset ?? 0), 10) || 0, 0);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows: countRows } = await db.query(
    `SELECT COUNT(*) AS total FROM audit_logs a ${whereSql}`, params,
  );
  const { rows } = await db.query(
    `SELECT a.*, g.name AS gym_name FROM audit_logs a
     LEFT JOIN gyms g ON g.id = a.gym_id
     ${whereSql}
     ORDER BY a.created_at DESC, a.id DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  res.json({ items: rows, total: Number(countRows[0].total), limit, offset });
});
