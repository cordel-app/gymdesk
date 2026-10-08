import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { resolveMemberProfessionalServices } from '../domain/memberProfessionalServices';
import { resolveRequestActor } from '../domain/auditActor';
import {
  BalanceHistoryEntry,
  parseAdjustmentInput,
  sortHistory,
} from '../domain/professionalServiceAdjustments';

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
  const memberId = parseInt((req.params as unknown as { memberId: string }).memberId, 10);
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

/**
 * #1227 stage 1: the Member's Professional Services section. One row per
 * service the gym has switched on, with the balance the booking gate itself
 * reads (`resolveMemberProfessionalServices`) — never a second balance.
 */
memberProfessionalServicesRouter.get('/wallet', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const memberId = parseInt((req.params as unknown as { memberId: string }).memberId, 10);
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return res.status(400).json({ error: 'memberId must be a positive integer' });
  }
  try {
    const { rows: memberRows } = await db.query(
      'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [memberId, gymId],
    );
    if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

    const { rows: services } = await db.query(
      `SELECT ps.id AS professional_service_id, ps.name
         FROM professional_services ps
         JOIN gym_professional_services gps
           ON gps.professional_service_id = ps.id AND gps.gym_id = ? AND gps.status = 'active'
        WHERE ps.deleted_at IS NULL
        ORDER BY ps.name ASC`,
      [gymId],
    );
    const balances = new Map(
      (await resolveMemberProfessionalServices(gymId, memberId)).map((b) => [b.professional_service_id, b]),
    );
    res.json(services.map((s: { professional_service_id: number; name: string }) => ({
      professional_service_id: s.professional_service_id,
      name: s.name,
      available_items: balances.get(s.professional_service_id)?.sessions ?? 0,
      sources: balances.get(s.professional_service_id)?.sources ?? [],
    })));
  } catch (err) { next(err); }
});

/** The balance's history for one service: staff adjustments and spent / returned sessions, newest first. */
memberProfessionalServicesRouter.get('/:serviceId/history', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const memberId = parseInt((req.params as unknown as { memberId: string }).memberId, 10);
  const serviceId = parseInt(String(req.params.serviceId), 10);
  if (!Number.isInteger(memberId) || memberId <= 0 || !Number.isInteger(serviceId) || serviceId <= 0) {
    return res.status(400).json({ error: 'memberId and serviceId must be positive integers' });
  }
  try {
    const { rows: memberRows } = await db.query(
      'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [memberId, gymId],
    );
    if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

    const { rows: adjustments } = await db.query(
      `SELECT delta, balance_before, balance_after, reason, created_at, created_by
         FROM professional_service_adjustments
        WHERE gym_id = ? AND member_id = ? AND professional_service_id = ?`,
      [gymId, memberId, serviceId],
    );
    const { rows: consumptions } = await db.query(
      `SELECT reason, created_at, created_by, returned_at, returned_by
         FROM professional_service_consumptions
        WHERE gym_id = ? AND member_id = ? AND professional_service_id = ?`,
      [gymId, memberId, serviceId],
    );
    const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
    const entries: BalanceHistoryEntry[] = [
      ...adjustments.map((a: any) => ({
        kind: 'adjustment' as const, at: iso(a.created_at), quantity: Number(a.delta), reason: a.reason,
        balance_before: Number(a.balance_before), balance_after: Number(a.balance_after), actor: a.created_by,
      })),
      ...consumptions.flatMap((c: any) => {
        const spent: BalanceHistoryEntry = {
          kind: 'consumption', at: iso(c.created_at), quantity: -1, reason: c.reason,
          balance_before: null, balance_after: null, actor: c.created_by,
        };
        return c.returned_at
          ? [spent, { ...spent, at: iso(c.returned_at), quantity: 1, reason: 'returned', actor: c.returned_by }]
          : [spent];
      }),
    ];
    res.json(sortHistory(entries));
  } catch (err) { next(err); }
});

/**
 * Set the Member's balance for one service. Staff enter the desired final
 * balance; the ledger stores the signed delta with the balance before and
 * after (#1227 Q3). The Member row is locked so two adjustments cannot both
 * read the same "before".
 */
memberProfessionalServicesRouter.post('/:serviceId/adjust', requireModuleWrite('MEMBERS'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const memberId = parseInt((req.params as unknown as { memberId: string }).memberId, 10);
  const serviceId = parseInt(String(req.params.serviceId), 10);
  if (!Number.isInteger(memberId) || memberId <= 0 || !Number.isInteger(serviceId) || serviceId <= 0) {
    return res.status(400).json({ error: 'memberId and serviceId must be positive integers' });
  }
  const input = parseAdjustmentInput(req.body);
  if ('error' in input) return res.status(400).json({ error: input.error });
  try {
    const result = await db.transaction(async (tx) => {
      const { rows: memberRows } = await tx.query(
        'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL FOR UPDATE',
        [memberId, gymId],
      );
      if (memberRows.length === 0) return { status: 404 as const, body: { error: 'Member not found' } };
      const { rows: serviceRows } = await tx.query(
        `SELECT ps.id FROM professional_services ps
           JOIN gym_professional_services gps
             ON gps.professional_service_id = ps.id AND gps.gym_id = ? AND gps.status = 'active'
          WHERE ps.id = ? AND ps.deleted_at IS NULL`,
        [gymId, serviceId],
      );
      if (serviceRows.length === 0) return { status: 404 as const, body: { error: 'Professional service not found' } };

      const before = (await resolveMemberProfessionalServices(gymId, memberId))
        .find((b) => b.professional_service_id === serviceId)?.sessions ?? 0;
      const delta = input.new_balance - before;
      if (delta === 0) return { status: 200 as const, body: { professional_service_id: serviceId, available_items: before, changed: false } };

      await tx.query(
        `INSERT INTO professional_service_adjustments
           (gym_id, member_id, professional_service_id, delta, balance_before, balance_after, reason, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [gymId, memberId, serviceId, delta, before, input.new_balance, input.reason, resolveRequestActor(ctx)],
      );
      return { status: 200 as const, body: { professional_service_id: serviceId, available_items: input.new_balance, changed: true } };
    });
    res.status(result.status).json(result.body);
  } catch (err) { next(err); }
});
