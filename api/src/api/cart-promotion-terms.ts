import { db } from '../infra/db';
import { promotionHolderSql } from './plan-snapshot-lines';
import { fetchLiveBenefits, membershipFeeBenefitsFromSnapshot } from './membership-promotions';

/**
 * #3154 — what the Members App's *Your gym is preparing a change* card says
 * about a Promotion beside a plan or a Product: its picture, its description
 * and its main terms, with no money.
 *
 * A plan's Promotions are its snapshot's standing applications
 * (`plan_promotion_snapshots`, through the snapshot that holds them, #3026).
 * A confirmed application reads its own frozen JSON snapshot (#635 §16); a
 * Draft reference has none yet (#2624 stage 4) and reads the live Promotion,
 * which is what its confirmation would freeze. Nothing here prices anything.
 */
export interface PlanViewPromotion {
  id: number;
  promotion_id: number;
  promotion_name: string;
  description: string | null;
  image_url: string | null;
  image_thumbnail_url: string | null;
  free_months: number | null;
  paid_months: number | null;
  bonus_months: number | null;
  /** The Promotion's Membership Fee Benefit (the first enabled one), or `null` when it has none. */
  membership_fee_benefit: { action: string; value: number | null; duration_months: number | null } | null;
}

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function parseSnapshot(raw: unknown): any {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

/** The standing Promotions of each plan snapshot, keyed by the snapshot id asked for. */
export async function loadPlanPromotionsForView(
  gymId: string,
  planSnapshotIds: readonly number[],
): Promise<Map<number, PlanViewPromotion[]>> {
  const out = new Map<number, PlanViewPromotion[]>();
  if (planSnapshotIds.length === 0) return out;
  const marks = planSnapshotIds.map(() => '?').join(',');
  const { rows } = await db.query<any>(
    `SELECT pa.id AS plan_snapshot_id, pps.id, pps.promotion_id, pps.snapshot,
            p.name, p.description, p.image_url, COALESCE(p.image_thumbnail_url, p.image_url) AS image_thumbnail_url,
            p.free_months, p.paid_months, p.bonus_months
       FROM plan_snapshots pa
       JOIN plan_promotion_snapshots pps
         ON pps.plan_snapshot_id = ${promotionHolderSql('pa.id')} AND pps.gym_id = pa.gym_id
       JOIN promotions p ON p.id = pps.promotion_id
      WHERE pa.gym_id = ? AND pa.id IN (${marks}) AND pps.status = 'applied'
      ORDER BY pps.applied_at, pps.id`,
    [gymId, ...planSnapshotIds],
  );
  for (const r of rows) {
    const snap = parseSnapshot(r.snapshot);
    const benefits = snap
      ? membershipFeeBenefitsFromSnapshot(snap)
      : (await fetchLiveBenefits(db as any, Number(r.promotion_id))).membership_fee_benefits;
    const fee = benefits.find((b: any) => b?.enabled && b?.action && b.action !== 'no_benefit') ?? null;
    const promo: PlanViewPromotion = {
      id: Number(r.id),
      promotion_id: Number(r.promotion_id),
      promotion_name: String(snap?.name ?? r.name ?? `Promotion #${r.promotion_id}`),
      description: (snap ? snap.description : r.description) ?? null,
      image_url: (snap?.image_url ?? r.image_url) ?? null,
      image_thumbnail_url: (snap?.image_thumbnail_url ?? snap?.image_url ?? r.image_thumbnail_url) ?? null,
      free_months: num(snap ? snap.free_months : r.free_months),
      paid_months: num(snap ? snap.paid_months : r.paid_months),
      bonus_months: num(snap ? snap.bonus_months : r.bonus_months),
      membership_fee_benefit: fee
        ? { action: String(fee.action), value: num(fee.value), duration_months: num(fee.duration_months) }
        : null,
    };
    const key = Number(r.plan_snapshot_id);
    out.set(key, [...(out.get(key) ?? []), promo]);
  }
  return out;
}

/**
 * The description of each Promotion named, for a Product's applied Promotion
 * (its application stores no description). Presentation only, read live like
 * the Product's own description and picture.
 */
export async function loadPromotionDescriptions(
  gymId: string,
  promotionIds: readonly number[],
): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  const ids = Array.from(new Set(promotionIds.map(Number))).filter((id) => Number.isFinite(id));
  if (ids.length === 0) return out;
  const { rows } = await db.query<any>(
    `SELECT id, description FROM promotions WHERE gym_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    [gymId, ...ids],
  );
  for (const r of rows) out.set(Number(r.id), r.description ?? null);
  return out;
}

/** Adds each applied Promotion's `description` to the lists given, in place. */
export async function withPromotionDescriptions<T extends { promotion_id: number }>(
  gymId: string,
  lists: Array<T[] | undefined>,
): Promise<void> {
  const all = lists.flatMap((l) => l ?? []);
  const descriptions = await loadPromotionDescriptions(gymId, all.map((p) => p.promotion_id));
  for (const p of all) (p as any).description = descriptions.get(Number(p.promotion_id)) ?? null;
}
