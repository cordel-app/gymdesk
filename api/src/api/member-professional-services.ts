import { isCurrentAssignmentSnapshotSql } from '../domain/planAssignments';
import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { attachTranslations } from './professional-service-translations';
import { getRequestLocale } from '../infra/locale';
import { resolveMemberProfessionalServices } from '../domain/memberProfessionalServices';
import { resolveRequestActor } from '../domain/auditActor';
import { reservationBalance } from '../domain/serviceReservation';
import { loadBookedByService, loadServiceBalanceViews } from './service-reservation';
import { familyWalletOf, inList, lockWallet, MEMBER_FAMILY_SQL } from './family-wallet';
import { walletAdjustmentParams, walletAdjustmentScope, walletLedgerParams, walletLedgerScope } from '../domain/memberProfessionalServices';
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
 * #2605 stage 3: `total_items` is that balance, `booked_items` the units held
 * by future bookings and `available_items` what is left to book
 * (`5 items (0 available + 5 booked)`), all from `loadServiceBalanceViews()`.
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
      `SELECT ps.id AS professional_service_id, ps.name,
              COALESCE(ps.image_thumbnail_url, ps.image_url) AS image_thumbnail_url,
              ps.image_url, ps.description
         FROM professional_services ps
         JOIN gym_professional_services gps
           ON gps.professional_service_id = ps.id AND gps.gym_id = ? AND gps.status = 'active'
        WHERE ps.gym_id = ? AND ps.deleted_at IS NULL
        ORDER BY ps.name ASC`,
      [gymId, gymId],
    );
    const balances = new Map(
      (await resolveMemberProfessionalServices(gymId, memberId)).map((b) => [b.professional_service_id, b]),
    );
    const views = await loadServiceBalanceViews(gymId, memberId);
    // #2297: the full-size image and the description in the request locale, for the image modal.
    const localized = await attachTranslations(
      services.map((s: { professional_service_id: number; name: string; description: string | null }) => ({ ...s, id: s.professional_service_id })),
      getRequestLocale(req),
    );
    const imagesById = new Map<number, { image_thumbnail_url: string | null; image_url: string | null }>(
      services.map((s: { professional_service_id: number; image_thumbnail_url: string | null; image_url: string | null }) => [
        s.professional_service_id,
        { image_thumbnail_url: s.image_thumbnail_url, image_url: s.image_url },
      ]),
    );
    res.json(localized.map((s) => ({
      professional_service_id: s.professional_service_id,
      name: s.name,
      image_thumbnail_url: imagesById.get(s.professional_service_id)?.image_thumbnail_url ?? null,
      image_url: imagesById.get(s.professional_service_id)?.image_url ?? null,
      display_description: s.display_description ?? null,
      total_items: views.get(s.professional_service_id)?.total ?? 0,
      booked_items: views.get(s.professional_service_id)?.booked ?? 0,
      available_items: views.get(s.professional_service_id)?.available ?? 0,
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

    // #2670 stage 2: the Family wallet's history — the same for every member of the family.
    const wallet = await familyWalletOf(db, gymId, memberId);
    const ids = wallet.memberIds;
    const { rows: adjustments } = await db.query(
      `SELECT psa.delta, psa.balance_before, psa.balance_after, psa.reason, psa.created_at, psa.created_by,
              psa.member_id, m.name AS member_name
         FROM professional_service_adjustments psa
         LEFT JOIN members m ON m.id = psa.member_id
        WHERE psa.gym_id = ? AND ${walletAdjustmentScope('psa', wallet.familyId, inList(ids))}
          AND psa.professional_service_id = ?
        ORDER BY psa.id ASC`,
      [gymId, ...walletAdjustmentParams(wallet.familyId, ids), serviceId],
    );
    // The member named on a spend is the one who booked (the booking's member), not
    // the holder of the grant it was taken from.
    const { rows: consumptions } = await db.query(
      `SELECT psc.reason, psc.created_at, psc.created_by, psc.returned_at, psc.returned_by,
              COALESCE(ceb.member_id, psc.member_id) AS member_id, m.name AS member_name
         FROM professional_service_consumptions psc
         LEFT JOIN calendar_event_bookings ceb ON ceb.id = psc.calendar_event_booking_id
         LEFT JOIN members m ON m.id = COALESCE(ceb.member_id, psc.member_id)
        WHERE psc.gym_id = ? AND psc.professional_service_id = ?
          AND ${walletLedgerScope('psc', wallet.familyId, inList(ids))}
        ORDER BY psc.id ASC`,
      [gymId, serviceId, ...walletLedgerParams(wallet.familyId, ids)],
    );
    // #1227 stage 2: each renewal of a plan Session Benefit allowance is a grant.
    const { rows: renewals } = await db.query(
      `SELECT par.quantity, par.renewal_date
         FROM plan_allowance_renewals par
         JOIN plan_session_snapshots umss ON umss.id = par.plan_session_snapshot_id
         JOIN plan_snapshots pa ON pa.id = umss.plan_snapshot_id AND pa.gym_id = par.gym_id
        WHERE par.gym_id = ? AND pa.status = 'active' AND ${isCurrentAssignmentSnapshotSql('pa')}
          AND (pa.member_id IN ${inList(ids)}
               OR EXISTS (SELECT 1 FROM plan_snapshot_beneficiaries umm
                          WHERE umm.plan_snapshot_id = pa.id AND umm.gym_id = pa.gym_id AND umm.member_id IN ${inList(ids)}))
          AND EXISTS (SELECT 1 FROM product_professional_services sips
                       WHERE sips.product_id = umss.product_id AND sips.gym_id = par.gym_id
                         AND sips.professional_service_id = ?)
        ORDER BY par.renewal_date ASC, par.id ASC`,
      [gymId, ...ids, ...ids, serviceId],
    );
    const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
    const entries: BalanceHistoryEntry[] = [
      ...adjustments.map((a: any) => ({
        kind: 'adjustment' as const, at: iso(a.created_at), quantity: Number(a.delta), reason: a.reason,
        balance_before: Number(a.balance_before), balance_after: Number(a.balance_after), actor: a.created_by,
        member_id: a.member_id == null ? null : Number(a.member_id), member_name: a.member_name ?? null,
      })),
      ...renewals.map((r: any) => ({
        kind: 'grant' as const, at: iso(r.renewal_date), quantity: Number(r.quantity), reason: 'plan_renewal',
        balance_before: null, balance_after: null, actor: null,
      })),
      ...consumptions.flatMap((c: any) => {
        const spent: BalanceHistoryEntry = {
          kind: 'consumption', at: iso(c.created_at), quantity: -1, reason: c.reason,
          balance_before: null, balance_after: null, actor: c.created_by,
          member_id: c.member_id == null ? null : Number(c.member_id), member_name: c.member_name ?? null,
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
      // #2670 stage 2: the balance is the Family's, so corrections are serialised per family.
      await lockWallet(tx, gymId, await familyWalletOf(tx, gymId, memberId), memberId);
      const { rows: serviceRows } = await tx.query(
        `SELECT ps.id FROM professional_services ps
           JOIN gym_professional_services gps
             ON gps.professional_service_id = ps.id AND gps.gym_id = ? AND gps.status = 'active'
          WHERE ps.id = ? AND ps.gym_id = ? AND ps.deleted_at IS NULL`,
        [gymId, serviceId, gymId],
      );
      if (serviceRows.length === 0) return { status: 404 as const, body: { error: 'Professional service not found' } };

      const before = (await resolveMemberProfessionalServices(gymId, memberId))
        .find((b) => b.professional_service_id === serviceId)?.sessions ?? 0;
      // #2605 stage 3: staff set the total (remaining) balance; what is
      // available is that less the units future bookings already hold.
      const booked = (await loadBookedByService(tx, gymId, memberId))
        .find((b) => b.professional_service_id === serviceId)?.booked ?? 0;
      const view = (total: number) => {
        const v = reservationBalance(total, booked);
        return { total_items: v.total, booked_items: v.booked, available_items: v.available };
      };
      const delta = input.new_balance - before;
      if (delta === 0) return { status: 200 as const, body: { professional_service_id: serviceId, ...view(before), changed: false } };

      await tx.query(
        `INSERT INTO professional_service_adjustments
           (gym_id, member_id, family_id, professional_service_id, delta, balance_before, balance_after, reason, created_by)
         VALUES (?, ?, ${MEMBER_FAMILY_SQL}, ?, ?, ?, ?, ?, ?)`,
        [gymId, memberId, memberId, gymId, serviceId, delta, before, input.new_balance, input.reason, resolveRequestActor(ctx)],
      );
      return { status: 200 as const, body: { professional_service_id: serviceId, ...view(input.new_balance), changed: true } };
    });
    res.status(result.status).json(result.body);
  } catch (err) { next(err); }
});
