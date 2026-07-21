import { Request } from 'express';
import { db } from './db';
import { resolveEntityName, enrichPayload } from './audit-registry';

/**
 * P6.1: fire-and-forget audit writer. Never fails the calling request —
 * a rejected INSERT logs to console.error and the business write goes on.
 *
 * Actor name is pulled from req.tenantCtx.actorName (resolved once per
 * request in tenantContext middleware from the Clerk user object).
 * Entity name is resolved from the registry unless the caller passes one.
 * FK references inside previous/next payloads are enriched to { id, name }.
 */
export interface AuditPayload {
  action: string;
  entityType: string;
  entityId?: unknown;
  /** Pre-resolved entity display name. If omitted, resolved from the registry. */
  entityName?: string | null;
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
  if (!ctx) return;

  const actor = ctx.userId ?? null;
  const actorName = ctx.impersonatedUserId
    ? `${ctx.actorName ?? ctx.userId} (impersonating ${ctx.impersonatedActorName ?? ctx.impersonatedUserId})`
    : (ctx.actorName ?? null);
  const source = sourceForRole(ctx.role);
  const ip = firstIp(req);
  const ua = (req.headers['user-agent'] as string | undefined)?.slice(0, 500) ?? null;
  const entityIdStr = payload.entityId != null ? String(payload.entityId) : null;

  (async () => {
    const [entityName, prevEnriched, nextEnriched] = await Promise.all([
      payload.entityName !== undefined
        ? Promise.resolve(payload.entityName)
        : resolveEntityName(payload.entityType, entityIdStr, ctx.gymId),
      payload.previous != null && typeof payload.previous === 'object'
        ? enrichPayload(payload.previous as Record<string, unknown>)
        : Promise.resolve(payload.previous),
      payload.next != null && typeof payload.next === 'object'
        ? enrichPayload(payload.next as Record<string, unknown>)
        : Promise.resolve(payload.next),
    ]);

    const prev = prevEnriched != null ? JSON.stringify(prevEnriched) : null;
    const next = nextEnriched != null ? JSON.stringify(nextEnriched) : null;

    await db.query(
      `INSERT INTO audit_logs
       (gym_id, actor_user_id, actor_name, action, entity_type, entity_id, entity_name,
        previous_values, new_values, source, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ctx.gymId, actor, actorName, payload.action,
        payload.entityType, entityIdStr, entityName ?? null,
        prev, next, source, ip, ua,
      ],
    );
  })().catch((err) => {
    console.error('audit_logs insert failed', err.message ?? err);
  });
}
