import { Request } from 'express';
import { db } from './db';

/**
 * P6.1: fire-and-forget audit writer. Never fails the calling request —
 * a rejected INSERT logs to console.error and the business write goes on.
 *
 * Actor / gym / IP / UA are pulled from the request automatically. Callers
 * pass action, entity_type, entity_id, and optional previous/new value
 * snapshots (any JSON-serialisable shape).
 */
export interface AuditPayload {
  action: string;
  entityType: string;
  entityId?: unknown; // stringified below — accepts numbers, req.params.id (string | string[]), etc.
  previous?: unknown;
  next?: unknown;
}

function firstIp(req: Request): string | null {
  const fwd = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  return fwd || req.ip || null;
}

function sourceForRole(role: string | undefined): string {
  if (role === 'admin') return 'admin';
  if (role === 'member') return 'customer';
  return 'employee';
}

export function recordAudit(req: Request, payload: AuditPayload): void {
  const ctx = req.tenantCtx;
  if (!ctx) return; // no tenant context — nothing to attribute the row to
  const actor = ctx.userId ?? null;
  const source = sourceForRole(ctx.role);
  const ip = firstIp(req);
  const ua = (req.headers['user-agent'] as string | undefined)?.slice(0, 500) ?? null;

  const prev = payload.previous != null ? JSON.stringify(payload.previous) : null;
  const next = payload.next != null ? JSON.stringify(payload.next) : null;

  db.query(
    `INSERT INTO audit_logs
     (gym_id, actor_user_id, action, entity_type, entity_id, previous_values, new_values, source, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ctx.gymId, actor, payload.action, payload.entityType,
      payload.entityId != null ? String(payload.entityId) : null,
      prev, next, source, ip, ua,
    ],
  ).catch((err) => {
    // Never fail the caller — log and move on.
    console.error('audit_logs insert failed', err.message ?? err);
  });
}
