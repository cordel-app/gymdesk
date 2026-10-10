import type { Request, Response } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { resolveRequestActor } from '../domain/auditActor';
import { DraftRefusal, LockedDraft } from './product-set-draft';
import { reconfigureProjected, retireProjected, type ReconfigureOutcome } from './product-set-bridge';

/**
 * #1325 PR 5 — one place that turns an **assignment-keyed edit** into a new
 * ProductSet version, for the routes the Admin's Assigned Plan card calls.
 *
 * `handled` is the only thing a route needs: `false` means the edit is not for
 * this module (the assignment is not a projection of an Active set — a Draft or
 * a pending one) and the route carries on with its own write exactly as it
 * did; `true` means the response has been sent. The legacy handler therefore
 * keeps its whole body and gains one early line.
 */

function actorOf(req: Request) {
  const ctx = getTenantContext(req);
  return {
    name: resolveRequestActor({
      actorName: ctx.actorName ?? null,
      impersonatedUserId: ctx.impersonatedUserId,
      impersonatedActorName: ctx.impersonatedActorName,
    }),
    type: ctx.impersonatedUserId ? 'superadmin' : 'staff',
  };
}

function sendRefusal(res: Response, r: ReconfigureOutcome): boolean {
  switch (r.kind) {
    case 'edit_locked':
      res.status(409).json({
        error: 'edit_locked',
        message: 'This plan cannot be modified until its unresolved Billing Events are resolved.',
        blocking: r.blocking,
      });
      return true;
    case 'in_flight':
      res.status(409).json({ error: 'in_flight', product_set_id: r.productSetId });
      return true;
    case 'not_a_draft':
      res.status(409).json({ error: 'not_a_draft', status: r.status });
      return true;
    case 'expired':
      res.status(410).json({ error: 'draft_expired' });
      return true;
    case 'not_found':
      res.status(404).json({ error: 'not_found' });
      return true;
    case 'invalid':
      res.status(400).json({ error: r.message });
      return true;
    case 'conflict':
      res.status(409).json({ error: r.error, message: r.message });
      return true;
    default:
      return false;
  }
}

export async function redirectEditToProductSet(req: Request, res: Response, input: {
  userMembershipId: number;
  action: string;
  detail?: Record<string, unknown>;
  mutate: (tx: Tx, draft: LockedDraft) => Promise<{ ok: true } | DraftRefusal>;
  /** What the legacy route answers with, read after the new version is live. */
  respond: () => Promise<unknown>;
  /** The legacy route's own success status (an apply answers 201). */
  status?: number;
}): Promise<boolean> {
  const { gymId } = getTenantContext(req);
  if (!Number.isInteger(input.userMembershipId) || input.userMembershipId <= 0) return false;

  let outcome: ReconfigureOutcome;
  try {
    outcome = await db.transaction(async (tx) => {
      const r = await reconfigureProjected(tx, {
        gymId, userMembershipId: input.userMembershipId, actor: actorOf(req), mutate: input.mutate,
      });
      // A refused edit must leave nothing behind (the draft included).
      if (r.kind !== 'ok' && r.kind !== 'not_projected') {
        throw Object.assign(new Error('refused'), { outcome: r });
      }
      return r;
    });
  } catch (err: any) {
    if (!err?.outcome) throw err;
    outcome = err.outcome as ReconfigureOutcome;
  }
  if (outcome.kind === 'not_projected') return false;
  if (sendRefusal(res, outcome)) return true;

  recordAudit(req, {
    action: input.action, entityType: 'product_set', entityId: (outcome as { productSetId: number }).productSetId,
    next: input.detail,
  });
  res.status(input.status ?? 200).json(await input.respond());
  return true;
}

/** Cancel / close of a projected plan: a new, empty version. */
export async function redirectRetireToProductSet(req: Request, res: Response, input: {
  userMembershipId: number;
  /** `null` answers `204 No Content`, as the cancel route does. */
  respond: (() => Promise<unknown>) | null;
}): Promise<boolean> {
  const { gymId } = getTenantContext(req);
  if (!Number.isInteger(input.userMembershipId) || input.userMembershipId <= 0) return false;

  let outcome: ReconfigureOutcome;
  try {
    outcome = await db.transaction(async (tx) => {
      const r = await retireProjected(tx, { gymId, userMembershipId: input.userMembershipId, actor: actorOf(req) });
      if (r.kind !== 'ok' && r.kind !== 'not_projected') throw Object.assign(new Error('refused'), { outcome: r });
      return r;
    });
  } catch (err: any) {
    if (!err?.outcome) throw err;
    outcome = err.outcome as ReconfigureOutcome;
  }
  if (outcome.kind === 'not_projected') return false;
  if (sendRefusal(res, outcome)) return true;
  recordAudit(req, {
    action: 'retire', entityType: 'product_set', entityId: (outcome as { productSetId: number }).productSetId,
    next: { status: 'active', plan: null },
  });
  if (input.respond === null) res.status(204).send();
  else res.json(await input.respond());
  return true;
}
